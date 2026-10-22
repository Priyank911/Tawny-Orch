import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runChild } from './childRunner';
import { contractJson, contractMarkdown } from '../orchestrator/prompts';
import { logPipeline } from '../logger';
import type { AgentResult, ArtifactBundle, TaskContract } from '../../shared/contracts';
import { agentResultsSchema } from '../../shared/contracts';
import { redactSecrets } from '../orchestrator/packets';
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

/** Extract an AgentResult from a final response without trusting prose around it. */
export function parseStrictResponse(text: string): AgentResult | undefined {
  const source = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const direct = agentResultsSchema.safeParse(safeJsonText(source));
  if (direct.success) return direct.data;
  // Some CLIs add a short preamble. Find balanced JSON objects while respecting
  // quoted braces, then validate the whole object against the output schema.
  for (let start = source.indexOf('{'); start >= 0; start = source.indexOf('{', start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === '{') depth += 1;
      else if (character === '}' && --depth === 0) {
        const parsed = agentResultsSchema.safeParse(safeJsonText(source.slice(start, index + 1)));
        if (parsed.success) return parsed.data;
        break;
      }
    }
  }
  return undefined;
}

function safeJsonText(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
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
  requireStrict?: boolean;
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
  if (outcome.requireStrict) {
    return {
      stdoutSummary: outcome.parsed?.summary.slice(0, 4000) ?? (outcome.stdout.length > 4000 ? `…${outcome.stdout.slice(-4000)}` : outcome.stdout),
      result: null,
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
  sessionId?(stdout: string): string | undefined;
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
    const sessionLogPath = context.sessionLogPath;
    if (sessionLogPath) {
      await mkdir(resolve(join(sessionLogPath, '..')), { recursive: true });
      await writeFile(sessionLogPath, `# ${plan.commandLine} session · ${contract.stageId} · attempt ${contract.attempts.attempt}\n# Working directory: ${context.cwd}\n\n`, 'utf8');
    }
    let writeSession = Promise.resolve();
    const buffers: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
    const saveOutput = (stream: 'stdout' | 'stderr', value: string) => {
      const safeText = redactSecrets(value).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\r\n]+/g, ' ').slice(-1200);
      if (!safeText.trim()) return;
      context.onSessionEvent?.({ type: 'output', stream, text: safeText });
      if (sessionLogPath) {
        writeSession = writeSession.then(() => appendFile(sessionLogPath, `[${new Date().toISOString()}] ${stream}> ${safeText}\n`, 'utf8')).catch(() => undefined);
      }
    };
    const receiveOutput = (stream: 'stdout' | 'stderr', chunk: string) => {
      const combined = buffers[stream] + chunk;
      const lines = combined.split(/\r?\n/);
      buffers[stream] = lines.pop() ?? '';
      for (const line of lines) saveOutput(stream, line);
      // Some CLIs emit a long progress line without a newline. Bound the
      // in-memory remainder while redacting the whole segment before display.
      if (buffers[stream].length > 16_000) {
        saveOutput(stream, buffers[stream]);
        buffers[stream] = '';
      }
    };
    const flushOutput = () => {
      saveOutput('stdout', buffers.stdout);
      saveOutput('stderr', buffers.stderr);
      buffers.stdout = '';
      buffers.stderr = '';
    };
    const outcome = await runChild(plan.commandLine, finalArgs, {
      cwd: context.cwd,
      timeoutMs,
      stdinPayload: usesFilePrompt ? undefined : contractMarkdown(contract),
      cancelSignal: signal,
      env: plan.env?.(contract),
      onSpawn: (pid) => context.onSessionEvent?.({ type: 'started', pid }),
      onOutput: receiveOutput
    });
    flushOutput();
    context.onSessionEvent?.({ type: 'finished', exitCode: outcome.exitCode, timedOut: outcome.timedOut, cancelled: outcome.cancelled });
    await writeSession;
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
    // Persist structured handoffs from the host after the CLI exits. Read-only
    // agents therefore never need write access to the project or app-data path.
    const responseResult = contract.strictOutput ? parseStrictResponse(parsed?.summary ?? '') : undefined;
    if (responseResult && contract.strictOutput?.path && outcome.exitCode === 0 && !outcome.timedOut && !outcome.cancelled) {
      await mkdir(resolve(join(contract.strictOutput.path, '..')), { recursive: true });
      await writeFile(contract.strictOutput.path, JSON.stringify(responseResult, null, 2), 'utf8');
    }
    const strict = await readStrictResult(contract.strictOutput?.path) ?? responseResult;
    const bundle = buildBundle({ ...outcome, parsed, strict, requireStrict: Boolean(contract.strictOutput) });
    bundle.sessionId = plan.sessionId?.(outcome.stdout);
    return bundle;
  } finally {
    releaseAborter(contract);
  }
}
