import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import type { AgentAdapter, AdapterContext } from '../src/main/agents/base';
import type { AgentResult, RunSnapshot, StageSpec } from '../src/shared/contracts';
import { OrchestratorEngine } from '../src/main/orchestrator/engine';
import { git, branchName, worktreeDirectory } from '../src/main/orchestrator/worktree';
import { changedFilesSince, workspaceFacts, readOnlyGate, globMatches } from '../src/main/orchestrator/gates';
import { readVerifiedPacket, redactSecrets, safeData, type VerifiedPacket } from '../src/main/orchestrator/packets';
import { runReport } from '../src/main/orchestrator/report';
import { runDir, saveRun } from '../src/main/orchestrator/store';
import { makePacketAdapter } from '../src/main/agents/packet';
import { memoryFilePath } from '../src/main/orchestrator/memory';

let root: string;
let project: string;
let engine: OrchestratorEngine;
let calls: AdapterContext[];
let action: (context: AdapterContext) => Partial<AgentResult> | Promise<Partial<AgentResult>>;

const spec = (role: StageSpec['role'], overrides: Partial<StageSpec> = {}): StageSpec => ({
  id: role, title: role, role, agentId: 'fake-local', acceptanceCommands: [], allowedFiles: [], forbiddenFiles: [], retries: 0, ...overrides
});

