import { describe, expect, it } from 'vitest';
import {
  agentStatusSchema, appSettingsSchema, budgetConfigSchema, settingsUpdateSchema, stageSpecSchema,
  type AgentStatus, type BudgetConfigInput
} from '../src/shared/contracts';
import { budgetEligibility, DEFAULT_BUDGET } from '../src/main/orchestrator/budget';
import { pickAgent, scoreStage, WEIGHTS, type RouterAgent } from '../src/main/orchestrator/router';

const stage = stageSpecSchema.parse({ id: 'execute', role: 'execute' });
const free = { kind: 'free', userConfirmed: true } as const;
const paid = { kind: 'paid', userConfirmed: true, maxCostUsd: 0.2 } as const;

function agent(id: string, overrides: Partial<AgentStatus> = {}): RouterAgent {
  return {
    status: agentStatusSchema.parse({
      id, label: id, tier: 'B', family: 'other', detected: true,
      costClass: 0, latencyClass: 0, roles: ['execute', 'test', 'review'], ...overrides
    }),
    currentLoad: 0
  };
}

function pick(agents: RouterAgent[], budget: BudgetConfigInput = {}, pin: string | null = null) {
  return pickAgent({ ...stage, agentId: pin }, 'execute', agents, [], {}, budget);
}

function eligibility(status: AgentStatus, input: BudgetConfigInput = {}) {
  return budgetEligibility(status, 'execute', budgetConfigSchema.parse(input));
}

describe('budget contracts', () => {
  it('defaults to free-only with a zero dollar cap', () => {
    expect(budgetConfigSchema.parse({})).toEqual({
      policy: 'free-only', maxUsd: 0, spentUsd: 0, entitlements: {}
    });
    expect(DEFAULT_BUDGET).toEqual(budgetConfigSchema.parse({}));
  });

  it('keeps old agent and settings parse callers compatible', () => {
    expect(agent('codex').status.authenticated).toBeUndefined();
    expect(appSettingsSchema.parse({}).budget).toBeUndefined();
    expect(settingsUpdateSchema.parse({ settings: {} }).settings).toEqual(appSettingsSchema.parse({}));
    expect(appSettingsSchema.parse({ budget: {} }).budget).toEqual(DEFAULT_BUDGET);
    expect(settingsUpdateSchema.parse({ settings: { budget: {} } }).settings.budget).toEqual(DEFAULT_BUDGET);
  });

  it('preserves optional entitlement metadata through settings parsing', () => {
    const budget = { entitlements: { codex: { ...free, remainingRequests: 2, expiresAt: '2999-01-01T00:00:00Z' } } };
    expect(appSettingsSchema.parse({ budget }).budget?.entitlements.codex).toEqual(budget.entitlements.codex);
  });

  it.each([
    { maxUsd: -1 }, { spentUsd: -1 }, { maxUsd: Infinity }, { policy: 'cheap' },
    { entitlements: { codex: { remainingRequests: -1 } } },
    { entitlements: { codex: { maxCostUsd: -1 } } },
    { entitlements: { codex: { expiresAt: 'not-a-date' } } }
  ])('rejects invalid budget metadata: %j', (input) => {
    expect(budgetConfigSchema.safeParse(input).success).toBe(false);
  });
});

