import type { AgentAdapter, AdapterContext, AdapterHandle } from './base';
import type { ArtifactBundle } from '../../shared/contracts';
import { abort, isReadOnlyContract, runHeadless, type HeadlessPlan } from './headless';
import { parseTailNarrative } from './childRunner';

const plan: HeadlessPlan = {
  commandLine: 'cursor-agent',
  // cursor.com/docs/cli/reference/parameters: ask is read-only. Do not use
  // --force/--yolo: unattended writes depend on the installed CLI's policy.
  args: (contract) => ['-p', ...(isReadOnlyContract(contract) ? ['--mode', 'ask'] : []), 'CONTRACT_PROMPT'],
  parse: parseTailNarrative
};

export const cursorAgentAdapter: AgentAdapter = {
  id: 'cursor-agent',
  name: 'Cursor Agent',
  tier: 'B',
  start: async (context: AdapterContext): Promise<AdapterHandle> => ({
    key: `${context.contract.runId}:${context.contract.stageId}:cursor-agent`,
    ctx: context,
    extras: {}
  }),
  collect: async (handle: AdapterHandle): Promise<ArtifactBundle> =>
    runHeadless(handle.ctx.contract, handle.ctx, plan),
  cancel: async (handle: AdapterHandle) => {

    abort(handle.ctx.contract);
  }
};


