import { readFile } from 'node:fs/promises';
import type { RunSnapshot } from '../../shared/contracts';
import { readVerifiedPacket, redactSecrets } from './packets';

const quoted = (text: string): string => text.split('\n').map((line) => `    ${line}`).join('\n');
const oneLine = (text: string): string => text.replace(/[\r\n]+/g, ' ');

/** Reports distinguish observed facts, agent claims, skipped work and unavailable telemetry. */
export async function runReport(run: RunSnapshot): Promise<string> {
  const selectedProjectWorkspace = run.stages.some((stage) => stage.artifacts.some((artifact) => artifact.name === 'workspace_mode' && artifact.path === 'selected-project'));
  const lines = [
    '# Tawny Orch run report', '', `- Run: ${run.id}`, `- Status: ${run.status}`,
    `- Goal: ${run.goal}`, `- Project: ${run.projectName} (${run.projectPath})`,
    `- Created: ${run.createdAt}`, `- Updated: ${run.updatedAt ?? 'unknown'}`,
    '- Cost / tokens: unavailable (not measured; not assumed free)',
    selectedProjectWorkspace
      ? '- Agents worked directly in the selected project folder; the recorded file gates describe what changed there.'
      : run.publishedOutputs.length
        ? '- Only explicitly requested output files were copied from the verified run worktree; other changes remain isolated there.'
        : '- Changes remain in the run worktree; no output files were published to the project folder.',
    ...(run.requestedOutputs.length ? ['', '## Requested outputs', ...run.requestedOutputs.map((path) => `- ${path}`)] : []),
    ...(run.publishedOutputs.length ? ['', selectedProjectWorkspace ? '## Verified requested outputs' : '## Published outputs', ...run.publishedOutputs.map((path) => `- ${path}`)] : []),
    ...(run.publicationIssues.length ? ['', '## Output publication needs attention', ...run.publicationIssues.map((issue) => `- ${oneLine(issue)}`)] : []),
    ''
  ];
  for (const stage of run.stages) {
    lines.push(`## ${stage.spec.title} — ${stage.status} — agent: ${stage.agentId ?? 'n/a'}`, '',
      `- Attempts: ${stage.attempt}`, `- Started: ${stage.startedAt ?? 'not recorded'}`,
      `- Ended: ${stage.endedAt ?? 'not recorded'}`);
    for (const artifact of stage.artifacts.filter((artifact) => ['worktree', 'branch', 'base_commit'].includes(artifact.name))) {
      lines.push(`- ${artifact.name}: ${artifact.path}`);
    }
    for (const artifact of stage.artifacts.filter((artifact) => ['task_contract', 'agent_session', 'agent_result', 'task_packet'].includes(artifact.name) || artifact.name.startsWith('prior_attempt:'))) {
      lines.push(`- ${artifact.name}: ${artifact.path}`);
    }
    lines.push('', '### Agent/human self-report (not verified)', '', quoted(stage.summary || '(no summary)'));
    if (stage.failureReason) lines.push('', `Failure / decision: ${oneLine(stage.failureReason)}`);
    lines.push('', '### Engine gates', '');
    lines.push(...(stage.gates.length ? stage.gates.map((gate) => `- ${gate.gate}: ${gate.result} — ${oneLine(gate.reason || '(no details)')}`) : ['- No gate evidence. This stage is not verified.']));
    for (const artifact of stage.artifacts.filter((item) => item.name.startsWith('prior_attempt:'))) {
      try {
        const prior = JSON.parse(await readFile(artifact.path, 'utf8')) as {
          attempt?: number; agentId?: string | null; status?: string; decision?: string;
          failureReason?: string; gates?: Array<{ gate: string; result: string; reason: string }>;
        };
        lines.push('', `### Prior attempt ${prior.attempt ?? 'unknown'} — ${prior.status ?? 'unknown'} — agent: ${prior.agentId ?? 'n/a'}`);
        if (prior.decision) lines.push('', `Decision: ${oneLine(prior.decision)}`);
        if (prior.failureReason) lines.push('', `Prior failure / decision: ${oneLine(prior.failureReason)}`);
        if (prior.gates?.length) lines.push('', 'Prior attempt gates:', '', ...prior.gates.map((gate) => `- ${gate.gate}: ${gate.result} — ${oneLine(gate.reason || '(no details)')}`));
      } catch {
        lines.push('', `Prior attempt evidence could not be read: ${artifact.path}`);
      }
    }
    const path = stage.artifacts.find((artifact) => artifact.name === 'verified_packet')?.path;
    const hash = stage.artifacts.find((artifact) => artifact.name === 'packet_sha256')?.path;
    const packet = path && hash ? await readVerifiedPacket(path, hash) : undefined;
    if (!packet || packet.run !== run.id || packet.stage !== stage.spec.id || packet.attempt !== stage.attempt) {
      lines.push('', 'Verified packet: unavailable for this attempt.');
    } else {
      const truth = packet.ground_truth;
      lines.push('', `### Observed changes (${truth.evidence})`, '',
        ...truth.stage_files_changed.map((file) => `- ${JSON.stringify(file)}`));
      if (!truth.stage_files_changed.length) lines.push('- No observed file changes.');
      lines.push('', '### Contradictions / verification gaps', '',
        ...[...truth.contradictions, ...truth.verification_errors].map((item) => `- ${oneLine(item)}`));
      if (!truth.contradictions.length && !truth.verification_errors.length) lines.push('- None detected (not a proof of semantic correctness).');
    }
    const history = stage.artifacts.filter((artifact) => artifact.name.startsWith('packet_attempt:') && artifact.path !== path);
    for (const artifact of history) {
      const previous = await readVerifiedPacket(artifact.path, artifact.name.slice('packet_attempt:'.length));
      if (!previous || previous.run !== run.id || previous.stage !== stage.spec.id) {
        lines.push('', 'Earlier attempt evidence unavailable or integrity check failed.');
        continue;
      }
      lines.push('', `### Earlier attempt ${previous.attempt}`, '',
        ...previous.ground_truth.gate_results.map((gate) => `- ${gate.gate}: ${gate.result} — ${oneLine(gate.reason || '(no details)')}`),
        ...previous.ground_truth.contradictions.map((item) => `- Contradiction: ${oneLine(item)}`));
    }
    lines.push('');
  }
  if (run.stages.some((stage) => stage.status === 'skipped')) lines.push('WARNING: stages were skipped; run completion does not mean all work was verified.');
  return redactSecrets(lines.join('\n'));
}
