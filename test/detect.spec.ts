import { describe, expect, it } from 'vitest';
import { agentCatalog, isVersionLike, probeVersion, whereCommand } from '../src/main/detect/registry';
import { fromCatalog } from '../src/main/detect/agents';
import { parseAgyStreamJson, parseClaudeStreamJson, parseCodexJson, parseTailNarrative, runChild } from '../src/main/agents/childRunner';
import { templateById } from '../src/main/orchestrator/templates';

describe('agent catalog', () => {
  it('covers the known terminals with install hints', () => {
    const ids = agentCatalog.map((entry) => entry.id);
    for (const id of ['claude-code', 'codex', 'gemini-cli', 'cursor-agent', 'opencode', 'antigravity', 'muse-code', 'qwen-code', 'manual']) {
      expect(ids).toContain(id);
    }
    expect(agentCatalog.find((entry) => entry.id === 'antigravity')).toMatchObject({ command: 'agy', tier: 'A', family: 'google' });
    for (const entry of agentCatalog) {
      if (entry.id !== 'manual') expect(entry.installHint.length).toBeGreaterThan(8);
    }
  });

  it('manual slot always resolves as part of the pipeline', () => {
    const manual = agentCatalog.find((entry) => entry.id === 'manual');
    expect(manual?.command).toBe('');
  });

  it('probe output looks like a version', () => {
    expect(isVersionLike('1.0.32 (Claude Code)')).toBe(true);
    expect(isVersionLike('codex-cli 0.44.0')).toBe(true);
    expect(isVersionLike('')).toBe(false);
  });

  it('fromCatalog preserves tier + roles', () => {
    const claudeEntry = agentCatalog.find((entry) => entry.id === 'claude-code')!;
    const status = fromCatalog(claudeEntry, true, '1.0.0');
    expect(status.tier).toBe('A');
    expect(status.family).toBe('anthropic');
    expect(status.roles).toContain('plan');
  });

  it('probes installed Antigravity and OpenCode CLIs through Windows PATH shims', async () => {
    for (const id of ['antigravity', 'opencode']) {
      const entry = agentCatalog.find((candidate) => candidate.id === id)!;
      if (!(await whereCommand(entry.command))) continue;
      const version = await probeVersion(entry);
      expect(version, `${entry.label} was found but its version probe failed`).toMatch(/\d+\.\d+/);
    }
  }, 20_000);
});

describe('vendor output parsers', () => {
  it('finds the final claude result event', () => {
    const stream = [
      '{"type":"system","subtype":"init","cwd":"D:/x"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"Did the OAuth flow."}'
    ].join('\n');
    const parsed = parseClaudeStreamJson(stream);
    expect(parsed?.summary).toBe('Did the OAuth flow.');
    expect(parsed?.isFailure).toBe(false);
  });

  it('marks claude error results as failures', () => {
    const stream = '{"type":"result","subtype":"error_max_turns","is_error":true,"result":"hit cap"}';
    expect(parseClaudeStreamJson(stream)?.isFailure).toBe(true);
  });

  it('recovers the last codex agent_message', () => {
    const stream = [
      '{"msg":{"type":"task_started"}}',
      '{"msg":{"type":"agent_message","message":"Wrote codex tests for auth."}}'
    ].join('\n');
    expect(parseCodexJson(stream)?.summary).toContain('tests for auth');
  });

  it('parses Antigravity CLI NDJSON output and recognizes non-success results', () => {
    const output = [
      '{"event":"init","init":{"cwd":"D:/project"}}',
      '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"Updated the "}}',
      '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"implementation."}}',
      '{"event":"result","result":{"status":"SUCCESS","response":"Updated the implementation.\\n"}}'
    ].join('\n');
    expect(parseAgyStreamJson(output)).toEqual({ summary: 'Updated the implementation.', isFailure: false });
    expect(parseAgyStreamJson('{"event":"result","result":{"status":"ERROR","error":"auth required"}}'))
      .toEqual({ summary: 'auth required', isFailure: true });
  });

  it('falls back to narrative tails', () => {
    const output = 'step one ok\n=== BUILD OK ===\nWrote 2 files and ran 5 tests.';
    const parsed = parseTailNarrative(output);
    expect(parsed.summary).toContain('2 files');
  });

  it('treats empty tails as failures', () => {
    expect(parseTailNarrative('   ').isFailure).toBe(true);
  });

  it('runChild enforces timeouts and cancellation shape', async () => {
    // PowerShell wait is 3x slower than cmd; use cmd timeout which is universally
    // present on Windows dev machines.
    const result = await runChild('cmd', ['/c', 'ping -n 8 127.0.0.1 > nul'], {
      cwd: process.cwd(),
      timeoutMs: 1200
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode === 0).toBeFalsy();
  }, 15_000);

  it('runChild exits clean on quick commands', async () => {
    const result = await runChild('cmd', ['/c', 'echo hello'], { cwd: process.cwd(), timeoutMs: 15_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  }, 20_000);
});

describe('templates remain pinned to detected vendor ids', () => {
  it('all template agent ids exist in the catalog', () => {
    for (const template of [templateById('solo'), templateById('duo'), templateById('cross-vendor')]) {
      for (const stage of template?.stages ?? []) {
        if (stage.agentId) {
          expect(agentCatalog.some((entry) => entry.id === stage.agentId)).toBe(true);
        }
      }
    }
  });
});
