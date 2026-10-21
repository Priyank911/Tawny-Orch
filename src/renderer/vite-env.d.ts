import type {
  AgentStatus, AppSettings, OrchEvent, OverlaySnapshot,
  PipelineLog, PipelineTemplate, ProjectAttachment, ProjectConfig, RunSnapshot, StageSpec, VoiceDecision
} from '../shared/contracts';

declare global {
  interface Window {
    tawnyOrch: {
      getSnapshot: () => Promise<OverlaySnapshot>;
      subscribe: (listener: (snapshot: OverlaySnapshot) => void) => () => void;
      send: (event: 'HOTKEY' | 'STOP' | 'CANCEL' | 'CONFIRM') => void;
      transcribeAudio: (audio: Uint8Array | Uint8Array[]) => Promise<string>;
      logCapture: (input: { event: string; message: string; level?: 'debug' | 'info' | 'warn' | 'error'; data?: Record<string, string> }) => void;

      getAgents: () => Promise<AgentStatus[]>;
      detectAgents: () => Promise<AgentStatus[]>;

      attachProject: () => Promise<ProjectAttachment | null>;
      getProject: () => Promise<ProjectAttachment | null>;
      getProjectConfig: (projectPath: string) => Promise<ProjectConfig>;
      saveProjectConfig: (projectPath: string, config: ProjectConfig) => Promise<void>;

      getTemplates: () => Promise<PipelineTemplate[]>;
      createRun: (input: { goal: string; overwriteStages?: StageSpec[]; templateId?: string; projectPath?: string }) => Promise<RunSnapshot | null>;
      getRuns: () => Promise<RunSnapshot[]>;
      getRun: (runId: string) => Promise<RunSnapshot | null>;
      cancelRun: (runId: string) => Promise<void>;
      escalateStage: (input: {
        runId: string; stageId: string;
        reassignAgentId?: string | null; manualComplete?: boolean; summary?: string; skip?: boolean;
      }) => Promise<void>;

      getEvents: (runId?: string) => Promise<OrchEvent[]>;
      onEvent: (listener: (event: OrchEvent) => void) => () => void;
      getLogs: () => Promise<PipelineLog[]>;
      onLog: (listener: (entry: PipelineLog) => void) => () => void;

      getSettings: () => Promise<AppSettings>;
      saveSettings: (settings: AppSettings) => Promise<void>;

      enterBackground: () => Promise<void>;
      hideWindow: () => void;
      onMode: (listener: (mode: 'shell' | 'pill') => void) => () => void;
      onRunUpdate: (listener: (run: RunSnapshot) => void) => () => void;
      onRunCreated: (listener: (run: RunSnapshot) => void) => () => void;
      onProjectUpdate: (listener: (project: ProjectAttachment | null) => void) => () => void;
      onVoiceAssign: (listener: (decision: VoiceDecision) => void) => () => void;
    };
  }
}

export {};
