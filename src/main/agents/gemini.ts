import type { AgentAdapter, AdapterContext, AdapterHandle } from './base';
import type { ArtifactBundle } from '../../shared/contracts';
import { abort, isReadOnlyContract, runHeadless, type HeadlessPlan } from './headless';
import { parseGeminiJson, parseSessionId } from './childRunner';

const plan: HeadlessPlan = {
  commandLine: 'gemini',
  // geminicli.com/docs/cli/cli-reference: -p appends to piped stdin and
  // forces non-interactive mode. Plan mode can still write internal plan files.
  args: (contract) => ['--approval-mode', isReadOnlyContract(contract) ? 'plan' : 'auto_edit',
    '--output-format', 'json', '-p', 'Follow the task contract supplied on stdin. Do not escalate permissions.'],
  parse: parseGeminiJson,
  sessionId: parseSessionId
};

export const geminiAdapter: AgentAdapter = {
  id: 'gemini-cli',
  name: 'Gemini CLI',
  tier: 'A',
  start: async (context: AdapterContext): Promise<AdapterHandle> => ({
    key: `${context.contract.runId}:${context.contract.stageId}:gemini-cli`,
    ctx: context,
    extras: {}
  }),
  collect: async (handle: AdapterHandle): Promise<ArtifactBundle> =>
    runHeadless(handle.ctx.contract, handle.ctx, plan),
  cancel: async (handle: AdapterHandle) => {

    abort(handle.ctx.contract);
  }
};


