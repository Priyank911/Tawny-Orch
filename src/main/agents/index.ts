import type { AgentAdapter } from './base';
import { claudeCodeAdapter } from './claudeCode';
import { codexAdapter } from './codex';
import { geminiAdapter } from './gemini';
import { cursorAgentAdapter } from './cursorAgent';
import { opencodeAdapter } from './opencode';
import { antigravityAdapter } from './antigravity';
import { qwenAdapter } from './qwen';
import { makePacketCliAdapter } from './packetCli';
import { makePacketAdapter } from './packet';
import { catalogEntry } from '../detect/registry';

const adapters = new Map<string, AgentAdapter>([
  ['claude-code', claudeCodeAdapter],
  ['codex', codexAdapter],
  ['gemini-cli', geminiAdapter],
  ['cursor-agent', cursorAgentAdapter],
  ['opencode', opencodeAdapter],
  ['antigravity', antigravityAdapter],
  ['qwen-code', qwenAdapter],
  // Muse Code remains IDE-first and routes through a manual packet.
  ['muse-code', makePacketAdapter({ id: 'muse-code', name: 'Muse Code', tier: 'C' })],
  ['manual', makePacketAdapter({ id: 'manual', name: 'Manual slot', tier: 'C' })]
]);

export function getAdapter(agentId: string): AgentAdapter | undefined {
  const known = adapters.get(agentId);
  if (known) return known;
  // Unknown but catalog-listed agents fall back to packet execution so a
  // pipeline stage is never blocked by a missing adapter.
  if (catalogEntry(agentId)) return adapters.get('manual');
  return undefined;
}

export function adapterIds(): string[] {
  return [...adapters.keys()];
}
