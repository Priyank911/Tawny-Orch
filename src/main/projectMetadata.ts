import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** Keep project-specific Tawny state in app data instead of cluttering projects. */
export function projectMetadataDirectory(userDataDir: string, projectPath: string): string {
  const identity = process.platform === 'win32' ? projectPath.toLowerCase() : projectPath;
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
