import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createDaemonClient } from '../src/main/daemon/client';
import { createDaemonServer } from '../src/main/daemon/server';
import { encode, PROTOCOL_VERSION, type Transport } from '../src/main/daemon/protocol';
import type { AdapterContext, AgentAdapter } from '../src/main/agents/base';
import { OrchestratorEngine } from '../src/main/orchestrator/engine';
import { cachedAgents } from '../src/main/detect/agents';
import { agentResultsSchema, agentStatusSchema, budgetConfigSchema, stageSpecSchema, type ArtifactBundle } from '../src/shared/contracts';

vi.mock('../src/main/detect/agents', () => ({ cachedAgents: vi.fn(), detectAgents: vi.fn() }));
vi.mock('../src/main/logger', () => ({ logPipeline: vi.fn() }));

// Real engine/router/store behind the JSON-RPC client, with a controlled offline adapter.
describe('daemon budget refresh between stage attempts', () => {
  it.each(['revoke confirmation', 'remove entitlement'] as const)('%s affects the next stage, not the in-flight attempt', async (change) => {
    const root = await mkdtemp(join(tmpdir(), 'tawny-daemon-budget-'));
    const project = join(root, 'project');
    await mkdir(project);
    let budget = budgetConfigSchema.parse({ entitlements: { 'claude-code': { kind: 'free', userConfirmed: true } } });
    vi.mocked(cachedAgents).mockReturnValue([agentStatusSchema.parse({
      id: 'claude-code', label: 'Offline Claude fixture', tier: 'B', family: 'anthropic',
      detected: true, roles: ['plan'], costClass: 0, latencyClass: 0
    })]);
    let release!: (bundle: ArtifactBundle) => void;
    const collection = new Promise<ArtifactBundle>((resolve) => { release = resolve; });
    const contexts: AdapterContext[] = [];
    const adapter: AgentAdapter = {
      id: 'claude-code', name: 'Offline fixture', tier: 'B',
      start: vi.fn(async (ctx) => { contexts.push(ctx); return { key: ctx.contract.stageId, ctx, extras: {} }; }),
      collect: vi.fn(() => collection),
      cancel: vi.fn(async () => { release({ result: null, stdoutSummary: '', stderrTail: [], exitCode: null, timedOut: false }); })
    };
    const listeners = new Set<(wire: unknown) => void>();
    const server = createDaemonServer({
      send: (wire) => { for (const listener of listeners) listener(wire); },
      createEngine: (deps) => new OrchestratorEngine({ ...deps, adapterFor: () => adapter })
    });
    const transport: Transport = {
      send: (wire) => { void server.receive(wire); },
      onMessage: (listener) => {
        listeners.add(listener);
        queueMicrotask(() => listener(encode({ jsonrpc: '2.0', method: 'daemon.ready', params: { protocolVersion: PROTOCOL_VERSION } })));
        return () => { listeners.delete(listener); };
      },
      onClose: () => () => undefined,
      terminate: async () => undefined
    };
    const errors: Error[] = [];
    const client = createDaemonClient({
      userDataDir: root, transportFactory: () => transport, budgetFor: () => budget,
      onError: (error) => errors.push(error), shutdownTimeoutMs: 5_000
    });
    try {
      const run = await client.createRun({
        goal: 'Complete two offline read-only planning stages', projectPath: project, templateId: 'budget-refresh',
        stages: ['first', 'second'].map((id) => stageSpecSchema.parse({
          id, title: id, role: 'plan', agentId: 'claude-code', retries: 0
        }))
      });
      await client.startRun(run.id);
      await vi.waitFor(() => expect(adapter.collect).toHaveBeenCalledOnce(), { timeout: 10_000 });
      const originalContract = structuredClone(contexts[0].contract);
      const firstHandle = vi.mocked(adapter.collect).mock.calls[0][0];
      budget = budgetConfigSchema.parse(change === 'remove entitlement'
        ? {}
        : { entitlements: { 'claude-code': { kind: 'free', userConfirmed: false } } });
      await client.updateBudget();
      expect(adapter.cancel).not.toHaveBeenCalled();
      expect(adapter.start).toHaveBeenCalledOnce();
      expect(firstHandle.ctx.contract).toEqual(originalContract);
      const active = await client.loadRunById(run.id);
      expect(active?.status).toBe('running');
      expect(active?.stages[0].status).toBe('running');
      expect(active?.stages[1].status).toBe('queued');

      release({
        result: agentResultsSchema.parse({ status: 'completed', summary: 'First planning attempt completed normally.' }),
        stdoutSummary: 'First planning attempt completed normally.', stderrTail: [], exitCode: 0, timedOut: false
      });
      await vi.waitFor(async () => expect((await client.loadRunById(run.id))?.status).toBe('escalated'), { timeout: 10_000 });
      const finished = await client.loadRunById(run.id);
      expect(finished?.stages[0].status, JSON.stringify({ run: finished, errors: errors.map((error) => error.message) })).toBe('passed');
      expect(contexts.map((ctx) => ctx.contract.stageId)).toEqual(['first']);
      expect(adapter.cancel).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(errors.some((error) => error.message.includes('selected agent is unavailable'))).toBe(true));
    } finally {
      release({ result: null, stdoutSummary: '', stderrTail: [], exitCode: null, timedOut: false });
      try { await client.stop(); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  }, 25_000);
});
