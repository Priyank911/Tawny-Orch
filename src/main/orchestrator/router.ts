import {
  budgetConfigSchema, type AgentScoreRow, type AgentStatus, type BudgetConfigInput,
  type RoleKind, type StageSpec
} from '../../shared/contracts';
import { budgetEligibility } from './budget';

// Capability + score routing (architecture doc §6.2 simplified for local use).
// Pins override ranking, never hard eligibility checks. Omitting the budget
// preserves legacy scoring; pass {} to opt into the default free-only policy.

export const WEIGHTS = {
  pass: 0.55,
  cost: 0.15,
  speed: 0.15,
  load: 0.1,
  family: 0.3
} as const;

const PRIOR_PASS_RATE = 0.75;

const FAMILY_OF: Record<string, string> = {
  'claude-code': 'anthropic',
  codex: 'openai',
  'gemini-cli': 'google',
  'cursor-agent': 'cursor',
  opencode: 'other',
  antigravity: 'google',
  'muse-code': 'other',
  'qwen-code': 'other',
  manual: 'human'
};

export interface RouterAgent {
  status: AgentStatus;
  currentLoad: number;
}

export function independentVerificationPenalty(
  candidateAgentId: string,
  authorFamily: string | undefined,
  loadBearers: Map<string, string>,
  candidateFamily = FAMILY_OF[candidateAgentId] ?? 'other'
): number {
  if (!authorFamily || authorFamily === 'human') return 0;

  // The family that wrote or last touched the code must not verify it.
  if (candidateFamily === authorFamily) return WEIGHTS.family;
  const upstreamByLoad = loadBearers.get(candidateAgentId);
  if (upstreamByLoad && upstreamByLoad === authorFamily) return WEIGHTS.family / 2;
  return 0;
}

export function authorFamilyFor(agentId: string | null | undefined): string | undefined {
  if (!agentId) return undefined;
  return FAMILY_OF[agentId];
}

export function priorPassRate(row: AgentScoreRow | undefined): number {
  if (!row || row.attempts < 5) return PRIOR_PASS_RATE;
  return row.passes / Math.max(1, row.attempts);
}

export function scoreStage(
  stage: StageSpec,
  role: RoleKind,
  agents: RouterAgent[],
  scores: AgentScoreRow[],
  authors: { executedBy?: string } = {},
  budgetInput?: BudgetConfigInput
): Array<{ agentId: string; score: number; reasons: string[] }> {
  const budget = budgetInput === undefined ? undefined : budgetConfigSchema.parse(budgetInput);
  const results: Array<{ agentId: string; score: number; reasons: string[] }> = [];
  const freeAgents = new Set<string>();
  const now = Date.now();
  const authorFamily = agents.find((agent) => agent.status.id === authors.executedBy)?.status.family
    ?? authorFamilyFor(authors.executedBy);
  for (const agent of agents) {
    const eligibility = budgetEligibility(agent.status, role, budget, now);
    if (!eligibility.eligible) continue;
    if (eligibility.free) freeAgents.add(agent.status.id);
    const reasons: string[] = budget ? [eligibility.reason] : [];
    const row = scores.find((candidate) => candidate.agent === agent.status.id && candidate.role === role);
    const pass = priorPassRate(row);
    reasons.push(`pass-rate ${(pass * 100).toFixed(0)}%`);
    const cost = (1 - agent.status.costClass) * WEIGHTS.cost;
    const speed = (1 - agent.status.latencyClass) * WEIGHTS.speed;
    const loadPenalty = WEIGHTS.load * agent.currentLoad;
    const independent = role === 'test' || role === 'review';
    const familyPenalty = independent
      ? independentVerificationPenalty(agent.status.id, authorFamily, new Map(), agent.status.family)
      : 0;
    const score = Number(
      (
        WEIGHTS.pass * pass + cost + speed - loadPenalty - familyPenalty
      ).toFixed(4)
    );
    if (budget && familyPenalty > 0) continue;
    if (familyPenalty > 0) reasons.push('same family as author');
    if (agent.currentLoad > 0) reasons.push(`load ${agent.currentLoad.toFixed(2)}`);
    results.push({ agentId: agent.status.id, score, reasons });
  }
  results.sort((left, right) => {
    if (budget?.policy === 'free-first') {
      const freePreference = Number(freeAgents.has(right.agentId)) - Number(freeAgents.has(left.agentId));
      if (freePreference !== 0) return freePreference;
    }
    return right.score - left.score;
  });
  const pinnedIndex = results.findIndex((result) => result.agentId === stage.agentId);
  if (pinnedIndex >= 0) {
    const [pinned] = results.splice(pinnedIndex, 1);
    pinned.reasons.push('eligible stage pin');
    results.unshift(pinned);
  }
  return results;
}

/**
 * Pass settings.budget ?? {} as the sixth argument to enable conservative defaults.
 * Budget-aware routing returns undefined if no supplied agent is eligible; callers
 * must not replace that result with an unchecked agent. Eligible pins override
 * policy ranking. The caller owns spend/quota accounting and dispatch reservations.
 */
export function pickAgent(
  stage: StageSpec,
  role: RoleKind,
  agents: RouterAgent[],
  scores: AgentScoreRow[],
  authors: { executedBy?: string } = {},
  budgetInput?: BudgetConfigInput
): { agentId: string; score: number; reasons: string[] } | undefined {
  const ranked = scoreStage(stage, role, agents, scores, authors, budgetInput);
  if (ranked.length === 0 && budgetInput === undefined) {
    // Compatibility only: policy-aware callers must supply an eligible manual slot.
    return { agentId: 'manual', score: 0, reasons: ['no detected agent for this role — manual fallback'] };
  }
  return ranked[0];
}
