import { app } from 'electron';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LogLevel, PipelineLog } from '../shared/contracts';

const MAX_IN_MEMORY = 250;

const logs: PipelineLog[] = [];
let sinkPath: string | undefined;
let rendererSink: ((entry: PipelineLog) => void) | undefined;

function persist(entry: PipelineLog): void {
  if (!sinkPath) return;
  const line = `${JSON.stringify(entry)}\n`;
  void appendFile(sinkPath, line, 'utf8').catch(() => undefined);
}

export function setLogSink(target?: string, renderer?: (entry: PipelineLog) => void): void {
  sinkPath = target;
  rendererSink = renderer;
  if (target) {
    void mkdir(join(target, '..'), { recursive: true }).catch(() => undefined);
  }
}

export type LogPipelineInput = Omit<PipelineLog, 'timestamp' | 'level'> & { level?: LogLevel };

export function logPipeline(input: LogPipelineInput): void {
  const entry: PipelineLog = { timestamp: new Date().toISOString(), level: 'info', ...input };
  logs.push(entry);
  if (logs.length > MAX_IN_MEMORY) {
    logs.splice(0, logs.length - MAX_IN_MEMORY);
  }
  console.log(`[tawny-orch] ${entry.level}: ${entry.event} ${entry.message}`);
  persist(entry);
  try {
    rendererSink?.(entry);
  } catch {
    /* renderer not ready */
  }
}

export function getRecentLogs(): PipelineLog[] {
  return [...logs];
}

export function logsFileName(): string {
  return join(app.getPath('userData'), 'logs', 'orchestrator.jsonl');
}
