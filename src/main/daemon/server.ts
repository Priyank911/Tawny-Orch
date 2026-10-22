import type { RunSnapshot } from '../../shared/contracts';
import type { EngineDeps, OrchestratorEngine } from '../orchestrator/engine';
import {
  DaemonRpcError, PROTOCOL_VERSION, decode, encode, errorMessage, isMethod, paramsSchemas, requestSchema,
  type Method, type Notification, type NotificationMethod, type NotificationParams, type Params, type Response
} from './protocol';

export type DaemonEngine = Pick<OrchestratorEngine,
  'createRun' | 'listRuns' | 'loadRunById' | 'startRun' | 'cancelRun' | 'escalateStage'> & {
    stopAgents?(): Promise<void>;
  };
export type DaemonEngineDeps = EngineDeps;
export interface ServerOptions {
  send(message: string): void;
  createEngine(deps: DaemonEngineDeps): DaemonEngine;
  onShutdown?(): void;
}

/** One engine per process. No network listener, renderer dependency, or credential store access. */
export function createDaemonServer(options: ServerOptions) {
  let engine: DaemonEngine | undefined;
  let configuring = false;
  let ready = false;
  let closing = false;
  let shutdown: Promise<void> | undefined;
  const drivers = new Map<string, Promise<void>>();
  const active = new Set<string>();
  const operations = new Set<Promise<unknown>>();
  const ids = new Set<number>();

  function notify<M extends NotificationMethod>(method: M, params: NotificationParams<M>): void {
    try { options.send(encode({ jsonrpc: '2.0', method, params } as Notification)); } catch { /* parent disconnected */ }
  }
  function report(error: unknown, runId?: string): void {
    notify('daemon.error', { message: errorMessage(error), runId });
  }
  function runUpdate(run: RunSnapshot): void {
    if (run.status === 'running') active.add(run.id);
    // Keep IDs until drivers have drained: cancellation during preparation must not miss a handle.
    notify('run.update', run);
  }
  function launch(runId: string): void {
    if (!engine || closing || drivers.has(runId)) return;
    active.add(runId);
    const task = Promise.resolve().then(() => engine!.startRun(runId))
      .catch((error) => report(error, runId))
      .finally(() => { drivers.delete(runId); active.delete(runId); });
    drivers.set(runId, task);
  }
  async function stop(): Promise<void> {
    if (shutdown) return shutdown;
    closing = true;
    shutdown = (async () => {
      // Cancel first to unblock long-lived collectors; drain short RPC mutations before a second sweep.
      const cancelActive = async () => {
        if (!engine) return;
        const runs = await engine.listRuns();
        const targets = new Set([...active, ...drivers.keys(), ...runs.filter((run) => run.status === 'running').map((run) => run.id)]);
        await Promise.all([...targets].map(async (id) => {
          const run = await engine!.loadRunById(id);
          if (run && !['done', 'cancelled', 'escalated', 'failed'].includes(run.status)) await engine!.cancelRun(id);
          // Terminal/escalated state is preserved. stopAgents handles any lingering collectors.
        }));
      };
      await Promise.all([cancelActive(), engine?.stopAgents?.()]);
      await Promise.allSettled([...operations]);
      await cancelActive();
      await Promise.allSettled([...drivers.values()]);
    })();
    return shutdown;
  }

  async function dispatch<M extends Method>(method: M, raw: unknown): Promise<unknown> {
    const parsed = paramsSchemas[method].safeParse(raw);
    if (!parsed.success) throw new DaemonRpcError(-32602, `Invalid params for ${method}: ${parsed.error.message}`);
    const params = parsed.data;
    if (method === 'shutdown') { await stop(); return null; }
    if (closing) throw new DaemonRpcError(-32001, 'Daemon is stopping');
    if (method === 'configure') {
      if (configuring || engine) throw new DaemonRpcError(-32002, 'Daemon is already configured');
      configuring = true;
      const config = params as Params<'configure'>;
      engine = options.createEngine({ userDataDir: config.userDataDir, onRunUpdate: runUpdate });
      const runs = await engine.listRuns();
      const recoverable = runs.filter((run) => run.status === 'pending' || run.status === 'running');
      // Engine.startRun preserves interrupted attempts as escalated; it never repeats them.
      for (const run of recoverable.filter((candidate) => candidate.status === 'running')) {
        if (closing) break;
        const interrupted = run.stages.some((stage) => ['running', 'gated', 'routed', 'contract_ready', 'retrying'].includes(stage.status));
        if (interrupted) {
          active.add(run.id);
          try { await engine.startRun(run.id); } finally { active.delete(run.id); }
        } else launch(run.id);
      }
      for (const run of recoverable.filter((candidate) => candidate.status === 'pending')) launch(run.id);
      ready = true;
      return { protocolVersion: PROTOCOL_VERSION, recoveredRunIds: recoverable.map((run) => run.id) };
    }
    if (!engine || !ready) throw new DaemonRpcError(-32003, 'Daemon is not configured');
    switch (method) {
      // Kept as a protocol compatibility no-op for clients from earlier builds.
      case 'updateBudget': return null;
      case 'createRun': return engine.createRun((params as Params<'createRun'>).input);
      case 'listRuns': return engine.listRuns();
      case 'loadRunById': return engine.loadRunById((params as Params<'loadRunById'>).runId);
      case 'startRun': {
        const { runId } = params as Params<'startRun'>;
        const run = await engine.loadRunById(runId);
        if (!run) throw new DaemonRpcError(-32004, `Unknown run: ${runId}`);
        if (run.status === 'pending' || run.status === 'running') launch(runId);
        return null;
      }
      case 'cancelRun': await engine.cancelRun((params as Params<'cancelRun'>).runId); return null;
      case 'escalateStage': {
        const { input } = params as Params<'escalateStage'>;
        active.add(input.runId);
        try { return await engine.escalateStage(input); }
        finally {
          // Escalation can start an engine-owned background driver. Retain the ID until shutdown.
          if ((await engine.loadRunById(input.runId))?.status !== 'running') active.delete(input.runId);
        }
      }
    }
  }

  async function receive(wire: unknown): Promise<void> {
    let value: unknown;
    try { value = decode(wire); } catch { options.send(encode({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })); return; }
    const request = requestSchema.safeParse(value);
    if (!request.success) { options.send(encode({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } })); return; }
    const { id, method, params } = request.data;
    let response: Response;
    if (ids.has(id)) {
      options.send(encode({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Duplicate request ID' } }));
      return;
    }
    ids.add(id);
    try {
      if (!isMethod(method)) throw new DaemonRpcError(-32601, `Method not found: ${method}`);
      // Do not track shutdown itself: stop() drains the other RPCs.
      const operation = dispatch(method, params);
      if (method !== 'shutdown') operations.add(operation);
      let result: unknown;
      try { result = await operation; } finally { operations.delete(operation); }
      response = { jsonrpc: '2.0', id, result };
    } catch (error) {
      response = { jsonrpc: '2.0', id, error: { code: error instanceof DaemonRpcError ? error.code : -32603, message: errorMessage(error) } };
    } finally { ids.delete(id); }
    options.send(encode(response));
    if (method === 'shutdown') options.onShutdown?.();
  }
  return { receive, stop, notify };
}
