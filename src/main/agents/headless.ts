import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runChild } from './childRunner';
import { contractJson, contractMarkdown } from '../orchestrator/prompts';
import { logPipeline } from '../logger';
import type { AgentResult, ArtifactBundle, TaskContract } from '../../shared/contracts';
import { agentResultsSchema } from '../../shared/contracts';
import type { AdapterContext } from './base';

// ---------------------------------------------------------------------------
// Shared machinery behind every Tier A/B adapter. The vendor CLI receives the
// markdown contract through stdin (preferred) and/or a file on disk, and the
// shared runner enforces the contract's timeout budget.
// ---------------------------------------------------------------------------

export async function writeContractFiles(context: AdapterContext): Promise<{ jsonPath: string; mdPath: string }> {
  await mkdir(context.workdir, { recursive: true });
  const jsonPath = resolve(join(context.workdir, `contract-${context.contract.stageId}.json`));
  const mdPath = resolve(join(context.workdir, `contract-${context.contract.stageId}.md`));
  await writeFile(jsonPath, contractJson(context.contract), 'utf8');
  await writeFile(mdPath, contractMarkdown(context.contract), 'utf8');
  return { jsonPath, mdPath };
}


export async function readStrictResult(path: string | undefined): Promise<AgentResult | undefined> {
  if (!path) return undefined;
  try {
    const parsed = agentResultsSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function stderrTail(stderr: string, lines = 6): string[] {
  return stderr
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(-lines);
}

export function isReadOnlyContract(contract: TaskContract): boolean {
  return !['execute', 'test'].includes(contract.role);
}

export interface HeadlessOutcome extends ChildOutcomeLike {
  parsed?: { summary: string; isFailure: boolean };
  strict?: AgentResult;
}

export interface ChildOutcomeLike {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
}

export function buildBundle(outcome: HeadlessOutcome): ArtifactBundle {
  const tail = stderrTail(outcome.stderr);
  const complete = outcome.exitCode === 0 && !outcome.timedOut && !outcome.cancelled && !outcome.parsed?.isFailure;
  if (outcome.strict && complete) {
    return {
      stdoutSummary: outcome.strict.summary.slice(0, 4000),
      result: outcome.strict,
      stderrTail: tail,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut
    };
  }
  if (outcome.parsed) {

    return {
      stdoutSummary: outcome.parsed.summary.slice(0, 4000),
      result: {
        status: complete ? 'completed' : 'failed',
        summary: outcome.parsed.summary,
        filesChanged: [],
        assumptions: [],
        unresolved: [],
        confidence: 'medium'
      },
      stderrTail: tail,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut
    };
  }

  return {
    stdoutSummary: outcome.stdout.length > 4000 ? `…${outcome.stdout.slice(-4000)}` : outcome.stdout,
    result: complete
      ? {
          status: 'completed',
          summary: 'Finished without a structured report; the engine verifies via gates.',
          filesChanged: [],
          assumptions: [],
          unresolved: [],
          confidence: 'low'
        }
      : null,
    stderrTail: tail,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut
  };
}

// Per-contract abort registry so engine-level cancels translate to child kills.
const aborters = new Map<string, AbortController>();

export function aborterFor(contract: TaskContract): { signal: AbortSignal; abort: () => void } {
  const key = `${contract.runId}:${contract.stageId}`;
  const existing = aborters.get(key);
  if (existing) return { signal: existing.signal, abort: () => existing.abort() };
  const controller = new AbortController();
  aborters.set(key, controller);
  return { signal: controller.signal, abort: () => controller.abort() };
}

export function releaseAborter(contract: TaskContract): void {
  aborters.delete(`${contract.runId}:${contract.stageId}`);
}

export function abort(contract: TaskContract): void {
  aborterFor(contract).abort();
}

export interface HeadlessPlan {
  commandLine: string;
  args: string[] | ((contract: TaskContract) => string[]);
  env?: (contract: TaskContract) => NodeJS.ProcessEnv;
  parse(stdout: string): { summary: string; isFailure: boolean } | undefined;
}

export async function runHeadless(contract: TaskContract, context: AdapterContext, plan: HeadlessPlan): Promise<ArtifactBundle> {
  // Register before async file I/O so a cancellation during preparation is kept.
  const { signal } = aborterFor(contract);
  try {
    const files = await writeContractFiles(context);
    const args = typeof plan.args === 'function' ? plan.args(contract) : plan.args;
    const usesFilePrompt = args.includes('CONTRACT_PROMPT');
    const finalArgs = args.map((part) => part === 'CONTRACT_PROMPT'
      ? `Read task packet at ${files.mdPath} and follow its instructions. Respect this session's permission restrictions; report any blocked operation rather than escalating permissions.`
      : part === 'CONTRACT_FILE' ? files.mdPath : part);
    const timeoutMs = Math.max(60_000, contract.constraints.timeoutMinutes * 60_000);
    logPipeline({
      event: 'adapter.spawn',
      message: `${plan.commandLine} dispatched for stage ${contract.stageId}`,
      stage: 'orchestrate',
      runId: contract.runId,
      data: { stage: contract.stageId, cwd: context.cwd, contract: files.mdPath }
    });
    const outcome = await runChild(plan.commandLine, finalArgs, {
      cwd: context.cwd,
      timeoutMs,
      stdinPayload: usesFilePrompt ? undefined : contractMarkdown(contract),
      cancelSignal: signal,
      env: plan.env?.(contract)
    });
    const parsed = plan.parse(outcome.stdout);
    if (!parsed) {
      logPipeline({
        event: 'adapter.plain_output',
        message: `No structured ${contract.agentId} output with exit code ${outcome.exitCode}; falling back to gates.`,
        stage: 'orchestrate',
        runId: contract.runId,
        data: { stage: contract.stageId, bytes: String(outcome.stdout.length) }
      });
    }
    const strict = await readStrictResult(contract.strictOutput?.path);
    return buildBundle({ ...outcome, parsed, strict });
  } finally {
    releaseAborter(contract);
  }
}
