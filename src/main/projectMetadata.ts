import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Keep project-specific Tawny state in app data instead of cluttering projects. */
export function projectMetadataDirectory(userDataDir: string, projectPath: string): string {
  // Normalize filesystem aliases before deriving the key. macOS commonly
  // exposes /var as a symlink to /private/var, and Windows may return an 8.3
  // path from one API and a long path from another. Without this, writes and
  // reads can land in different metadata directories for the same project.
  let canonicalPath: string;
  try { canonicalPath = realpathSync.native(projectPath); }
  catch { canonicalPath = resolve(projectPath); }
  const identity = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
  const key = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  return join(userDataDir, 'orchestrator', 'projects', key);
}

/** Hide a legacy project metadata directory once we encounter it. */
export function hideProjectMetadata(projectPath: string): void {
  if (process.platform !== 'win32') return; // Dot directories are hidden by default on Unix-like systems.
  const directory = join(projectPath, '.tawny-orch');
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  spawnSync(join(systemRoot, 'System32', 'attrib.exe'), ['+H', directory], {
    windowsHide: true, stdio: 'ignore', timeout: 5_000
  });
}
