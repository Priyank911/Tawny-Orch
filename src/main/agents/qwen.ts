import type { AgentAdapter, AdapterContext, AdapterHandle } from './base';
import type { ArtifactBundle } from '../../shared/contracts';
import { abort, isReadOnlyContract, runHeadless, type HeadlessPlan } from './headless';
import { parseQwenJson, parseSessionId } from './childRunner';

const plan: HeadlessPlan = {
  commandLine: 'qwen',
  // Qwen's documented headless interface accepts the prompt on stdin and
  // exposes explicit approval modes. Keep inspection roles read-only.
  args: (contract) => ['--approval-mode', isReadOnlyContract(contract) ? 'plan' : 'auto',
    '--output-format', 'json', '-p', 'Follow the task contract supplied on stdin. Do not escalate permissions.'],
  parse: parseQwenJson,
  sessionId: parseSessionId
};

export const qwenAdapter: AgentAdapter = {
  id: 'qwen-code',
  name: 'Qwen Code',
  tier: 'B',
  start: async (context: AdapterContext): Promise<AdapterHandle> => ({
    key: `${context.contract.runId}:${context.contract.stageId}:qwen-code`,
    ctx: context,
    extras: {}
  }),
  collect: async (handle: AdapterHandle): Promise<ArtifactBundle> =>
    runHeadless(handle.ctx.contract, handle.ctx, plan),
  cancel: async (handle: AdapterHandle) => abort(handle.ctx.contract)
};
