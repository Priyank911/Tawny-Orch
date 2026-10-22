import type { MemoryEntry, RunSnapshot, StageRuntime, TaskContract } from '../../shared/contracts';

export const ROLE_TIMEOUT_MINUTES: Record<string, number> = {
  research: 10,
  plan: 10,
  execute: 30,
  test: 20,
  review: 15,
  deliver: 8
};

export function workdirFor(runsRootDir: string, runId: string): string {
  return `${runsRootDir}${process.platform === 'win32' ? '\\' : '/'}${runId}`;
}

export function strictOutputPathFor(workdir: string, stageId: string, attempt: number): string {
  return `${workdir}${process.platform === 'win32' ? '\\' : '/'}result-${stageId}-${attempt}.json`;
}

export interface ContractInputs {
  run: RunSnapshot;
  stage: StageRuntime;
  attempt: number;
  runsRootDir: string;
  worktreePath: string;
  baseBranch: string;
  priorDiffs: string[];
  memoryEntries: MemoryEntry[];
  previousFailure?: { gate: string; reason: string };
}

const ROLE_GOAL_PREFIX: Record<string, string> = {
  research: 'Research and produce a factual brief for this goal:',
  plan: 'Produce a structured implementation plan for this goal:',
  execute: 'Implement this goal in the working directory:',
  test: 'Write and run tests to independently verify this goal was implemented:',
  review: 'Review the current state of this goal against the changes:',
  deliver: 'Compose the final delivery summary for this goal:'
};

// Pure contract builder: everything an agent needs, nothing else. The engine
// composes prior stage summaries straight out of the run snapshot.
export function buildContract(inputs: ContractInputs): TaskContract {
  const { run, stage, attempt } = inputs;
  const workdir = workdirFor(inputs.runsRootDir, run.id);
  const summaryFor = (role: string): string => {
    const runtime = run.stages.find((candidate) => candidate.spec.role === role);
    return runtime?.summary ?? '';
  };
  return {
    runId: run.id,
    stageId: stage.spec.id,
    role: stage.spec.role,
    agentId: stage.agentId ?? 'manual',
    goal: `${ROLE_GOAL_PREFIX[stage.spec.role] ?? stage.spec.role} ${run.goal}`,
    projectPath: run.projectPath,
    projectName: run.projectName,
    worktreePath: inputs.worktreePath,
    requestedOutputs: run.requestedOutputs,
    baseBranch: inputs.baseBranch,
    planSummary: summaryFor('plan'),
    researchSummary: summaryFor('research'),
    diffSoFar: inputs.priorDiffs,
    testReport: summaryFor('test'),
    reviewFindings: summaryFor('review'),
    verifiedHandoffs: [],
    memory: inputs.memoryEntries,
    constraints: {
      allowedFiles: stage.spec.allowedFiles,
      forbiddenFiles: stage.spec.forbiddenFiles,
      acceptanceCommands: stage.spec.acceptanceCommands,
      timeoutMinutes: ROLE_TIMEOUT_MINUTES[stage.spec.role] ?? 15
    },
    previousFailure: inputs.previousFailure ?? previousFailureInfo(stage, attempt),
    attempts: {
      attempt,
      maxAttempts: Math.max(1, stage.spec.retries + 1)
    },
    strictOutput: {
      path: strictOutputPathFor(workdir, stage.spec.id, attempt),
      hint:
        stage.spec.role === 'deliver'
          ? 'The delivery summary becomes the run report; be concrete and complete.'
          : 'Return the JSON object as your final response. Tawny validates and writes the result artifact after your process exits.'
    }
  };
}

export function maxAttemptsFor(stage: StageRuntime): number {
  return Math.max(1, stage.spec.retries + 1);
}

function previousFailureInfo(stage: StageRuntime, attempt: number): { gate: string; reason: string } | undefined {
  if (attempt <= 1 || !stage.failureReason) return undefined;
  const separator = stage.failureReason.indexOf(':');
  if (separator < 0) return { gate: 'previous_attempt', reason: stage.failureReason.slice(0, 200) };
  return { gate: stage.failureReason.slice(0, separator).trim(), reason: stage.failureReason.slice(separator + 1).trim().slice(0, 400) };
}
