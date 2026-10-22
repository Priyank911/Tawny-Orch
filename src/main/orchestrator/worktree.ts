import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

export interface WorkspacePlan {
  usesWorktree: boolean;
  branch?: string;
  cwd: string;
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['--no-pager', ...args], {
    cwd, windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024 * 1024,
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
  });
}

export function needsWorktree(role: string, isGit: boolean): boolean {
  return isGit && (role === 'execute' || role === 'test');
}

export function worktreeDirectory(userDataDir: string, projectPath: string, runId: string, stageId: string): string {
  const projectKey = createHash('sha256').update(resolve(projectPath).toLowerCase()).digest('hex').slice(0, 16);
  return join(userDataDir, 'orchestrator', 'worktrees', projectKey, sanitize(runId), sanitize(stageId));
}

export function branchName(branchPrefix: string, runId: string, stageId: string): string {
  return `${branchPrefix}/${runId.replace(/[^a-zA-Z0-9]+/g, '').slice(0, 24)}-${sanitize(stageId)}`;
}

function sanitize(value: string): string {
  const result = value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 48);
  if (!result || result === '.' || result === '..') throw new Error('Invalid workspace identifier.');
  return result;
}

export function hasGitDirectory(projectPath: string): boolean {
  try { return git(projectPath, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'; }
  catch { return false; }
}

/** Reuse only a registered worktree of this repository on the expected branch. Never fall back. */
export function ensureWorktree(projectPath: string, target: string, branch: string, base: string): void {
  git(projectPath, ['check-ref-format', '--branch', branch]);
  git(projectPath, ['rev-parse', '--verify', `${base}^{commit}`]);
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
    git(projectPath, ['worktree', 'add', '-b', branch, target, base]);
  }
  const canonical = (path: string): string => realpathSync(path).replace(/\\/g, '/');
  const registered = git(projectPath, ['worktree', 'list', '--porcelain', '-z']).split('\0')
    .filter((field) => field.startsWith('worktree ')).map((field) => field.slice(9));
  if (!registered.some((path) => canonical(path) === canonical(target)) ||
      canonical(git(target, ['rev-parse', '--show-toplevel']).trim()) !== canonical(target) ||
      git(target, ['symbolic-ref', '--short', 'HEAD']).trim() !== branch ||
      canonical(resolve(target, git(target, ['rev-parse', '--git-common-dir']).trim())) !==
        canonical(resolve(projectPath, git(projectPath, ['rev-parse', '--git-common-dir']).trim()))) {
    throw new Error('Workspace is not the expected registered run worktree; refusing to dispatch.');
  }
  git(target, ['merge-base', '--is-ancestor', base, 'HEAD']);
}
