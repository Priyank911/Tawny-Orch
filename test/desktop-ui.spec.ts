import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppSettings, StageSpec } from '../src/shared/contracts';

// Build first. Normal test runs never launch Electron or require a graphical session.
// TAWNY_DESKTOP_UI_TEST=1 npm test -- test/desktop-ui.spec.ts
// Add TAWNY_DESKTOP_UI_SCREENSHOTS=1 to retain screenshots in test-artifacts/desktop-ui/.
const enabled = process.env.TAWNY_DESKTOP_UI_TEST === '1';
const screenshots = process.env.TAWNY_DESKTOP_UI_SCREENSHOTS === '1';
const projectRoot = resolve('.');
const artifacts = resolve('test-artifacts/desktop-ui');
const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
class Cdp {
  private nextId = 0;
  private pending = new Map<number, Pending>();
  readonly exceptions: string[] = [];
  constructor(private socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Runtime.exceptionThrown') this.exceptions.push(JSON.stringify(message.params.exceptionDetails));
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    });
    socket.addEventListener('close', () => this.rejectAll(new Error('Electron CDP connection closed')));
    socket.addEventListener('error', () => this.rejectAll(new Error('Electron CDP connection failed')));
  }
  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }
  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('CDP connection timed out')); }, 4_000);
      socket.addEventListener('open', () => { clearTimeout(timer); done(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not open CDP')); }, { once: true });
    });
    const cdp = new Cdp(socket);
    try {
      await cdp.send('Runtime.enable');
      await cdp.send('Page.enable');
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      return cdp;
    } catch (error) { cdp.close(); throw error; }
  }
  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((done, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, 5_000);
      this.pending.set(id, { resolve: (value) => done(value as T), reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.send<{ result: { value: T }; exceptionDetails?: unknown }>('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true
    });
    if (result.exceptionDetails) throw new Error(`Browser evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    return result.result.value;
  }
  async waitFor(expression: string, label: string, timeoutMs = 5_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (await this.evaluate<boolean>(expression)) return;
      await delay(40);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }
  async key(key: 'Tab' | 'Enter' | 'Escape', shift = false): Promise<void> {
    const keyCode = { Tab: 9, Enter: 13, Escape: 27 }[key];
    const event = { key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: shift ? 8 : 0 };
    await this.send('Input.dispatchKeyEvent', { ...event, type: 'keyDown', ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
    await this.send('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
  }
  async screenshot(name: string): Promise<void> {
    if (!screenshots) return;
    await mkdir(artifacts, { recursive: true });
    const result = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(join(artifacts, `${name}.png`), Buffer.from(result.data, 'base64'));
  }
  close(): void { this.rejectAll(new Error('CDP disposed')); this.socket.close(); }
}

type Desktop = { cdp: Cdp; child: ChildProcess; root: string; output: () => string; stop: () => Promise<void> };
async function killTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>((done) => {
      execFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { timeout: 5_000, windowsHide: true }, () => done());
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

async function launchDesktop(mode: 'real' | 'mock'): Promise<Desktop> {
  for (const name of ['out/main/index.js', 'out/main/daemon.js', 'out/preload/preload.js', 'out/renderer/index.html']) {
    try { await readFile(resolve(name)); }
    catch (error) { throw new Error(`Missing ${name}; run npm run build before opting into desktop UI tests.`, { cause: error }); }
  }
  const root = await mkdtemp(join(tmpdir(), 'tawny-desktop-ui-'));
  const profile = join(root, 'profile');
  const home = join(root, 'home');
  const emptyPath = join(root, 'empty-path');
  for (const directory of [profile, home, emptyPath]) await mkdir(directory, { recursive: true });
  const launcher = join(root, 'launch.cjs');
  // This runtime-only launcher sets isolation before importing the actual production main.
  // The mock shell has no preload: its entire test bridge is injected before renderer scripts via CDP.
  await writeFile(launcher, `
const { app, BrowserWindow, session } = require('electron');
app.setPath('userData', ${JSON.stringify(profile)});
app.setPath('sessionData', ${JSON.stringify(profile)});
app.setAppPath(${JSON.stringify(projectRoot)});
app.commandLine.appendSwitch('disable-background-networking');
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
});
const deadline = setTimeout(() => { app.quit(); setTimeout(() => app.exit(124), 3000); }, 80000);
app.on('will-quit', () => clearTimeout(deadline));
${mode === 'real' ? `require(${JSON.stringify(resolve('out/main/index.js'))});` : `
let mockWindow;
app.whenReady().then(() => {
  mockWindow = new BrowserWindow({ width: 1100, height: 900, show: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  mockWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  void mockWindow.loadURL('about:blank');
});
app.on('window-all-closed', () => app.quit());`}
`, 'utf8');
  const env = { ...process.env, PATH: emptyPath, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home };
  for (const name of Object.keys(env)) {
    if (/API[_]?KEY|TOKEN|SECRET|ELECTRON_RENDERER_URL|ELECTRON_RUN_AS_NODE|NODE_OPTIONS/i.test(name)) delete env[name as keyof typeof env];
  }
  const require = createRequire(import.meta.url);
  const child = spawn(require('electron') as string, [launcher, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`], {
    env, cwd: root, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  let spawnError: Error | undefined;
  child.on('error', (error) => { spawnError = error; });
  child.stdout?.on('data', (chunk) => { output = (output + String(chunk)).slice(-32_000); });
  child.stderr?.on('data', (chunk) => { output = (output + String(chunk)).slice(-32_000); });
  const hardDeadline = setTimeout(() => { void killTree(child); }, 85_000);
  let cdp: Cdp | undefined;
  async function stop(): Promise<void> {
    clearTimeout(hardDeadline);
    if (cdp) {
      try { await cdp.send('Browser.close'); } catch { /* Closing the socket can precede the reply. */ }
      cdp.close();
    }
    const until = Date.now() + 2_000;
    while (child.exitCode === null && Date.now() < until) await delay(50);
    await killTree(child);
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
  try {
    const until = Date.now() + 20_000;
    let target: { webSocketDebuggerUrl: string } | undefined;
    while (Date.now() < until) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Electron exited with ${child.exitCode}`);
      const endpoint = output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (endpoint) {
        const response = await fetch(`http://127.0.0.1:${endpoint[1]}/json/list`, { signal: AbortSignal.timeout(1_000) });
        const targets = await response.json() as { type: string; webSocketDebuggerUrl: string }[];
        target = targets.find((item) => item.type === 'page');
        if (target) break;
      }
      await delay(60);
    }
    if (!target) throw new Error('Electron did not publish a page target in 20 seconds');
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    if (mode === 'mock') {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK_BRIDGE });
      await cdp.send('Page.navigate', { url: pathToFileURL(resolve('out/renderer/index.html')).href });
    }
    await cdp.waitFor(`!!document.querySelector('.nav-tab') && !document.querySelector('.loading-state')`, 'renderer startup', 15_000);
    return { cdp, child, root, output: () => output, stop };
  } catch (error) {
    await stop();
    throw new Error(`Desktop ${mode} startup failed: ${String(error)}\n${output}`);
  }
}

