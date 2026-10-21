import {
  agentCatalog, catalogEntry, isVersionLike, probeVersion, whereCommand, type AgentCatalogEntry
} from './registry';
import type { AgentStatus } from '../../shared/contracts';

const DETECT_CACHE_TTL_MS = 15_000;
let cache: AgentStatus[] = [];
let cacheAt = 0;

export function fromCatalog(entry: AgentCatalogEntry, detected: boolean, version = '', health: AgentStatus['health'] = 'ready'): AgentStatus {
  return {
    id: entry.id,
    label: entry.label,
    tier: entry.tier,
    family: entry.family,
    detected,
    version,
    installHint: entry.installHint,
    health,
    costClass: entry.costClass,
    latencyClass: entry.latencyClass,
    roles: entry.roles as AgentStatus['roles']
  };
}

export async function detectAgents(force = false): Promise<AgentStatus[]> {
  if (!force && cache.length > 0 && Date.now() - cacheAt < DETECT_CACHE_TTL_MS) {
    return cache;
  }
  const results: AgentStatus[] = [];
  for (const entry of agentCatalog) {
    if (!entry.command) {
      // Manual slot: always available.
      results.push(fromCatalog(entry, true));
      continue;
    }
    const onPath = await whereCommand(entry.command);
    if (!onPath) {
      results.push(fromCatalog(entry, false, '', 'not_installed'));
      continue;
    }
    const version = entry.versionArg ? await probeVersion(entry) : '';
    const healthy = entry.versionArg ? version.length > 0 && isVersionLike(version) : true;
    results.push(
      fromCatalog(
        entry,
        healthy,
        version,
        healthy ? 'ready' : 'probe_failed'
      )
    );
  }
  cache = results;
  cacheAt = Date.now();
  return results;
}

export function cachedAgents(): AgentStatus[] {
  return cache;
}

export function agentLabel(agentId: string): string {
  return catalogEntry(agentId)?.label ?? agentId;
}

export function isAgentDetected(agentId: string, agents?: AgentStatus[]): boolean {
  if (agentId === 'manual') return true;
  const list = agents ?? cachedAgents();
  if (list.length === 0) return true; // never block routing during boot
  return list.some((status) => status.id === agentId && status.detected);
}
