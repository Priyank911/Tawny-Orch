import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrchestratorEngine } from '../src/main/orchestrator/engine';
import { stageSpecSchema, type StageSpec } from '../src/shared/contracts';

const stage = (id = 'plan'): StageSpec => ({
  id, title: id, role: 'plan', agentId: 'manual', acceptanceCommands: [],
  allowedFiles: [], forbiddenFiles: [], retries: 0
});
type CreateInput = Parameters<OrchestratorEngine['createRun']>[0];

describe('stageSpecSchema safe stage IDs', () => {
  it.each(['a', '_', '-', 'Plan_02-v2', 'execute', 'plan2', 'x'.repeat(80)])('accepts %s', (id) => {
    expect(stageSpecSchema.parse(stage(id)).id).toBe(id);
  });

  it.each([
    '', '.', '..', '../execute', 'plan/execute', 'plan\\execute', '/absolute', '\\absolute',
    'C:stream', 'plan name', ' plan', 'plan ', 'plan\n', 'plan\r\n', 'plan\0',
    'plán', '計画', 'x'.repeat(81)
  ])('rejects unsafe or oversized ID %j', (id) => {
    expect(stageSpecSchema.safeParse(stage(id)).success).toBe(false);
  });
});

describe('engine.createRun validates before persistence', () => {
  let root: string;
  let project: string;
  let userData: string;
  let engine: OrchestratorEngine;
  let updates: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tawny run validation '));
    project = join(root, 'project with spaces');
    userData = join(root, 'user data');
    mkdirSync(project);
    updates = vi.fn();
    engine = new OrchestratorEngine({ userDataDir: userData, onRunUpdate: updates });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  const input = (projectPath: string, overrides: Partial<CreateInput> = {}): CreateInput => ({
    goal: 'Plan a local implementation', projectPath, stages: [stage()], templateId: 'manual-slot', ...overrides
  });

  async function rejectsWithoutWrites(request: CreateInput): Promise<void> {
    await expect(engine.createRun(request)).rejects.toMatchObject({ name: 'PipelineError', cls: 'input', stage: 'dispatch' });
    expect(existsSync(userData)).toBe(false);
    expect(updates).not.toHaveBeenCalled();
  }

  it('rejects duplicate IDs even when stages have different roles', async () => {
    await rejectsWithoutWrites(input(project, { stages: [stage('shared'), { ...stage('shared'), role: 'execute' }] }));
  });

  it('rejects case-only duplicate IDs that would collide on Windows', async () => {
    await rejectsWithoutWrites(input(project, { stages: [stage('Plan'), stage('plan')] }));
  });

  it.each(['../escape', 'nested/execute', 'nested\\execute', 'plan\n', 'x'.repeat(81)])('rejects unsafe IDs through the direct engine API: %j', async (id) => {
    await rejectsWithoutWrites(input(project, { stages: [stage(id)] }));
    expect(existsSync(join(root, 'escape'))).toBe(false);
  });

  it('rejects zero stages', async () => {
    await rejectsWithoutWrites(input(project, { stages: [] }));
  });

  it('rejects more than 20 stages', async () => {
    await rejectsWithoutWrites(input(project, { stages: Array.from({ length: 21 }, (_, index) => stage(`stage-${index}`)) }));
  });

  it('accepts the 20-stage boundary and existing ID styles', async () => {
    const stages = Array.from({ length: 20 }, (_, index) => stage(`Plan_${index}-v2`));
    const run = await engine.createRun(input(project, { stages }));
    expect(run.stages.map((runtime) => runtime.spec.id)).toEqual(stages.map((spec) => spec.id));
    expect((await engine.loadRunById(run.id))?.stages).toHaveLength(20);
  });

  it.each(['', ' \t\r\n ', 'x'.repeat(8001)])('rejects empty, whitespace-only or oversized goal %j', async (goal) => {
    await rejectsWithoutWrites(input(project, { goal }));
  });

  it('trims the goal before storing and notifying listeners', async () => {
    const run = await engine.createRun(input(project, { goal: ' \t Plan the next change \r\n ' }));
    expect(run.goal).toBe('Plan the next change');
    expect((await engine.loadRunById(run.id))?.goal).toBe('Plan the next change');
    expect(updates.mock.calls[0][0].goal).toBe('Plan the next change');
  });

  it('accepts an 8,000-character trimmed goal', async () => {
    const run = await engine.createRun(input(project, { goal: `  ${'x'.repeat(8000)}\n` }));
    expect(run.goal).toHaveLength(8000);
  });

  it.each(['', 'relative/project', 'C:drive-relative'])('rejects non-absolute project path %j', async (path) => {
    await rejectsWithoutWrites(input(path));
  });

  it('rejects a missing directory without creating it', async () => {
    const missing = join(root, 'missing');
    await rejectsWithoutWrites(input(missing));
    expect(existsSync(missing)).toBe(false);
  });

  it('rejects a regular file as the project directory', async () => {
    const file = join(root, 'not a folder.txt');
    writeFileSync(file, 'User content must remain intact.');
    await rejectsWithoutWrites(input(file));
    expect(readFileSync(file, 'utf8')).toBe('User content must remain intact.');
  });

  it('rejects a malformed filesystem path', async () => {
    await rejectsWithoutWrites(input(join(root, 'bad\0directory')));
  });

  it('resolves directory aliases to their real absolute path', async () => {
    const alias = join(root, 'project alias');
    symlinkSync(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const run = await engine.createRun(input(alias));
    expect(run.projectPath).toBe(realpathSync(project));
    expect((await engine.loadRunById(run.id))?.projectPath).toBe(realpathSync(project));
  });

  it('does not alter existing persisted runs when a later request is invalid', async () => {
    const original = await engine.createRun(input(project));
    const file = join(userData, 'orchestrator', 'runs', original.id, 'state.json');
    const before = readFileSync(file, 'utf8');
    await expect(engine.createRun(input(project, { stages: [stage('plan'), stage('plan')] }))).rejects.toMatchObject({ cls: 'input' });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect((await engine.listRuns()).map((run) => run.id)).toEqual([original.id]);
    expect(updates).toHaveBeenCalledOnce();
  });

  it('uses distinct crypto UUIDs for concurrent creation across engine instances at the same timestamp', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const other = new OrchestratorEngine({ userDataDir: userData, onRunUpdate: updates });
    const runs = await Promise.all(Array.from({ length: 24 }, (_, index) =>
      (index % 2 ? engine : other).createRun(input(project, { goal: `Concurrent goal ${index}` }))));
    expect(new Set(runs.map((run) => run.id)).size).toBe(24);
    for (const run of runs) {
      expect(run.id).toMatch(/^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect((await engine.loadRunById(run.id))?.goal).toBe(run.goal);
    }
    expect(await engine.listRuns()).toHaveLength(24);
    expect(updates).toHaveBeenCalledTimes(24);
  }, 15_000);
});