const MOCK_BRIDGE = String.raw`
(() => {
  const clone = value => JSON.parse(JSON.stringify(value));
  const roles = ['research', 'plan', 'execute', 'test', 'review', 'deliver'];
  const stages = roles.map((role, index) => ({ id: role, title: ['Research', 'Plan', 'Build', 'Test', 'Review', 'Deliver'][index],
    role, agentId: null, retries: 0, acceptanceCommands: role === 'test' ? ['npm test'] : [], allowedFiles: [], forbiddenFiles: [] }));
  const project = { name: 'Client invoices', path: 'D:/desktop-ui-fixture/invoices', isGit: true };
  const config = { version: 1, templateId: 'solo', stages };
  const settings = { groqApiKey: '', cloudflareAccountId: 'keep-account', cloudflareApiToken: 'keep-token',
    futureDesktopSetting: { enabled: true, value: 'preserve-unknown' },
    prefs: { hotkey: 'Control+Alt+Space', alwaysRoute: false, wakePhrases: ['hey tawny'] },
    budget: { policy: 'quality-first', maxUsd: 50, spentUsd: 3, entitlements: {
      absent: { kind: 'paid', userConfirmed: true, maxCostUsd: 2 }
    } } };
  const agent = { id: 'fixture-local', label: 'Fixture local terminal', family: 'other', tier: 'C', detected: true,
    health: 'ready', version: 'test-only', installHint: '', roles, costClass: 0, latencyClass: 0 };
  const run = { id: 'fixture-record', goal: 'Recorded fixture only', projectPath: project.path, projectName: project.name,
    templateId: 'solo', branchPrefix: 'test', status: 'done', createdAt: '2026-10-21T10:00:00.000Z',
    stages: stages.map(spec => ({ spec, status: 'passed', agentId: agent.id, attempt: 1, summary: 'Fixture self-report',
      failureReason: '', gates: [{ gate: 'acceptance', result: 'pass', reason: 'Fixture command exited 0', durationMs: 1 }],
      artifacts: [{ name: 'Task packet', path: project.path + '/packet.json' }] })) };
  const state = { creates: [], saved: null, audioCalls: 0, audioBytes: 0, rejectNext: false, errors: [], actions: [] };
  const subscriptions = new Set();
  let created;
  const noop = () => () => {};
  window.addEventListener('unhandledrejection', event => state.errors.push(String(event.reason)));
  window.addEventListener('error', event => state.errors.push(String(event.message)));
  window.__desktopFixture = { state, snapshot: value => subscriptions.forEach(listener => listener({ state: value, elapsedMs: 0, rms: 0 })) };
  window.tawnyOrch = {
    getSnapshot: async () => ({ state: 'idle', elapsedMs: 0, rms: 0 }),
    subscribe: listener => { subscriptions.add(listener); return () => subscriptions.delete(listener); },
    getSettings: async () => clone(settings), saveSettings: async value => { state.saved = clone(value); },
    getAgents: async () => [clone(agent), { ...clone(agent), id: 'manual', family: 'human', label: 'Manual slot' },
      { ...clone(agent), id: 'missing', detected: false, health: 'not_installed', label: 'Not installed' }],
    detectAgents: async () => [], getProject: async () => clone(project), attachProject: async () => clone(project),
    getProjectConfig: async () => clone(config), saveProjectConfig: async () => {},
    getTemplates: async () => [{ id: 'solo', name: 'Fixture delivery', description: 'A local test fixture, not a provider.', stages: clone(stages) }],
    getRuns: async () => clone(created ? [created, run] : [run]), getRun: async () => clone(run),
    createRun: async input => {
      state.creates.push(clone(input));
      await new Promise(done => setTimeout(done, 50));
      if (state.rejectNext) { state.rejectNext = false; throw new Error('Fixture dispatch unavailable'); }
      created = { ...clone(run), id: 'fixture-created', goal: input.goal };
      return clone(created);
    },
    cancelRun: async () => {}, escalateStage: async () => {}, getEvents: async () => [], getLogs: async () => [],
    transcribeAudio: async buffers => { state.audioCalls++; state.audioBytes = buffers.reduce((total, buffer) => total + buffer.length, 0); return 'Fixture transcript'; },
    send: action => state.actions.push(action), logCapture: () => {}, enterBackground: async () => {}, hideWindow: () => {},
    onMode: noop, onRunUpdate: noop, onRunCreated: noop, onProjectUpdate: noop, onVoiceAssign: noop, onEvent: noop, onLog: noop
  };
})();
`;

