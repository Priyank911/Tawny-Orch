import { describe, expect, it } from 'vitest';
import { parseVoiceCommand, normalize } from '../src/main/pipeline/voice';

const noFolder: { attachedProjectPath?: string } = {};

describe('voice grammar routing', () => {
  it('normalizes hostile whitespace and punctuation', () => {
    expect(normalize('  Hey,   TAWN&Y!!   build  a  thing ')).toContain('hey tawn');
    expect(normalize('a  b')).not.toContain('  ');
  });

  it('requires a wake phrase unless alwaysRoute', () => {
    const notRouted = parseVoiceCommand({ transcript: 'build a login page', alwaysRoute: false, ...noFolder });
    expect(notRouted.routed).toBe(false);
    expect(notRouted.decision.intent).toBe('dictation_goal');

    const routed = parseVoiceCommand({ transcript: 'build a login page', alwaysRoute: true, ...noFolder });
    expect(routed.routed).toBe(true);
    expect(routed.decision.goal).toContain('build a login page');
  });

  it('matches fuzzy wake phrases (edit distance ≤ 2)', () => {
    const result = parseVoiceCommand({ transcript: 'hey tawny build a login page', alwaysRoute: false, ...noFolder });
    expect(result.routed).toBe(true);
    expect(result.decision.goal).toContain('build a login page');
  });

  it('stops the run on stop commands', () => {
    const result = parseVoiceCommand({ transcript: 'hey tawny stop the run', alwaysRoute: false, ...noFolder });
    expect(result.decision.intent).toBe('stop_run');
  });

  it('parses status requests', () => {
    const result = parseVoiceCommand({ transcript: 'what is the status of the run', alwaysRoute: true, ...noFolder });
    expect(result.decision.intent).toBe('status');
  });

  it('attaches a windows folder', () => {
    const result = parseVoiceCommand({ transcript: 'attach folder D:\\projects\\demo', alwaysRoute: false, ...noFolder });
    expect(result.decision.intent).toBe('attach_folder');
    expect(result.decision.projectPath.toLowerCase()).toContain('d:');
    expect(result.decision.projectPath).toContain('demo');
  });

  it('extracts in-folder goals for build commands', () => {
    const result = parseVoiceCommand({
      transcript: 'hey tawny build a todo app in D:\\work\\todo',
      alwaysRoute: false,
      ...noFolder
    });
    expect(result.decision.intent).toBe('build_in_project');
    expect(result.decision.projectPath.toLowerCase()).toContain(':\\work\\todo');
    expect(result.decision.goal.toLowerCase()).toContain('todo app');
  });

  it('parses new project speech with name and folder', () => {
    const result = parseVoiceCommand({
      transcript: 'create a new project called Atlas in D:\\dev\\atlas',
      alwaysRoute: true,
      ...noFolder
    });
    expect(result.decision.intent).toBe('new_project');
    expect(result.decision.projectName).toBe('Atlas');
    expect(result.decision.projectPath.toLowerCase()).toContain('atlas');
    expect(result.decision.goal).toContain('Atlas');
  });

  it('assigns roles to agents through speech', () => {
    const result = parseVoiceCommand({ transcript: 'assign testing to gemini', alwaysRoute: true, ...noFolder });
    expect(result.decision.intent).toBe('assign_role');
    expect(result.decision.role).toBe('test');
    expect(result.decision.agentId).toBe('gemini-cli');
  });

  it('assigns claude code aliases', () => {
    const result = parseVoiceCommand({ transcript: 'assign review stage to claude code', alwaysRoute: true, ...noFolder });
    expect(result.decision.agentId).toBe('claude-code');
  });

  it('falling back keeps uncertainty on the goal side', () => {
    const result = parseVoiceCommand({ transcript: 'hey tawny refactor the checkout flow for performance', alwaysRoute: false, ...noFolder });
    expect(result.routed).toBe(true);
    expect(result.decision.intent).toBe('build_in_project');
    expect(result.decision.goal).toContain('checkout');
  });

  it('returns vacuous decision on empty transcript', () => {
    const result = parseVoiceCommand({ transcript: '', alwaysRoute: false, ...noFolder });
    expect(result.routed).toBe(false);
  });
});
