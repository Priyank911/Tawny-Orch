import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { MemoryCategory, MemoryEntry } from '../../shared/contracts';

// Shared memory ledger per project: `.tawny-orch/memory.jsonl`.
// Only the engine writes entries; contracts embed the latest entries so every
// agent starts from the same conventions, decisions, and failures.

const MEMORY_FILE = 'memory.jsonl';

export function memoryFilePath(projectPath: string): string {
  return join(projectPath, '.tawny-orch', MEMORY_FILE);
}

export async function readMemory(projectPath: string, limit = 12): Promise<MemoryEntry[]> {
  try {
    const raw = await readFile(memoryFilePath(projectPath), 'utf8');
    const entries = raw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => safeParse(line))
      .filter((value): value is MemoryEntry => value !== undefined);
    // Newest entries matter most for prompt context.
    return entries.slice(-limit);
  } catch {
    return [];
  }
}

function safeParse(line: string): MemoryEntry | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed && typeof parsed === 'object' && 'category' in parsed && 'content' in parsed) {
      return parsed as MemoryEntry;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

const MAX_ENTRY_CHARS = 4000;

export async function writeMemoryEntries(
  projectPath: string,
  entries: Array<{ category: MemoryCategory; content: string; sourceRunId: string }>
): Promise<MemoryEntry[]> {
  if (entries.length === 0) return [];
  const file = memoryFilePath(projectPath);
  await mkdir(join(file, '..'), { recursive: true });
  const written: MemoryEntry[] = [];
  let existing: MemoryEntry[] = [];
  try {
    existing = await readMemory(projectPath, 500);
  } catch {
    existing = [];
  }
  const seen = new Set(existing.map((entry) => `${entry.category}:${entry.content}`));
  const fresh = entries.filter((entry) => !seen.has(`${entry.category}:${entry.content}`));
  const lines = fresh
    .map((entry): MemoryEntry => ({
      id: `mem-${Date.now().toString(36)}-${existing.length + written.length}`,
      category: entry.category,
      content: entry.content.slice(0, MAX_ENTRY_CHARS),
      sourceRunId: entry.sourceRunId,
      createdAt: new Date().toISOString(),
      confidence: 0.9
    }));
  for (const entry of lines) {
    await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
    written.push(entry);
  }
  return written;
}

// Used by the engine: gate failures immediately become durable lessons.
export function failureEntries(runId: string, failures: string[]): Array<{ category: MemoryCategory; content: string; sourceRunId: string }> {
  return failures
    .filter((reason) => reason.trim().length > 0)
    .map((reason) => ({ category: 'failures' as MemoryCategory, content: reason.slice(0, MAX_ENTRY_CHARS), sourceRunId: runId }));
}