describe('conservative eligibility and pins', () => {
  it.each(['gemini-cli', 'qwen-code', 'opencode', 'codex', 'claude-code', 'unknown-agent'])(
    'never infers free access for %s from vendor or zero costClass', (id) => {
      expect(pick([agent(id)], {}, id)).toBeUndefined();
    }
  );

  it('does not fabricate manual availability under a policy', () => {
    expect(pick([])).toBeUndefined();
    expect(pick([agent('manual', { family: 'human', detected: false })])).toBeUndefined();
    expect(pick([agent('manual', { family: 'human', roles: [] })])).toBeUndefined();
  });

  it('allows the actual local manual slot without a vendor entitlement', () => {
    const result = pick([agent('manual', { family: 'human' })]);
    expect(result?.agentId).toBe('manual');
    expect(result?.reasons).toContain('local manual slot');
    expect(pick([agent('manual', { family: 'other' })])).toBeUndefined();
  });

  it('allows user-confirmed local models but not unconfirmed local claims', () => {
    const agents = [agent('local-model')];
    expect(pick(agents, { entitlements: { 'local-model': { kind: 'local' } } })).toBeUndefined();
    expect(pick(agents, { entitlements: { 'local-model': { kind: 'local', userConfirmed: true } } })?.agentId)
      .toBe('local-model');
  });

  it.each([
    { kind: 'free' }, { kind: 'paid' }, { kind: 'unknown', userConfirmed: true },
    { ...free, maxCostUsd: 0.01 }, paid
  ])('excludes a non-free pin and chooses an eligible alternative: %j', (entitlement) => {
    const result = pick([agent('paid-pin'), agent('safe')], {
      maxUsd: 100, entitlements: { 'paid-pin': entitlement, safe: free }
    } as BudgetConfigInput, 'paid-pin');
    expect(result?.agentId).toBe('safe');
  });

  it.each([
    { detected: false }, { health: 'not_installed' }, { health: 'probe_failed' },
    { roles: ['research'] }, { authenticated: false }, { remainingRequests: 0 }
  ] satisfies Partial<AgentStatus>[])('filters hard eligibility before pins: %j', (override) => {
    expect(pick([agent('pin', override), agent('safe')], {
      entitlements: { pin: free, safe: free }
    }, 'pin')?.agentId).toBe('safe');
  });

  it.each([
    { ...free, authenticated: false }, { ...free, remainingRequests: 0 },
    { ...free, expiresAt: '2000-01-01T00:00:00Z' }
  ])('excludes unavailable entitlement pins: %j', (entitlement) => {
    expect(pick([agent('pin'), agent('safe')], {
      entitlements: { pin: entitlement, safe: free }
    }, 'pin')?.agentId).toBe('safe');
  });

  it('does not let declared availability override known runtime exhaustion or failed auth', () => {
    const budget = { entitlements: { pin: { ...free, authenticated: true, remainingRequests: 20 } } };
    expect(pick([agent('pin', { authenticated: false })], budget, 'pin')).toBeUndefined();
    expect(pick([agent('pin', { remainingRequests: 0 })], budget, 'pin')).toBeUndefined();
  });

  it('permits unknown auth/headroom only with a confirmed free entitlement', () => {
    expect(pick([agent('pin')], { entitlements: { pin: free } }, 'pin')?.reasons)
      .toContain('eligible stage pin');
  });

  it('treats expiry at the current instant as expired, even with headroom', () => {
    const now = Date.parse('2026-10-21T12:00:00Z');
    const budget = budgetConfigSchema.parse({
      entitlements: { pin: { ...free, remainingRequests: 100, expiresAt: new Date(now).toISOString() } }
    });
    expect(budgetEligibility(agent('pin').status, 'execute', budget, now).reason).toBe('entitlement expired');
    expect(budgetEligibility(agent('pin').status, 'execute', budget, now - 1).eligible).toBe(true);
  });

  it('uses pins only after eligibility, even when their score is lower', () => {
    const pinned = agent('pin', { costClass: 1, latencyClass: 1 });
    expect(pick([agent('fast'), pinned], { entitlements: { fast: free, pin: free } }, 'pin')?.agentId).toBe('pin');
    expect(pick([agent('fast')], { entitlements: { fast: free } }, 'missing')?.agentId).toBe('fast');
  });
});

describe('paid budget and policy ordering', () => {
  it.each(['free-first', 'quality-first'] as const)('requires explicit bounded paid access under %s', (policy) => {
    const candidates = [agent('paid')];
    expect(pick(candidates, { policy, entitlements: { paid } })).toBeUndefined();
    expect(pick(candidates, { policy, maxUsd: 1 })).toBeUndefined();
    expect(pick(candidates, { policy, maxUsd: 1, entitlements: { paid: { kind: 'paid', userConfirmed: true } } }))
      .toBeUndefined();
    expect(pick(candidates, { policy, maxUsd: 1, entitlements: { paid: { ...paid, maxCostUsd: 0 } } }))
      .toBeUndefined();
    expect(pick(candidates, { policy, maxUsd: 1, entitlements: { paid } })?.agentId).toBe('paid');
  });

  it.each(['free-first', 'quality-first'] as const)('excludes exhausted/over-cap paid pins under %s', (policy) => {
    for (const spentUsd of [0.9, 1, 2]) {
      expect(pick([agent('paid'), agent('safe')], {
        policy, maxUsd: 1, spentUsd, entitlements: { paid, safe: free }
      }, 'paid')?.agentId).toBe('safe');
    }
    expect(pick([agent('paid')], { policy, maxUsd: 0.2, entitlements: { paid } }, 'paid')?.agentId).toBe('paid');
  });

  it('ranks free access before a higher scoring paid route under free-first', () => {
    const candidates = [agent('paid'), agent('free', { costClass: 1, latencyClass: 1 })];
    const budget: BudgetConfigInput = { policy: 'free-first', maxUsd: 1, entitlements: { paid, free } };
    expect(pick(candidates, budget)?.agentId).toBe('free');
    expect(pick(candidates, { ...budget, policy: 'quality-first' })?.agentId).toBe('paid');
    // An explicit eligible pin overrides preference, but never the cap.
    expect(pick(candidates, budget, 'paid')?.agentId).toBe('paid');
    expect(pick(candidates, { ...budget, spentUsd: 1 }, 'paid')?.agentId).toBe('free');
  });

  it('falls back to bounded paid access when free-first quota is exhausted', () => {
    expect(pick([agent('free'), agent('paid')], {
      policy: 'free-first', maxUsd: 1,
      entitlements: { free: { ...free, remainingRequests: 0 }, paid }
    })?.agentId).toBe('paid');
  });

  it('still permits zero-cost dispatches after the paid cap is exhausted', () => {
    expect(eligibility(agent('free').status, {
      maxUsd: 1, spentUsd: 2, entitlements: { free }
    }).eligible).toBe(true);
  });
});

