import { join } from 'node:path';
import { budgetConfigSchema, type BudgetConfig, type OrchEvent, type PipelineLog, type RunSnapshot } from '../../shared/contracts';
import {
  DaemonRpcError, PROTOCOL_VERSION, decode, encode, errorMessage, isNotification,
  notificationSchema, notificationSchemas, responseSchema, resultSchemas,
  type Method, type NotificationMethod, type NotificationParams, type Params, type Request, type Result, type Transport
} from './protocol';

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; method: Method };
export interface DaemonClientOptions {
  userDataDir?: string;
  entryPath?: string;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  budget?: BudgetConfig;
  /** Read the current non-secret budget for recovery, dispatch-capable RPCs, and updateBudget(). */
  budgetFor?: () => BudgetConfig | undefined | Promise<BudgetConfig | undefined>;
  onRunUpdate?: (run: RunSnapshot) => void;
  onEvent?: (event: OrchEvent) => void;
  onLog?: (entry: PipelineLog) => void;
  onError?: (error: Error) => void;
  /** Test seam; production uses utilityProcess.fork, never a network socket. */
  transportFactory?: () => Transport | Promise<Transport>;
}

export function createDaemonClient(options: DaemonClientOptions = {}) {
  let transport: Transport | undefined;
  let nextId = 0;
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let configured = false;
  let disconnected = false;
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  let detach: (() => void)[] = [];
  const pending = new Map<number, Pending>();
  const listeners = new Map<NotificationMethod, Set<(value: never) => void>>();
  const errorListeners = new Set<(error: Error) => void>();
  if (options.onError) errorListeners.add(options.onError);

  function report(error: Error): void {
    for (const listener of errorListeners) { try { listener(error); } catch { /* subscriber isolation */ } }
  }
  function subscribe<M extends NotificationMethod>(method: M, listener: (value: NotificationParams<M>) => void): () => void {
    let group = listeners.get(method);
    if (!group) { group = new Set(); listeners.set(method, group); }
    group.add(listener as (value: never) => void);
    return () => { group!.delete(listener as (value: never) => void); };
  }
  if (options.onRunUpdate) subscribe('run.update', options.onRunUpdate);
  if (options.onEvent) subscribe('orch.event', options.onEvent);
  if (options.onLog) subscribe('log.entry', options.onLog);

  function failPending(error: Error): void {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  }
  function disconnect(error: Error): void {
    if (disconnected) return;
    disconnected = true;
    configured = false;
    readyReject?.(error);
    failPending(error);
    if (!stopping) report(error);
  }
  function receive(wire: unknown): void {
    if (disconnected) return;
    try {
      const value = decode(wire);
      const response = responseSchema.safeParse(value);
      if (response.success) {
        const message = response.data;
        if (message.id === null) { report(new Error('Daemon rejected an invalid RPC envelope')); return; }
        const entry = pending.get(message.id);
        if (!entry) return; // Late replies to timed-out calls must not resolve a newer request.
        clearTimeout(entry.timer);
        pending.delete(message.id);
        if ('error' in message) entry.reject(new DaemonRpcError(message.error.code, message.error.message));
        else {
          const result = resultSchemas[entry.method].safeParse(message.result);
          if (result.success) entry.resolve(result.data);
          else entry.reject(new Error(`Invalid daemon result for ${entry.method}: ${result.error.message}`));
        }
        return;
      }
      const notification = notificationSchema.parse(value);
      if (!isNotification(notification.method)) throw new Error(`Unknown daemon notification: ${notification.method}`);
      const data = notificationSchemas[notification.method].parse(notification.params);
      if (notification.method === 'daemon.ready') readyResolve?.();
      if (notification.method === 'daemon.error') {
        const failure = notificationSchemas['daemon.error'].parse(data);
        report(new Error(`${failure.runId ? `${failure.runId}: ` : ''}${failure.message}`));
      }
      for (const listener of listeners.get(notification.method) ?? []) {
        try { listener(data as never); } catch (error) { report(new Error(`Daemon subscriber failed: ${errorMessage(error)}`)); }
      }
    } catch (error) {
      disconnect(new Error(`Invalid daemon message: ${errorMessage(error)}`));
    }
  }
  function request<M extends Method>(method: M, params: Params<M>, timeoutMs = options.requestTimeoutMs ?? 30_000): Promise<Result<M>> {
    if (!transport || disconnected) return Promise.reject(new Error('Daemon is not connected'));
    const id = ++nextId;
    return new Promise<Result<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Daemon ${method} timed out after ${timeoutMs}ms; the operation may still complete`));
      }, timeoutMs);
      pending.set(id, { method, resolve: (value) => resolve(value as Result<M>), reject, timer });
      try { transport!.send(encode({ jsonrpc: '2.0', id, method, params } as Request)); }
      catch (error) { disconnect(new Error(`Daemon send failed: ${errorMessage(error)}`)); }
    });
  }
  async function currentBudget(): Promise<BudgetConfig> {
    // Removing a policy must reset to free-only, not retain a previously configured paid policy.
    return (options.budgetFor ? await options.budgetFor() : options.budget) ?? budgetConfigSchema.parse({});
  }

  function start(): Promise<void> {
    if (stopping) return Promise.reject(new Error('Daemon is stopping'));
    if (starting) return starting;
    if (configured && !disconnected) return Promise.resolve();
    if (disconnected && transport) return Promise.reject(new Error('Daemon disconnected; call stop() before restarting'));
    starting = (async () => {
      disconnected = false;
      const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      const timer = setTimeout(() => readyReject?.(new Error('Daemon startup timed out')), options.startupTimeoutMs ?? 15_000);
      // Attach a handler before awaiting the asynchronous transport factory.
      void ready.catch(() => undefined);
      try {
        let userDataDir = options.userDataDir;
        if (options.transportFactory) transport = await options.transportFactory();
        else {
          const { app } = await import('electron');
          await app.whenReady();
          userDataDir ??= app.getPath('userData');
          const { forkDaemonTransport } = await import('./transport');
          // Resolve from the app root, not __dirname: Vite may place the transport in a shared chunk.
          transport = forkDaemonTransport(options.entryPath ?? join(app.getAppPath(), 'out', 'main', 'daemon.js'));
        }
        detach = [transport.onMessage(receive), transport.onClose(disconnect)];
        await ready;
        if (!userDataDir) throw new Error('userDataDir is required with a custom transport');
        await request('configure', { userDataDir, protocolVersion: PROTOCOL_VERSION, budget: await currentBudget() });
        if (disconnected) throw new Error('Daemon disconnected during startup');
        configured = true;
      } catch (error) {
        disconnect(error instanceof Error ? error : new Error(String(error)));
        try { await transport?.terminate(); } finally { detach.forEach((off) => off()); detach = []; transport = undefined; }
        throw error;
      } finally { clearTimeout(timer); readyResolve = undefined; readyReject = undefined; }
    })().finally(() => { starting = undefined; });
    return starting;
  }
  async function call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
    await start();
    if (stopping) throw new Error('Daemon is stopping');
    return request(method, params);
  }
  function stop(): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      try {
        await starting?.catch(() => undefined);
        failPending(new Error('Daemon is stopping'));
        if (transport && !disconnected) await request('shutdown', {}, options.shutdownTimeoutMs ?? 10_000);
      } finally {
        try { await transport?.terminate(); }
        finally {
          disconnect(new Error('Daemon stopped'));
          detach.forEach((off) => off()); detach = []; transport = undefined; configured = false;
        }
      }
    })().finally(() => { stopping = undefined; });
    return stopping;
  }

  return {
    start, stop,
    updateBudget: async (): Promise<void> => { await call('updateBudget', { budget: await currentBudget() }); },
    runsRootDir: () => {
      if (!options.userDataDir) throw new Error('Pass userDataDir to use synchronous runsRootDir()');
      return join(options.userDataDir, 'orchestrator', 'runs');
    },
    createRun: async (input: Params<'createRun'>['input']): Promise<RunSnapshot> => call('createRun', { input, budget: await currentBudget() }),
    listRuns: (): Promise<RunSnapshot[]> => call('listRuns', {}),
    loadRunById: (runId: string): Promise<RunSnapshot | null> => call('loadRunById', { runId }),
    startRun: async (runId: string): Promise<void> => { await call('startRun', { runId, budget: await currentBudget() }); },
    cancelRun: async (runId: string): Promise<void> => { await call('cancelRun', { runId }); },
    escalateStage: async (input: Params<'escalateStage'>['input']): Promise<RunSnapshot | null> => call('escalateStage', { input, budget: await currentBudget() }),
    onRunUpdate: (listener: (run: RunSnapshot) => void) => subscribe('run.update', listener),
    onEvent: (listener: (event: OrchEvent) => void) => subscribe('orch.event', listener),
    onLog: (listener: (entry: PipelineLog) => void) => subscribe('log.entry', listener),
    onError: (listener: (error: Error) => void) => { errorListeners.add(listener); return () => { errorListeners.delete(listener); }; }
  };
}
export type DaemonClient = ReturnType<typeof createDaemonClient>;
