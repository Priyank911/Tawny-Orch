import type { AgentTier, ArtifactBundle, TaskContract } from '../../shared/contracts';

export interface RunKey {
  readonly key: string;
}

export interface AdapterContext {
  readonly contract: TaskContract;
  readonly cwd: string;
  readonly workdir: string;
  readonly packetPath?: string;
  readonly sessionLogPath?: string;
  readonly onSessionEvent?: (event: {
    type: 'started' | 'output' | 'finished';
    pid?: number;
    stream?: 'stdout' | 'stderr';
    text?: string;
    exitCode?: number | null;
    timedOut?: boolean;
    cancelled?: boolean;
  }) => void;
}

export interface AdapterHandle extends RunKey {
  readonly ctx: AdapterContext;
  readonly extras: Record<string, string>;
}

export interface AgentAdapter {
  readonly id: string;
  readonly name: string;
  readonly tier: AgentTier;
  start(context: AdapterContext): Promise<AdapterHandle>;
  collect(handle: AdapterHandle): Promise<ArtifactBundle>;
  cancel(handle: AdapterHandle): Promise<void>;
}

export const ADAPTER_PROTOCOL_VERSION = 1;
