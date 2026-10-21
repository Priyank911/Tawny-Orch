import type { AgentAdapter, AdapterContext, AdapterHandle } from './base';
import type { ArtifactBundle } from '../../shared/contracts';
import { abort, isReadOnlyContract, runHeadless, type HeadlessPlan } from './headless';
import { parseTailNarrative } from './childRunner';

const plan: HeadlessPlan = {
  commandLine: 'opencode',
  // opencode.ai/docs/{cli,agents,permissions}: Plan alone does not deny shell
  // execution. Apply the same deny-by-default policy at global and agent scope.
  args: (contract) => ['run', '--agent', isReadOnlyContract(contract) ? 'plan' : 'build',
    'CONTRACT_PROMPT', '--file', 'CONTRACT_FILE'],
  env: (contract) => {
    // Explicit denials also override common per-tool allows inherited from
    // user/project config; a wildcard alone can lose to those specific rules.
    const permission = { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow',
      shell: 'deny', bash: 'deny', task: 'deny', skill: 'deny', webfetch: 'deny', websearch: 'deny',
      external_directory: 'deny', edit: isReadOnlyContract(contract) ? 'deny' : 'allow' };
    return {
      OPENCODE_PERMISSION: JSON.stringify(permission),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission, agent: { plan: { permission }, build: { permission } } })
    };
  },
  parse: parseTailNarrative
};

export const opencodeAdapter: AgentAdapter = {
  id: 'opencode',
  name: 'OpenCode',
  tier: 'B',
  start: async (context: AdapterContext): Promise<AdapterHandle> => ({
    key: `${context.contract.runId}:${context.contract.stageId}:opencode`,
    ctx: context,
    extras: {}
  }),
  collect: async (handle: AdapterHandle): Promise<ArtifactBundle> =>
    runHeadless(handle.ctx.contract, handle.ctx, plan),
  cancel: async (handle: AdapterHandle) => {

    abort(handle.ctx.contract);
  }
};


