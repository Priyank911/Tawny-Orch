import { describe, expect, it } from 'vitest';
import { scanSecrets, scopeGate, SECRET_PATTERNS } from '../src/main/orchestrator/gates';
import type { TaskContract } from '../src/shared/contracts';

function contractWith(overrides: Partial<TaskContract['constraints']> = {}): TaskContract {
  return {
    runId: 'run-test',
    stageId: 'execute',
    role: 'execute',
    agentId: 'claude-code',
    goal: 'test goal',
    projectPath: 'C:/proj',
    projectName: 'proj',
    worktreePath: '',
    requestedOutputs: [],
    baseBranch: 'main',
    planSummary: '',
    researchSummary: '',
    diffSoFar: [],
    testReport: '',
    reviewFindings: '',
    verifiedHandoffs: [],
    memory: [],
    constraints: {
      allowedFiles: [],
      forbiddenFiles: [],
      acceptanceCommands: [],
      timeoutMinutes: 15,
      ...overrides
    },
    attempts: { attempt: 1, maxAttempts: 3 }
  };
}

describe('secret scan gate', () => {
  it('passes clean output', () => {
    const result = scanSecrets('did the thing successfully');
    expect(result.result).toBe('pass');
  });

  it('flags AWS keys', () => {
    const result = scanSecrets('using key AKIAIOSFODNN7EXAMPLE in config');
    expect(result.result).toBe('fail');
    expect(result.reason).toContain('aws-access-key');
  });

  it('flags exposed env secrets outright', () => {
    const result = scanSecrets('SECRET_KEY = "supersecretvalue123456"');
    expect(result.result).toBe('fail');
    expect(result.reason).toContain('dotenv-exposed');
  });

  it('flags private key pem markers', () => {
    const result = scanSecrets('-----BEGIN RSA PRIVATE KEY-----');
    expect(result.result).toBe('fail');
  });

  it('has a bounded pattern corpus', () => {
    expect(SECRET_PATTERNS.length).toBeGreaterThanOrEqual(6);
  });
});

describe('scope gate', () => {
  it('skips when not git', () => {
    const result = scopeGate('not-git', contractWith());
    expect(result.result).toBe('pass');
    expect(result.reason).toContain('Not a git');
  });

  it('allows in-scope writes', () => {
    const result = scopeGate(['src/auth/oauth.ts'], contractWith({ allowedFiles: ['src/auth/**'] }));
    expect(result.result).toBe('pass');
  });

  it('fails out-of-scope writes', () => {
    const result = scopeGate(['src/payment/billing.ts'], contractWith({ allowedFiles: ['src/auth/**'] }));
    expect(result.result).toBe('fail');
    expect(result.reason).toContain('outside');
  });

  it('fails forbidden paths even when broadly allowed', () => {
    const result = scopeGate(['infra/main.tf'], contractWith({ forbiddenFiles: ['infra/**'] }));
    expect(result.result).toBe('fail');
  });

  it('never lets env files through', () => {
    const result = scopeGate(['.env'], contractWith({ forbiddenFiles: ['.env*'] }));
    expect(result.result).toBe('fail');
  });

  it('accepts wildcard extension scoping', () => {
    const passGate = scopeGate(['src/components/button.tsx'], contractWith({ allowedFiles: ['src/**/*.tsx'] }));
    expect(passGate.result).toBe('pass');
    const failGate = scopeGate(['src/lib/util.ts'], contractWith({ allowedFiles: ['src/**/*.tsx'] }));
    expect(failGate.result).toBe('fail');
  });
});
