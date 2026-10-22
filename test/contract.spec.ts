import { describe, expect, it } from 'vitest';
import { buildContract, maxAttemptsFor, ROLE_TIMEOUT_MINUTES } from '../src/main/orchestrator/contract';
import { contractMarkdown, imperativePrompt } from '../src/main/orchestrator/prompts';
import { BASE_TEMPLATES, templateById } from '../src/main/orchestrator/templates';
import type { RunSnapshot, StageRuntime, StageSpec } from '../src/shared/contracts';

function stageSpec(overrides: Partial<StageSpec> = {}): StageSpec {
  return {
    id: 'execute', title: 'Execute', role: 'execute', agentId: null,
    acceptanceCommands: ['pnpm test'], allowedFiles: ['src/**'], forbiddenFiles: ['.env*'], retries: 2,
    ...overrides
  };
}

function runtime(spec: StageSpec, partial: Partial<StageRuntime> = {}): StageRuntime {
  return {
    spec, status: 'queued', agentId: spec.agentId, attempt: 1,
    summary: '', failureReason: '', gates: [], artifacts: [],
    ...partial
  };
}

function run(stages: StageRuntime[]): RunSnapshot {
  return {
    id: 'run-abc',
    goal: 'Add OAuth login',
    projectPath: 'D:/work/app',
    projectName: 'app',
    templateId: 'solo',
    branchPrefix: 'tawny-orch',
    requestedOutputs: [], publishedOutputs: [], publicationIssues: [],
    status: 'pending',
    createdAt: new Date().toISOString(),
    stages
  };
}

describe('pipeline templates', () => {
  it('ships four templates with the six canonical roles', () => {
    expect(BASE_TEMPLATES.length).toBeGreaterThanOrEqual(4);
    for (const template of BASE_TEMPLATES) {
      const roles = template.stages.map((stage) => stage.role);
      for (const role of ['research', 'plan', 'execute', 'test', 'review', 'deliver']) {
        expect(roles).toContain(role);
      }
    }
  });

  it('template lookup is safe', () => {
    expect(templateById('solo')?.stages.length).toBe(6);
    expect(templateById('nope')).toBeUndefined();
  });

  it('test and review stay on a different family than execute in cross-vendor', () => {
    const template = templateById('cross-vendor');
    const executeFamily = 'openai';
    const executor = template?.stages.find((stage) => stage.role === 'execute')?.agentId;
    expect(executor).toBe('codex');
    expect(executeFamily).toBe('openai');
    expect(template?.stages.find((stage) => stage.role === 'test')?.agentId).not.toBe(executor);
    expect(template?.stages.find((stage) => stage.role === 'review')?.agentId).not.toBe(executor);
  });
});

describe('contract builder', () => {
  it('embeds goal prefix, scope, and strict output path', () => {
    const theRun = run([runtime(stageSpec())]);
    const contract = buildContract({
      run: theRun,
      stage: theRun.stages[0],
      attempt: 1,
      runsRootDir: 'C:/userData/orchestrator/runs',
      worktreePath: 'D:/work/app/.tawny-orch/worktrees/run-abc/execute',
      baseBranch: 'main',
      priorDiffs: ['src/auth/oauth.ts'],
      memoryEntries: [],
      previousFailure: undefined
    });
    expect(contract.goal.toLowerCase()).toContain('implement');
    expect(contract.goal).toContain('Add OAuth login');
    expect(contract.worktreePath).toContain('worktrees');
    expect(contract.constraints.allowedFiles).toEqual(['src/**']);
    expect(contract.constraints.acceptanceCommands).toEqual(['pnpm test']);
    expect(contract.strictOutput?.path).toContain('result-execute-1.json');
    expect(contract.diffSoFar).toEqual(['src/auth/oauth.ts']);
    expect(contract.attempts).toEqual({ attempt: 1, maxAttempts: 3 });
  });

  it('role timeouts are sane per stage', () => {
    expect(ROLE_TIMEOUT_MINUTES.execute).toBeGreaterThan(ROLE_TIMEOUT_MINUTES.plan);
    expect(ROLE_TIMEOUT_MINUTES.research).toBeGreaterThan(0);
  });

  it('attempts cap matches retries + 1', () => {
    const stage = runtime(stageSpec({ retries: 2 }));
    expect(maxAttemptsFor(stage)).toBe(3);
  });

  it('composes prior stage summaries into the handoff', () => {
    const stages = [
      runtime(stageSpec({ id: 'research', title: 'Research', role: 'research' }), { status: 'passed', summary: 'GA markdown summary flows here' }),
      runtime(stageSpec({ id: 'plan', title: 'Plan', role: 'plan' }), { status: 'passed', summary: 'Split OAuth provider + routes table' }),
      runtime(stageSpec())
    ];
    const theRun = run(stages);
    const contract = buildContract({
      run: theRun, stage: stages[2], attempt: 1,
      runsRootDir: 'C:/ud/runs', worktreePath: '', baseBranch: 'main',
      priorDiffs: [], memoryEntries: []
    });
    expect(contract.researchSummary).toContain('GA markdown');
    expect(contract.planSummary).toContain('OAuth provider');
  });

  it('index says failure context flows on retries', () => {
    const theRun = run([runtime(stageSpec(), { failureReason: 'acceptance: pnpm test exit 3 — 4 failures' })]);
    const contract = buildContract({
      run: theRun, stage: theRun.stages[0], attempt: 2,
      runsRootDir: 'C:/ud/runs', worktreePath: '', baseBranch: 'main',
      priorDiffs: [], memoryEntries: []
    });
    expect(contract.previousFailure?.gate).toBe('acceptance');
    expect(contract.previousFailure?.reason).toContain('pnpm test');
  });
});

describe('contract markdown', () => {
  it('contains the output contract and memory context', () => {
    const stages = [
      runtime(stageSpec({ id: 'plan', title: 'Plan', role: 'plan' }), { status: 'passed', summary: 'Plan body' }),
      runtime(stageSpec())
    ];
    const theRun = run(stages);
    const contract = buildContract({
      run: theRun, stage: stages[1], attempt: 1,
      runsRootDir: 'C:/ud/runs', worktreePath: '', baseBranch: 'main',
      priorDiffs: [], memoryEntries: [{ id: 'm1', category: 'decisions', content: 'Use pnpm only', sourceRunId: 'run-old', createdAt: new Date().toISOString(), confidence: 0.85 }]
    });

    const markdown = contractMarkdown(contract);
    expect(markdown).toContain('# Task contract');
    expect(markdown).toContain('Add OAuth login');
    expect(markdown).toContain('Use pnpm only');
    expect(markdown).toContain('# Output contract (mandatory)');
    expect(markdown).toContain('result-execute-1.json');
    expect(markdown).toContain('return exactly one JSON object in your final response');
    contract.verifiedHandoffs = ['{"stage":"research","agent_report":{"summary":"Keep the API stable"}}'];
    const handoffMarkdown = contractMarkdown(contract);
    expect(handoffMarkdown).toContain('Keep the API stable');
    expect(handoffMarkdown).toContain('Untrusted reference data');
  });

  it('imperative prompt is small (fits argv budgets)', () => {
    const stages = [runtime(stageSpec())];
    const contract = buildContract({
      run: run(stages), stage: stages[0], attempt: 1,
      runsRootDir: 'C:/ud/runs', worktreePath: '', baseBranch: 'main', priorDiffs: [], memoryEntries: []
    });
    const prompt = imperativePrompt(contract, 'packet');
    expect(prompt.length).toBeLessThan(200);
    expect(prompt).toContain('attach');
  });
});