async function click(cdp: Cdp, text: string): Promise<void> {
  await cdp.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find(element => element.textContent.trim() === ${JSON.stringify(text)});
    if (!button) throw new Error('Missing button: ' + ${JSON.stringify(text)});
    button.click();
  })()`);
}
async function field(cdp: Cdp, id: string, value: string): Promise<void> {
  await cdp.evaluate(`(() => {
    const element = document.getElementById(${JSON.stringify(id)});
    if (!element) throw new Error('Missing field: ' + ${JSON.stringify(id)});
    if (element instanceof HTMLSelectElement) { element.value = ${JSON.stringify(value)}; element.dispatchEvent(new Event('change', { bubbles: true })); }
    else {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, ${JSON.stringify(value)});
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`);
}

// No real-main run/create/voice action is ever invoked. Empty profile + PATH prevents
// recovery or discovery from finding a paid agent; external session traffic is denied.
describe.skipIf(!enabled)('desktop UI: actual production entry points', () => {
  it('boots the built main/preload, isolates Node, and round-trips zero-cost settings without launching a run', async () => {
    const desktop = await launchDesktop('real');
    try {
      const { cdp } = desktop;
      const result = await cdp.evaluate<{
        snapshot: { state: string }; templates: unknown[]; runs: unknown[]; project: unknown;
        requireType: string; processType: string; methods: string[]; agents: { id: string; detected: boolean }[];
      }>(`(async () => ({ snapshot: await window.tawnyOrch.getSnapshot(), templates: await window.tawnyOrch.getTemplates(),
        runs: await window.tawnyOrch.getRuns(), project: await window.tawnyOrch.getProject(),
        agents: await window.tawnyOrch.getAgents(), requireType: typeof window.require, processType: typeof window.process,
        methods: ['getProjectConfig', 'saveProjectConfig', 'createRun', 'saveSettings'].filter(key => typeof window.tawnyOrch[key] === 'function') }))()`);
      expect(result.snapshot.state).toBe('idle');
      expect(result.templates.length).toBeGreaterThan(0);
      expect(result.runs).toEqual([]);
      expect(result.project).toBeNull();
      expect(result.requireType).toBe('undefined');
      expect(result.processType).toBe('undefined');
      expect(result.methods).toHaveLength(4);
      expect(result.agents.filter((agent) => agent.detected).map((agent) => agent.id)).toEqual(['manual']);
      const settings = await cdp.evaluate<{ budget: { policy: string; maxUsd: number }; prefs: { alwaysRoute: boolean } }>(`(async () => {
        const current = await window.tawnyOrch.getSettings();
        await window.tawnyOrch.saveSettings({ ...current, budget: { policy: 'quality-first', maxUsd: 99, spentUsd: 0, entitlements: {} },
          prefs: { ...current.prefs, alwaysRoute: true } });
        return window.tawnyOrch.getSettings();
      })()`);
      expect(settings.budget).toMatchObject({ policy: 'free-only', maxUsd: 0 });
      expect(settings.prefs.alwaysRoute).toBe(true);
      expect(await cdp.evaluate(`window.tawnyOrch.getRuns()`)).toEqual([]);
      const files = JSON.parse(await readFile(join(desktop.root, 'profile', 'preferences.json'), 'utf8'));
      expect(files.budget).toMatchObject({ policy: 'free-only', maxUsd: 0 });
      expect(cdp.exceptions).toEqual([]);
      await cdp.screenshot('real-main-preload');
    } catch (error) { throw new Error(`${String(error)}\n${desktop.output()}`); }
    finally { await desktop.stop(); }
  }, 45_000);
});

describe.skipIf(!enabled)('desktop UI: bounded mocked renderer interactions', () => {
  let desktop: Desktop;
  beforeAll(async () => { desktop = await launchDesktop('mock'); }, 30_000);
  afterAll(async () => { await desktop?.stop(); }, 15_000);
  beforeEach(async () => {
    desktop.cdp.exceptions.length = 0;
    await desktop.cdp.send('Emulation.clearDeviceMetricsOverride');
    await desktop.cdp.send('Page.reload', { ignoreCache: true });
    await desktop.cdp.waitFor(`!!window.__desktopFixture && !!document.querySelector('.nav-tab') && !document.querySelector('.loading-state')`, 'fresh mock renderer');
  }, 10_000);

  it('uses keyboard navigation, labeled controls, visible focus, and button-based run disclosures', async () => {
    const { cdp } = desktop;
    await cdp.evaluate(`document.querySelector('.nav-tab').focus()`);
    expect(await cdp.evaluate(`document.activeElement.getAttribute('aria-current')`)).toBe('page');
    await cdp.key('Tab');
    expect(await cdp.evaluate(`document.activeElement.textContent.trim()`)).toBe('Pipeline');
    expect(await cdp.evaluate(`getComputedStyle(document.activeElement).outlineStyle`)).not.toBe('none');
    await cdp.key('Enter');
    await cdp.waitFor(`document.querySelector('.nav-tab.active').textContent.trim() === 'Pipeline'`, 'keyboard navigation');
    await cdp.key('Tab');
    await cdp.key('Enter');
    await cdp.waitFor(`!!document.querySelector('.run-summary')`, 'runs page');
    expect(await cdp.evaluate(`document.querySelector('.run-summary').tagName`)).toBe('BUTTON');
    await cdp.evaluate(`document.querySelector('.run-summary').focus()`);
    await cdp.key('Enter');
    expect(await cdp.evaluate(`document.querySelector('.run-summary').getAttribute('aria-expanded')`)).toBe('true');
    expect(await cdp.evaluate(`document.querySelector('.run-detail').hidden`)).toBe(false);
    expect(await cdp.evaluate(`document.querySelector('.gate-list').textContent`)).toContain('Fixture command exited 0');
    expect(await cdp.evaluate(`document.querySelector('.artifact-list code').textContent`)).toContain('packet.json');
    await cdp.key('Enter');
    expect(await cdp.evaluate(`document.querySelector('.run-detail').hidden`)).toBe(true);
    await click(cdp, 'Settings');
    await cdp.waitFor(`!!document.querySelector('.settings-form')`, 'settings controls');
    expect(await cdp.evaluate(`Array.from(document.querySelectorAll('input,textarea,select')).every(element => element.labels.length > 0 || element.getAttribute('aria-label'))`)).toBe(true);
    expect(cdp.exceptions).toEqual([]);
  }, 15_000);

  it('saves explicit free/local/off access, forces free-only/$0, and preserves unknown and hidden settings', async () => {
    const { cdp } = desktop;
    await click(cdp, 'Settings');
    await cdp.waitFor(`!!document.querySelector('.entitlement-editor')`, 'entitlements');
    expect(await cdp.evaluate(`document.querySelectorAll('.entitlement-editor').length`)).toBe(1);
    expect(await cdp.evaluate(`Array.from(document.querySelectorAll('.entitlement-editor option')).map(option => option.value)`)).toEqual(['off', 'free', 'local']);
    expect(await cdp.evaluate(`document.getElementById('entitlement-fixture-local').value`)).toBe('off');
    await field(cdp, 'entitlement-fixture-local', 'free');
    await field(cdp, 'requests-fixture-local', '-1');
    expect(await cdp.evaluate(`document.querySelector('.settings-form').checkValidity()`)).toBe(false);
    await click(cdp, 'Save settings');
    expect(await cdp.evaluate(`window.__desktopFixture.state.saved`)).toBeNull();
    // An invalid intermediate number must remain editable rather than throw from schema validation.
    await field(cdp, 'requests-fixture-local', '3');
    await field(cdp, 'expiry-fixture-local', '2030-12-01T14:30');
    await click(cdp, 'Save settings');
    await cdp.waitFor(`window.__desktopFixture.state.saved !== null`, 'settings save');
    const saved = await cdp.evaluate<AppSettings & {
          budget: NonNullable<AppSettings['budget']>; futureDesktopSetting: { enabled: boolean; value: string };
        }>(`window.__desktopFixture.state.saved`);
    expect(saved.budget).toMatchObject({ policy: 'free-only', maxUsd: 0, spentUsd: 3 });
    expect(saved.budget.entitlements['fixture-local']).toMatchObject({ kind: 'free', userConfirmed: true, maxCostUsd: 0, remainingRequests: 3 });
    expect(Number.isFinite(Date.parse(saved.budget.entitlements['fixture-local'].expiresAt ?? ''))).toBe(true);
    expect(saved.budget.entitlements['fixture-local'].authenticated).toBeUndefined();
    expect(saved.budget.entitlements.absent).toEqual({ kind: 'paid', userConfirmed: true, maxCostUsd: 2 });
    expect(saved.futureDesktopSetting).toEqual({ enabled: true, value: 'preserve-unknown' });
    expect(saved.cloudflareAccountId).toBe('keep-account');
    expect(saved.cloudflareApiToken).toBe('keep-token');
    await field(cdp, 'entitlement-fixture-local', 'local');
    await field(cdp, 'requests-fixture-local', '0');
    await click(cdp, 'Save settings');
    await cdp.waitFor(`window.__desktopFixture.state.saved.budget.entitlements['fixture-local'].kind === 'local'`, 'local confirmation');
    expect(await cdp.evaluate(`window.__desktopFixture.state.saved.budget.entitlements['fixture-local'].remainingRequests`)).toBe(0);
    await field(cdp, 'entitlement-fixture-local', 'off');
    await click(cdp, 'Save settings');
    await cdp.waitFor(`window.__desktopFixture.state.saved.budget.entitlements['fixture-local'].userConfirmed === false`, 'revoked confirmation');
    expect(await cdp.evaluate(`window.__desktopFixture.state.saved.budget.entitlements['fixture-local'].kind`)).toBe('unknown');
    expect(await cdp.evaluate(`window.__desktopFixture.state.errors`)).toEqual([]);
    expect(cdp.exceptions).toEqual([]);
    await cdp.screenshot('settings-entitlements');
  }, 15_000);

  it('never dispatches a typed goal until explicit review confirmation, traps focus, and handles rejection', async () => {
    const { cdp } = desktop;
    await field(cdp, 'quick-goal', 'Export client invoices and test CSV totals');
    await cdp.evaluate(`document.querySelector('button[type="submit"]').focus()`);
    await cdp.key('Enter');
    await cdp.waitFor(`!!document.querySelector('dialog[open]')`, 'review modal');
    expect(await cdp.evaluate(`window.__desktopFixture.state.creates.length`)).toBe(0);
    expect(await cdp.evaluate(`document.activeElement.textContent.trim()`)).toBe('Back to goal');
    await cdp.key('Tab');
    expect(await cdp.evaluate(`document.activeElement.textContent.trim()`)).toBe('Confirm & dispatch');
    await cdp.key('Tab', true);
    expect(await cdp.evaluate(`document.activeElement.textContent.trim()`)).toBe('Back to goal');
    await cdp.key('Escape');
    await cdp.waitFor(`!document.querySelector('dialog[open]')`, 'cancelled review');
    expect(await cdp.evaluate(`window.__desktopFixture.state.creates.length`)).toBe(0);
    await click(cdp, 'Review run');
    await cdp.waitFor(`!!document.querySelector('dialog[open]')`, 'second review');
    expect(await cdp.evaluate(`document.querySelector('dialog .free-only-notice').textContent`)).toContain('manual slot');
    await cdp.screenshot('review-before-dispatch');
    await cdp.evaluate(`window.__desktopFixture.state.rejectNext = true`);
    await click(cdp, 'Confirm & dispatch');
    await cdp.waitFor(`document.querySelector('dialog').textContent.includes('Fixture dispatch unavailable')`, 'visible rejection');
    expect(await cdp.evaluate(`document.querySelector('dialog').open`)).toBe(true);
    expect(await cdp.evaluate(`window.__desktopFixture.state.creates.length`)).toBe(1);
    await cdp.evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('dialog button')).find(element => element.textContent.includes('Confirm & dispatch'));
      button.click(); button.click();
    })()`);
    await cdp.waitFor(`document.querySelector('.nav-tab.active').textContent.includes('Runs')`, 'confirmed mock run');
    const inputs = await cdp.evaluate<{ goal: string; projectPath: string; templateId: string; overwriteStages: StageSpec[] }[]>(`window.__desktopFixture.state.creates`);
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toMatchObject({ projectPath: 'D:/desktop-ui-fixture/invoices', goal: 'Export client invoices and test CSV totals', templateId: 'solo' });
    expect(inputs[1].overwriteStages).toHaveLength(6);
    expect(await cdp.evaluate(`window.__desktopFixture.state.errors`)).toEqual([]);
    expect(cdp.exceptions).toEqual([]);
  }, 15_000);

  it('restores keyboard focus to Review run after Escape closes the review', async () => {
    const { cdp } = desktop;
    await field(cdp, 'quick-goal', 'Keep keyboard focus after cancelling review');
    await cdp.evaluate(`document.querySelector('button[type="submit"]').focus()`);
    await cdp.key('Enter');
    await cdp.waitFor(`!!document.querySelector('dialog[open]')`, 'keyboard review');
    await cdp.key('Escape');
    await cdp.waitFor(`!document.querySelector('dialog[open]')`, 'closed review');
    await cdp.screenshot('review-escape-focus');
    expect(await cdp.evaluate(`window.__desktopFixture.state.creates`)).toEqual([]);
    // Keep this as a real regression, not an expected failure: renderer fixes belong to its owner.
    expect(await cdp.evaluate(`document.activeElement === document.querySelector('button[type="submit"]')`)).toBe(true);
  }, 10_000);

  it.each([760, 420])('keeps cockpit, settings, and review inside a %ipx viewport', async (width) => {
    const { cdp } = desktop;
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const page of ['Cockpit', 'Settings']) {
      await click(cdp, page);
      await cdp.waitFor(`document.querySelector('.nav-tab.active').textContent.trim() === ${JSON.stringify(page)}`, page);
      await delay(80);
      const bounds = await cdp.evaluate<{ viewport: number; root: number; main: number; scroll: number }>(`({ viewport: innerWidth,
        root: document.documentElement.scrollWidth, main: document.querySelector('.page-scroll').clientWidth,
        scroll: document.querySelector('.page-scroll').scrollWidth })`);
      expect(bounds.viewport).toBe(width);
      expect(bounds.root).toBeLessThanOrEqual(width);
      expect(bounds.scroll).toBeLessThanOrEqual(bounds.main);
      await cdp.screenshot(`${page.toLowerCase()}-${width}`);
    }
    await click(cdp, 'Cockpit');
    await field(cdp, 'quick-goal', 'Review this responsive local fixture');
    await click(cdp, 'Review run');
    await cdp.waitFor(`!!document.querySelector('dialog[open]')`, 'responsive review');
    const dialog = await cdp.evaluate<{ left: number; right: number; width: number; scroll: number; height: number; bottom: number }>(`(() => {
      const element = document.querySelector('dialog'), rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: element.clientWidth, scroll: element.scrollWidth, height: rect.height, bottom: rect.bottom };
    })()`);
    expect(dialog.left).toBeGreaterThanOrEqual(0);
    expect(dialog.right).toBeLessThanOrEqual(width);
    expect(dialog.scroll).toBeLessThanOrEqual(dialog.width);
    expect(dialog.bottom).toBeLessThanOrEqual(900);
    await cdp.screenshot(`review-${width}`);
    expect(await cdp.evaluate(`window.__desktopFixture.state.creates`)).toEqual([]);
  }, 15_000);

  it('auto-stops capture at 120 seconds, includes final audio, blocks oversized uploads, and cleans up cancellation', async () => {
    const { cdp } = desktop;
    await cdp.evaluate(`(() => {
      const state = window.__desktopFixture.state;
      state.tracksStopped = 0; state.recorderStarts = 0; state.largeAudio = false; state.autoStop = null;
      const originalTimeout = window.setTimeout.bind(window);
      window.setTimeout = (callback, ms, ...args) => {
        if (ms === 120000) { state.autoStop = callback; return originalTimeout(() => {}, ms); }
        return originalTimeout(callback, ms, ...args);
      };
      const stream = () => ({ getTracks: () => [{ stop: () => { state.tracksStopped++; } }] });
      state.fakeStream = stream;
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => stream() } });
      window.MediaRecorder = class {
        static isTypeSupported() { return true; }
        constructor() { this.state = 'inactive'; }
        start(ms) { this.state = 'recording'; state.recorderStarts++; state.timeslice = ms; }
        stop() {
          this.state = 'inactive';
          originalTimeout(() => {
            this.ondataavailable({ data: new Blob([state.largeAudio ? new Uint8Array(25 * 1024 * 1024 + 1) : 'FINAL_AUDIO']) });
            this.onstop();
          }, 10);
        }
      };
      window.__desktopFixture.snapshot('recording');
    })()`);
    await cdp.waitFor(`typeof window.__desktopFixture.state.autoStop === 'function'`, '120-second capture deadline');
    expect(await cdp.evaluate(`window.__desktopFixture.state.timeslice`)).toBe(1_000);
    await cdp.evaluate(`window.__desktopFixture.state.autoStop()`);
    await cdp.waitFor(`window.__desktopFixture.state.audioCalls === 1`, 'final audio transcription');
    expect(await cdp.evaluate(`window.__desktopFixture.state.audioBytes`)).toBe(11);
    expect(await cdp.evaluate(`window.__desktopFixture.state.tracksStopped`)).toBe(1);
    expect(await cdp.evaluate(`window.__desktopFixture.state.actions`)).toContain('STOP');
    await cdp.evaluate(`window.__desktopFixture.snapshot('cancelled')`);
    await delay(30);
    await cdp.evaluate(`window.__desktopFixture.state.largeAudio = true; window.__desktopFixture.snapshot('recording')`);
    await cdp.waitFor(`window.__desktopFixture.state.recorderStarts === 2`, 'oversized capture');
    await cdp.evaluate(`window.__desktopFixture.snapshot('finalizing')`);
    await cdp.waitFor(`!!document.querySelector('.error-notice')`, 'upload limit error');
    expect(await cdp.evaluate(`document.querySelector('.error-notice').textContent`)).toContain('25 MB');
    expect(await cdp.evaluate(`window.__desktopFixture.state.audioCalls`)).toBe(1);
    expect(await cdp.evaluate(`window.__desktopFixture.state.tracksStopped`)).toBe(2);
    await cdp.evaluate(`window.__desktopFixture.snapshot('cancelled')`);
    await delay(30);
    await cdp.evaluate(`navigator.mediaDevices.getUserMedia = () => new Promise(done => { window.__desktopFixture.state.allowMicrophone = done; }); window.__desktopFixture.snapshot('recording')`);
    await cdp.waitFor(`typeof window.__desktopFixture.state.allowMicrophone === 'function'`, 'pending microphone permission');
    await cdp.evaluate(`window.__desktopFixture.snapshot('cancelled')`);
    await delay(30);
    await cdp.evaluate(`window.__desktopFixture.state.allowMicrophone(window.__desktopFixture.state.fakeStream())`);
    await cdp.waitFor(`window.__desktopFixture.state.tracksStopped === 3`, 'late permission cleanup');
    expect(await cdp.evaluate(`window.__desktopFixture.state.recorderStarts`)).toBe(2);
    expect(await cdp.evaluate(`window.__desktopFixture.state.audioCalls`)).toBe(1);
    expect(await cdp.evaluate(`window.__desktopFixture.state.errors`)).toEqual([]);
    expect(cdp.exceptions).toEqual([]);
  }, 15_000);
});
