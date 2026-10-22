import { describe, expect, it } from 'vitest';
import { pickAgent, WEIGHTS, type RouterAgent } from '../src/main/orchestrator/router';
import { agentCatalog } from '../src/main/detect/registry';
import type { AgentStatus, AgentScoreRow } from '../src/shared/contracts';

function fakeAgent(id: string, overrides: Partial<AgentStatus> = {}): AgentStatus {
  const catalog = agentCatalog.find((entry) => entry.id === id);
  return {
    id,
    label: catalog?.label ?? id,
    tier: catalog?.tier ?? 'B',
    family: catalog?.family ?? 'other',
    detected: true,
    version: '1.0.0',
    installHint: '',
    health: 'ready',
    costClass: catalog?.costClass ?? 0.5,
    latencyClass: catalog?.latencyClass ?? 0.5,
    roles: (catalog?.roles ?? ['execute', 'test']) as AgentStatus['roles'],
    ...overrides
  };
}

const AGENTS: RouterAgent[] = [
  { status: fakeAgent('claude-code'), currentLoad: 0 },
  { status: fakeAgent('codex'), currentLoad: 0 },
  { status: fakeAgent('gemini-cli'), currentLoad: 0.8 }
].map((entry) => entry);

const stage = (agentId: string | null) => ({
  id: 'execute', title: 'Execute', role: 'execute' as const,
  agentId, acceptanceCommands: [], allowedFiles: [], forbiddenFiles: [], retries: 2
});

describe('router', () => {
  it('keeps weights documented', () => {
    expect(WEIGHTS.pass).toBeGreaterThan(WEIGHTS.cost);
    expect(WEIGHTS.family).toBeGreaterThan(0);
  });

  it('filters undetected agents out', () => {
    const agents = [
      { status: fakeAgent('codex', { detected: false, health: 'not_installed' }), currentLoad: 0 },
      { status: fakeAgent('claude-code'), currentLoad: 0 }
    ];
    const ranked = pickAgent(stage(null), 'execute', agents, []);
    expect(ranked?.agentId).toBe('claude-code');
  });

  it('does not verify with the author family (independent verification)', () => {
    const executedBy = 'codex';
    const stageTest = { ...stage(null), role: 'test' as const, id: 'test' };
    const ranked = pickAgent(stageTest, 'test', AGENTS, [], { executedBy });
    // openai family (codex) must lose the family penalty; keep it out of winner
    expect(ranked?.agentId).not.toBe('codex');
  });

  it('manual fallback exists when nothing matches a role', () => {
    const agents = [{ status: fakeAgent('cursor-agent'), currentLoad: 0 }];
    // Cursor Agent is intentionally restricted to implementation in this catalog.
    const ranked = pickAgent(stage(null), 'research', agents, []);
    expect(ranked?.agentId).toBe('manual');
  });

  it('allows Codex read-only roles supported by its read-only sandbox adapter', () => {
    const ranked = pickAgent(stage(null), 'research', [{ status: fakeAgent('codex'), currentLoad: 0 }], []);
    expect(ranked?.agentId).toBe('codex');
  });

  it('factor load penalties reduce score', () => {
    const idle = [{ status: fakeAgent('gemini-cli'), currentLoad: 0 }];
    const busy = [{ status: fakeAgent('gemini-cli'), currentLoad: 1 }];
    const testStage = { ...stage(null), role: 'test' as const, id: 'test' };
    const idleScore = pickAgent(testStage, 'test', idle, []);
    void busy;
    const busyScore = pickAgent(testStage, 'test', idle.map(({ status }) => ({ status, currentLoad: 1 })), []);
    expect((busyScore?.score ?? 0)).toBeLessThan(idleScore?.score ?? 0);
  });

  it('learns from recorded outcomes (prior rate rises)', () => {
    const scores: AgentScoreRow[] = [
      { agent: 'gemini-cli', role: 'test', attempts: 20, passes: 18, avgLatencyMs: 4000 }
    ];
    const testStage = { ...stage(null), role: 'test' as const, id: 'test' };
    const learned = pickAgent(testStage, 'test', AGENTS, scores);
    expect(learned?.reasons.join(' ')).toMatch(/90%/);
  });
});
