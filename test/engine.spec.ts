import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OrchestratorEngine } from '../src/main/orchestrator/engine';
import type { StageSpec } from '../src/shared/contracts';
import { memoryFilePath } from '../src/main/orchestrator/memory';

// Engine integration test with real manual (packet) adapters: no CLIs needed.
// The manual adapter writes a task packet and waits for DONE.json; the test
// completes stages manually via escalateStage which also covers reassignment.

let workDir: string;
let projectDir: string;
let engine: OrchestratorEngine;
let events: string[] = [];

const SPEC = (agentId: string | null, id = 'plan'): StageSpec => ({
  id, title: id.charAt(0).toUpperCase() + id.slice(1), role: 'plan', agentId,
  acceptanceCommands: [], allowedFiles: [], forbiddenFiles: [], retries: 0
});

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'tawny-orch-engine-'));
  projectDir = join(workDir, 'proj');
  mkdirSync(projectDir, { recursive: true });
  events = [];
  engine = new OrchestratorEngine({
    userDataDir: workDir,
    onRunUpdate: (run) => events.push(`${run.id}:${run.status}:${run.stages.map((stage) => stage.status).join(',')}`)
  });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const inboxFile = (runId: string, stageId = 'plan'): string =>
  join(workDir, 'orchestrator', 'runs', runId, 'packets', `${runId}-${stageId}.md`);
const doneFile = (runId: string, stageId = 'plan'): string =>
  join(workDir, 'orchestrator', 'runs', runId, 'packets', `${runId}-${stageId}`, 'DONE.json');

describe('orchestrator engine (manual adapters)', () => {
  it('creates, escalates, and completes a run end to end', async () => {
    const run = await engine.createRun({
      goal: 'Add a README',
      projectPath: projectDir,
      stages: [SPEC('manual')],
      templateId: 'manual-slot'
    });

    void engine.startRun(run.id).catch(() => undefined);
    await waitFor(() => existsSync(doneFile(run.id)) === false &&
      existsSync(inboxFile(run.id)) && readFileSync(inboxFile(run.id), 'utf8').includes('Tawny Orch task packet'),
    10_000, 'packet content written');
    const packet = readFileSync(inboxFile(run.id), 'utf8');
    expect(packet).toContain('Tawny Orch task packet');
    expect(packet).toContain('Add a README');

    await engine.escalateStage({ runId: run.id, stageId: 'plan', manualComplete: true, manualSummary: 'Wrote the README by hand.' });
    await waitFor(async () => ((await engine.loadRunById(run.id))?.status ?? '') === 'done', 20_000, 'run completes');
    const state = await engine.loadRunById(run.id);
    expect(state?.status).toBe('done');
    expect(state?.stages[0].status).toBe('passed');
    expect(state?.stages[0].summary).toContain('README');
  }, 45_000);

  it('writes the shared memory ledger after plan passes', async () => {
    const run = await engine.createRun({
      goal: 'Define conventions',
      projectPath: projectDir,
      stages: [SPEC('manual')],
      templateId: 'manual-slot'
    });
    void engine.startRun(run.id).catch(() => undefined);
    await waitFor(() => existsSync(doneFile(run.id)) === false &&
      existsSync(inboxFile(run.id)) && readFileSync(inboxFile(run.id), 'utf8').includes('Tawny Orch task packet'),
    10_000, 'packet content written');
    await engine.escalateStage({ runId: run.id, stageId: 'plan', manualComplete: true, manualSummary: 'Plan summary with decisions.' });
    await waitFor(async () => ((await engine.loadRunById(run.id))?.status ?? '') === 'done', 20_000, 'run completes');

    const memoryPath = memoryFilePath(projectDir, workDir);
    await waitFor(() => existsSync(memoryPath), 10_000, 'memory appears');
    expect(readFileSync(memoryPath, 'utf8')).toContain('Plan summary with decisions');
  }, 45_000);

  it('runs stay cancelable', async () => {
    const run = await engine.createRun({
      goal: 'Long manual task',
      projectPath: projectDir,
      stages: [SPEC('manual'), { ...SPEC('manual'), id: 'plan2', title: 'Second stage' }],
      templateId: 'manual-slot'
    });
    void engine.startRun(run.id).catch(() => undefined);
    // Cancel immediately after the packet is written; manual completion has not arrived yet.
    await waitFor(() => existsSync(inboxFile(run.id)), 10_000, 'packet wrote');
    await engine.cancelRun(run.id);
    const final = await engine.loadRunById(run.id);
    expect(final?.status).toBe('cancelled');
    expect(final?.stages.map((stage) => stage.status)).toEqual(['cancelled', 'cancelled']);
    expect(final?.stages[0].endedAt).toBeTruthy();
    const report = readFileSync(join(workDir, 'orchestrator', 'runs', run.id, 'final-summary.md'), 'utf8');
    expect(report).toContain('Status: cancelled');
    expect(report).toContain('Not started because the run was cancelled.');
  }, 45_000);

  it('stops and skips the active stage, then continues with the next stage', async () => {
    const run = await engine.createRun({
      goal: 'Skip research and continue to planning',
      projectPath: projectDir,
      stages: [SPEC('manual', 'research'), SPEC('manual', 'plan')],
      templateId: 'custom'
    });
    void engine.startRun(run.id).catch(() => undefined);
    await waitFor(() => existsSync(inboxFile(run.id, 'research')), 10_000, 'research packet wrote');

    await engine.escalateStage({ runId: run.id, stageId: 'research', skipStage: true });
    await waitFor(() => existsSync(inboxFile(run.id, 'plan')), 10_000, 'next stage packet wrote');
    const during = await engine.loadRunById(run.id);
    expect(during?.stages[0].status).toBe('skipped');
    expect(during?.stages[1].status).toBe('running');

    await engine.cancelRun(run.id);
    await waitFor(async () => (await engine.loadRunById(run.id))?.status === 'cancelled', 10_000, 'run cancelled');
  }, 45_000);
});

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`waitFor(${label}) timed out`);
}
