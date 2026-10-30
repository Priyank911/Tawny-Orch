import {
  app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, safeStorage, screen, shell, Tray
} from 'electron';
import { isAbsolute, join, relative } from 'node:path';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createActor } from 'xstate';
import electronUpdater from 'electron-updater';
import { overlayState, pipelineMachine } from './pipeline/machine';
import { parseVoiceCommand } from './pipeline/voice';
import { resolveVoiceProject } from './pipeline/projectResolver';
import { transcribeWithGroq } from './providers/groqWhisper';
import { detectAgents } from './detect/agents';
import { runDir } from './orchestrator/store';
import { BASE_TEMPLATES, templateById } from './orchestrator/templates';
import { saveAttachedProject } from './projectStore';
import { openAgentTerminal } from './agentTerminal';
import { setEventSink } from './orchestrator/events';
import { createDaemonClient } from './daemon/client';
import { appSettingsSchema, stageSpecSchema } from '../shared/contracts';
import { z } from 'zod';
import { getRecentLogs, logsFileName, logPipeline, setLogSink } from './logger';
import { readSettings, saveSettings } from './settings';
import {
  chooseProjectFolder, readAttachedProject, readProjectConfig, saveProjectConfig, resolveRegisteredProject, listRegisteredProjects
} from './projectStore';
import type {
  AgentStatus, AppSettings, AppUpdateState, OrchEvent, OverlaySnapshot, PipelineLog, RunSnapshot, StageSpec
} from '../shared/contracts';
import { checkForReleaseUpdate, RELEASES_URL } from './releaseUpdates';
import { createFirebaseAuthService } from './firebaseAuth';
import type { AuthState } from '../shared/contracts';

declare const __TAWNY_FIREBASE_API_KEY__: string;
declare const __TAWNY_GOOGLE_CLIENT_ID__: string;
declare const __TAWNY_GOOGLE_CLIENT_SECRET__: string;

const { autoUpdater } = electronUpdater;

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let escapingJob = false;
let backgroundMode = false;
let quitting = false;
let lastHotkeyAt = 0;
let machineActor: ReturnType<typeof createActor<typeof pipelineMachine>> = createActor(pipelineMachine);
let snapshot: OverlaySnapshot = { state: 'idle', elapsedMs: 0, rms: 0 };
let settings: AppSettings = {
  groqApiKey: '', cloudflareAccountId: '', cloudflareApiToken: '',
  prefs: { hotkey: 'Control+Alt+Space', alwaysRoute: false, wakePhrases: ['hey tawny', 'hey buddy'] }
};
let updateState: AppUpdateState = { status: 'idle', currentVersion: '', version: '', releaseNotes: '' };
let updateCheck: Promise<AppUpdateState> | undefined;
let notifiedUpdateVersion = '';
let updaterConfigured = false;
let updateInstallCheck: Promise<void> | undefined;
let voiceGeneration = 0;
let currentDecision: ReturnType<typeof parseVoiceCommand>['decision'] | undefined;
let authState: AuthState = { status: 'checking', persistentSession: false };
const auth = createFirebaseAuthService({
  apiKey: __TAWNY_FIREBASE_API_KEY__,
  googleClientId: __TAWNY_GOOGLE_CLIENT_ID__,
  googleClientSecret: __TAWNY_GOOGLE_CLIENT_SECRET__,
  userDataDir: app.getPath('userData'),
  encryptionAvailable: () => safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text',
  encrypt: (value) => safeStorage.encryptString(value),
  decrypt: (value) => safeStorage.decryptString(value),
  openExternal: (url) => shell.openExternal(url),
  onState: (state) => {
    authState = state;
    if (state.status === 'authenticated' && mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    try { mainWindow?.webContents.send('auth:state', state); } catch { /* Window may be closing. */ }
  }
});

function requireAuthenticated(): void {
  if (!auth.isAuthenticated()) throw new Error('Sign in with Google before using workspace features.');
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showShell();
  });
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

const userDataDir = (): string => app.getPath('userData');
const engine = createDaemonClient({
  userDataDir: userDataDir(),
  onRunUpdate: (run) => updateSnapshotForRun(run),
  onEvent: (event) => mainWindow?.webContents.send('orch:event', event),
  onLog: ({ timestamp: _timestamp, ...entry }) => logPipeline(entry),
  onError: (error) => logPipeline({ event: 'daemon.error', message: error.message, level: 'error' })
});

function updateSnapshotForRun(run: RunSnapshot): void {
  if (snapshot.runId && snapshot.runId === run.id) {
    const active = run.stages.find((stage) => stage.status === 'running' || stage.status === 'retrying');
    const index = active ? run.stages.indexOf(active) : -1;
    snapshot = {
      ...snapshot,
      message: `${run.projectName} · ${stageOrOverallText(run)}`,
      runStageIndex: index >= 0 ? index + 1 : snapshot.runStageIndex,
      runStageTotal: run.stages.length,
      runStageTitle: active?.spec.title
    };
  }
  pushSnapshot();
  try {
    mainWindow?.webContents.send('run:update', run);
  } catch {
    /* window gone */
  }
  if (updateState.status === 'downloaded') scheduleWindowsUpdateInstall();
}

