import type { AgentAdapter, AdapterContext, AdapterHandle } from './base';
import type { ArtifactBundle, AgentTier } from '../../shared/contracts';
import { runHeadless, type HeadlessPlan } from './headless';
import { parseTailNarrative } from './childRunner';

export function makePacketCliAdapter(options: {
  id: string;
  name: string;
  tier: AgentTier;
  commandLine: string;
  args: string[];
}): AgentAdapter {
  const plan: HeadlessPlan = { commandLine: options.commandLine, args: options.args, parse: parseTailNarrative };
  return {
    id: options.id,
    name: options.name,
    tier: options.tier,
    start: async (context: AdapterContext): Promise<AdapterHandle> => ({
      key: `${context.contract.runId}:${context.contract.stageId}:${options.id}`,
      ctx: context,
      extras: {}
    }),
    collect: async (handle: AdapterHandle): Promise<ArtifactBundle> =>
      runHeadless(handle.ctx.contract, handle.ctx, plan),
    cancel: async (handle: AdapterHandle) => {
      const { abort } = await import('./headless');
      abort(handle.ctx.contract);
    }
  };
}


