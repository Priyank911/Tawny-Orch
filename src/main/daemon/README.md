# Week 1: local Electron utility daemon

This is a local Node orchestration process hosted by Electron's
`utilityProcess.fork`, not a renderer worker. It has no `BrowserWindow`, HTTP
listener, WebSocket, authentication token, SQLite dependency, or Tauri runtime.
It still depends on Electron as its process host. Persistence remains the
existing JSON run files and JSONL event ledger.

## Current shell integration

`app.ts` now imports `createDaemonClient` from `./daemon/client` instead of
constructing an in-process engine. It loads settings and awaits `engine.start()`
on app readiness before registering IPC and opening the window. Its current
callback configuration is equivalent to:

```ts
const engine = createDaemonClient({
  userDataDir: app.getPath('userData'),
  budgetFor: () => ({
    ...settings.budget, policy: 'free-only', maxUsd: 0, spentUsd: 0,
    entitlements: settings.budget?.entitlements ?? {}
  }),
  onRunUpdate: updateSnapshotForRun,
  onEvent: (event) => mainWindow?.webContents.send('orch:event', event),
  onLog: (entry) => mainWindow?.webContents.send('pipeline:log', entry),
  onError: (error) => logPipeline({
    event: 'daemon.error', level: 'error', message: error.message
  })
});
await engine.start();
```

`start()` waits for `app.whenReady()` in production, the child's ready handshake,
configuration, and interrupted-run preservation. It schedules pending recovery
without waiting for those runs to finish. API methods also start lazily, but
explicit startup at shell boot is needed for recovery without user interaction.
Only one client/process should own a given user-data directory; this step does
not introduce a cross-process store lock.

Public signature:

- `createDaemonClient(options?: DaemonClientOptions): DaemonClient`
- `start(): Promise<void>` / `stop(): Promise<void>` (both idempotent while in flight)
- `updateBudget(): Promise<void>` — rereads `budgetFor` and updates the daemon's
  routing policy without cancelling or modifying an in-flight attempt.
- `createRun(input): Promise<RunSnapshot>`
- `listRuns(): Promise<RunSnapshot[]>`
- `loadRunById(runId): Promise<RunSnapshot | null>`
- `startRun(runId): Promise<void>` — **scheduling acknowledgement**, not run
  completion. Background failures go to `onError`; completion goes to updates.
- `cancelRun(runId): Promise<void>`
- `escalateStage(input): Promise<RunSnapshot | null>`
- `runsRootDir(): string` (requires explicit `userDataDir`)
- `onRunUpdate(listener)`, `onEvent(listener)`, `onLog(listener)`,
  `onError(listener)` — each returns an unsubscribe function. The first three
  also have corresponding optional constructor callbacks.

Run/escalation input types match the engine. No credentials are transmitted;
`budgetFor` returns only `BudgetConfig`, not the settings object. The callback
is reread at recovery startup, every create/start/escalation request, and every
`updateBudget()` call. After saving settings and replacing the shell's settings
snapshot, the parent should `await engine.updateBudget()` so later stages of an
already-running pipeline use the new policy, including revoked entitlements.
The acknowledgement means the new policy is installed for subsequent routing
checks; attempts that already passed routing continue unchanged. Missing budget
resets to the shared free-only budget. Budget settings are process-wide (the
same app settings policy), not per-project mutable overrides.

**Engine integration is installed:** the daemon passes
`budgetFor: () => BudgetConfig` into the optional `EngineDeps.budgetFor` callback.
The engine reads that callback in `routeStage` and applies policy checks to both
automatic and pinned selections. The shell currently forces free-only policy,
zero paid budget, and the settings' confirmed entitlements.

Keep main's settings/credentials, detection UI, recent logs, IPC, preload, and
renderer in the shell. The child's existing `emitEvent` writes the event ledger;
forward events to the renderer without appending them again. The child forwards
structured logs but does not configure a log file sink. The current shell
`onLog` callback forwards entries directly to the renderer, so daemon entries do
not populate the shell's `getRecentLogs()` buffer or log file and are lost from
that view after renderer reload. To retain them, the shell must also ingest
forwarded entries into its logger, without emitting duplicate renderer events.
`onLog` receives the original child timestamp.

## Quit and failures

The shell's `before-quit` handler now prevents the first quit, waits for
`engine.stop()`, and quits again using a `daemonStopped` guard. Closing/reloading
a renderer does not stop the daemon. Callers must handle a rejected `stop()`
promise as well as resume quitting; the current handler's `finally` resumes quit
but does not catch that rejection.

Shutdown refuses new mutations, cancels active runs, cancels and drains tracked
adapter handles (including engine-internal escalation drivers), drains in-flight
RPC operations and scheduled drivers, then acknowledges and exits. Done,
cancelled, failed, and already-escalated persisted runs are not restarted at
boot. The engine preserves interrupted evidence and marks interrupted attempts
escalated for explicit human action.

Defaults: request timeout 30 seconds, ready timeout 15 seconds, shutdown timeout
10 seconds. All are configurable. A timeout does not undo an operation; inspect
persisted state before retrying a mutation. Transport closure rejects all pending
calls immediately. Invalid protocol messages fail the connection; subscriber
exceptions are isolated. There is no automatic restart/replay after a crash:
call `stop()` to clean up, then explicitly `start()` for recovery. Request IDs
are never reused by the client.

After the graceful deadline, transport termination uses Windows
`taskkill /PID <pid> /T /F`, with `UtilityProcess.kill()` as fallback. On other
platforms adapter cancellation and `UtilityProcess.kill()` are best effort;
there is no OS job object/process-group guarantee for independently detached
vendor subprocesses. The child also watches the shell PID and handles signals
with bounded shutdown. A hard machine/process crash cannot guarantee cleanup;
recovery never silently retries interrupted attempts.

## Build and tests

`electron.vite.config.ts` emits `out/main/index.js` and
`out/main/daemon.js` (plus shared chunks). Package the **entire** `out/main`
directory, not just its two entries. The client resolves the default child entry
from `app.getAppPath()/out/main/daemon.js`; `entryPath` overrides this for custom
packaging layouts.

- `pnpm exec vitest run test/daemon.spec.ts`: fake-transport protocol/lifecycle tests.
- `pnpm build`, then `pnpm exec vitest run test/desktop-bridge.spec.ts`: executes
  the actual `out/preload/preload.js` in a VM with a restricted mocked Electron
  module; checks project config, run creation, escalation mapping, errors, and
  event subscriptions. This verifies the built artifact, so rebuild after any
  preload changes. It does not replace a real renderer/main IPC end-to-end test.
- `pnpm build`, then `TAWNY_DAEMON_UTILITY_TEST=1 pnpm exec vitest run test/daemon-utility.spec.ts`:
  opt-in real Electron child, with no renderer, real file persistence, recovery,
  forwarded events/logs, and manual-adapter shutdown. The environment assignment
  shown is for sh; use the platform's equivalent when running another shell.

The parent change owns the shell integration and engine policy enforcement.
The daemon remains a local Electron-hosted process split, not a standalone
WebSocket daemon or Tauri migration.