function stageOrOverallText(run: RunSnapshot): string {
  const active = run.stages.find((stage) => stage.status === 'running' || stage.status === 'retrying');
  if (active) return `${active.spec.title}: ${active.status} (attempt ${active.attempt}) → ${active.agentId}`;
  const escalated = run.stages.find((stage) => stage.status === 'escalated');
  if (escalated) return `${escalated.spec.title} needs your decision`;
  return run.status;
}

function pushSnapshot(): void {
  try {
    mainWindow?.webContents.send('overlay:update', snapshot);
  } catch {
    /* window gone */
  }
}

function publishUpdateState(next: AppUpdateState): void {
  updateState = next;
  try { mainWindow?.webContents.send('updates:state', next); } catch { /* Window may be closing. */ }
}

async function notifyAboutUpdate(state: AppUpdateState): Promise<void> {
  if (state.status !== 'available' || !state.version || !state.releaseUrl ||
      (mainWindow?.isVisible() ?? false) || !Notification.isSupported()) return;
  const notificationPath = join(userDataDir(), 'update-notified.json');
  try {
    const saved = JSON.parse(await readFile(notificationPath, 'utf8')) as { version?: unknown };
    if (saved.version === state.version) return;
  } catch { /* No prior notification record. */ }
  const notification = new Notification({
    title: `Tawny Orch ${state.version} is ready`,
    body: 'Open the profile menu in Tawny and choose Download update.'
  });
  notification.on('click', () => showShell());
  notification.show();
  notifiedUpdateVersion = state.version;
  try { await writeFile(notificationPath, JSON.stringify({ version: state.version }), 'utf8'); }
  catch (error) { logPipeline({ event: 'updates.notification_record_failed', message: String(error), level: 'warn' }); }
}