const completed = (overrides: Partial<AgentResult> = {}): AgentResult => ({
  status: 'completed', summary: 'Work finished.', filesChanged: [], assumptions: [], unresolved: [], confidence: 'medium', ...overrides
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tawny golden path '));
  project = join(root, 'project with spaces');
  mkdirSync(project);
  git(project, ['init', '-b', 'main']);
  git(project, ['config', 'core.autocrlf', 'false']);
  git(project, ['config', 'user.email', 'offline@example.test']);
  git(project, ['config', 'user.name', 'Offline fixture']);
  writeFileSync(join(project, 'implementation.txt'), 'base\n');
  git(project, ['add', '.']);
  git(project, ['commit', '-m', 'Fixture']);
  calls = [];
  action = () => ({});
  const adapter: AgentAdapter = {
    id: 'fake-local', name: 'Offline scripted agent', tier: 'B',
    async start(ctx) { calls.push(ctx); return { key: ctx.contract.stageId, ctx, extras: {} }; },
    async collect(handle) {
      const result = completed(await action(handle.ctx));
      return { result, stdoutSummary: result.summary, stderrTail: [], exitCode: 0, timedOut: false };
    },
    async cancel() {}
  };
  engine = new OrchestratorEngine({ userDataDir: root, onRunUpdate() {}, adapterFor: () => adapter });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

async function create(stages: StageSpec[], branchPrefix?: string): Promise<RunSnapshot> {
  return engine.createRun({ goal: 'Implement and independently verify a local change', projectPath: project, stages, templateId: 'offline', branchPrefix });
}
async function finish(run: RunSnapshot): Promise<RunSnapshot> {
  await engine.startRun(run.id);
  return (await engine.loadRunById(run.id))!;
}
async function packet(run: RunSnapshot, index = 0): Promise<VerifiedPacket> {
  const path = run.stages[index].artifacts.find((artifact) => artifact.name === 'verified_packet')!.path;
  return (await readVerifiedPacket(path))!;
}

describe('local golden path: actual implementation workspace', () => {
  it('creates explicitly requested plan.md in the selected project folder', async () => {
    action = (ctx) => {
      expect(ctx.contract.requestedOutputs).toContain('plan.md');
      writeFileSync(join(ctx.cwd, 'plan.md'), '# Harness plan\n');
      return { filesChanged: ['plan.md'] };
    };
    const run = await engine.createRun({
      goal: 'Research the harness and create a plan.md with the architecture.',
      projectPath: project,
      stages: [spec('execute')],
      templateId: 'offline'
    });
    expect(run.requestedOutputs).toEqual(['plan.md']);
    const state = await finish(run);
    expect(state.status).toBe('done');
    expect(state.publishedOutputs).toEqual([join(project, 'plan.md')]);
    expect(state.publicationIssues).toEqual([]);
    expect(readFileSync(join(project, 'plan.md'), 'utf8')).toBe('# Harness plan\n');
    expect(existsSync(join(project, '.tawny-orch'))).toBe(false);
    expect(calls[0].cwd).toBe(project);
    expect(state.stages[0].artifacts.find((artifact) => artifact.name === 'workspace_mode')?.path).toBe('selected-project');
    expect(await runReport(state)).toContain(`- ${join(project, 'plan.md')}`);
  });

  it('execute, test and review share uncommitted implementation on the current HEAD, not main', async () => {
    git(project, ['checkout', '-b', 'feature/current']);
    writeFileSync(join(project, 'feature.txt'), 'current checkout only');
    git(project, ['add', '.']);
    git(project, ['commit', '-m', 'Current feature']);
    const base = git(project, ['rev-parse', 'HEAD']).trim();
    action = (ctx) => {
      expect(existsSync(join(ctx.cwd, 'feature.txt'))).toBe(true);
      if (ctx.contract.role === 'execute') {
        writeFileSync(join(ctx.cwd, 'implementation.txt'), 'implemented\n');
        return { filesChanged: ['implementation.txt'] };
      }
      expect(readFileSync(join(ctx.cwd, 'implementation.txt'), 'utf8')).toBe('implemented\n');
      expect(ctx.contract.verifiedHandoffs.length).toBeGreaterThan(0);
      expect(ctx.contract.verifiedHandoffs[0]).toContain('"ground_truth"');
      if (ctx.contract.role === 'test') {
        writeFileSync(join(ctx.cwd, 'test.txt'), 'verified implementation');
        return { filesChanged: ['test.txt'] };
      }
      expect(existsSync(join(ctx.cwd, 'test.txt'))).toBe(true);
      return {};
    };
    const state = await finish(await create([
      spec('execute'), spec('test', { allowedFiles: ['test.txt'] }), spec('review')
    ]));
    expect(state.status).toBe('done');
    expect(new Set(calls.map((ctx) => ctx.cwd)).size).toBe(1);
    expect(calls[0].cwd).toBe(project);
    expect(calls.every((ctx) => ctx.contract.baseBranch === base)).toBe(true);
    expect(readFileSync(join(project, 'implementation.txt'), 'utf8')).toBe('implemented\n');
    expect((await packet(state, 1)).ground_truth.files_changed).toEqual(['implementation.txt', 'test.txt']);
    expect((await packet(state, 1)).ground_truth.stage_files_changed).toEqual(['test.txt']);
    expect(state.stages[2].gates.find((gate) => gate.gate === 'read_only')?.result).toBe('pass');
  });

  it('requires a Git repository for verified direct execute stages', async () => {
    rmSync(join(project, '.git'), { recursive: true, force: true });
    const run = await create([spec('execute')]);
    await expect(engine.startRun(run.id)).rejects.toThrow('Git project so Tawny can verify direct workspace changes');
    expect(calls).toHaveLength(0);
  });

  it('reuses the same verified workspace on retry, preserving the first attempt and evidence', async () => {
    let attempts = 0;
    action = (ctx) => {
      attempts += 1;
      if (attempts === 1) {
        writeFileSync(join(ctx.cwd, 'implementation.txt'), 'partial\n');
        return { status: 'failed', summary: 'Partial work; tests pass', filesChanged: ['implementation.txt'] };
      }
      expect(readFileSync(join(ctx.cwd, 'implementation.txt'), 'utf8')).toBe('partial\n');
      writeFileSync(join(ctx.cwd, 'implementation.txt'), 'complete\n');
      return { filesChanged: ['implementation.txt'] };
    };
    const state = await finish(await create([spec('execute', { retries: 1 })]));
    expect(state.status).toBe('done');
    expect(calls[0].cwd).toBe(calls[1].cwd);
    expect(state.stages[0].artifacts.filter((artifact) => artifact.name.startsWith('packet_attempt:'))).toHaveLength(2);
    const report = await runReport(state);
    expect(report).toContain('Earlier attempt 1');
    expect(report).toContain('agent_status: fail');
    expect(report).toContain('no engine acceptance command verified');
  });
});

describe('real-git read-only and scope evidence', () => {
  it('detects a plan agent editing an already-dirty file and halts without trusting its completion', async () => {
    writeFileSync(join(project, 'implementation.txt'), 'user dirty work\n');
    action = (ctx) => {
      writeFileSync(join(ctx.cwd, 'implementation.txt'), 'agent overwrote dirty work\n');
      return { summary: 'Completed without changes.' };
    };
    const state = await finish(await create([spec('plan', { retries: 2 }), spec('execute')]));
    expect(state.status).toBe('escalated');
    expect(calls).toHaveLength(1);
    expect(state.stages[0].gates.find((gate) => gate.gate === 'read_only')?.result).toBe('fail');
    expect((await packet(state)).ground_truth.stage_files_changed).toEqual(['implementation.txt']);
    expect(state.stages[1].status).toBe('queued');
  });

  it.each(['staged', 'untracked', 'deleted', 'commit', 'index-only', 'branch-only'] as const)('detects %s changes using git facts', (kind) => {
    const before = workspaceFacts(project);
    if (kind === 'branch-only') git(project, ['checkout', '-b', 'unexpected-branch']);
    else if (kind === 'deleted') rmSync(join(project, 'implementation.txt'));
    else if (kind === 'untracked') writeFileSync(join(project, 'new file.txt'), 'new');
    else {
      writeFileSync(join(project, 'implementation.txt'), 'new\n');
      git(project, ['add', 'implementation.txt']);
      if (kind === 'commit') git(project, ['commit', '-m', 'Unexpected read-only commit']);
      if (kind === 'index-only') writeFileSync(join(project, 'implementation.txt'), 'base\n');
    }
    expect(readOnlyGate(before, workspaceFacts(project)).result).toBe('fail');
  });

  it('sees unstaged, staged and untracked files, retains spaces, and throws on an invalid base', () => {
    writeFileSync(join(project, 'implementation.txt'), 'modified\n');
    writeFileSync(join(project, 'staged file.txt'), 'staged');
    git(project, ['add', 'staged file.txt']);
    writeFileSync(join(project, 'untracked file.txt'), 'untracked');
    expect(changedFilesSince(project, 'HEAD')).toEqual(['implementation.txt', 'staged file.txt', 'untracked file.txt']);
    expect(() => changedFilesSince(project, 'missing-base')).toThrow();
    expect(globMatches('src/deep/nested/auth.ts', 'src/**')).toBe(true);
    expect(globMatches('src/deep/nested/auth.ts', 'src/**/*.ts')).toBe(true);
  });

  it('checks scope after acceptance commands create files', async () => {
    const command = 'node -e "require(\'fs\').writeFileSync(\'forbidden.txt\',\'gate wrote\')"';
    const state = await finish(await create([spec('execute', { allowedFiles: ['implementation.txt'], acceptanceCommands: [command] })]));
    expect(state.stages[0].gates.find((gate) => gate.gate === 'scope')?.result).toBe('fail');
    expect((await packet(state)).ground_truth.files_changed).toContain('forbidden.txt');
  });

  it('detects index-only secret content even when working-tree bytes have been restored', async () => {
    action = (ctx) => {
      writeFileSync(join(ctx.cwd, 'implementation.txt'), 'AKIAIOSFODNN7EXAMPLE\n');
      git(ctx.cwd, ['add', 'implementation.txt']);
      writeFileSync(join(ctx.cwd, 'implementation.txt'), 'base\n');
      return { filesChanged: ['implementation.txt'] };
    };
    const state = await finish(await create([spec('execute')]));
    expect(state.stages[0].gates.some((gate) => gate.gate === 'secret_scan' && gate.result === 'fail')).toBe(true);
    expect((await packet(state)).ground_truth.stage_files_changed).toContain('implementation.txt');
    expect((await packet(state)).ground_truth.files_changed).toContain('implementation.txt');
  });

  it('verifies read-only after acceptance commands, not just after agent execution', async () => {
    const command = 'node -e "require(\'fs\').writeFileSync(\'implementation.txt\',\'gate wrote\')"';
    const state = await finish(await create([spec('plan', { acceptanceCommands: [command] })]));
    expect(state.stages[0].gates.find((gate) => gate.gate === 'read_only')?.result).toBe('fail');
  });
});

describe('verified handoff, contradictions and reporting', () => {
  it('records failed acceptance and fabricated file claims without reporting a successful test run', async () => {
    action = (ctx) => {
      writeFileSync(join(ctx.cwd, 'implementation.txt'), 'changed\n');
      return { summary: 'All tests pass', filesChanged: ['fabricated.txt'] };
    };
    const state = await finish(await create([spec('execute', { acceptanceCommands: ['node -e "console.error(\'real failure\'); process.exit(3)"'] })]));
    const evidence = await packet(state);
    expect(state.status).toBe('escalated');
    expect(evidence.agent_report?.filesChanged).toEqual(['fabricated.txt']);
    expect(evidence.ground_truth.files_changed).toEqual(['implementation.txt']);
    expect(evidence.ground_truth.contradictions.join('\n')).toContain('engine acceptance command failed');
    expect(evidence.ground_truth.contradictions.join('\n')).toContain('without observed stage changes');
    expect(evidence.ground_truth.contradictions.join('\n')).toContain('omitted from self-report');
    const report = readFileSync(join(runDir(root, state.id), 'final-summary.md'), 'utf8');
    expect(report).toContain('Status: escalated');
    expect(report).toContain('acceptance: fail');
    expect(report).toContain('real failure');
    expect(report).toContain('not measured; not assumed free');
  });

  it('redacts structured self-report secrets before packets, persisted state, reports and memory', async () => {
    const secret = `sk-proj-${'a'.repeat(32)}`;
    action = () => ({ summary: `Found credential ${secret}`, assumptions: [`API_TOKEN="${'b'.repeat(30)}"`] });
    const state = await finish(await create([spec('plan')]));
    expect(state.status).toBe('escalated');
    const json = state.stages[0].artifacts.find((artifact) => artifact.name === 'verified_packet')!.path;
    const markdown = state.stages[0].artifacts.find((artifact) => artifact.name === 'verified_packet_md')!.path;
    for (const path of [json, markdown, join(runDir(root, state.id), 'state.json'), join(runDir(root, state.id), 'final-summary.md')]) {
      const text = readFileSync(path, 'utf8');
      expect(text).not.toContain(secret);
      expect(text).not.toContain('b'.repeat(30));
    }
    expect(existsSync(memoryFilePath(project, root))).toBe(true); // Failure memory also remains redacted.
    expect(readFileSync(memoryFilePath(project, root), 'utf8')).not.toContain(secret);
  });

  it('scans actual file content even if agent output hides the secret', async () => {
    action = (ctx) => {
      writeFileSync(join(ctx.cwd, 'implementation.txt'), `AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n`);
      return { filesChanged: ['implementation.txt'] };
    };
    const state = await finish(await create([spec('execute')]));
    expect(state.stages[0].gates.some((gate) => gate.gate === 'secret_scan' && gate.result === 'fail')).toBe(true);
  });

  it('does not treat valid strict JSON with failed status or a nonzero exit as success', async () => {
    engine = new OrchestratorEngine({ userDataDir: root, onRunUpdate() {}, adapterFor: () => ({
      id: 'fake-local', name: 'Failure fixture', tier: 'B',
      async start(ctx) { return { key: 'failure', ctx, extras: {} }; },
      async collect(handle) {
        writeFileSync(handle.ctx.contract.strictOutput!.path, JSON.stringify(completed({ status: 'failed' })));
        return { result: completed(), stdoutSummary: '', stderrTail: ['crashed'], exitCode: 9, timedOut: false };
      }, async cancel() {}
    }) });
    const state = await finish(await create([spec('execute')]));
    expect(state.status).toBe('escalated');
    expect(state.stages[0].gates.find((gate) => gate.gate === 'agent_exit')?.result).toBe('error');
    expect(state.stages[0].gates.find((gate) => gate.gate === 'agent_status')?.result).toBe('fail');
    expect((await packet(state)).agent_report?.status).toBe('failed');
  });

  it('detects tampering with persisted packet evidence instead of trusting it in the report', async () => {
    const state = await finish(await create([spec('plan')]));
    const artifact = state.stages[0].artifacts.find((item) => item.name === 'verified_packet')!;
    const tampered = await packet(state);
    tampered.ground_truth.stage_files_changed = ['fabricated-success.txt'];
    writeFileSync(artifact.path, JSON.stringify(tampered));
    expect(await runReport(state)).toContain('Verified packet: unavailable');
    expect(await runReport(state)).not.toContain('fabricated-success.txt');
  });

  it('redacts PEM bodies, bearer tokens, URL credentials, JSON credentials and long values before truncation', () => {
    const text = '-----BEGIN PRIVATE KEY-----\nbody-of-private-key\n-----END PRIVATE KEY-----\nBearer bearer-value\nhttps://alice:password@example.test\n{"api_key":"json-secret-value"}';
    const safe = redactSecrets(text);
    for (const value of ['body-of-private-key', 'bearer-value', 'alice:password', 'json-secret-value']) expect(safe).not.toContain(value);
    const long = safeData({ summary: `-----BEGIN PRIVATE KEY-----\n${'x'.repeat(9000)}\n-----END PRIVATE KEY-----` });
    expect(long.summary).not.toContain('xxxxx');
  });
});

describe('manual verification and conservative recovery', () => {
  it('manual completion submits evidence to gates instead of bypassing a read-only violation', async () => {
    engine = new OrchestratorEngine({ userDataDir: root, onRunUpdate() {}, adapterFor: () => makePacketAdapter({ id: 'fake-local', name: 'Offline human', tier: 'C', pollMs: 10 }) });
    const run = await create([spec('plan')]);
    const driving = engine.startRun(run.id);
    const inbox = join(runDir(root, run.id), 'packets', `${run.id}-plan.md`);
    await waitFor(() => existsSync(inbox));
    writeFileSync(join(project, 'implementation.txt'), 'manual forbidden edit\n');
    await engine.escalateStage({ runId: run.id, stageId: 'plan', manualComplete: true, manualSummary: 'I am done.' });
    await driving;
    const state = (await engine.loadRunById(run.id))!;
    expect(state.status).toBe('escalated');
    expect(state.stages[0].gates.find((gate) => gate.gate === 'read_only')?.result).toBe('fail');
    expect((await packet(state)).agent_report?.summary).toBe('I am done.');
  });

  it('preserves interrupted workspace and attempt count; only explicit reassignment resumes it', async () => {
    const run = await create([spec('execute')]);
    const target = worktreeDirectory(root, project, run.id, 'execute');
    expect(target).toContain(join(root, 'orchestrator', 'worktrees'));
    const branch = branchName(run.branchPrefix, run.id, 'execute');
    const base = git(project, ['rev-parse', 'HEAD']).trim();
    git(project, ['worktree', 'add', '-b', branch, target, base]);
    writeFileSync(join(target, 'implementation.txt'), 'interrupted implementation\n');
    run.status = 'running';
    run.stages[0].status = 'running';
    run.stages[0].attempt = 2;
    run.stages[0].artifacts = [{ name: 'worktree', path: target }, { name: 'branch', path: branch }, { name: 'base_commit', path: base }];
    await saveRun(root, run);
    await engine.startRun(run.id);
    const recovered = (await engine.loadRunById(run.id))!;
    expect(recovered.status).toBe('escalated');
    expect(recovered.stages[0].attempt).toBe(2);
    expect(calls).toHaveLength(0);
    action = (ctx) => {
      expect(ctx.cwd).toBe(target);
      expect(readFileSync(join(ctx.cwd, 'implementation.txt'), 'utf8')).toBe('interrupted implementation\n');
      return {};
    };
    await engine.escalateStage({ runId: run.id, stageId: 'execute', reassignAgentId: 'fake-local' });
    await waitFor(async () => (await engine.loadRunById(run.id))?.status === 'done');
    await waitFor(() => readFileSync(join(runDir(root, run.id), 'final-summary.md'), 'utf8').includes('Status: done'));
    expect(calls).toHaveLength(1);
  });
});

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Offline fixture did not reach expected state.');
}
