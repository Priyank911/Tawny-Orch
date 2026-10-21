import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function renameWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (process.platform !== 'win32' || attempt >= 6 ||
          (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
        throw error;
      }
      // Windows readers/AV can briefly deny replacement. Keep the old file and
      // retry the same completed temporary file: six waits, 1.26 seconds total.
      await delay(20 * 2 ** attempt);
    }
  }
}

/** Replace a file only after its complete contents have been flushed to disk. */
export async function atomicWriteFile(file: string, contents: string | Buffer): Promise<void> {
  await withStorageLock(`atomic-write:${file}`, async () => {
    await mkdir(dirname(file), { recursive: true });
    const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameWithRetry(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  });
}

const pending = new Map<string, Promise<unknown>>();

/** Serialize in-process read/modify/write operations, including after failures. */
export async function withStorageLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const previous = pending.get(file) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  pending.set(file, next);
  try {
    return await next;
  } finally {
    if (pending.get(file) === next) pending.delete(file);
  }
}

export function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}
