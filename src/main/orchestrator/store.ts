import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunSnapshot } from '../../shared/contracts';
import { runSnapshotSchema } from '../../shared/contracts';
import { atomicWriteFile } from '../storage';

// Run persistence: `userData/orchestrator/runs/<runId>/state.json`, one file
// per run. Crashes keep their state; the renderer reads the same files.

export function runsRoot(userDataDir: string): string {
  return join(userDataDir, 'orchestrator', 'runs');
}

export function runDir(userDataDir: string, runId: string): string {
  // Keep legacy run-* IDs, but reject separators, drive/stream syntax and
  // Windows device names even when the store is accessed on another OS.
  if (typeof runId !== 'string' || runId.length > 255 ||
      !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(runId) || runId.endsWith('.') ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(runId)) {
    throw new Error('Invalid run ID: expected a safe directory name');
  }
  return join(runsRoot(userDataDir), runId);
}

export async function saveRun(userDataDir: string, run: RunSnapshot): Promise<void> {
  const parsed = runSnapshotSchema.parse(run);
  const dir = runDir(userDataDir, parsed.id);
  await atomicWriteFile(join(dir, 'state.json'), JSON.stringify(parsed, null, 2));
}

export async function loadRun(userDataDir: string, runId: string): Promise<RunSnapshot | undefined> {
  try {
    const raw = await readFile(join(runDir(userDataDir, runId), 'state.json'), 'utf8');
    const parsed = runSnapshotSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.id === runId ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function listRuns(userDataDir: string): Promise<RunSnapshot[]> {
  try {
    const entries = await readdir(runsRoot(userDataDir), { withFileTypes: true });
    const runs: RunSnapshot[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const run = await loadRun(userDataDir, entry.name);
      if (run) runs.push(run);
    }
    return runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } catch {
    return [];
  }
}

export function agentScoresFile(userDataDir: string): string {
  return join(userDataDir, 'orchestrator', 'agent_scores.json');
}
