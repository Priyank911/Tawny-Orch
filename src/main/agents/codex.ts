import type { AgentAdapter, AdapterContext, AdapterHandle } from './base';
import type { ArtifactBundle } from '../../shared/contracts';
import { abort, isReadOnlyContract, runHeadless, type HeadlessPlan } from './headless';
import { parseCodexJson, parseSessionId } from './childRunner';

const plan: HeadlessPlan = {
  commandLine: 'codex',
  // developers.openai.com/codex/cli/reference: approval_policy via -c also
  // works on exec versions that do not accept the global -a after the subcommand.
  args: (contract) => ['exec', '--json', '--sandbox', isReadOnlyContract(contract) ? 'read-only' : 'workspace-write',
    '-c', 'approval_policy=never', '--skip-git-repo-check', '-'],
  parse: parseCodexJson,
  sessionId: parseSessionId
};

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  name: 'Codex (OpenAI)',
  tier: 'A',
  start: async (context: AdapterContext): Promise<AdapterHandle> => ({
    key: `${context.contract.runId}:${context.contract.stageId}:codex`,
    ctx: context,
    extras: {}
  }),
  collect: async (handle: AdapterHandle): Promise<ArtifactBundle> =>
    runHeadless(handle.ctx.contract, handle.ctx, plan),
  cancel: async (handle: AdapterHandle) => {

    abort(handle.ctx.contract);
  }
};
