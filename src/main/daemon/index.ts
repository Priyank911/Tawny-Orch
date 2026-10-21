import { OrchestratorEngine } from '../orchestrator/engine';
import { getAdapter } from '../agents';
import { manageDaemonAgents } from './agents';
import { setEventSink } from '../orchestrator/events';
import { setLogSink } from '../logger';
import { PROTOCOL_VERSION, errorMessage } from './protocol';
import { createDaemonServer } from './server';

const port = process.parentPort;
if (!port) throw new Error('The orchestrator daemon must be launched with Electron utilityProcess.fork');
const parentPid = Number(process.argv[2]);
if (!Number.isSafeInteger(parentPid) || parentPid <= 0) throw new Error('Missing daemon parent PID');
let exiting = false;
const server = createDaemonServer({
  send: (message) => port.postMessage(message),
  createEngine: (deps) => {
    const agents = manageDaemonAgents(getAdapter);
    return Object.assign(new OrchestratorEngine({ ...deps, adapterFor: agents.adapterFor }), { stopAgents: agents.stop });
  },
  onShutdown: () => {
    exiting = true;
    clearInterval(watchdog);
    // Allow the shutdown acknowledgement to be delivered before closing the channel.
    setImmediate(() => process.exit(0));
  }
});
setEventSink((event) => server.notify('orch.event', event));
// The shell owns log persistence. The daemon's event ledger is still written by the engine.
setLogSink(undefined, (entry) => server.notify('log.entry', entry));
port.on('message', (event) => {
  void server.receive(event.data).catch((error) => {
    server.notify('daemon.error', { message: errorMessage(error) });
    void shutdown(1);
  });
});

async function shutdown(code: number): Promise<void> {
  if (exiting) return;
  exiting = true;
  clearInterval(watchdog);
  // Bound shutdown even if an adapter never settles; the shell also has a process-tree fallback.
  const deadline = setTimeout(() => process.exit(1), 10_000);
  try { await server.stop(); } catch (error) { server.notify('daemon.error', { message: errorMessage(error) }); }
  finally { clearTimeout(deadline); process.exit(code); }
}
const watchdog = setInterval(() => {
  try { process.kill(parentPid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') void shutdown(0);
  }
}, 1_000);
process.on('SIGTERM', () => { void shutdown(0); });
process.on('SIGINT', () => { void shutdown(0); });
process.on('uncaughtException', (error) => {
  server.notify('daemon.error', { message: errorMessage(error) });
  void shutdown(1);
});
process.on('unhandledRejection', (error) => {
  server.notify('daemon.error', { message: errorMessage(error) });
  void shutdown(1);
});
server.notify('daemon.ready', { protocolVersion: PROTOCOL_VERSION });
