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
    roles: ['execute', 'test']
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
    roles: ['execute', 'research']
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
    roles: ['execute', 'research']
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
    const probe = spawn('where.exe', [windowsCommand.command], { windowsHide: true });
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
    const done = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      try {
        probe.kill();
      } catch {
        /* already gone */
      }
      resolveVersion(value.trim().split(/\r?\n/, 1)[0].slice(0, 60));
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
    probe.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    probe.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    probe.on('error', () => done(''));
    probe.on('close', () => done(output));
  });
}

export function isVersionLike(output: string): boolean {
  const normalized = output.trim().toLowerCase();
  if (!normalized) return false;
  // CLI version strings like "1.0.32 (Claude Code)", "codex 0.44.0", or banner text.
  return /\d+\.\d+/.test(normalized.split(/\r?\n/, 1)[0].slice(0, 120));
}
