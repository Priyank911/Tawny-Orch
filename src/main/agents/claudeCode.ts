import type { AgentAdapter, AdapterContext, AdapterHandle } from './base';
import type { ArtifactBundle, AgentTier } from '../../shared/contracts';
import { abort, isReadOnlyContract, runHeadless, type HeadlessPlan } from './headless';
import { parseClaudeStreamJson } from './childRunner';

const plan: HeadlessPlan = {
  commandLine: 'claude',
  // CLI reference: code.claude.com/docs/en/cli-reference. --tools is an
  // availability restriction; --allowedTools alone is not an allowlist.
  args: (contract) => ['-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', isReadOnlyContract(contract) ? 'plan' : 'acceptEdits',
    '--tools', isReadOnlyContract(contract) ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write',
    '--disallowedTools', 'mcp__*', '--strict-mcp-config', '--max-turns', '60'],
  parse: parseClaudeStreamJson
};

export const claudeCodeAdapter: AgentAdapter = {
  id: 'claude-code',
  name: 'Claude Code',
  tier: 'A',
  start: async (context: AdapterContext): Promise<AdapterHandle> => ({
    key: `${context.contract.runId}:${context.contract.stageId}:claude-code`,
    ctx: context,
    extras: {}
  }),
  collect: async (handle: AdapterHandle): Promise<ArtifactBundle> =>
    runHeadless(handle.ctx.contract, handle.ctx, plan),
  cancel: async (handle: AdapterHandle) => {

    abort(handle.ctx.contract);
  }
};

export const claudeCodeTier: AgentTier = 'A';
