import type { AgentAdapter, AdapterContext, AdapterHandle } from './base';
import type { ArtifactBundle } from '../../shared/contracts';
import { abort, runHeadless, type HeadlessPlan } from './headless';
import { parseAgyStreamJson, parseSessionId } from './childRunner';

const plan: HeadlessPlan = {
  commandLine: 'agy',
  // Headless mode uses the CLI's configured permission policy. Do not bypass it.
  args: ['-p', 'CONTRACT_PROMPT', '--output-format', 'stream-json'],
  parse: parseAgyStreamJson,
  sessionId: parseSessionId
};

export const antigravityAdapter: AgentAdapter = {
  id: 'antigravity',
  name: 'Antigravity CLI',
  tier: 'A',
  start: async (context: AdapterContext): Promise<AdapterHandle> => ({
    key: `${context.contract.runId}:${context.contract.stageId}:antigravity`,
    ctx: context,
    extras: {}
  }),
  collect: async (handle: AdapterHandle): Promise<ArtifactBundle> =>
    runHeadless(handle.ctx.contract, handle.ctx, plan),
  cancel: async (handle: AdapterHandle) => abort(handle.ctx.contract)
};
