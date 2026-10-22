import { spawn } from 'node:child_process';
import { prepareChildSpawn } from '../agents/childRunner';

type WindowsCommand = { command: string; versionArg?: string[] };

export interface AgentCatalogEntry {
  id: string;
  label: string;
  tier: 'A' | 'B' | 'C';
  family: 'anthropic' | 'openai' | 'google' | 'cursor' | 'other' | 'human';
  command: string;
  args?: string[];
  versionArg?: string[];
  installHint: string;
  costClass: number;
  latencyClass: number;
  roles: string[];
}

// Canonical agent terminal catalog. `command` is resolved strictly against PATH
// with `where.exe`; no shell interpolation ever happens with agent names.
export const agentCatalog: AgentCatalogEntry[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    tier: 'A',
    family: 'anthropic',
    command: 'claude',
    versionArg: ['--version'],
    installHint: 'npm install -g @anthropic-ai/claude-code',
    costClass: 0.35,
    latencyClass: 0.35,
    roles: ['plan', 'execute', 'review', 'research']
  },
  {
    id: 'codex',
    label: 'Codex (OpenAI)',
    tier: 'A',
    family: 'openai',
    command: 'codex',
    versionArg: ['--version'],
    installHint: 'npm install -g @openai/codex',
    costClass: 0.4,
    latencyClass: 0.45,
    // The adapter uses Codex's read-only sandbox for research, planning,
    // review, and delivery; execution/testing use workspace-write.
    roles: ['research', 'plan', 'execute', 'test', 'review', 'deliver']
  },
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    tier: 'A',
    family: 'google',
    command: 'gemini',
    versionArg: ['--version'],
    installHint: 'npm install -g @google/gemini-cli',
    costClass: 0.25,
    latencyClass: 0.4,
    roles: ['research', 'execute', 'test']
  },
  {
    id: 'cursor-agent',
    label: 'Cursor Agent',
    tier: 'B',
    family: 'cursor',
    command: 'cursor-agent',
    versionArg: ['--version'],
    installHint: 'npm install -g @cursor/agent-cli (requires Cursor account)',
    costClass: 0.5,
    latencyClass: 0.5,
    roles: ['execute']
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    tier: 'B',
    family: 'other',
    command: 'opencode',
    versionArg: ['--version'],
    installHint: 'npm install -g opencode-ai',
    costClass: 0.45,
    latencyClass: 0.5,
    // The adapter's plan profile is read-only and is used for all non-writing
    // stages, including plan, review, and delivery.
    roles: ['research', 'plan', 'execute', 'test', 'review', 'deliver']
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    tier: 'A',
    family: 'google',
    command: 'agy',
    versionArg: ['--version'],
    installHint: 'Install Google Antigravity CLI (agy): https://antigravity.google/docs/cli/install/',
    costClass: 0.25,
    latencyClass: 0.4,
    roles: ['research', 'plan', 'execute', 'test', 'review']
  },
  {
    id: 'muse-code',
    label: 'Muse Code',
    tier: 'C',
    family: 'other',
    command: 'muse',
    versionArg: ['--version'],
    installHint: 'Muse Code may not have a public CLI - please check its installation documentation',
    costClass: 0.5,
    latencyClass: 0.7,
    roles: ['execute', 'research']
  },
  {
    id: 'qwen-code',
    label: 'Qwen Code',
    tier: 'B',
    family: 'other',
    command: 'qwen',
    versionArg: ['--version'],
    installHint: 'npm install -g @qwen-code/qwen-code',
    costClass: 0.2,
    latencyClass: 0.45,
    roles: ['research', 'plan', 'execute', 'test', 'review', 'deliver']
  },
  {
    id: 'manual',
    label: 'Manual slot',
    tier: 'C',
    family: 'human',
    command: '',
    installHint: 'No install required - the pipeline writes a task packet for you',
    costClass: 0.9,
    latencyClass: 0.95,
    roles: ['research', 'plan', 'execute', 'test', 'review', 'deliver']
  }
];

export const agentIds = agentCatalog.map((entry) => entry.id);

export function catalogEntry(agentId: string): AgentCatalogEntry | undefined {
  return agentCatalog.find((entry) => entry.id === agentId);
}

export async function whereCommand(command: string): Promise<boolean> {
  if (!command) return true;
  const windowsCommand: WindowsCommand = { command };
  if (!windowsCommand.command) return false;
  return new Promise((resolveWait) => {
    const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
    const probe = spawn(lookup, [windowsCommand.command], { windowsHide: true, stdio: 'ignore' });
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolveWait(value);
    };
    const killer = setTimeout(() => done(false), 4000);
    probe.on('error', () => done(false));
    probe.on('close', (code) => done(code === 0));
  });
}

export async function probeVersion(entry: AgentCatalogEntry, timeoutMs = 8000): Promise<string> {
  const args = entry.versionArg ?? ['--version'];
  return new Promise((resolveVersion) => {
    let probe: ReturnType<typeof spawn>;
    let output = '';
    let settled = false;
    const done = (value: string, code?: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      try {
        probe.kill();
      } catch {
        /* already gone */
      }
      const lines = value.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const versionLine = lines.find((line) => /\d+\.\d+/.test(line));
      resolveVersion(code === 0 ? (versionLine ?? lines[0] ?? '').slice(0, 60) : '');
    };
    const killer = setTimeout(() => done(''), timeoutMs);
    try {
      // Apply Windows PATHEXT and .cmd/.bat shim handling to version probes too.
      const invocation = prepareChildSpawn(entry.command, args, process.cwd(), process.env);
      probe = spawn(invocation.command, invocation.args, {
        ...invocation.options, windowsHide: true, env: process.env, stdio: 'pipe'
      });
    } catch {
      done('');
      return;
    }
    probe.stdout?.on('data', (chunk: Buffer) => { output = `${output}${chunk.toString()}`.slice(-4096); });
    probe.stderr?.on('data', (chunk: Buffer) => { output = `${output}${chunk.toString()}`.slice(-4096); });
    probe.on('error', () => done(''));
    probe.on('close', (code) => done(output, code));
  });
}

export function isVersionLike(output: string): boolean {
  const normalized = output.trim().toLowerCase();
  if (!normalized) return false;
  // Some Windows shims print access warnings before the actual version line.
  return normalized.split(/\r?\n/).some((line) => /\d+\.\d+/.test(line.slice(0, 120)));
}