describe('family eligibility and legacy calls', () => {
  describe.each(['free-only', 'free-first', 'quality-first'] as const)('%s verification', (policy) => {
    it.each(['test', 'review'] as const)('hard excludes same-family %s agents, including pins', (role) => {
      const agents = [
        agent('custom-writer', { family: 'openai' }),
        agent('custom-verifier', { family: 'openai' }),
        agent('independent', { family: 'google' })
      ];
      const verification = { ...stage, role, agentId: 'custom-verifier' };
      const budget = { policy, entitlements: { 'custom-verifier': free, independent: free } };
      const authors = { executedBy: 'custom-writer' };
      const ranked = scoreStage(verification, role, agents, [], authors, budget);
      // Author is budget-ineligible, but its family still informs verification.
      expect(ranked.map((row) => row.agentId)).toEqual(['independent']);
      expect(pickAgent(verification, role, agents, [], authors, budget)?.agentId).toBe('independent');
      expect(pickAgent(verification, role, agents.slice(0, 2), [], authors, budget)).toBeUndefined();
      expect(pickAgent(verification, role, [
        ...agents.slice(0, 2), agent('manual', { family: 'human' })
      ], [], authors, budget)?.agentId).toBe('manual');
    });
  });

  it.each(['test', 'review'] as const)('retains the soft family penalty for legacy %s calls', (role) => {
    const agents = [
      agent('custom-writer', { family: 'openai' }),
      agent('custom-verifier', { family: 'openai' }),
      agent('independent', { family: 'google' })
    ];
    const authors = { executedBy: 'custom-writer' };
    const ranked = scoreStage({ ...stage, role }, role, agents, [], authors);
    const sameFamily = ranked.find((row) => row.agentId === 'custom-verifier')!;
    expect(ranked).toHaveLength(3);
    expect(ranked[0].agentId).toBe('independent');
    expect(sameFamily.reasons).toContain('same family as author');
    expect(ranked[0].score - sameFamily.score).toBeCloseTo(WEIGHTS.family);
    expect(pickAgent({ ...stage, role }, role, agents.slice(1, 2), [], authors)?.agentId).toBe('custom-verifier');
  });

  it('does not apply the family penalty to execution or human authors', () => {
    const agents = [agent('writer', { family: 'openai' }), agent('verifier', { family: 'openai' })];
    const budget = { entitlements: { writer: free, verifier: free } };
    expect(scoreStage(stage, 'execute', agents, [], { executedBy: 'writer' }, budget)[0].reasons)
      .not.toContain('same family as author');
    expect(scoreStage(stage, 'review', agents, [], { executedBy: 'manual' }, budget)[0].reasons)
      .not.toContain('same family as author');
  });

  it('retains score routing and the manual fallback when no policy is passed', () => {
    expect(pickAgent(stage, 'execute', [agent('unknown-agent')], [])?.agentId).toBe('unknown-agent');
    expect(pickAgent(stage, 'execute', [], [])?.agentId).toBe('manual');
    expect(pickAgent(stage, 'execute', [agent('unhealthy', { health: 'probe_failed' }), agent('healthy')], [])?.agentId)
      .toBe('healthy');
  });
});
