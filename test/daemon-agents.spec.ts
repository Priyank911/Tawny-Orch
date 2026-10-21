import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/main/logger', () => ({ logPipeline: vi.fn() }));
import { manageDaemonAgents } from '../src/main/daemon/agents';
import { aborterFor, releaseAborter } from '../src/main/agents/headless';
import type { AdapterContext, AdapterHandle, AgentAdapter } from '../src/main/agents/base';
import type { ArtifactBundle, TaskContract } from '../src/shared/contracts';

const bundle: ArtifactBundle = { stdoutSummary: '', stderrTail: [], exitCode: null, timedOut: false, result: null };
const context = (runId: string): AdapterContext => ({ contract: { runId, stageId: 'plan' } as TaskContract, cwd: '.', workdir: '.' });
const handleFor = (ctx: AdapterContext): AdapterHandle => ({ key: ctx.contract.runId, ctx, extras: {} });

describe('daemon-owned agent lifetimes', () => {
  it('cancels and drains a collector independent of who started its engine driver', async () => {
    const ctx = context('managed-active'); const handle = handleFor(ctx);
    let complete!: (bundle: ArtifactBundle) => void;
    const collection = new Promise<ArtifactBundle>((resolve) => { complete = resolve; });
    const adapter: AgentAdapter = {
      id: 'manual', name: 'Manual', tier: 'C', start: vi.fn(async () => handle),
      collect: vi.fn(() => collection), cancel: vi.fn(async () => { complete(bundle); })
    };
    const managed = manageDaemonAgents((id) => id === 'manual' ? adapter : undefined);
    expect(managed.adapterFor('unknown')).toBeUndefined();
    const wrapper = managed.adapterFor('manual')!;
    expect(managed.adapterFor('manual')).toBe(wrapper);
    await wrapper.start(ctx); const collected = wrapper.collect(handle);
    await Promise.all([managed.stop(), managed.stop()]);
    expect(await collected).toEqual(bundle);
    expect(adapter.cancel).toHaveBeenCalledOnce();
    await expect(wrapper.start(ctx)).rejects.toThrow('stopping');
    releaseAborter(ctx.contract);
  });

  it('cancels a handle that finishes startup after shutdown begins', async () => {
    const ctx = context('managed-startup'); const handle = handleFor(ctx);
    let started!: (handle: AdapterHandle) => void;
    const adapter: AgentAdapter = {
      id: 'manual', name: 'Manual', tier: 'C',
      start: vi.fn(() => new Promise<AdapterHandle>((resolve) => { started = resolve; })),
      collect: vi.fn(async () => bundle), cancel: vi.fn(async () => undefined)
    };
    const managed = manageDaemonAgents(() => adapter);
    const starting = expect(managed.adapterFor('manual')!.start(ctx)).rejects.toThrow('stopped during agent startup');
    const stopping = managed.stop(); started(handle);
    await Promise.all([starting, stopping]);
    expect(adapter.cancel).toHaveBeenCalledWith(handle);
    expect(adapter.collect).not.toHaveBeenCalled();
    releaseAborter(ctx.contract);
  });

  it('aborts the contract even if vendor cancellation throws, then reports the failure', async () => {
    const ctx = context('managed-cancel-error'); const handle = handleFor(ctx);
    const signal = aborterFor(ctx.contract).signal;
    const adapter: AgentAdapter = {
      id: 'cli', name: 'CLI', tier: 'A', start: vi.fn(async () => handle),
      collect: vi.fn(() => new Promise<ArtifactBundle>((resolve) => { signal.addEventListener('abort', () => resolve(bundle), { once: true }); })),
      cancel: vi.fn(async () => { throw new Error('vendor cancel failed'); })
    };
    const managed = manageDaemonAgents(() => adapter); const wrapper = managed.adapterFor('cli')!;
    await wrapper.start(ctx); const collected = wrapper.collect(handle);
    await expect(managed.stop()).rejects.toThrow('vendor cancel failed');
    expect(signal.aborted).toBe(true); await collected;
    releaseAborter(ctx.contract);
  });
});