function checkForUpdates(): Promise<AppUpdateState> {
  if (updateCheck) return updateCheck;
  const currentVersion = app.getVersion();
  publishUpdateState({ status: 'checking', currentVersion, version: '', releaseNotes: '' });
  if (process.platform === 'win32' && app.isPackaged) {
    configureWindowsUpdater();
    updateCheck = autoUpdater.checkForUpdates().then(async (result) => {
      if (result && !result.isUpdateAvailable) {
        publishUpdateState({ status: 'current', currentVersion, version: '', releaseNotes: '', checkedAt: new Date().toISOString() });
      }
      return updateState;
    }).catch((error: unknown) => {
      const message = `Could not check Windows updates: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
      publishUpdateState({ status: 'error', currentVersion, version: '', releaseNotes: '', checkedAt: new Date().toISOString(), message });
      logPipeline({ event: 'updates.error', message, level: 'warn' });
      return updateState;
    }).finally(() => { updateCheck = undefined; });
    return updateCheck;
  }
  updateCheck = checkForReleaseUpdate(currentVersion).then(async (state) => {
    publishUpdateState(state);
    if (state.status === 'available' && notifiedUpdateVersion !== state.version) await notifyAboutUpdate(state);
    logPipeline({ event: `updates.${state.status}`, message: state.message ?? `Update check completed for ${currentVersion}.`,
      level: state.status === 'error' ? 'warn' : 'info', data: { currentVersion, availableVersion: state.version } });
    return state;
  }).finally(() => { updateCheck = undefined; });
  return updateCheck;
}

function configureWindowsUpdater(): void {
  if (updaterConfigured || process.platform !== 'win32' || !app.isPackaged) return;
  updaterConfigured = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.allowPrerelease = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.on('checking-for-update', () => publishUpdateState({
    status: 'checking', currentVersion: app.getVersion(), version: '', releaseNotes: ''
  }));
  autoUpdater.on('update-available', (info) => {
    const releaseNotes = typeof info.releaseNotes === 'string' ? info.releaseNotes
      : Array.isArray(info.releaseNotes) ? info.releaseNotes.map((item) => item.note).join('\n') : '';
    const next: AppUpdateState = {
      status: 'available', currentVersion: app.getVersion(), version: info.version,
      releaseUrl: RELEASES_URL, releaseNotes: releaseNotes.slice(0, 12_000), checkedAt: new Date().toISOString(),
      message: `Version ${info.version} is ready to download.`
    };
    publishUpdateState(next);
    if (notifiedUpdateVersion !== info.version) void notifyAboutUpdate(next);
    logPipeline({ event: 'updates.available', message: next.message!, data: { version: info.version } });
  });
  autoUpdater.on('update-not-available', () => publishUpdateState({
    status: 'current', currentVersion: app.getVersion(), version: '', releaseNotes: '', checkedAt: new Date().toISOString()
  }));
  autoUpdater.on('download-progress', (progress) => publishUpdateState({
    ...updateState, status: 'downloading', percent: Math.max(0, Math.min(100, progress.percent)),
    bytesPerSecond: progress.bytesPerSecond, message: `Downloading update · ${Math.round(progress.percent)}%`
  }));
  autoUpdater.on('update-downloaded', (info) => {
    publishUpdateState({ ...updateState, status: 'downloaded', version: info.version, percent: 100,
      message: `Version ${info.version} is downloaded. Tawny will restart after active runs finish.` });
    logPipeline({ event: 'updates.downloaded', message: `Version ${info.version} downloaded.` });
    scheduleWindowsUpdateInstall();
  });
  autoUpdater.on('error', (error) => {
    const message = `Windows update failed: ${error.message}`.slice(0, 300);
    publishUpdateState({ ...updateState, status: 'error', checkedAt: new Date().toISOString(), message });
    logPipeline({ event: 'updates.error', message, level: 'error' });
  });
}

function downloadWindowsUpdate(): void {
  if (process.platform !== 'win32' || !app.isPackaged) throw new Error('Automatic installation is available in the packaged Windows app.');
  if (updateState.status !== 'available') throw new Error('Check for an available update before downloading it.');
  configureWindowsUpdater();
  publishUpdateState({ ...updateState, status: 'downloading', percent: 0, message: 'Starting secure update download…' });
  void autoUpdater.downloadUpdate().catch((error: unknown) => {
    const message = `Could not download update: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
    publishUpdateState({ ...updateState, status: 'error', message });
    logPipeline({ event: 'updates.download_failed', message, level: 'error' });
  });
}

async function installWindowsUpdate(): Promise<void> {
  if (process.platform !== 'win32' || !app.isPackaged) throw new Error('Automatic installation is available in the packaged Windows app.');
  if (updateState.status !== 'downloaded') throw new Error('The update must finish downloading before installation.');
  const runs = await engine.listRuns();
  const activeRun = runs.find((run) => ['pending', 'running'].includes(run.status) || run.stages.some((stage) => ['running', 'retrying'].includes(stage.status)));
  if (activeRun) {
    publishUpdateState({ ...updateState, message: `Version ${updateState.version} is downloaded. Tawny will restart after “${activeRun.goal.slice(0, 80)}” finishes.` });
    return;
  }
  publishUpdateState({ ...updateState, status: 'installing', message: 'Closing Tawny safely, installing the update, and restarting…' });
  await engine.stop();
  daemonStopped = true;
  quitting = true;
  autoUpdater.quitAndInstall(false, true);
}

function scheduleWindowsUpdateInstall(): void {
  if (updateInstallCheck || updateState.status !== 'downloaded') return;
  updateInstallCheck = installWindowsUpdate().catch((error: unknown) => {
    const message = `Could not install update: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
    publishUpdateState({ ...updateState, status: 'error', message });
    logPipeline({ event: 'updates.install_failed', message, level: 'error' });
  }).finally(() => { updateInstallCheck = undefined; });
}

setEventSink((event: OrchEvent) => {
  try {
    mainWindow?.webContents.send('orch:event', event);
  } catch {
    /* window gone */
  }
});

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------

const SHELL_SIZE = { width: 1020, height: 700 };
const PILL_SIZE = { width: 620, height: 84 };

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: SHELL_SIZE.width,
    height: SHELL_SIZE.height,
    minWidth: 760,
    minHeight: 540,
    show: false,
    frame: false,
    backgroundColor: '#f4f7fb',
    titleBarStyle: 'hidden',
    icon: join(__dirname, '../renderer/tawny-orch-mark.svg'),
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      backgroundMode = true;
      mainWindow?.hide();
    }
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    pushSnapshot();
  });
}

function showShell(): void {
  backgroundMode = false;
  if (!mainWindow) return;
  mainWindow.setMinimumSize(760, 540);
  mainWindow.setSize(SHELL_SIZE.width, SHELL_SIZE.height);
  mainWindow.setResizable(true);
  mainWindow.setSkipTaskbar(false);
  mainWindow.setAlwaysOnTop(false);
  mainWindow.center();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('app:mode', 'shell');
}

function showVoicePill(): void {
  if (!mainWindow) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = display.workArea;
  mainWindow.setMinimumSize(PILL_SIZE.width, PILL_SIZE.height);
  mainWindow.setSize(PILL_SIZE.width, PILL_SIZE.height);
  mainWindow.setResizable(false);
  mainWindow.setSkipTaskbar(backgroundMode);
  mainWindow.setPosition(
    Math.round(bounds.x + (bounds.width - PILL_SIZE.width) / 2),
    Math.round(bounds.y + 16),
    false
  );
  mainWindow.webContents.send('app:mode', 'pill');
  mainWindow.showInactive();
  mainWindow.moveTop();
}

// ---------------------------------------------------------------------------
// Voice pipeline (Tawny lifecycle)
// ---------------------------------------------------------------------------

function subscribeMachine(): void {
  machineActor.subscribe((state) => {
    const value = overlayState(String(state.value));
    if (snapshot.state !== value) {
      snapshot = { ...snapshot, state: value };
      pushSnapshot();
    }
    if (value === 'done' || value === 'failed' || value === 'cancelled') {
      releaseEscaper();
      setTimeout(() => {
        if (backgroundMode && ['done', 'failed', 'cancelled'].includes(snapshot.state)) {
          mainWindow?.hide();
        }
      }, 4000);
    }
  });
  machineActor.start();
}

async function startVoiceJob(): Promise<void> {
  if (updateState.status === 'installing') {
    snapshot = { ...snapshot, state: 'failed', message: 'Tawny is updating and will reopen shortly.' };
    pushSnapshot();
    return;
  }
  if (!auth.isAuthenticated()) {
    snapshot = { ...snapshot, state: 'failed', message: 'Sign in with Google before starting voice capture.' };
    pushSnapshot();
    return;
  }
  voiceGeneration += 1;
  currentDecision = undefined;
  snapshot = { ...snapshot, state: 'arming', elapsedMs: 0, rms: 0, message: undefined, decision: undefined, transcript: undefined, runId: undefined, runStageIndex: undefined, runStageTotal: undefined, runStageTitle: undefined };
  pushSnapshot();
  logPipeline({ event: 'hotkey.start', message: 'Voice capture starting.', stage: 'capture' });
  showVoicePill();
  machineActor.send({ type: 'HOTKEY' });
  setTimeout(() => machineActor.send({ type: 'AUDIO_READY' }), 150);
  registerEscaper();
}

function stopVoiceJob(): void {
  machineActor.send({ type: 'STOP' });
}

function cancelVoiceJob(): void {
  voiceGeneration += 1;
  currentDecision = undefined;
  machineActor.send({ type: 'CANCEL' });
  snapshot = { ...snapshot, message: 'Cancelled.' };
  pushSnapshot();
  releaseEscaper();
}

function registerEscaper(): void {
  if (escapingJob) return;
  escapingJob = globalShortcut.register('Escape', () => {
    if (['recording', 'confirming', 'arming'].includes(snapshot.state)) {
      logPipeline({ event: 'hotkey.cancel', message: 'Escape cancelled the active job.', stage: 'capture', errorClass: 'cancelled' });
      cancelVoiceJob();
    }
  });
}

function releaseEscaper(): void {
  if (!escapingJob) return;
  globalShortcut.unregister('Escape');
  escapingJob = false;
}

function normalizeAudio(audio: Uint8Array | Uint8Array[]): Uint8Array {
  const chunks = Array.isArray(audio) ? audio : [audio];
  if (!chunks.length || chunks.some((chunk) => !(chunk instanceof Uint8Array)) || chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) > 25 * 1024 * 1024) {
    throw new Error('Audio must be a nonempty recording no larger than 25 MB.');
  }
  if (Array.isArray(audio)) {
    const total = audio.reduce((sum, segment) => sum + segment.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const segment of audio) {
      merged.set(segment, offset);
      offset += segment.byteLength;
    }
    return merged;
  }
  return audio;
}

async function transcribeFromRenderer(audio: Uint8Array | Uint8Array[]): Promise<string> {
  const segments = Array.isArray(audio) ? audio.length : 1;
  logPipeline({ event: 'stt.start', message: `Transcribing ${segments} audio segment(s).`, stage: 'stt' });
  const text = await transcribeWithGroq(settings.groqApiKey, normalizeAudio(audio));
  logPipeline({ event: 'stt.success', message: `Transcript ready (${text.length} chars).`, stage: 'stt' });
  return text;
}

async function finalizeVoiceJob(transcript: string): Promise<void> {
  machineActor.send({ type: 'STAGE', stage: 'transcribing' });
  snapshot = { ...snapshot, state: 'gating', stage: 'gate' };
  pushSnapshot();
  machineActor.send({ type: 'STAGE', stage: 'gating' });

  const attached = await readAttachedProject();
  const gate = parseVoiceCommand({
    transcript,
    alwaysRoute: settings.prefs?.alwaysRoute ?? false
  });
  logPipeline({
    event: 'decision.result',
    message: `${gate.decision.intent}${gate.decision.message ? `: ${gate.decision.message}` : ''}`,
    stage: 'decide',
    errorClass: gate.routed ? undefined : 'input',
    data: { intent: gate.decision.intent, routed: String(gate.routed) }
  });

  if (!gate.routed) {
    snapshot = { ...snapshot, state: 'done', message: gate.decision.message ?? 'Wake phrase not heard — nothing routed.' };
    pushSnapshot();
    machineActor.send({ type: 'SUCCESS' });
    return;
  }

  if (gate.decision.intent === 'attach_folder') {
    // Dictated paths are never trusted. A native picker is the approval boundary.
    const selected = await chooseProjectFolder();
    if (!selected) throw new Error('No project selected. Choose a registered folder to continue.');
    mainWindow?.webContents.send('project:update', await readAttachedProject());
    snapshot = { ...snapshot, state: 'done', message: `Folder attached: ${selected.name}` };
    pushSnapshot();
    machineActor.send({ type: 'SUCCESS' });
    return;
  }

  if (gate.decision.intent === 'stop_run' || gate.decision.intent === 'pause_run' || gate.decision.intent === 'resume_run' || gate.decision.intent === 'status') {
    await handleImmediateIntent(gate.decision.intent);
    machineActor.send({ type: 'SUCCESS' });
    return;
  }

  if (gate.decision.intent === 'assign_role') {
    mainWindow?.webContents.send('voice:assign', gate.decision);
    snapshot = {
      ...snapshot,
      state: 'done',
      message: gate.decision.message ?? 'Role assignment noted — apply it on the Pipeline page.'
    };
    pushSnapshot();
    machineActor.send({ type: 'SUCCESS' });
    return;
  }

  // Run-type intents pass through a confirmation gate before agents are burned.
  if (gate.decision.intent === 'new_project') {
    throw new Error('Automatic project creation is not enabled. Create or choose a folder with the project picker, then describe the goal.');
  }
  const registrations = await listRegisteredProjects();
  const resolution = resolveVoiceProject(transcript, registrations, attached);
  if (resolution.needsSelection || !resolution.project || gate.decision.projectPath) {
    throw new Error(`Choose the project folder in Cockpit first (${resolution.reason}). Spoken paths and ambiguous project names are not used.`);
  }
  const registration = registrations.find((project) => project.path === resolution.project?.path);
  const resolved = registration ? await resolveRegisteredProject(registration.aliases[0]) : attached;
  if (!resolved) throw new Error('The selected project is unavailable. Reattach its folder before dispatching.');
  const goal = (resolution.goal ?? gate.decision.goal).replace(/^\s*hey\s+(?:tawny|buddy)[,\s]*/i, '').trim();
  if (!goal) throw new Error('Describe a goal as well as the project.');
  currentDecision = { ...gate.decision, goal, projectPath: resolved.path, projectName: resolved.name };
  machineActor.send({ type: 'STAGE', stage: 'deciding' });
  machineActor.send({ type: 'STAGE', stage: 'confirming' });
  const projectPath = resolved.path;
  snapshot = {
    ...snapshot,
    state: 'confirming',
    stage: 'decide',
    decision: currentDecision,
    message: `Build: ${goal.slice(0, 110)}${projectPath ? ` · ${projectPath.split(/[\\/]/).filter(Boolean).pop()}` : ' · no folder attached'}`
  };
  pushSnapshot();
}

async function handleImmediateIntent(intent: 'stop_run' | 'pause_run' | 'resume_run' | 'status'): Promise<void> {
  const runs = await engine.listRuns();
  const active = runs.find((run) => run.status === 'running' || run.status === 'escalated');
  if (intent === 'stop_run') {
    if (active) {
      await engine.cancelRun(active.id);
      snapshot = { ...snapshot, state: 'done', message: `Stopped run ${active.id}.` };
    } else {
      snapshot = { ...snapshot, state: 'done', message: 'No active run to stop.' };
    }
  } else if (intent === 'status') {
    snapshot = {
      ...snapshot,
      state: 'done',
      message: active ? `Run ${active.id}: ${stageOrOverallText(active)}` : 'No active runs.'
    };
  } else {
    snapshot = { ...snapshot, state: 'done', message: 'Use the Runs page to pause or resume a run.' };
  }
  pushSnapshot();
}

async function dispatchConfirmed(): Promise<void> {
  if (updateState.status === 'installing') {
    currentDecision = undefined;
    snapshot = { ...snapshot, state: 'failed', message: 'Tawny is updating and will reopen shortly.' };
    pushSnapshot();
    return;
  }
  if (!auth.isAuthenticated()) {
    currentDecision = undefined;
    snapshot = { ...snapshot, state: 'failed', message: 'Sign in with Google before dispatching a pipeline.' };
    pushSnapshot();
    return;
  }
  const decision = currentDecision;
  if (snapshot.state !== 'confirming') return;
  if (!decision) {
    snapshot = { ...snapshot, state: 'failed', message: 'Nothing to dispatch.' };
    pushSnapshot();
    machineActor.send({ type: 'FAIL', message: 'Nothing to dispatch.' });
    return;
  }
  currentDecision = undefined;
  machineActor.send({ type: 'CONFIRM' });
  machineActor.send({ type: 'STAGE', stage: 'handling' });
  snapshot = { ...snapshot, state: 'handling', message: 'Preparing the pipeline…' };
  pushSnapshot();

  const projectPath = decision.projectPath || (await readAttachedProject())?.path || '';
  if (!projectPath) {
    snapshot = { ...snapshot, state: 'failed', message: 'No project folder attached. Attach one on Home first.' };
    pushSnapshot();
    machineActor.send({ type: 'FAIL', message: 'No project folder attached.' });
    return;
  }
  const { stages, templateId } = await (async () => {
    const config = await readProjectConfig(projectPath);
    if (config.stages.length > 0) {
      return { stages: config.stages, templateId: config.templateId };
    }
    const template = templateById(config.templateId || 'solo') ?? BASE_TEMPLATES[0];
    return {
      stages: template.stages.map((stage) => ({
        id: stage.id,
        title: stage.title,
        role: stage.role,
        agentId: stage.agentId,
        acceptanceCommands: stage.acceptanceCommands,
        allowedFiles: stage.allowedFiles,
        forbiddenFiles: stage.forbiddenFiles,
        retries: stage.retries
      })),
      templateId: template.id
    };
  })();
  const goal = decision.goal
    || `Prototype ${decision.projectName || 'the project'} through the full pipeline.`;
  machineActor.send({ type: 'STAGE', stage: 'dispatching' });
  snapshot = {
    ...snapshot,
    state: 'dispatching',
    message: `Dispatching ${stages.length} stages…`,
    runStageTotal: stages.length,
    runStageIndex: 1,
    runStageTitle: stages[0]?.title
  };
  pushSnapshot();

  const run = await engine.createRun({
    goal,
    projectPath,
    projectName: decision.projectName || projectPath.split(/[\\/]/).filter(Boolean).pop() || 'project',
    stages,
    templateId
  });
  await saveProjectConfig(projectPath, { version: 1, templateId, stages });
  machineActor.send({ type: 'DISPATCHED', runId: run.id });
  snapshot = { ...snapshot, state: 'done', message: `Run ${run.id} dispatched — tracking in the background.`, runId: run.id };
  pushSnapshot();
  mainWindow?.webContents.send('run:created', run);

  void engine.startRun(run.id).catch((error: unknown) => {
    logPipeline({
      event: 'run.engine_error', message: String(error), level: 'error', stage: 'orchestrate', runId: run.id
    });
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle('auth:get-state', () => authState);
  ipcMain.handle('auth:sign-in', async () => auth.signIn());
  ipcMain.handle('auth:cancel', async () => { await auth.cancelSignIn(); return auth.getState(); });
  ipcMain.handle('auth:sign-out', async () => {
    cancelVoiceJob();
    return auth.signOut();
  });
  ipcMain.handle('auth:retry', async () => auth.initialize());
  ipcMain.handle('diagnostics:export', async () => {
    const saveOptions = {
      title: 'Export Tawny diagnostic summary',
      defaultPath: `tawny-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON report', extensions: ['json'] }]
    };
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, saveOptions) : await dialog.showSaveDialog(saveOptions);
    if (result.canceled || !result.filePath) return false;
    const entries = getRecentLogs();
    const counts = entries.reduce<Record<string, number>>((all, entry) => {
      const key = `${entry.level}:${entry.event.split('.')[0] || 'other'}`;
      all[key] = (all[key] ?? 0) + 1;
      return all;
    }, {});
    const report = {
      reportVersion: 1,
      generatedAt: new Date().toISOString(),
      app: { name: app.getName(), version: app.getVersion(), platform: process.platform, arch: process.arch },
      auth: { status: authState.status, persistentSession: authState.persistentSession, secureStorageAvailable: auth.hasSecureStorage() },
      updates: { status: updateState.status, version: updateState.version || undefined, checkedAt: updateState.checkedAt },
      recentActivity: { includedEntries: Math.min(entries.length, 500), groupedCounts: counts }
    };
    await writeFile(result.filePath, JSON.stringify(report, null, 2), 'utf8');
    return true;
  });
  ipcMain.handle('overlay:get-snapshot', () => snapshot);
  ipcMain.handle('updates:get-state', () => updateState);
  ipcMain.handle('updates:check', () => checkForUpdates());
  ipcMain.handle('updates:download', () => { downloadWindowsUpdate(); });
  ipcMain.handle('updates:install', () => installWindowsUpdate());
  ipcMain.handle('updates:open-release', async () => {
    const destination = updateState.releaseUrl ?? RELEASES_URL;
    const url = new URL(destination);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith('/Priyank911/Tawny-Orch/releases')) {
      throw new Error('The update page did not match Tawny’s official GitHub Releases page.');
    }
    await shell.openExternal(url.toString());
  });

  ipcMain.handle('audio:transcribe', async (_event, audio: Uint8Array | Uint8Array[]) => {
    requireAuthenticated();
    const generation = voiceGeneration;
    try {
      const text = await transcribeFromRenderer(audio);
      if (generation !== voiceGeneration) return '';
      snapshot = { ...snapshot, transcript: text.slice(0, 240) };
      void finalizeVoiceJob(text).catch((error: unknown) => {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
        logPipeline({ event: 'gate.failed', message, level: 'error', stage: 'gate' });
        snapshot = { ...snapshot, state: 'failed', message };
        pushSnapshot();
        machineActor.send({ type: 'FAIL', message });
      });
      return text;
    } catch (error) {
      if (generation !== voiceGeneration) return '';
      const message = ('Transcription failed: ' + (error instanceof Error ? error.message : String(error))).slice(0, 300);
      logPipeline({ event: 'stt.failed', message, level: 'error', stage: 'stt' });
      snapshot = { ...snapshot, state: 'failed', message };
      pushSnapshot();
      machineActor.send({ type: 'FAIL', message });
      return '';
    }
  });

  ipcMain.handle('agents:get', (): Promise<AgentStatus[]> => { requireAuthenticated(); return detectAgents(); });
  ipcMain.handle('agents:detect', async (): Promise<AgentStatus[]> => { requireAuthenticated(); return detectAgents(true); });

  ipcMain.handle('project:attach', async () => {
    requireAuthenticated();
    const project = await chooseProjectFolder();
    logPipeline({
      event: 'project.attached',
      message: project ? `Project attached: ${project.path}` : 'Folder selection cancelled.',
      stage: 'gate'
    });
    if (project) mainWindow?.webContents.send('project:update', project);
    return project;
  });
  ipcMain.handle('project:get', () => { requireAuthenticated(); return readAttachedProject(); });
  const approvedProject = async (projectPath: string): Promise<string> => {
    const attached = await readAttachedProject();
    if (!attached || attached.path !== projectPath) throw new Error('Attach this project using the folder picker first.');
    return attached.path;
  };
  ipcMain.handle('project:config:get', async (_event, projectPath: string) => { requireAuthenticated(); return readProjectConfig(await approvedProject(projectPath)); });
  ipcMain.handle('project:config:save', async (_event, payload: { projectPath: string; config: { version: 1; templateId: string; stages: StageSpec[]; updatedAt?: string } }) => {
    requireAuthenticated();
    await saveProjectConfig(await approvedProject(payload.projectPath), payload.config);
  });

  ipcMain.handle('templates:get', () => BASE_TEMPLATES);

  ipcMain.handle('run:create', async (_event, input: { goal: string; overwriteStages?: StageSpec[]; templateId?: string; projectPath?: string }) => {
    requireAuthenticated();
    if (updateState.status === 'installing') throw new Error('Tawny is installing an update and will reopen shortly.');
    const parsed = z.object({ goal: z.string().trim().min(1).max(12000), overwriteStages: z.array(stageSpecSchema).min(1).max(20).optional(), templateId: z.string().optional(), projectPath: z.string().optional() }).parse(input);
    input = parsed;
    const projectPath = input.projectPath
      ? await approvedProject(input.projectPath)
      : (await readAttachedProject())?.path;
    if (!projectPath) return null;
    const config = await readProjectConfig(projectPath);
    const template = templateById(input.templateId ?? config.templateId ?? 'solo') ?? BASE_TEMPLATES[0];
    const stages = input.overwriteStages && input.overwriteStages.length > 0
      ? input.overwriteStages
      : (config.stages.length > 0 ? config.stages : template.stages);
    const run = await engine.createRun({
      goal: input.goal,
      projectPath,
      projectName: projectPath.split(/[\\/]/).filter(Boolean).pop() ?? 'project',
      stages,
      templateId: template.id
    });
    await saveProjectConfig(projectPath, { version: 1, templateId: template.id, stages });
    void engine.startRun(run.id).catch((error: unknown) => {
      logPipeline({
        event: 'run.engine_error', message: String(error), level: 'error', stage: 'orchestrate', runId: run.id
      });
    });
    return run;
  });
  ipcMain.handle('runs:list', async () => { requireAuthenticated(); return engine.listRuns(); });
  ipcMain.handle('run:get', async (_event, runId: string) => { requireAuthenticated(); return engine.loadRunById(runId); });
  ipcMain.handle('run:cancel', async (_event, runId: string) => { requireAuthenticated(); await engine.cancelRun(runId); });
  ipcMain.handle('run:artifact:open', async (_event, input: { runId: string; stageId?: string; name: string }) => {
    requireAuthenticated();
    if (!['task_contract', 'agent_session', 'agent_result', 'final_report', 'worktree', 'selected_workspace', 'published_output', 'verified_packet_md'].includes(input.name)) throw new Error('This artifact cannot be opened from the run view.');
    const run = await engine.loadRunById(input.runId);
    if (!run) throw new Error('This run no longer exists.');
    const artifact = input.name === 'final_report'
      ? { path: join(runDir(userDataDir(), run.id), 'final-summary.md') }
      : run.stages.find((candidate) => candidate.spec.id === input.stageId)?.artifacts.find((candidate) => candidate.name === input.name);
    if (!artifact) throw new Error('This stage has no matching artifact yet.');
    let target: string;
    try { target = await realpath(artifact.path); }
    catch { throw new Error('This file is not available yet. Wait for the stage or run to finish and try again.'); }
    if (input.name === 'selected_workspace') {
      if (target !== await realpath(run.projectPath)) throw new Error('The selected workspace path does not match this run project.');
    } else if (input.name === 'worktree') {
      const roots = [join(userDataDir(), 'orchestrator', 'worktrees'), join(run.projectPath, '.tawny-orch', 'worktrees')];
      const allowed = await Promise.all(roots.map(async (path) => {
        try {
          const root = await realpath(path);
          const withinRoot = relative(root, target);
          return Boolean(withinRoot && !withinRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && withinRoot !== '..' && !isAbsolute(withinRoot));
        } catch { return false; }
      }));
      if (!allowed.some(Boolean)) {
        throw new Error('The worktree path is outside Tawny run storage and cannot be opened.');
      }
    } else {
      const root = await realpath(runDir(userDataDir(), run.id));
      const withinRun = relative(root, target);
      if (!withinRun || withinRun.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || withinRun === '..' || isAbsolute(withinRun)) {
        throw new Error('The artifact path is outside this run folder and cannot be opened.');
      }
    }
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
  });
  ipcMain.handle('run:agent-session:open', async (_event, input: { runId: string; stageId: string }) => {
    requireAuthenticated();
    const run = await engine.loadRunById(input.runId);
    const stage = run?.stages.find((candidate) => candidate.spec.id === input.stageId);
    if (!run || !stage || ['running', 'queued', 'routed', 'retrying'].includes(stage.status)) {
      throw new Error('Wait for this agent attempt to finish before reopening its saved session.');
    }
    const sessionId = stage.artifacts.find((artifact) => artifact.name === 'agent_session_id')?.path;
    if (!sessionId || !stage.agentId) throw new Error('This agent did not report a resumable session ID. Open its captured session log instead.');
    const cwd = stage.artifacts.find((artifact) => artifact.name === 'worktree')?.path ?? run.projectPath;
    await openAgentTerminal(stage.agentId, sessionId, cwd);
  });
  ipcMain.handle('run:escalate', async (_event, input: { runId: string; stageId: string; agentId?: string | null; manualComplete?: boolean; summary?: string; skip?: boolean }) => {
    requireAuthenticated();
    return engine.escalateStage({
      runId: input.runId,
      stageId: input.stageId,
      reassignAgentId: input.agentId ?? undefined,
      manualComplete: input.manualComplete,
      manualSummary: input.summary,
      skipStage: input.skip
    });
  });

  ipcMain.handle('events:get', async (_event, runId?: string) => {
    requireAuthenticated();
    const events = await readEventsFromDisk();
    return runId ? events.filter((event) => event.runId === runId) : events;
  });
  ipcMain.handle('logs:get', () => { requireAuthenticated(); return getRecentLogs(); });

  ipcMain.handle('settings:get', async () => {
    requireAuthenticated();
    settings = await readSettings();
    return settings;
  });
  ipcMain.handle('settings:save', async (_event, next: AppSettings) => {
    requireAuthenticated();
    const validated = appSettingsSchema.parse(next);
    await saveSettings(validated);
    settings = validated;
    logPipeline({ event: 'settings.saved', message: 'App settings updated.' });
  });

  ipcMain.handle('app:enter-background', () => {
    backgroundMode = true;
    logPipeline({ event: 'app.background', message: 'Running in the background (tray + hotkey).' });
    setTimeout(() => mainWindow?.hide(), 650);
  });

  ipcMain.on('pipeline:event', (_event, action: 'HOTKEY' | 'STOP' | 'CANCEL' | 'CONFIRM') => {
    if (!auth.isAuthenticated() && action !== 'CANCEL') return;
    handlePipelineAction(action);
  });
  ipcMain.on('capture:log', (_event, input: { event: string; message: string; level?: 'debug' | 'info' | 'warn' | 'error'; data?: Record<string, string> }) => {
    logPipeline({ ...input, stage: 'capture' } as PipelineLog);
  });
  ipcMain.on('app:hide', () => {
    backgroundMode = true;
    mainWindow?.hide();
  });
}

