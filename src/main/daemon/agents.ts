import type { AdapterHandle, AgentAdapter } from '../agents/base';
import { aborterFor } from '../agents/headless';

/** Own adapter lifetimes, including drivers started internally by escalateStage(). */
export function manageDaemonAgents(adapterFor: (id: string) => AgentAdapter | undefined) {
  let stopping = false;
  let stopTask: Promise<void> | undefined;
  const starts = new Set<Promise<AdapterHandle>>();
  const handles = new Map<AdapterHandle, { adapter: AgentAdapter; done: Promise<void>; finish(): void }>();
  const adapters = new Map<string, AgentAdapter>();

  async function cancel(adapter: AgentAdapter, handle: AdapterHandle): Promise<void> {
    // Abort even if vendor cancellation fails, matching the engine's cancellation path.
    try { await adapter.cancel(handle); }
    finally { aborterFor(handle.ctx.contract).abort(); }
  }
  function managedAdapterFor(id: string): AgentAdapter | undefined {
    const cached = adapters.get(id);
    if (cached) return cached;
    const adapter = adapterFor(id);
    if (!adapter) return undefined;
    const managed: AgentAdapter = {
      id: adapter.id, name: adapter.name, tier: adapter.tier,
      start(context) {
        if (stopping) return Promise.reject(new Error('Daemon agents are stopping'));
        const task = (async () => {
          const handle = await adapter.start(context);
          if (stopping) {
            await cancel(adapter, handle);
            throw new Error('Daemon stopped during agent startup');
          }
          let finish!: () => void;
          const done = new Promise<void>((resolve) => { finish = resolve; });
          handles.set(handle, { adapter, done, finish });
          return handle;
        })();
        starts.add(task);
        void task.then(() => starts.delete(task), () => starts.delete(task));
        return task;
      },
      async collect(handle) {
        try { return await adapter.collect(handle); }
        finally {
          handles.get(handle)?.finish();
          handles.delete(handle);
        }
      },
      cancel: (handle) => cancel(adapter, handle)
    };
    adapters.set(id, managed);
    return managed;
  }
  function stop(): Promise<void> {
    stopping = true;
    stopTask ??= (async () => {
      await Promise.allSettled([...starts]);
      const active = [...handles.entries()];
      const results = await Promise.allSettled(active.map(([handle, entry]) => cancel(entry.adapter, handle)));
      await Promise.all(active.map(([, entry]) => entry.done));
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    })();
    return stopTask;
  }
  return { adapterFor: managedAdapterFor, stop };
}
