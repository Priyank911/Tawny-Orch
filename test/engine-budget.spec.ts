import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AdapterContext } from '../src/main/agents/base';
import { cachedAgents, detectAgents } from '../src/main/detect/agents';
import { OrchestratorEngine } from '../src/main/orchestrator/engine';
import {
  agentResultsSchema, agentStatusSchema, budgetConfigSchema, stageSpecSchema,
  type AgentStatus, type BudgetConfig
} from '../src/shared/contracts';

// Keep the real engine/router and disk-backed lifecycle, without probing or
// dispatching any installed CLI. Adapter injection must not bypass budgetFor.
vi.mock('../src/main/detect/agents', () => ({
  cachedAgents: vi.fn(),
  detectAgents: vi.fn()
}));

let root: string;
let project: string;
let engine: OrchestratorEngine;
let budget: BudgetConfig | undefined;
let calls: AdapterContext[];
let budgetFor: ReturnType<typeof vi.fn<() => BudgetConfig | undefined>>;
let adapterFor: ReturnType<typeof vi.fn<(agentId: string) => AgentAdapter | undefined>>;

const free = { kind: 'free', userConfirmed: true } as const;
const paid = { kind: 'paid', userConfirmed: true, maxCostUsd: 0.25 } as const;

function status(id: string, overrides: Partial<AgentStatus> = {}): AgentStatus {
  return agentStatusSchema.parse({
    id, label: id, tier: 'B', family: 'other', detected: true,
    roles: ['plan'], costClass: 0, latencyClass: 0, ...overrides
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'tawny-engine-budget-'));
  project = join(root, 'project');
  mkdirSync(project);
  calls = [];
  budget = budgetConfigSchema.parse({});
  vi.mocked(cachedAgents).mockReturnValue([
    status('claude-code', { family: 'anthropic' }),
    status('unknown-agent'),
    status('manual', { family: 'human' })
  ]);
  vi.mocked(detectAgents).mockRejectedValue(new Error('Unexpected live detection'));
  const adapter: AgentAdapter = {
    id: 'offline-fixture', name: 'Offline routing fixture', tier: 'B',
    async start(ctx) {
      calls.push(ctx);
      return { key: ctx.contract.stageId, ctx, extras: {} };
    },
    async collect() {
      return {
        result: agentResultsSchema.parse({ status: 'completed', summary: 'Offline plan completed.' }),
        stdoutSummary: 'Offline plan completed.', stderrTail: [], exitCode: 0, timedOut: false
      };
    },
    async cancel() {}
  };
  budgetFor = vi.fn(() => budget);
  adapterFor = vi.fn(() => adapter);
  engine = new OrchestratorEngine({ userDataDir: root, onRunUpdate() {}, budgetFor, adapterFor });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function create(agentId: string | null) {
  return engine.createRun({
    goal: 'Prepare an offline plan within the configured budget',
    projectPath: project, templateId: 'budget-fixture',
    stages: [stageSpecSchema.parse({ id: 'plan', title: 'Plan', role: 'plan', agentId, retries: 0 })]
  });
}

async function expectBlocked(agentId: string | null) {
  const run = await create(agentId);
  await expect(engine.startRun(run.id)).rejects.toMatchObject({ cls: 'input', stage: 'dispatch' });
  expect(budgetFor).toHaveBeenCalledOnce();
  expect(adapterFor).not.toHaveBeenCalled();
  expect(calls).toHaveLength(0);
  expect((await engine.loadRunById(run.id))?.status).toBe('escalated');
  expect(detectAgents).not.toHaveBeenCalled();
}

async function expectCompleted(pin: string | null, expectedAgentId: string) {
  const run = await create(pin);
  await engine.startRun(run.id);
  expect(budgetFor).toHaveBeenCalledOnce();
  expect(adapterFor).toHaveBeenCalledExactlyOnceWith(expectedAgentId);
  expect(calls.map((ctx) => ctx.contract.agentId)).toEqual([expectedAgentId]);
  const persisted = await engine.loadRunById(run.id);
  expect(persisted?.status).toBe('done');
  expect(persisted?.stages[0].agentId).toBe(expectedAgentId);
  expect(persisted?.stages[0].status).toBe('passed');
  expect(detectAgents).not.toHaveBeenCalled();
}

describe('EngineDeps.budgetFor routing integration', () => {
  it.each(['claude-code', 'unknown-agent'])('blocks the ineligible %s pin rather than dispatching or substituting manual', async (id) => {
    budget = budgetConfigSchema.parse({ maxUsd: 100, entitlements: { 'claude-code': paid } });
    await expectBlocked(id);
  });

  it.each(['claude-code', 'unknown-agent'])('uses free-only defaults when budgetFor returns undefined for a %s pin', async (id) => {
    budget = undefined;
    await expectBlocked(id);
  });

  it('blocks an unpinned run when only paid and unknown agents are available', async () => {
    vi.mocked(cachedAgents).mockReturnValue([
      status('claude-code', { family: 'anthropic' }), status('unknown-agent')
    ]);
    budget = budgetConfigSchema.parse({ entitlements: { 'claude-code': paid } });
    await expectBlocked(null);
  });

  it('allows the detected human manual pin with no external entitlement', async () => {
    await expectCompleted('manual', 'manual');
  });

  it('selects eligible manual for an unpinned run instead of paid or unknown agents', async () => {
    budget = budgetConfigSchema.parse({ entitlements: { 'claude-code': paid } });
    await expectCompleted(null, 'manual');
  });

  it('does not synthesize manual availability when the detected manual slot is ineligible', async () => {
    vi.mocked(cachedAgents).mockReturnValue([status('manual', { family: 'human', detected: false })]);
    await expectBlocked('manual');
  });

  it('reads the current budget at routing time and permits a newly confirmed free pin', async () => {
    const run = await create('claude-code');
    expect(budgetFor).not.toHaveBeenCalled();
    budget = budgetConfigSchema.parse({ entitlements: { 'claude-code': free } });
    await engine.startRun(run.id);
    expect(budgetFor).toHaveBeenCalledOnce();
    expect(adapterFor).toHaveBeenCalledExactlyOnceWith('claude-code');
    expect(calls.map((ctx) => ctx.contract.agentId)).toEqual(['claude-code']);
    expect((await engine.loadRunById(run.id))?.status).toBe('done');
  });
});
