import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) };
});
vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return { ...actual, setTimeout: vi.fn(async () => undefined) };
});
import { atomicWriteFile } from '../src/main/storage';

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
const transientCodes = ['EPERM', 'EACCES', 'EBUSY'] as const;
const retryDelays = [20, 40, 80, 160, 320, 640];
let root: string;
let file: string;
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
}
function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated ${code}`), { code });
}
async function seed(): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, 'original');
}
function expectNoDestinationRemoval(): void {
  expect(vi.mocked(rm).mock.calls.every(([path]) => path !== file && dirname(String(path)) === dirname(file))).toBe(true);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tawny-storage-'));
  file = join(root, '新用户 café', 'nested', 'state.json');
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(open).mockReset().mockImplementation(actual.open);
  vi.mocked(rename).mockReset().mockImplementation(actual.rename);
  vi.mocked(rm).mockReset().mockImplementation(actual.rm);
  vi.mocked(delay).mockReset().mockResolvedValue(undefined);
  setPlatform('win32');
});
afterEach(async () => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  await actual.rm(root, { recursive: true, force: true });
});

describe('atomic storage rename retries', () => {
  it('creates fresh Unicode directories without waiting on a successful rename', async () => {
    await atomicWriteFile(file, Buffer.from('complete snapshot'));
    expect(await readFile(file, 'utf8')).toBe('complete snapshot');
    expect(rename).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
    expect(await readdir(dirname(file))).toEqual(['state.json']);
    expectNoDestinationRemoval();
  });

  it.each(transientCodes)('recovers from a transient Windows %s without rewriting the temp file', async (code) => {
    await seed();
    vi.mocked(rename).mockRejectedValueOnce(failure(code));
    await atomicWriteFile(file, 'replacement');
    expect(await readFile(file, 'utf8')).toBe('replacement');
    expect(rename).toHaveBeenCalledTimes(2);
    expect(vi.mocked(rename).mock.calls[1]).toEqual(vi.mocked(rename).mock.calls[0]);
    expect(open).toHaveBeenCalledOnce();
    expect(delay).toHaveBeenCalledExactlyOnceWith(20);
    expect(await readdir(dirname(file))).toEqual(['state.json']);
    expectNoDestinationRemoval();
  });

  it('uses bounded exponential delays and succeeds on the final allowed attempt', async () => {
    await seed();
    for (let index = 0; index < retryDelays.length; index++) {
      vi.mocked(rename).mockRejectedValueOnce(failure(transientCodes[index % transientCodes.length]));
    }
    await atomicWriteFile(file, 'last-attempt replacement');
    expect(rename).toHaveBeenCalledTimes(7);
    expect(vi.mocked(delay).mock.calls.map(([milliseconds]) => milliseconds)).toEqual(retryDelays);
    expect(new Set(vi.mocked(rename).mock.calls.map(([source]) => source)).size).toBe(1);
    expect(await readFile(file, 'utf8')).toBe('last-attempt replacement');
    expect(await readdir(dirname(file))).toEqual(['state.json']);
    expectNoDestinationRemoval();
  });

  it.each(transientCodes)('preserves the original and removes only the temp file after exhausting %s retries', async (code) => {
    await seed();
    const error = failure(code);
    vi.mocked(rename).mockImplementation(async (source, destination) => {
      expect(destination).toBe(file);
      expect(await readFile(file, 'utf8')).toBe('original');
      expect(await readFile(source, 'utf8')).toBe('replacement');
      throw error;
    });
    await expect(atomicWriteFile(file, 'replacement')).rejects.toBe(error);
    expect(rename).toHaveBeenCalledTimes(7);
    expect(vi.mocked(delay).mock.calls.map(([milliseconds]) => milliseconds)).toEqual(retryDelays);
    expect(open).toHaveBeenCalledOnce();
    expect(await readFile(file, 'utf8')).toBe('original');
    expect(await readdir(dirname(file))).toEqual(['state.json']);
    expect(rm).toHaveBeenCalledOnce();
    expectNoDestinationRemoval();
  });

  it('cleans up a failed first save without creating a destination', async () => {
    vi.mocked(rename).mockRejectedValue(failure('EPERM'));
    await expect(atomicWriteFile(file, 'replacement')).rejects.toMatchObject({ code: 'EPERM' });
    expect(rename).toHaveBeenCalledTimes(7);
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(dirname(file))).toEqual([]);
    expectNoDestinationRemoval();
  });

  it.each(['ENOENT', 'ENOSPC', 'EXDEV', 'EIO', 'EEXIST'])('does not retry a nontransient %s rename error', async (code) => {
    await seed();
    const error = failure(code);
    vi.mocked(rename).mockRejectedValueOnce(error);
    await expect(atomicWriteFile(file, 'replacement')).rejects.toBe(error);
    expect(rename).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
    expect(await readFile(file, 'utf8')).toBe('original');
    expect(await readdir(dirname(file))).toEqual(['state.json']);
    expectNoDestinationRemoval();
  });

  it.each(['linux', 'darwin'] as const)('does not retry Windows transient codes on %s', async (platform) => {
    await seed();
    setPlatform(platform);
    for (const code of transientCodes) {
      vi.mocked(rename).mockClear().mockRejectedValueOnce(failure(code));
      await expect(atomicWriteFile(file, 'replacement')).rejects.toMatchObject({ code });
      expect(rename).toHaveBeenCalledOnce();
      expect(delay).not.toHaveBeenCalled();
      expect(await readFile(file, 'utf8')).toBe('original');
    }
    expect(await readdir(dirname(file))).toEqual(['state.json']);
    expectNoDestinationRemoval();
  });

  it('does not retry an error without a recognized code', async () => {
    await seed();
    const error = new Error('unclassified rename failure');
    vi.mocked(rename).mockRejectedValueOnce(error);
    await expect(atomicWriteFile(file, 'replacement')).rejects.toBe(error);
    expect(rename).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
    expect(await readFile(file, 'utf8')).toBe('original');
    expectNoDestinationRemoval();
  });

  it('does not retry transient errors from operations other than rename', async () => {
    await seed();
    const error = failure('EPERM');
    vi.mocked(open).mockRejectedValueOnce(error);
    await expect(atomicWriteFile(file, 'replacement')).rejects.toBe(error);
    expect(open).toHaveBeenCalledOnce();
    expect(rename).not.toHaveBeenCalled();
    expect(delay).not.toHaveBeenCalled();
    expect(await readFile(file, 'utf8')).toBe('original');
    expect(await readdir(dirname(file))).toEqual(['state.json']);
    expectNoDestinationRemoval();
  });

  it('holds the per-file lock across retry waits without blocking a different destination', async () => {
    await seed();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(delay).mockImplementationOnce(() => blocked);
    vi.mocked(rename).mockRejectedValueOnce(failure('EPERM'));
    const first = atomicWriteFile(file, 'first replacement');
    let second: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(delay).toHaveBeenCalledOnce());
      second = atomicWriteFile(file, 'second replacement');
      const other = join(dirname(file), 'other.json');
      await atomicWriteFile(other, 'independent');
      expect(await readFile(file, 'utf8')).toBe('original');
      expect(await readFile(other, 'utf8')).toBe('independent');
      expect(rename).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await Promise.all([first, second]);
    }
    expect(await readFile(file, 'utf8')).toBe('second replacement');
    expect(await readdir(dirname(file))).toEqual(['other.json', 'state.json']);
  });

  it('releases the lock after retry exhaustion so a subsequent save can succeed', async () => {
    await seed();
    const error = failure('EBUSY');
    for (let index = 0; index < 7; index++) vi.mocked(rename).mockRejectedValueOnce(error);
    const first = atomicWriteFile(file, 'failed replacement');
    const failed = expect(first).rejects.toBe(error);
    const second = atomicWriteFile(file, 'successful replacement');
    await Promise.all([failed, second]);
    expect(rename).toHaveBeenCalledTimes(8);
    expect(await readFile(file, 'utf8')).toBe('successful replacement');
    expect(await readdir(dirname(file))).toEqual(['state.json']);
    expectNoDestinationRemoval();
  });
});
