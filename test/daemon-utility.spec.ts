import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { build } from 'vite';
import { saveRun } from '../src/main/orchestrator/store';
import type { RunSnapshot } from '../src/shared/contracts';

// Opt in after `pnpm build`: this launches real Electron but never creates a BrowserWindow.
describe.skipIf(process.env.TAWNY_DAEMON_UTILITY_TEST !== '1')('real Electron utility daemon', () => {
  it('recovers interrupted/pending state, sends events/logs, and shuts down a manual agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tawny-daemon-'));
    const project = join(root, 'project');
    await mkdir(project);
    const fixture = (id: string, status: RunSnapshot['status']): RunSnapshot => ({
      id, status, projectPath: project, projectName: 'project', goal: 'Plan a local change', templateId: 'manual',
      branchPrefix: 'test', createdAt: new Date().toISOString(), stages: [{
        spec: { id: 'plan', title: 'Plan', role: 'plan', agentId: 'manual', acceptanceCommands: [], allowedFiles: [], forbiddenFiles: [], retries: 0 },
        status: status === 'running' ? 'running' : status === 'done' ? 'passed' : 'queued',
        agentId: 'manual', attempt: 1, summary: '', failureReason: '', gates: [], artifacts: []
      }]
    });
    for (const status of ['pending', 'running', 'cancelled', 'done', 'escalated'] as const) await saveRun(root, fixture(`run-${status}`, status));
    const report = join(root, 'report.json');
    const entry = resolve('out/main/daemon.js');
    const runner = join(root, 'smoke.cjs');
    // Bundle the public client too, exercising the real production transport and its chunk-safe entry path.
    await build({
      configFile: false, logLevel: 'silent',
      ssr: { noExternal: true, external: ['electron'] },
      build: {
        ssr: resolve('src/main/daemon/client.ts'), outDir: join(root, 'client'), emptyOutDir: true,
        rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'client.cjs', inlineDynamicImports: true } }
      }
    });
    await writeFile(runner, `
const { app } = require('electron');
const { writeFileSync } = require('node:fs');
const { createDaemonClient } = require(${JSON.stringify(join(root, 'client', 'client.cjs'))});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const notifications = [];
const errors = [];
const client = createDaemonClient({
  userDataDir: ${JSON.stringify(root)}, entryPath: ${JSON.stringify(entry)},
  onRunUpdate: params => notifications.push({ method: 'run.update', params }),
  onEvent: params => notifications.push({ method: 'orch.event', params }),
  onLog: params => notifications.push({ method: 'log.entry', params }),
  onError: error => errors.push(error.message)
});
const deadline = setTimeout(() => { void client.stop().finally(() => app.exit(2)); }, 25000);
app.whenReady().then(async () => {
  await client.start();
  let runs;
  for (let n = 0; n < 150; n++) {
    runs = await client.listRuns();
    const packetReady = notifications.some(event => event.method === 'log.entry' && event.params.event === 'packet.written' && event.params.runId === 'run-pending');
    if (runs.find(run => run.id === 'run-pending').stages[0].status === 'running' && packetReady) break;
    await wait(100);
  }
  const interrupted = await client.loadRunById('run-running');
  await client.updateBudget();
  const afterBudgetUpdate = await client.loadRunById('run-pending');
  await client.stop();
  writeFileSync(${JSON.stringify(report)}, JSON.stringify({ runs, interrupted, afterBudgetUpdate, notifications, errors }));
  clearTimeout(deadline);
  app.exit(0);
}).catch(async error => { console.error(error); await client.stop().catch(() => {}); app.exit(1); });
`, 'utf8');
    try {
      const require = createRequire(import.meta.url);
      const electron = require('electron') as string;
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      await new Promise<void>((resolveRun, reject) => {
        execFile(electron, [runner], { env, timeout: 35_000, windowsHide: true }, (error, stdout, stderr) => {
          if (error) reject(new Error(`${error.message}\n${stdout}\n${stderr}`)); else resolveRun();
        });
      });
      const result = JSON.parse(await readFile(report, 'utf8'));
      expect(result.errors).toEqual([]);
      expect(result.interrupted.status).toBe('escalated');
      expect(result.interrupted.stages[0].failureReason).toContain('Interrupted attempt preserved');
      const pending = result.runs.find((run: RunSnapshot) => run.id === 'run-pending');
      expect(pending.stages[0].status).toBe('running');
      // Preparation may still publish baseline artifacts; policy refresh must preserve the attempt lifecycle.
      expect(result.afterBudgetUpdate).toMatchObject({
        id: pending.id, status: 'running',
        stages: [{ status: 'running', attempt: pending.stages[0].attempt, agentId: 'manual' }]
      });
      for (const status of ['done', 'cancelled', 'escalated']) {
        expect(result.runs.find((run: RunSnapshot) => run.id === `run-${status}`).status).toBe(status);
      }
      expect(result.notifications.some((event: { method: string }) => event.method === 'run.update')).toBe(true);
      expect(result.notifications.some((event: { method: string }) => event.method === 'orch.event')).toBe(true);
      expect(result.notifications.some((event: { method: string }) => event.method === 'log.entry')).toBe(true);
      expect(JSON.parse(await readFile(join(root, 'orchestrator', 'runs', 'run-pending', 'state.json'), 'utf8')).status).toBe('cancelled');
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 40_000);
});
