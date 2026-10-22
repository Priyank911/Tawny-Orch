import type { PipelineTemplate } from '../../shared/contracts';

function stagesFor(
  assignments: Partial<Record<string, string | null>>
): PipelineTemplate['stages'] {
  return [
    {
      id: 'research', title: 'Research', role: 'research',
      agentId: assignments.research ?? null, acceptanceCommands: [], allowedFiles: [], forbiddenFiles: [], retries: 1
    },
    {
      id: 'plan', title: 'Plan', role: 'plan',
      agentId: assignments.plan ?? null, acceptanceCommands: [], allowedFiles: [], forbiddenFiles: [], retries: 1
    },
    {
      id: 'execute', title: 'Execute', role: 'execute',
      agentId: assignments.execute ?? null, acceptanceCommands: [], allowedFiles: [], forbiddenFiles: ['.env*', '**/.env*', 'infra/**', '.github/**'], retries: 2
    },
    {
      id: 'test', title: 'Test', role: 'test',
      agentId: assignments.test ?? null, acceptanceCommands: [], allowedFiles: [], forbiddenFiles: [], retries: 2
    },
    {
      id: 'review', title: 'Review', role: 'review',
      agentId: assignments.review ?? null, acceptanceCommands: [], allowedFiles: [], forbiddenFiles: [], retries: 1
    },
    {
      id: 'deliver', title: 'Deliver summary', role: 'deliver',
      agentId: assignments.deliver ?? null, acceptanceCommands: [], allowedFiles: [], forbiddenFiles: [], retries: 1
    }
  ];
}

export const BASE_TEMPLATES: PipelineTemplate[] = [
  {
    id: 'solo',
    name: 'Balanced pipeline',
    description: 'Choose the best detected tool for each stage. Use manual packets when a stage needs your input; verification stays independent.',
    stages: stagesFor({})
  },
  {
    id: 'duo',
    name: 'Cross-vendor duo',
    description: 'Plan + execute on a strong vendor; research, tests, and review stay on a different family.',
    stages: stagesFor({ research: 'gemini-cli', plan: 'claude-code', execute: 'claude-code', test: 'gemini-cli', review: 'codex', deliver: 'gemini-cli' })
  },
  {
    id: 'cross-vendor',
    name: 'Full cross-vendor team',
    description: 'Every stage on a different family: Gemini research, Claude plans, Codex executes, Gemini tests, Claude reviews.',
    stages: stagesFor({ research: 'gemini-cli', plan: 'claude-code', execute: 'codex', test: 'gemini-cli', review: 'claude-code', deliver: 'codex' })
  },
  {
    id: 'manual-slot',
    name: 'Human-in-the-loop',
    description: 'All stages become manual task packets; use when only packet-style agents exist.',
    stages: stagesFor({ research: 'manual', plan: 'manual', execute: 'manual', test: 'manual', review: 'manual', deliver: 'manual' })
  }
];

export function templateById(id: string): PipelineTemplate | undefined {
  return BASE_TEMPLATES.find((template) => template.id === id);
}

export const ROLE_TITLES: Record<string, string> = {
  research: 'Research',
  plan: 'Plan',
  execute: 'Execute',
  test: 'Test',
  review: 'Review',
  deliver: 'Deliver summary'
};