function reportVoiceFailure(error: unknown): void {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 400);
  snapshot = { ...snapshot, state: 'failed', message };
  currentDecision = undefined;
  machineActor.send({ type: 'FAIL', message });
  pushSnapshot();
  releaseEscaper();
}

function handlePipelineAction(action: 'HOTKEY' | 'STOP' | 'CANCEL' | 'CONFIRM'): void {
  const current = snapshot.state;
  if (action === 'STOP') {
    stopVoiceJob();
    return;
  }
  if (action === 'CANCEL') {
    cancelVoiceJob();
    return;
  }
  if (action === 'CONFIRM') {
    void dispatchConfirmed().catch(reportVoiceFailure);
    return;
  }
  if (current === 'recording') {
    logPipeline({ event: 'hotkey.stop', message: 'Hotkey toggled recording off.', stage: 'capture' });
    stopVoiceJob();
  } else if (current === 'confirming') {
    void dispatchConfirmed().catch(reportVoiceFailure);
  } else if (['idle', 'done', 'failed', 'cancelled'].includes(current)) {
    void startVoiceJob();
  } else {
    cancelVoiceJob();
  }
}

async function readEventsFromDisk(): Promise<OrchEvent[]> {
  try {
    const raw = await readFile(join(userDataDir(), 'orchestrator', 'events.jsonl'), 'utf8');
    return raw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .slice(-400)
      .map((line) => {
        try {
          return JSON.parse(line) as OrchEvent;
        } catch {
          return undefined;
        }
      })
      .filter((event): event is OrchEvent => event !== undefined);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tray + boot
// ---------------------------------------------------------------------------

function createTray(): void {
  const icon = nativeImage.createFromPath(join(__dirname, '../renderer/tawny-orch-mark.svg'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Tawny Orch — hotkey and speak');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Tawny Orch', click: () => showShell() },
    { type: 'separator' },
    { label: 'Start voice capture', click: () => { void startVoiceJob(); } },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('click', () => showShell());
}

app.whenReady().then(async () => {
  setLogSink(logsFileName(), (entry: PipelineLog) => {
    try {
      mainWindow?.webContents.send('pipeline:log', entry);
    } catch {
      /* window gone */
    }
  });
  authState = await auth.initialize();
  logPipeline({
    event: 'auth.startup',
    message: `Account gate initialized (${authState.status}; ${authState.persistentSession ? 'saved session' : 'no saved session'}).`,
    level: authState.status === 'error' || authState.status === 'offline' ? 'warn' : 'info'
  });
  settings = await readSettings();
  await engine.start();
  registerIpc();
  createWindow();
  createTray();
  subscribeMachine();
  logPipeline({ event: 'app.boot', message: 'Tawny Orch ready.' });
  if (app.isPackaged) {
    configureWindowsUpdater();
    void checkForUpdates();
    setInterval(() => { void checkForUpdates(); }, 24 * 60 * 60 * 1000);
  }

  const shortcut = settings.prefs?.hotkey ?? 'Control+Alt+Space';
  const registered = globalShortcut.register(shortcut, () => {
    const now = Date.now();
    if (now - lastHotkeyAt < 400) return;
    lastHotkeyAt = now;
    handlePipelineAction('HOTKEY');
  });
  if (registered) logPipeline({ event: 'hotkey.registered', message: shortcut });
  else logPipeline({ event: 'hotkey.conflict', message: `Could not register ${shortcut}.`, level: 'warn' });
}).catch((error: unknown) => {
  console.error('Tawny Orch failed to start.', error);
  app.quit();
});

let daemonStopped = false;
app.on('before-quit', (event) => {
  quitting = true;
  if (daemonStopped) return;
  event.preventDefault();
  void engine.stop().catch((error: unknown) => {
    logPipeline({ event: 'daemon.shutdown_error', message: String(error), level: 'error' });
  }).finally(() => { daemonStopped = true; app.quit(); });
});
app.on('will-quit', () => {
  releaseEscaper();
  globalShortcut.unregisterAll();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (mainWindow === undefined) createWindow();
});

