import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterContext, AgentAdapter } from '../src/main/agents/base';
import { OrchestratorEngine } from '../src/main/orchestrator/engine';
import { classifyQuota, exhaustedAgentIds, failoverCount, MAX_AUTOMATIC_FAILOVERS, readContinuation, type ContinuationPacket } from '../src/main/orchestrator/continuation';
import { readVerifiedPacket } from '../src/main/orchestrator/packets';
import { git } from '../src/main/orchestrator/worktree';
import { runDir } from '../src/main/orchestrator/store';
import { saveScores } from '../src/main/orchestrator/scores';
import { agentResultsSchema, agentStatusSchema, budgetConfigSchema, stageSpecSchema, type AgentStatus, type ArtifactBundle, type BudgetConfig, type RunSnapshot, type StageSpec } from '../src/shared/contracts';

vi.setConfig({ testTimeout: 45_000, hookTimeout: 30_000 });
const sha = (body: string): string => createHash('sha256').update(body).digest('hex');
const success = (): ArtifactBundle => ({ result: agentResultsSchema.parse({ status: 'completed', summary: 'Implementation independently completed.' }), stdoutSummary: 'Done', stderrTail: [], exitCode: 0, timedOut: false });
const limited = (stderr = 'HTTP 429 Too Many Requests'): ArtifactBundle => ({
  ...success(), result: agentResultsSchema.parse({ status: 'completed', summary: 'UNTRUSTED SUCCESS CLAIM' }),
  stdoutSummary: 'UNTRUSTED SUCCESS CLAIM', stderrTail: [stderr], exitCode: 1
});

describe('quota classification uses failed-process diagnostics only', () => {
  it.each([
    ['HTTP 429 Too Many Requests', 'http_429'],
    ['Error: 429 Too Many Requests', 'http_429'],
    ['API Error: 429 {"error":{"type":"rate_limit_error"}}', 'http_429'],
    ['rate_limit_error', 'rate_limit'],
    ['Error: rate_limit_exceeded: retry later', 'rate_limit'],
    ['quota exhausted', 'quota_exhausted'],
    ['Error: quota_exhausted: daily requests used', 'quota_exhausted'],
    ['{"error":{"type":"rate_limit_error"}}', 'rate_limit'],
    ['{"error":{"code":"insufficient_quota"}}', 'quota_exhausted'],
    ['{"status_code":429}', 'http_429']
  ])('recognizes %s', (stderr, expected) => expect(classifyQuota(limited(stderr))).toBe(expected));

  it.each([
    'We should handle rate limits and quota exhaustion.',
    'An example HTTP 429 response appears in the documentation.',
    'The rate_limit_error string is in our fixture.',
    'Error: ordinary agent failure',
    'Quota exhausted in a previous run, but this task has a syntax error.',
    '{"message":"HTTP 429 Too Many Requests"}',
    'file.ts:429: compiler error'
  ])('does not reroute on generic prose: %s', (stderr) => expect(classifyQuota(limited(stderr))).toBeUndefined());

  it('ignores successful exits, timeouts, unknown exits and stdout/self-report claims', () => {
    expect(classifyQuota({ ...limited(), exitCode: 0 })).toBeUndefined();
    expect(classifyQuota({ ...limited(), timedOut: true })).toBeUndefined();
    expect(classifyQuota({ ...limited(), exitCode: null })).toBeUndefined();
    expect(classifyQuota({ ...limited('ordinary failure'), stdoutSummary: 'HTTP 429 Too Many Requests' })).toBeUndefined();
    expect(classifyQuota({ ...limited(''), exitCode: 429 })).toBe('http_429');
  });
});

