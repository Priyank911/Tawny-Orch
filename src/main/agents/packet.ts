import { writeFile, readFile, access, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { AgentAdapter, AdapterContext, AdapterHandle } from './base';
import type { ArtifactBundle, AgentTier } from '../../shared/contracts';
import { agentResultsSchema } from '../../shared/contracts';
import { contractMarkdown, imperativePrompt } from '../orchestrator/prompts';
import { logPipeline } from '../logger';

export const SENTINEL_FILE = 'DONE.json';

export interface PacketPaths {
  packet: string;
  sentinelDir: string;
  sentinel: string;
}

export function packetPaths(context: AdapterContext, packetRootDir?: string): PacketPaths {
  const base = packetRootDir ?? join(context.workdir, 'packets');
  const packet = join(base, `${context.contract.runId}-${context.contract.stageId}.md`);
  const sentinelDir = join(base, `${context.contract.runId}-${context.contract.stageId}`);
  return { packet, sentinelDir, sentinel: join(sentinelDir, SENTINEL_FILE) };
}

// Tier C adapters: write a self-contained task packet that a human (Muse Code
// or another external tool) completes manually. The run waits for the
// sentinel file, which must contain an agent result JSON payload.
export function makePacketAdapter(options: { id: string; name: string; tier: AgentTier; pollMs?: number }): AgentAdapter {
  const pollMs = options.pollMs ?? 4000;
  const cancelled = new Set<string>();

  return {
    id: options.id,
    name: options.name,
    tier: options.tier,
    async start(context: AdapterContext): Promise<AdapterHandle> {
      const paths = packetPaths(context);
      await mkdir(dirname(paths.packet), { recursive: true });
      cancelled.delete(`${context.contract.runId}:${context.contract.stageId}`);
      const header = [
        `# Tawny Orch task packet — ${options.name}`,
        '',
        imperativePrompt(context.contract, 'packet'),
        '',
        '## Completion checklist',
        '',
        `1. Complete the task described below with your usual tooling.`,
        `2. When finished, create this sentinel file containing a JSON agent result:`,
        ``,
        '```json',
        JSON.stringify({ status: 'completed', summary: '…', filesChanged: [], assumptions: [], unresolved: [], confidence: 'medium' }, null, 2),
        '```',
        ``,
        `Sentinel path: ${paths.sentinel}`,
        '',
        'The engine re-verifies the result with deterministic gates before dispatching the next stage.',
        ''
      ].join('\n');
      await writeFile(paths.packet, `${header}\n---\n\n${contractMarkdown(context.contract)}`, 'utf8');
      logPipeline({
        event: 'packet.written',
        message: `Task packet created for ${options.name}: ${paths.packet}`,
        stage: 'orchestrate',
        runId: context.contract.runId,
        data: { packet: paths.packet, sentinel: paths.sentinel }
      });
      return {
        key: `${context.contract.runId}:${context.contract.stageId}:${options.id}`,
        ctx: context,
        extras: { packet: paths.packet, sentinel: paths.sentinel }
      };
    },
    async collect(handle: AdapterHandle): Promise<ArtifactBundle> {
      const paths = packetPaths(handle.ctx);
      const startedAt = Date.now();
      const timeoutMs = Math.max(120_000, handle.ctx.contract.constraints.timeoutMinutes * 60_000);
      while (Date.now() - startedAt < timeoutMs) {
        const key = `${handle.ctx.contract.runId}:${handle.ctx.contract.stageId}`;
        if (cancelled.has(key)) {
          return {
            stdoutSummary: 'Manual packet cancelled by the user.',
            result: null,
            stderrTail: [],
            exitCode: null,
            timedOut: false
          };
        }
        const result = await readSentinel(paths.sentinel);
        if (result) return result;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, pollMs));
      }
      return {
        stdoutSummary: 'Manual packet was never completed within its time budget.',
        result: null,
        stderrTail: [`Timed out waiting for ${paths.sentinel}`],
        exitCode: null,
        timedOut: true
      };
    },
    async cancel(handle: AdapterHandle): Promise<void> {
      cancelled.add(`${handle.ctx.contract.runId}:${handle.ctx.contract.stageId}`);
      try {
        await rm(packetPaths(handle.ctx).sentinel, { force: true });
      } catch {
        /* nothing to clean */
      }
    }
  };
}

export async function readSentinel(sentinelPath: string): Promise<ArtifactBundle | undefined> {
  if (!(await exists(sentinelPath))) return undefined;
  try {
    const raw = await readFile(sentinelPath, 'utf8');
    const parsed = agentResultsSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      return { stdoutSummary: parsed.data.summary, result: parsed.data, stderrTail: [], exitCode: 0, timedOut: false };
    }
    return {
      stdoutSummary: 'Manual packet sentinel present but malformed.',
      result: null,
      stderrTail: ['The sentinel JSON did not match the agent result schema.'],
      exitCode: 0,
      timedOut: false
    };
  } catch (error) {
    return {
      stdoutSummary: 'Manual packet sentinel could not be read.',
      result: null,
      stderrTail: [String(error)],
      exitCode: 0,
      timedOut: false
    };
  }
}

// Used by the renderer's "complete manually" action: drops the sentinel the
// adapter's collect() loop is polling for.
export async function writeManualResult(
  context: AdapterContext,
  result: ArtifactBundle | undefined
): Promise<void> {
  const paths = packetPaths(context);
  await mkdir(paths.sentinelDir, { recursive: true });
  await writeFile(
    paths.sentinel,
    JSON.stringify(
      result?.result ?? { status: 'completed', summary: 'Manually completed from Tawny Orch.', filesChanged: [], assumptions: [], unresolved: [], confidence: 'low' }
    ),
    'utf8'
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
