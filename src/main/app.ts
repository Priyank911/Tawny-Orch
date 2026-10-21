import {
  app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, Tray
} from 'electron';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createActor } from 'xstate';
import { overlayState, pipelineMachine } from './pipeline/machine';
import { parseVoiceCommand } from './pipeline/voice';
import { resolveVoiceProject } from './pipeline/projectResolver';
import { transcribeWithGroq } from './providers/groqWhisper';
import { detectAgents } from './detect/agents';
import { BASE_TEMPLATES, templateById } from './orchestrator/templates';
import { saveAttachedProject } from './projectStore';
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
  AgentStatus, AppSettings, OrchEvent, OverlaySnapshot, PipelineLog, RunSnapshot, StageSpec
} from '../shared/contracts';

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
let voiceGeneration = 0;
let currentDecision: ReturnType<typeof parseVoiceCommand>['decision'] | undefined;

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
  budgetFor: () => ({ ...settings.budget, policy: 'free-only', maxUsd: 0, spentUsd: 0, entitlements: settings.budget?.entitlements ?? {} }),
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
  ipcMain.handle('overlay:get-snapshot', () => snapshot);

  ipcMain.handle('audio:transcribe', async (_event, audio: Uint8Array | Uint8Array[]) => {
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

  ipcMain.handle('agents:get', (): Promise<AgentStatus[]> => detectAgents());
  ipcMain.handle('agents:detect', async (): Promise<AgentStatus[]> => detectAgents(true));

  ipcMain.handle('project:attach', async () => {
    const project = await chooseProjectFolder();
    logPipeline({
      event: 'project.attached',
      message: project ? `Project attached: ${project.path}` : 'Folder selection cancelled.',
      stage: 'gate'
    });
    if (project) mainWindow?.webContents.send('project:update', project);
    return project;
  });
  ipcMain.handle('project:get', () => readAttachedProject());
  const approvedProject = async (projectPath: string): Promise<string> => {
    const attached = await readAttachedProject();
    if (!attached || attached.path !== projectPath) throw new Error('Attach this project using the folder picker first.');
    return attached.path;
  };
  ipcMain.handle('project:config:get', async (_event, projectPath: string) => readProjectConfig(await approvedProject(projectPath)));
  ipcMain.handle('project:config:save', async (_event, payload: { projectPath: string; config: { version: 1; templateId: string; stages: StageSpec[]; updatedAt?: string } }) => {
    await saveProjectConfig(await approvedProject(payload.projectPath), payload.config);
  });

  ipcMain.handle('templates:get', () => BASE_TEMPLATES);

  ipcMain.handle('run:create', async (_event, input: { goal: string; overwriteStages?: StageSpec[]; templateId?: string; projectPath?: string }) => {
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
  ipcMain.handle('runs:list', async () => engine.listRuns());
  ipcMain.handle('run:get', async (_event, runId: string) => engine.loadRunById(runId));
  ipcMain.handle('run:cancel', async (_event, runId: string) => { await engine.cancelRun(runId); });
  ipcMain.handle('run:escalate', async (_event, input: { runId: string; stageId: string; agentId?: string | null; manualComplete?: boolean; summary?: string; skip?: boolean }) => {
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
    const events = await readEventsFromDisk();
    return runId ? events.filter((event) => event.runId === runId) : events;
  });
  ipcMain.handle('logs:get', () => getRecentLogs());

  ipcMain.handle('settings:get', async () => {
    settings = await readSettings();
    return settings;
  });
  ipcMain.handle('settings:save', async (_event, next: AppSettings) => {
    const validated = appSettingsSchema.parse(next);
    validated.budget = { ...validated.budget, policy: 'free-only', maxUsd: 0, spentUsd: 0, entitlements: validated.budget?.entitlements ?? {} };
    await saveSettings(validated);
    settings = validated;
    await engine.updateBudget();
    logPipeline({ event: 'settings.saved', message: 'Credentials updated.' });
  });

  ipcMain.handle('app:enter-background', () => {
    backgroundMode = true;
    logPipeline({ event: 'app.background', message: 'Running in the background (tray + hotkey).' });
    setTimeout(() => mainWindow?.hide(), 650);
  });

  ipcMain.on('pipeline:event', (_event, action: 'HOTKEY' | 'STOP' | 'CANCEL' | 'CONFIRM') => {
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
  settings = await readSettings();
  await engine.start();
  registerIpc();
  createWindow();
  createTray();
  subscribeMachine();
  logPipeline({ event: 'app.boot', message: 'Tawny Orch ready.' });

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

