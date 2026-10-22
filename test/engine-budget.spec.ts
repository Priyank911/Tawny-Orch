import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AdapterContext } from '../src/main/agents/base';
import { cachedAgents, detectAgents } from '../src/main/detect/agents';
import { OrchestratorEngine } from '../src/main/orchestrator/engine';
import { agentResultsSchema, agentStatusSchema, budgetConfigSchema, stageSpecSchema, type AgentStatus, type BudgetConfig } from '../src/shared/contracts';

// Legacy access settings are preserved for migration, but never gate dispatch.
vi.mock('../src/main/detect/agents', () => ({ cachedAgents: vi.fn(), detectAgents: vi.fn() }));

let root: string;
let project: string;
let engine: OrchestratorEngine;
let calls: AdapterContext[];
let budgetFor: ReturnType<typeof vi.fn<() => BudgetConfig | undefined>>;
let adapterFor: ReturnType<typeof vi.fn<(agentId: string) => AgentAdapter | undefined>>;

function status(id: string, overrides: Partial<AgentStatus> = {}): AgentStatus {
  return agentStatusSchema.parse({ id, label: id, tier: 'B', family: 'other', detected: true,
    roles: ['plan'], costClass: 0, latencyClass: 0, ...overrides });
}

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'tawny-engine-routing-'));
  project = join(root, 'project');
  mkdirSync(project);
  calls = [];
  vi.mocked(cachedAgents).mockReturnValue([
    status('claude-code', { family: 'anthropic' }),
    status('unknown-agent'),
    status('manual', { family: 'human' })
  ]);
  vi.mocked(detectAgents).mockRejectedValue(new Error('Unexpected live detection'));
  const adapter: AgentAdapter = {
    id: 'offline-fixture', name: 'Offline routing fixture', tier: 'B',
    async start(ctx) { calls.push(ctx); return { key: ctx.contract.stageId, ctx, extras: {} }; },
    async collect(handle) {
      const result = agentResultsSchema.parse({ status: 'completed', summary: 'Offline plan completed.' });
      writeFileSync(handle.ctx.contract.strictOutput!.path, JSON.stringify(result));
      return { result, stdoutSummary: result.summary, stderrTail: [], exitCode: 0, timedOut: false };
    },
    async cancel() {}
  };
  budgetFor = vi.fn(() => budgetConfigSchema.parse({ policy: 'free-only' }));
  adapterFor = vi.fn(() => adapter);
  engine = new OrchestratorEngine({ userDataDir: root, onRunUpdate() {}, budgetFor, adapterFor });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

async function create(agentId: string | null) {
  return engine.createRun({ goal: 'Prepare an offline plan', projectPath: project, templateId: 'routing-fixture',
    stages: [stageSpecSchema.parse({ id: 'plan', title: 'Plan', role: 'plan', agentId, retries: 0 })] });
}

describe('dispatch ignores legacy cost confirmations', () => {
  it.each(['claude-code', 'unknown-agent'])('dispatches an explicitly selected compatible %s without consulting budget settings', async (id) => {
    const run = await create(id);
    await engine.startRun(run.id);
    expect(budgetFor).not.toHaveBeenCalled();
    expect(adapterFor).toHaveBeenCalledExactlyOnceWith(id);
    expect(calls.map((ctx) => ctx.contract.agentId)).toEqual([id]);
    const persisted = await engine.loadRunById(run.id);
    expect(persisted?.status).toBe('done');
    expect(persisted?.stages[0].status).toBe('passed');
    expect(detectAgents).not.toHaveBeenCalled();
  }, 15_000);

  it('still rejects a pin that is not currently detected', async () => {
    const run = await create('missing-agent');
    await expect(engine.startRun(run.id)).rejects.toThrow(/not currently detected and ready/);
    expect(adapterFor).not.toHaveBeenCalled();
  });

  it('still rejects a detected tool that does not support the selected stage', async () => {
    vi.mocked(cachedAgents).mockReturnValue([status('cursor-agent', { roles: ['execute'] })]);
    const run = await create('cursor-agent');
    await expect(engine.startRun(run.id)).rejects.toThrow(/does not support the plan role/);
    expect(adapterFor).not.toHaveBeenCalled();
  });
});