describe('offline mid-task failover with real git', () => {
  let root: string;
  let project: string;
  let engine: OrchestratorEngine;
  let statuses: AgentStatus[];
  let budget: BudgetConfig;
  let calls: AdapterContext[];
  let act: (ctx: AdapterContext) => ArtifactBundle | Promise<ArtifactBundle>;
  let onUpdate: (run: RunSnapshot) => void;

  function status(id: string, family: AgentStatus['family'], costClass = 0): AgentStatus {
    return agentStatusSchema.parse({ id, label: id, family, tier: 'B', detected: true, authenticated: true,
      remainingRequests: 10, roles: ['plan', 'execute', 'test', 'review'], costClass, latencyClass: costClass });
  }
  const stage = (role: StageSpec['role'], overrides: Partial<StageSpec> = {}): StageSpec => stageSpecSchema.parse({ id: role, title: role, role, agentId: null, retries: 0, ...overrides });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'tawny failover '));
    await saveScores(root, []);
    project = join(root, 'repo with spaces');
    mkdirSync(project);
    git(project, ['init', '-b', 'main']);
    git(project, ['config', 'user.email', 'offline@example.test']);
    git(project, ['config', 'user.name', 'Free-only fixture']);
    git(project, ['config', 'core.autocrlf', 'false']);
    writeFileSync(join(project, 'implementation.txt'), 'base\n');
    git(project, ['add', '.']);
    git(project, ['commit', '-m', 'Offline fixture']);
    statuses = [status('free-a', 'anthropic'), status('free-b', 'google', 0.2)];
    budget = budgetConfigSchema.parse({ entitlements: Object.fromEntries(['free-a', 'free-b', 'free-c', 'free-d'].map((id) => [id, { kind: 'free', userConfirmed: true, remainingRequests: 10 }])) });
    calls = [];
    act = () => success();
    onUpdate = () => {};
    const adapter: AgentAdapter = {
      id: 'offline', name: 'No paid calls', tier: 'B',
      async start(ctx) { calls.push(ctx); return { key: `${ctx.contract.stageId}:${ctx.contract.agentId}`, ctx, extras: {} }; },
      async collect(handle) { return act(handle.ctx); }, async cancel() {}
    };
    engine = new OrchestratorEngine({ userDataDir: root, onRunUpdate: (run) => onUpdate(run),
      budgetFor: () => budget, agentsFor: () => statuses, adapterFor: () => adapter });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function create(stages = [stage('execute')]): Promise<RunSnapshot> {
    return engine.createRun({ goal: 'Finish partial work on confirmed free agents', projectPath: project, templateId: 'free-failover', stages });
  }
  async function finish(run: RunSnapshot): Promise<RunSnapshot> {
    await engine.startRun(run.id);
    return (await engine.loadRunById(run.id))!;
  }
  async function continuation(run: RunSnapshot, index = 0): Promise<ContinuationPacket> {
    const artifacts = run.stages[index].artifacts;
    const path = artifacts.find((artifact) => artifact.name === 'continuation')!.path;
    const hash = artifacts.find((artifact) => artifact.name === 'continuation_sha256')!.path;
    return (await readContinuation(path, hash))!;
  }

  it('resumes staged and untracked partial work in the SAME worktree without committing; acceptance runs only after completion', async () => {
    const base = git(project, ['rev-parse', 'HEAD']).trim();
    act = async (ctx) => {
      if (ctx.contract.agentId === 'free-a') {
        writeFileSync(join(ctx.cwd, 'implementation.txt'), 'partial\n');
        git(ctx.cwd, ['add', 'implementation.txt']);
        writeFileSync(join(ctx.cwd, 'untracked.txt'), 'preserved untracked work\n');
        writeFileSync(ctx.contract.strictOutput!.path, JSON.stringify(success().result));
        return limited('{"error":{"code":"rate_limit_exceeded"}}');
      }
      expect(ctx.cwd).toBe(calls[0].cwd);
      expect(readFileSync(join(ctx.cwd, 'implementation.txt'), 'utf8')).toBe('partial\n');
      expect(readFileSync(join(ctx.cwd, 'untracked.txt'), 'utf8')).toBe('preserved untracked work\n');
      expect(git(ctx.cwd, ['rev-parse', 'HEAD']).trim()).toBe(base);
      expect(git(ctx.cwd, ['diff', '--cached', '--name-only'])).toContain('implementation.txt');
      expect(ctx.contract.strictOutput?.hint).toContain('Read engine-authored continuation:');
      expect(ctx.contract.previousFailure?.gate).toBe('quota');
      const snapshot = await continuation((await engine.loadRunById(ctx.contract.runId))!);
      expect(snapshot.from).toBe('free-a');
      expect(snapshot.selected_replacement).toBe('free-b');
      expect(snapshot.ground_truth.files_changed).toEqual(['implementation.txt', 'untracked.txt']);
      expect(snapshot.ground_truth.untracked[0].content_and_mode_fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(snapshot.ground_truth.gates.some((gate) => gate.gate === 'acceptance')).toBe(false);
      expect(JSON.stringify(snapshot)).not.toContain('UNTRUSTED SUCCESS CLAIM');
      writeFileSync(join(ctx.cwd, 'implementation.txt'), 'complete\n');
      return success();
    };
    const command = 'node -e "if(require(\'fs\').readFileSync(\'implementation.txt\',\'utf8\')!==\'complete\\n\') process.exit(4)"';
    const state = await finish(await create([stage('execute', { acceptanceCommands: [command] })]));
    expect(state.status).toBe('done');
    expect(calls.map((ctx) => ctx.contract.agentId)).toEqual(['free-a', 'free-b']);
    expect(state.stages[0].attempt).toBe(2);
    expect(state.stages[0].spec.agentId).toBeNull();
    expect(exhaustedAgentIds(state)).toEqual(new Set(['free-a']));
    expect(readFileSync(join(project, 'implementation.txt'), 'utf8')).toBe('base\n');
    const artifacts = state.stages[0].artifacts;
    for (const [name, hashName] of [['continuation', 'continuation_sha256'], ['continuation_md', 'continuation_md_sha256']]) {
      const body = readFileSync(artifacts.find((artifact) => artifact.name === name)!.path, 'utf8');
      expect(sha(body)).toBe(artifacts.find((artifact) => artifact.name === hashName)!.path);
    }
    const earlier = artifacts.find((artifact) => artifact.name.startsWith('packet_attempt:'))!;
    const quotaPacket = (await readVerifiedPacket(earlier.path))!;
    expect(quotaPacket.agent_report).toBeNull();
    expect(quotaPacket.ground_truth.gate_results.find((gate) => gate.gate === 'quota')?.result).toBe('error');
    const report = readFileSync(join(runDir(root, state.id), 'final-summary.md'), 'utf8');
    expect(report).toContain('Selected replacement: free-b');
    expect(report).toContain('no engine commit, stash or reset');
    expect(report).toContain('not a complete recovery backup');
  });

  it('keeps explicit pins and escalates quota even when another free agent is available', async () => {
    act = (ctx) => { writeFileSync(join(ctx.cwd, 'implementation.txt'), 'partial\n'); return limited(); };
    const state = await finish(await create([stage('execute', { agentId: 'free-a', retries: 3 })]));
    expect(calls.map((ctx) => ctx.contract.agentId)).toEqual(['free-a']);
    expect(state.status).toBe('escalated');
    expect(state.stages[0].spec.agentId).toBe('free-a');
    expect((await continuation(state)).selected_replacement).toBeNull();
    expect(state.stages[0].failureReason).toContain('Explicit agent pin retained');
  });

  it.each(['paid', 'zero-headroom', 'entitlement-exhausted', 'unsupported', 'unauthenticated', 'expired'] as const)('never switches to a %s candidate or the manual slot', async (kind) => {
    if (kind === 'paid') {
      budget.policy = 'quality-first'; budget.maxUsd = 100;
      budget.entitlements['free-b'] = { kind: 'paid', userConfirmed: true, maxCostUsd: 0.1 };
    }
    if (kind === 'zero-headroom') statuses[1].remainingRequests = 0;
    if (kind === 'entitlement-exhausted') budget.entitlements['free-b'].remainingRequests = 0;
    if (kind === 'unsupported') statuses[1].roles = ['plan'];
    if (kind === 'unauthenticated') statuses[1].authenticated = false;
    if (kind === 'expired') budget.entitlements['free-b'].expiresAt = '2020-01-01T00:00:00.000Z';
    statuses.push(status('manual', 'human', 1));
    act = () => limited();
    const state = await finish(await create());
    expect(calls.map((ctx) => ctx.contract.agentId)).toEqual(['free-a']);
    expect(state.status).toBe('escalated');
    expect((await continuation(state)).selected_replacement).toBeNull();
    expect(state.stages[0].failureReason).toContain('No different eligible free/local external agent');
  });

  it('excludes exhausted IDs from subsequent automatic stages, not just the interrupted attempt', async () => {
    act = (ctx) => ctx.contract.role === 'execute' && ctx.contract.agentId === 'free-a' ? limited() : success();
    const state = await finish(await create([stage('execute'), stage('plan')]));
    expect(state.status).toBe('done');
    expect(calls.map((ctx) => `${ctx.contract.role}:${ctx.contract.agentId}`)).toEqual(['execute:free-a', 'execute:free-b', 'plan:free-b']);
    expect(exhaustedAgentIds((await engine.loadRunById(state.id))!)).toEqual(new Set(['free-a']));
  });

  it('does not bypass a later explicit pin to an exhausted agent', async () => {
    act = (ctx) => ctx.contract.agentId === 'free-a' ? limited() : success();
    const run = await create([stage('execute'), stage('plan', { agentId: 'free-a' })]);
    await expect(engine.startRun(run.id)).rejects.toMatchObject({ cls: 'input', stage: 'dispatch' });
    expect(calls.map((ctx) => ctx.contract.agentId)).toEqual(['free-a', 'free-b']);
    expect((await engine.loadRunById(run.id))?.stages[1].status).toBe('escalated');
  });

  it('keeps verification independent of BOTH writer families after execute failover', async () => {
    statuses.push(status('free-c', 'anthropic', 0.4), status('free-d', 'openai', 0.6));
    act = (ctx) => {
      if (ctx.contract.role === 'execute' && ctx.contract.agentId === 'free-a') {
        writeFileSync(join(ctx.cwd, 'implementation.txt'), 'partial\n'); return limited();
      }
      if (ctx.contract.role === 'test') {
        expect(ctx.contract.agentId).toBe('free-d');
        expect(readFileSync(join(ctx.cwd, 'implementation.txt'), 'utf8')).toBe('partial\n');
      }
      return success();
    };
    const state = await finish(await create([stage('execute'), stage('test')]));
    expect(state.status).toBe('done');
    expect(calls.map((ctx) => ctx.contract.agentId)).toEqual(['free-a', 'free-b', 'free-d']);
  });

  it('also enforces author-family constraints when the TEST agent hits quota', async () => {
    statuses.push(status('free-c', 'anthropic', 0.4), status('free-d', 'openai', 0.6));
    act = (ctx) => ctx.contract.role === 'test' && ctx.contract.agentId === 'free-b' ? limited() : success();
    const state = await finish(await create([stage('execute'), stage('test')]));
    expect(state.status).toBe('done');
    expect(calls.map((ctx) => ctx.contract.agentId)).toEqual(['free-a', 'free-b', 'free-d']);
    expect((await continuation(state, 1)).selected_replacement).toBe('free-d');
  });

  it('caps run-wide failover even with more free candidates and normal retries available', async () => {
    statuses.push(status('free-c', 'openai', 0.4), status('free-d', 'cursor', 0.6));
    act = (ctx) => { writeFileSync(join(ctx.cwd, 'implementation.txt'), `partial by ${ctx.contract.agentId}\n`); return limited(); };
    const state = await finish(await create([stage('execute', { retries: 5 })]));
    expect(state.status).toBe('escalated');
    expect(calls.map((ctx) => ctx.contract.agentId)).toEqual(['free-a', 'free-b', 'free-c']);
    expect(failoverCount(state)).toBe(MAX_AUTOMATIC_FAILOVERS);
    expect(exhaustedAgentIds(state)).toEqual(new Set(['free-a', 'free-b', 'free-c']));
    expect(state.stages[0].failureReason).toContain('Run failover cap');
    expect(new Set(calls.map((ctx) => ctx.cwd)).size).toBe(1);
  });

  it('redacts secrets in diagnostic and actual diff evidence, preserving raw work only in the worktree', async () => {
    const secret = `sk-proj-${'s'.repeat(32)}`;
    act = (ctx) => {
      writeFileSync(join(ctx.cwd, 'implementation.txt'), `partial credential ${secret}\n`);
      return limited(`HTTP 429 Too Many Requests\nBearer bearer-secret-value\n${secret}\n-----BEGIN PRIVATE KEY-----\n${'private-body'.repeat(1000)}\n-----END PRIVATE KEY-----`);
    };
    const state = await finish(await create());
    expect(state.status).toBe('escalated'); // Secret/scope safety never becomes a quota-gate pass.
    expect(calls).toHaveLength(1);
    const paths = state.stages[0].artifacts.filter((artifact) => ['continuation', 'continuation_md', 'verified_packet', 'verified_packet_md'].includes(artifact.name)).map((artifact) => artifact.path);
    paths.push(join(runDir(root, state.id), 'state.json'), join(runDir(root, state.id), 'final-summary.md'));
    for (const path of paths) {
      const text = readFileSync(path, 'utf8');
      for (const value of [secret, 'bearer-secret-value', 'private-body']) expect(text).not.toContain(value);
    }
    expect(readFileSync(join(calls[0].cwd, 'implementation.txt'), 'utf8')).toContain(secret);
    expect((await continuation(state)).ground_truth.working_diff_excerpt).toContain('[REDACTED');
  });

  it('bounds continuation excerpts, labels truncation, and verifies the JSON hash before the replacement starts', async () => {
    act = (ctx) => {
      if (ctx.contract.agentId === 'free-a') {
        writeFileSync(join(ctx.cwd, 'implementation.txt'), 'x'.repeat(20000));
        return limited(`HTTP 429 Too Many Requests\n${'untrusted prose '.repeat(2000)}`);
      }
      writeFileSync(join(ctx.cwd, 'implementation.txt'), 'complete\n'); return success();
    };
    const state = await finish(await create());
    const snapshot = await continuation(state);
    expect(snapshot.ground_truth.evidence_truncated).toBe(true);
    expect(snapshot.ground_truth.working_diff_excerpt.length).toBeLessThan(6200);
    expect(snapshot.untrusted_stderr_excerpt.length).toBeLessThan(2200);
    const path = state.stages[0].artifacts.find((artifact) => artifact.name === 'continuation')!.path;
    expect(Buffer.byteLength(readFileSync(path))).toBeLessThanOrEqual(96 * 1024);
    expect(await readContinuation(path, 'incorrect-hash')).toBeUndefined();
  });

  it('refuses continuation tampering before replacement dispatch', async () => {
    act = () => limited();
    onUpdate = (run) => {
      const interrupted = run.stages[0];
      if (interrupted.status === 'retrying') {
        const artifact = interrupted.artifacts.find((item) => item.name === 'continuation');
        if (artifact) writeFileSync(artifact.path, '{"forged":"claim success"}');
      }
    };
    const run = await create();
    await expect(engine.startRun(run.id)).rejects.toThrow('Continuation integrity');
    expect(calls.map((ctx) => ctx.contract.agentId)).toEqual(['free-a']);
    expect((await engine.loadRunById(run.id))?.status).toBe('escalated');
  });

  it('rechecks free eligibility immediately before replacement dispatch', async () => {
    act = () => limited();
    onUpdate = (run) => {
      if (run.stages[0].status === 'retrying') {
        budget.policy = 'quality-first'; budget.maxUsd = 100;
        budget.entitlements['free-b'] = { kind: 'paid', userConfirmed: true, maxCostUsd: 0.1 };
      }
    };
    const run = await create();
    await expect(engine.startRun(run.id)).rejects.toThrow('no longer eligible');
    expect(calls.map((ctx) => ctx.contract.agentId)).toEqual(['free-a']);
    expect((await engine.loadRunById(run.id))?.status).toBe('escalated');
  });

  it('does not use quota failover to conceal read-only or scope violations', async () => {
    act = (ctx) => { writeFileSync(join(ctx.cwd, 'unexpected.txt'), 'forbidden partial work'); return limited(); };
    const state = await finish(await create([stage('plan')]));
    expect(state.status).toBe('escalated');
    expect(calls).toHaveLength(1);
    expect(state.stages[0].gates.find((gate) => gate.gate === 'read_only')?.result).toBe('fail');
    expect((await continuation(state)).decision).toContain('safety/evidence verification failed');
    expect(existsSync(join(project, 'unexpected.txt'))).toBe(true);
  });
});
