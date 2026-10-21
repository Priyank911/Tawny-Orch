import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { git, hasGitDirectory } from './worktree';
import type { GateResult, TaskContract } from '../../shared/contracts';

// Deterministic gates between stages. Gates run in a clean context (the
// project/worktree root), never through the agent, and never idle-loop.
// A gate result is machine-readable: pass / fail / error (infra problem).

export interface GateRunnerContext {
  contract: TaskContract;
  cwd: string;
}

export function changedFilesSince(cwd: string, baseBranch: string): string[] | 'not-git' {
  if (!hasGitDirectory(cwd)) return 'not-git';
  // Deliberately propagate git errors: an invalid base is not a non-git checkout.
  const tracked = git(cwd, ['diff', '--no-ext-diff', '--name-only', '-z', baseBranch, '--']).split('\0').filter(Boolean);
  const staged = git(cwd, ['diff', '--cached', '--no-ext-diff', '--name-only', '-z', baseBranch, '--']).split('\0').filter(Boolean);
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  return [...new Set([...tracked, ...staged, ...untracked.filter((file) => !engineGenerated(file))])].sort();
}

export function engineGenerated(file: string): boolean {
  return /^\.tawny-orch\/(?:inbox\/|worktrees\/|memory\.jsonl$)/.test(file);
}

export interface WorkspaceFacts {
  kind: 'git' | 'filesystem';
  head: string;
  branch: string;
  index: string;
  files: Record<string, string>;
}

/** Content hashes detect writes to already-dirty files, staged changes, commits and deletions. */
export function workspaceFacts(cwd: string): WorkspaceFacts {
  const isGit = hasGitDirectory(cwd);
  if (!isGit && existsSync(join(cwd, '.git'))) throw new Error('Git evidence is unavailable.');
  const facts: WorkspaceFacts = { kind: isGit ? 'git' : 'filesystem', head: '', branch: '', index: '', files: {} };
  let files: string[];
  if (isGit) {
    facts.head = git(cwd, ['rev-parse', '--verify', 'HEAD']).trim();
    facts.branch = git(cwd, ['rev-parse', '--symbolic-full-name', 'HEAD']).trim();
    facts.index = git(cwd, ['ls-files', '--stage', '-z']) + '\nSTATUS\n' +
      git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
    const tracked = git(cwd, ['ls-files', '-z']).split('\0').filter(Boolean);
    const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
    files = [...new Set([...tracked, ...untracked.filter((file) => !engineGenerated(file))])];
  } else {
    files = [];
    const walk = (dir: string, prefix = ''): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = `${prefix}${entry.name}`;
        if (entry.name === 'node_modules' || entry.name === '.git' || engineGenerated(`${file}${entry.isDirectory() ? '/' : ''}`)) continue;
        if (entry.isDirectory()) walk(join(dir, entry.name), `${file}/`);
        else files.push(file);
      }
    };
    walk(cwd);
  }
  for (const file of files.sort()) {
    const path = join(cwd, file);
    try {
      const stat = lstatSync(path);
      if (stat.isDirectory()) { facts.files[file] = 'directory'; continue; }
      const content = stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path);
      facts.files[file] = createHash('sha256').update(content).update(String(stat.mode & 0o777)).digest('hex');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      facts.files[file] = 'deleted';
    }
  }
  return facts;
}

export function factChanges(before: WorkspaceFacts, after: WorkspaceFacts): string[] {
  const indexEntries = (facts: WorkspaceFacts): Record<string, string> => Object.fromEntries(
    facts.index.split('\nSTATUS\n')[0].split('\0').filter(Boolean).map((entry) => {
      const tab = entry.indexOf('\t');
      return [entry.slice(tab + 1), entry.slice(0, tab)];
    })
  );
  const left = indexEntries(before);
  const right = indexEntries(after);
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files), ...Object.keys(left), ...Object.keys(right)])]
    .filter((file) => before.files[file] !== after.files[file] || left[file] !== right[file]).sort();
}

export function readOnlyGate(before: WorkspaceFacts, after: WorkspaceFacts): GateResult {
  const changes = factChanges(before, after);
  if (before.kind !== after.kind) return gateResult('read_only', 'error', 'Workspace evidence kind changed.');
  return changes.length || before.head !== after.head || before.branch !== after.branch || before.index !== after.index
    ? gateResult('read_only', 'fail', `Read-only stage changed workspace/index/HEAD: ${changes.slice(0, 8).join(', ') || 'git metadata'}`)
    : gateResult('read_only', 'pass', `No changes in ${after.kind} evidence.`);
}

export function gateResult(gate: string, result: GateResult['result'], reason = '', durationMs = 0): GateResult {
  return { gate, result, reason, durationMs };
}

export const SECRET_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'openai-key', pattern: /\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'gemini-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'dotenv-exposed', pattern: /^\s*(?:ADMIN_PASSWORD|SECRET_KEY|API_KEY|PRIVATE_KEY)\s*=\s*["']?[A-Za-z0-9/+_-]{16,}["']?\s*$/m },
  { id: 'private-key-pem', pattern: /-----BEGIN (?:RSA |EC |OpenSSH )?PRIVATE KEY-----/ }
];

export function scanSecrets(text: string, filePaths?: string[]): GateResult {
  const findings: string[] = [];
  for (const { id, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) findings.push(id);
  }
  if (findings.length === 0) {
    return gateResult('secret_scan', 'pass');
  }
  const files = filePaths && filePaths.length > 0 ? ` in ${filePaths.join(', ')}` : '';
  return gateResult('secret_scan', 'fail', `Potential secrets detected (${findings.join(', ')})${files}. Remove them before proceeding.`);
}

export function scopeGate(
  changed: string[] | 'not-git',
  contract: TaskContract
): GateResult {
  if (changed === 'not-git') {
    return gateResult('scope', 'pass', 'Not a git checkout; scope gate skipped.');
  }
  const constraints = contract.constraints;
  const violations = changed.filter((file) => {
    if (matchesAny(file, constraints.forbiddenFiles)) return true;
    if (constraints.allowedFiles.length > 0 && !matchesAny(file, constraints.allowedFiles)) return true;
    return false;
  });
  if (violations.length === 0) return gateResult('scope', 'pass');
  return gateResult(
    'scope',
    'fail',
    `Files outside the stage's declared scope: ${violations.slice(0, 8).join(', ')}${violations.length > 8 ? '…' : ''}`
  );
}

function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globMatches(file, pattern));
}

// Glob semantics:
//   '**' matches across separators ('.env*' → any env file at that level,
//   'src/**/*.tsx' → tsx files at any depth under src),
//   a bare '*' matches anything, '*' inside a segment stops at '/'.
export function globMatches(file: string, pattern: string): boolean {
  if (pattern === '*' || pattern === '**') return true;
  let source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  source = source.replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*');
  try {
    return new RegExp(`^${source}$`).test(file);
  } catch {
    return false;
  }
}
