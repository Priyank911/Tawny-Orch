import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentScoreRow, RoleKind } from '../../shared/contracts';
import { agentScoreRowSchema } from '../../shared/contracts';
import { agentScoresFile } from './store';

const DEFAULT_SCORES: AgentScoreRow[] = [
  { agent: 'claude-code', role: 'plan', attempts: 0, passes: 0, avgLatencyMs: 0 },
  { agent: 'claude-code', role: 'execute', attempts: 0, passes: 0, avgLatencyMs: 0 },
  { agent: 'claude-code', role: 'review', attempts: 0, passes: 0, avgLatencyMs: 0 },
  { agent: 'codex', role: 'execute', attempts: 0, passes: 0, avgLatencyMs: 0 },
  { agent: 'codex', role: 'test', attempts: 0, passes: 0, avgLatencyMs: 0 },
  { agent: 'gemini-cli', role: 'research', attempts: 0, passes: 0, avgLatencyMs: 0 },
  { agent: 'gemini-cli', role: 'execute', attempts: 0, passes: 0, avgLatencyMs: 0 },
  { agent: 'gemini-cli', role: 'test', attempts: 0, passes: 0, avgLatencyMs: 0 }
];

export async function loadScores(userDataDir: string): Promise<AgentScoreRow[]> {
  try {
    const raw = await readFile(agentScoresFile(userDataDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_SCORES;
    return parsed
      .map((row) => agentScoreRowSchema.safeParse(row))
      .filter((result) => result.success)
      .map((result) => result.data as AgentScoreRow);
  } catch {
    return DEFAULT_SCORES;
  }
}

export async function saveScores(userDataDir: string, rows: AgentScoreRow[]): Promise<void> {
  const file = agentScoresFile(userDataDir);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(rows, null, 2), 'utf8');
}

export async function recordOutcome(
  userDataDir: string,
  agentId: string,
  role: RoleKind,
  passed: boolean,
  latencyMs: number
): Promise<AgentScoreRow[]> {
  const rows = await loadScores(userDataDir);
  const existing = rows.find((row) => row.agent === agentId && row.role === role);
  const normalizedLatency = latencyMs > 0 ? latencyMs : 0;
  if (existing) {
    existing.attempts += 1;
    if (passed) existing.passes += 1;
    if (normalizedLatency > 0) {
      existing.avgLatencyMs = existing.attempts <= 1
        ? normalizedLatency
        : Math.round(existing.avgLatencyMs * 0.7 + normalizedLatency * 0.3);
    }
  } else {
    rows.push({
      agent: agentId,
      role,
      attempts: 1,
      passes: passed ? 1 : 0,
      avgLatencyMs: normalizedLatency
    });
  }
  await saveScores(userDataDir, rows);
  return rows;
}
