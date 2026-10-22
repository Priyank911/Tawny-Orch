import { contextBridge, ipcRenderer } from 'electron';
import type {
  AgentStatus, AppSettings, OrchEvent, OverlaySnapshot,
  PipelineLog, PipelineTemplate, ProjectAttachment, ProjectConfig, RunSnapshot, StageSpec
} from '../shared/contracts';

contextBridge.exposeInMainWorld('tawnyOrch', {
  // Voice pipeline surface (Tawny parity)
  getSnapshot: (): Promise<OverlaySnapshot> => ipcRenderer.invoke('overlay:get-snapshot'),
  subscribe: (listener: (snapshot: OverlaySnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: OverlaySnapshot) => listener(snapshot);
    ipcRenderer.on('overlay:update', handler);
    return () => ipcRenderer.removeListener('overlay:update', handler);
  },
  send: (event: 'HOTKEY' | 'STOP' | 'CANCEL' | 'CONFIRM') => ipcRenderer.send('pipeline:event', event),
  transcribeAudio: (audio: Uint8Array | Uint8Array[]): Promise<string> =>
    ipcRenderer.invoke('audio:transcribe', audio),
  logCapture: (input: { event: string; message: string; level?: 'debug' | 'info' | 'warn' | 'error'; data?: Record<string, string> }): void =>
    ipcRenderer.send('capture:log', input),

  // Agents
  getAgents: (): Promise<AgentStatus[]> => ipcRenderer.invoke('agents:get'),
  detectAgents: (): Promise<AgentStatus[]> => ipcRenderer.invoke('agents:detect'),
  openAgentInstall: (): void => ipcRenderer.send('agents:open-install-hints'),

  // Projects
  attachProject: (): Promise<ProjectAttachment | null> => ipcRenderer.invoke('project:attach'),
  getProject: (): Promise<ProjectAttachment | null> => ipcRenderer.invoke('project:get'),
  getProjectConfig: (projectPath: string): Promise<ProjectConfig> => ipcRenderer.invoke('project:config:get', projectPath),
  saveProjectConfig: (projectPath: string, config: ProjectConfig): Promise<void> => ipcRenderer.invoke('project:config:save', { projectPath, config }),

  // Pipelines
  getTemplates: (): Promise<PipelineTemplate[]> => ipcRenderer.invoke('templates:get'),
  createRun: (input: { goal: string; overwriteStages?: StageSpec[]; templateId?: string; projectPath?: string }): Promise<RunSnapshot | null> =>
    ipcRenderer.invoke('run:create', input),
  getRuns: (): Promise<RunSnapshot[]> => ipcRenderer.invoke('runs:list'),
  getRun: (runId: string): Promise<RunSnapshot | null> => ipcRenderer.invoke('run:get', runId),
  cancelRun: (runId: string): Promise<void> => ipcRenderer.invoke('run:cancel', runId),
  openRunArtifact: (input: { runId: string; stageId?: string; name: 'task_contract' | 'agent_session' | 'agent_result' | 'final_report' | 'worktree' | 'selected_workspace' | 'published_output' }): Promise<void> =>
    ipcRenderer.invoke('run:artifact:open', input),
  openAgentSession: (input: { runId: string; stageId: string }): Promise<void> => ipcRenderer.invoke('run:agent-session:open', input),
  escalateStage: (input: { runId: string; stageId: string; reassignAgentId?: string | null; manualComplete?: boolean; summary?: string; skip?: boolean }): Promise<void> =>
    ipcRenderer.invoke('run:escalate', { ...input, agentId: input.reassignAgentId }),

  // Events + logs
  getEvents: (runId?: string): Promise<OrchEvent[]> => ipcRenderer.invoke('events:get', runId),
  onEvent: (listener: (event: OrchEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, entry: OrchEvent) => listener(entry);
    ipcRenderer.on('orch:event', handler);
    return () => ipcRenderer.removeListener('orch:event', handler);
  },
  getLogs: (): Promise<PipelineLog[]> => ipcRenderer.invoke('logs:get'),
  onLog: (listener: (entry: PipelineLog) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, entry: PipelineLog) => listener(entry);
    ipcRenderer.on('pipeline:log', handler);
    return () => ipcRenderer.removeListener('pipeline:log', handler);
  },

  // Settings
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: AppSettings): Promise<void> => ipcRenderer.invoke('settings:save', settings),

  // Window / app control
  enterBackground: (): Promise<void> => ipcRenderer.invoke('app:enter-background'),
  hideWindow: (): void => ipcRenderer.send('app:hide'),
  onMode: (listener: (mode: 'shell' | 'pill') => void) => {
    const handler = (_event: Electron.IpcRendererEvent, mode: 'shell' | 'pill') => listener(mode);
    ipcRenderer.on('app:mode', handler);
    return () => ipcRenderer.removeListener('app:mode', handler);
  },
  onRunUpdate: (listener: (run: RunSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, run: RunSnapshot) => listener(run);
    ipcRenderer.on('run:update', handler);
    return () => ipcRenderer.removeListener('run:update', handler);
  },
  onRunCreated: (listener: (run: RunSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, run: RunSnapshot) => listener(run);
    ipcRenderer.on('run:created', handler);
    return () => ipcRenderer.removeListener('run:created', handler);
  },
  onProjectUpdate: (listener: (project: ProjectAttachment | null) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, project: ProjectAttachment | null) => listener(project);
    ipcRenderer.on('project:update', handler);
    return () => ipcRenderer.removeListener('project:update', handler);
  },
  onVoiceAssign: (listener: (decision: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, decision: unknown) => listener(decision);
    ipcRenderer.on('voice:assign', handler);
    return () => ipcRenderer.removeListener('voice:assign', handler);
  },
  closeWindow: (): void => ipcRenderer.send('app:hide')
} as unknown as typeof window.tawnyOrch);
