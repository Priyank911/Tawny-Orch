import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSnapshotSchema, type RunSnapshot } from '../src/shared/contracts';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile), rename: vi.fn(actual.rename) };
});
vi.mock('../src/main/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/storage')>();
  return { ...actual, atomicWriteFile: vi.fn(actual.atomicWriteFile) };
});
import { atomicWriteFile } from '../src/main/storage';
import { listRuns, loadRun, runDir, runsRoot, saveRun } from '../src/main/orchestrator/store';

let root: string;
let userData: string;
function snapshot(id = 'run-legacy_123'): RunSnapshot {
  return runSnapshotSchema.parse({
    id,
    goal: 'Persist a run reliably',
    projectPath: join(root, '项目 café'),
    projectName: '项目 café',
    createdAt: '2026-10-21T10:00:00.000Z',
    stages: []
  });
}
async function writeState(directoryId: string, contents: unknown): Promise<void> {
  const directory = runDir(userData, directoryId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'state.json'), JSON.stringify(contents));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tawny-run-store-'));
  userData = join(root, '新用户 café', 'fresh');
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.mocked(rename).mockReset();
  // Restore the implementation after a simulated failure, including failed tests.
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(rename).mockImplementation(actual.rename);
  await rm(root, { recursive: true, force: true });
});

describe('run store persistence', () => {
  it('uses atomicWriteFile and creates fresh Unicode directories', async () => {
    const run = snapshot();
    await saveRun(userData, run);
    const file = join(runDir(userData, run.id), 'state.json');
    expect(atomicWriteFile).toHaveBeenCalledExactlyOnceWith(file, JSON.stringify(run, null, 2));
    expect(await loadRun(userData, run.id)).toEqual(run);
    expect(await readdir(runDir(userData, run.id))).toEqual(['state.json']);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(run);
  });

  it.each(['run-123abc', 'run-first', 'run-legacy_123', 'run-1.2', 'legacy-ID_42', '_old-run'])('preserves safe legacy IDs: %s', async (id) => {
    const run = snapshot(id);
    await saveRun(userData, run);
    expect(await loadRun(userData, id)).toEqual(run);
  });

  it('keeps the previous snapshot intact when atomic replacement fails', async () => {
    const run = snapshot();
    await saveRun(userData, run);
    const file = join(runDir(userData, run.id), 'state.json');
    const original = await readFile(file, 'utf8');
    vi.mocked(rename).mockRejectedValueOnce(new Error('simulated atomic replacement failure'));
    await expect(saveRun(userData, { ...run, status: 'running' })).rejects.toThrow('simulated atomic replacement failure');
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(await loadRun(userData, run.id)).toEqual(run);
    expect(await readdir(runDir(userData, run.id))).toEqual(['state.json']);
    await saveRun(userData, { ...run, status: 'done' });
    expect((await loadRun(userData, run.id))?.status).toBe('done');
  });

  it('serializes concurrent replacements without partial JSON or leftover temporary files', async () => {
    const run = snapshot();
    await Promise.all(Array.from({ length: 12 }, (_, index) => saveRun(userData, { ...run, goal: `Goal ${index}` })));
    expect((await loadRun(userData, run.id))?.goal).toBe('Goal 11');
    expect(await readdir(runDir(userData, run.id))).toEqual(['state.json']);
  });

  it('validates snapshots before creating directories or replacing existing state', async () => {
    const run = snapshot();
    await expect(saveRun(userData, { ...run, goal: '' })).rejects.toThrow();
    expect(atomicWriteFile).not.toHaveBeenCalled();
    expect(await listRuns(userData)).toEqual([]);
    await expect(readdir(userData)).rejects.toMatchObject({ code: 'ENOENT' });
    await saveRun(userData, run);
    await expect(saveRun(userData, { ...run, goal: '' })).rejects.toThrow();
    expect(await loadRun(userData, run.id)).toEqual(run);
  });

  it('returns no runs for a fresh install and no snapshot for missing or malformed state', async () => {
    expect(await listRuns(userData)).toEqual([]);
    expect(await loadRun(userData, 'run-missing')).toBeUndefined();
    await writeState('run-invalid-schema', { id: 'run-invalid-schema' });
    expect(await loadRun(userData, 'run-invalid-schema')).toBeUndefined();
    const malformed = runDir(userData, 'run-malformed');
    await mkdir(malformed, { recursive: true });
    await writeFile(join(malformed, 'state.json'), '{broken');
    expect(await loadRun(userData, 'run-malformed')).toBeUndefined();
  });
});

describe('run ID boundaries', () => {
  it.each([
    '', '.', '..', '../outside', '..\\outside', 'run/../../outside', 'run\\..\\outside',
    '/absolute', '\\absolute', 'C:\\outside', 'C:/outside', 'C:outside', '\\\\server\\share',
    'run-id:stream', 'run-id\0suffix', 'run-id\n', ' run-id', 'run-id ', 'run-id.',
    '.hidden', 'run?id', 'run*id', 'run%2foutside', 'run%5coutside',
    'CON', 'nul', 'PRN.json', 'AUX', 'com1', 'LPT9.json', 'a'.repeat(256)
  ])('rejects unsafe IDs before reading or writing: %j', async (id) => {
    expect(() => runDir(userData, id)).toThrow('Invalid run ID');
    await expect(saveRun(userData, { ...snapshot(), id })).rejects.toThrow();
    // An empty ID fails snapshot validation; all other IDs fail path validation.
    expect(await loadRun(userData, id)).toBeUndefined();
    expect(readFile).not.toHaveBeenCalled();
    expect(atomicWriteFile).not.toHaveBeenCalled();
  });


  it('never reads a valid snapshot outside the runs root through traversal', async () => {
    await mkdir(join(userData, 'orchestrator', 'outside'), { recursive: true });
    await writeFile(join(userData, 'orchestrator', 'outside', 'state.json'), JSON.stringify(snapshot('../outside')));
    expect(await loadRun(userData, '../outside')).toBeUndefined();
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each(['run-other', '../outside', 'RUN-EXPECTED'])('ignores snapshots whose ID does not match the directory: %s', async (storedId) => {
    await writeState('run-expected', snapshot(storedId));
    expect(await loadRun(userData, 'run-expected')).toBeUndefined();
    expect(await listRuns(userData)).toEqual([]);
  });

  it('lists only matching valid snapshots, newest first', async () => {
    const older = snapshot('run-older');
    const newer = { ...snapshot('run-newer'), createdAt: '2026-10-22T10:00:00.000Z' };
    await saveRun(userData, older);
    await saveRun(userData, newer);
    await writeState('run-mismatch', snapshot('run-somewhere-else'));
    await writeState('run-invalid', { id: 'run-invalid' });
    await mkdir(join(runsRoot(userData), '.unsafe-name'));
    await writeFile(join(runsRoot(userData), 'not-a-directory'), 'ignored');
    expect(await listRuns(userData)).toEqual([newer, older]);
  });
});
