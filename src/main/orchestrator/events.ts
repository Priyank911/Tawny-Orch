import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { OrchEvent } from '../../shared/contracts';

// Append-only event ledger. Every run/stage/agent boundary lands here first;
// the renderer receives a sanitized copy through the orchestrator bridge.

type Listener = (event: OrchEvent) => void;

let listener: Listener | undefined;

export function setEventSink(sink: Listener): void {
  listener = sink;
}

interface EmitEventInput {
  type: string;
  message: string;
  runId?: string;
  stageId?: string;
  agentId?: string;
  level?: OrchEvent['level'];
  data?: Record<string, string>;
}

const filePath = (root: string): string => join(root, 'orchestrator', 'events.jsonl');

export async function emitEvent(root: string, input: EmitEventInput): Promise<OrchEvent> {
  const event: OrchEvent = {
    ts: new Date().toISOString(),
    level: input.level ?? 'info',
    type: input.type,
    runId: input.runId,
    stageId: input.stageId,
    agentId: input.agentId,
    message: input.message,
    data: input.data
  };
  try {
    await mkdir(join(filePath(root), '..'), { recursive: true });
    await appendFile(filePath(root), `${JSON.stringify(event)}\n`, 'utf8');
  } catch {
    /* the ledger must never block the pipeline */
  }
  try {
    listener?.(event);
  } catch {
    /* renderer not ready */
  }
  return event;
}

export function eventsFilePath(root: string): string {
  return filePath(root);
}
