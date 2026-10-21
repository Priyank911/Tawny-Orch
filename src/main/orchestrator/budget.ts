import { budgetConfigSchema, type AgentStatus, type BudgetConfig, type RoleKind } from '../../shared/contracts';

export const DEFAULT_BUDGET: BudgetConfig = budgetConfigSchema.parse({});

export interface BudgetEligibility {
  eligible: boolean;
  free: boolean;
  reason: string;
}

/** Hard dispatch checks. Cost/latency scores and vendor names are not entitlements. */
export function budgetEligibility(
  agent: AgentStatus,
  role: RoleKind,
  budget?: BudgetConfig,
  now = Date.now()
): BudgetEligibility {
  const reject = (reason: string): BudgetEligibility => ({ eligible: false, free: false, reason });
  if (!agent.detected || agent.health !== 'ready') return reject('agent not installed or healthy');
  if (!agent.roles.includes(role)) return reject('role not supported');

  const entitlement = budget?.entitlements[agent.id];
  if (agent.authenticated === false || entitlement?.authenticated === false) {
    return reject('authentication unavailable');
  }
  if (agent.remainingRequests === 0 || entitlement?.remainingRequests === 0) {
    return reject('quota exhausted');
  }
  if (entitlement?.expiresAt && Date.parse(entitlement.expiresAt) <= now) {
    return reject('entitlement expired');
  }
  if (!budget) return { eligible: true, free: false, reason: 'legacy routing without budget policy' };

  // Only the built-in human slot is intrinsically local. Other agents may use
  // paid remote models, even when their CLI is open source or their score is 0.
  if (agent.id === 'manual' && agent.family === 'human') {
    return { eligible: true, free: true, reason: 'local manual slot' };
  }
  if (!entitlement?.userConfirmed || entitlement.kind === 'unknown') {
    return reject('explicit user entitlement required');
  }
  if (entitlement.kind === 'free' || entitlement.kind === 'local') {
    // Conflicting nonzero cost metadata must not silently become a free route.
    if (entitlement.maxCostUsd !== undefined && entitlement.maxCostUsd !== 0) {
      return reject('free entitlement has a nonzero dispatch cost');
    }
    return { eligible: true, free: true, reason: `user-confirmed ${entitlement.kind} entitlement` };
  }
  if (budget.policy === 'free-only') return reject('paid entitlement excluded by free-only policy');
  const remainingUsd = Math.max(0, budget.maxUsd - budget.spentUsd);
  if (remainingUsd === 0 || entitlement.maxCostUsd === undefined || entitlement.maxCostUsd <= 0) {
    return reject('paid dispatch requires budget and a positive cost bound');
  }
  if (entitlement.maxCostUsd > remainingUsd) return reject('dispatch cost exceeds remaining budget');
  return { eligible: true, free: false, reason: 'paid dispatch within remaining budget' };
}
