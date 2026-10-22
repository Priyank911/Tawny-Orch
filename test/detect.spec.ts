import { describe, expect, it } from 'vitest';
import { agentCatalog, isVersionLike, probeVersion, whereCommand } from '../src/main/detect/registry';
import { fromCatalog } from '../src/main/detect/agents';
import { parseAgyStreamJson, parseClaudeStreamJson, parseCodexJson, parseGeminiJson, parseOpenCodeJson, parseQwenJson, parseSessionId, parseTailNarrative, runChild } from '../src/main/agents/childRunner';
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
    expect(isVersionLike('WARNING: access denied\ncodex-cli 0.156.1')).toBe(true);
    expect(isVersionLike('')).toBe(false);
  });

  it('fromCatalog preserves tier + roles', () => {
    const claudeEntry = agentCatalog.find((entry) => entry.id === 'claude-code')!;
    const status = fromCatalog(claudeEntry, true, '1.0.0');
    expect(status.tier).toBe('A');
    expect(status.family).toBe('anthropic');
    expect(status.roles).toContain('plan');
    expect(agentCatalog.find((entry) => entry.id === 'codex')?.roles).toEqual(['research', 'plan', 'execute', 'test', 'review', 'deliver']);
    expect(agentCatalog.find((entry) => entry.id === 'opencode')?.roles).toEqual(['research', 'plan', 'execute', 'test', 'review', 'deliver']);
    expect(agentCatalog.find((entry) => entry.id === 'qwen-code')?.roles).toEqual(['research', 'plan', 'execute', 'test', 'review', 'deliver']);
  });

  it('probes installed Codex, Antigravity, and OpenCode CLIs through their PATH shims', async () => {
    for (const id of ['codex', 'antigravity', 'opencode']) {
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

  it('extracts provider session IDs from structured events and ignores unsafe values', () => {
    expect(parseSessionId('{"type":"thread.started","thread_id":"123e4567-e89b-12d3-a456-426614174000"}'))
      .toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(parseSessionId('{"type":"step_start","sessionID":"ses_abcdefgh1234"}')).toBe('ses_abcdefgh1234');
    expect(parseSessionId('{"session_id":"../../secrets"}')).toBeUndefined();
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

  it('parses Gemini JSON envelopes, OpenCode event streams, and Qwen result arrays', () => {
    expect(parseGeminiJson(JSON.stringify({ response: 'Gemini handoff' }))).toEqual({ summary: 'Gemini handoff', isFailure: false });
    expect(parseGeminiJson(JSON.stringify({ error: { message: 'quota exceeded' } }))).toMatchObject({ isFailure: true });
    expect(parseOpenCodeJson([
      JSON.stringify({ type: 'step_start', sessionID: 'ses_1' }),
      JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: '{"status":"completed"}' } }),
      JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } })
    ].join('\n'))?.summary).toBe('{"status":"completed"}');
    expect(parseOpenCodeJson([
      JSON.stringify({ type: 'text', messageID: 'msg_commentary', part: { type: 'text', text: "Now I'll create the plan." } }),
      JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason: 'tool-calls' } })
    ].join('\n'))).toMatchObject({ isFailure: true, summary: expect.stringContaining('before a final response') });
    expect(parseOpenCodeJson([
      JSON.stringify({ type: 'text', messageID: 'msg_1', part: { type: 'text', text: 'interim commentary' } }),
      JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason: 'tool-calls' } }),
      JSON.stringify({ type: 'text', messageID: 'msg_2', part: { type: 'text', text: '{"status":' } }),
      JSON.stringify({ type: 'text', messageID: 'msg_2', part: { type: 'text', text: '"completed"}' } }),
      JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } })
    ].join('\n'))).toEqual({ summary: '{"status":"completed"}', isFailure: false });
    expect(parseOpenCodeJson(JSON.stringify({ type: 'error', error: { data: { message: 'provider unavailable' } } }))).toMatchObject({ isFailure: true });
    expect(parseQwenJson(JSON.stringify([{ type: 'system', subtype: 'session_start' }, { type: 'result', subtype: 'success', result: 'Qwen handoff' }])))
      .toEqual({ summary: 'Qwen handoff', isFailure: false });
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
    const result = await runChild(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], {
      cwd: process.cwd(),
      timeoutMs: 1200
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode === 0).toBeFalsy();
  }, 15_000);

  it('runChild exits clean on quick commands', async () => {
    const streams: string[] = [];
    let pid: number | undefined;
    const result = await runChild(process.execPath, ['-e', 'process.stdout.write("hello")'], {
      cwd: process.cwd(), timeoutMs: 15_000,
      onSpawn: (value) => { pid = value; },
      onOutput: (stream, text) => streams.push(`${stream}:${text}`)
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(pid).toBeGreaterThan(0);
    expect(streams.join('')).toContain('stdout:hello');
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
