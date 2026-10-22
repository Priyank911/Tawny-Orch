import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitives (Tawny parity)
// ---------------------------------------------------------------------------

export const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof logLevelSchema>;

export const errorClassSchema = z.enum(['transient', 'permanent', 'input', 'environment', 'cancelled']);
export type ErrorClass = z.infer<typeof errorClassSchema>;

export const stageSchema = z.enum(['capture', 'stt', 'gate', 'decide', 'dispatch', 'orchestrate']);
export type Stage = z.infer<typeof stageSchema>;

export class PipelineError extends Error {
  readonly name = 'PipelineError';
  constructor(
    public readonly cls: ErrorClass,
    public readonly stage: Stage,
    public readonly userMessage: string,
    public readonly retryAfterMs?: number
  ) {
    super(userMessage);
  }
}

export const pipelineLogSchema = z.object({
  timestamp: z.string(),
  level: logLevelSchema,
  event: z.string(),
  message: z.string(),
  jobId: z.string().optional(),
  runId: z.string().optional(),
  stage: stageSchema.optional(),
  provider: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  errorClass: errorClassSchema.optional(),
  data: z.record(z.string(), z.string()).optional()
});
export type PipelineLog = z.infer<typeof pipelineLogSchema>;

// ---------------------------------------------------------------------------
// Roles, stages, pipelines
// ---------------------------------------------------------------------------

export const roleKindSchema = z.enum(['research', 'plan', 'execute', 'test', 'review', 'deliver']);
export type RoleKind = z.infer<typeof roleKindSchema>;

export const stageStatusSchema = z.enum([
  'queued', 'routed', 'contract_ready', 'running', 'gated',
  'passed', 'failed', 'retrying', 'escalated', 'skipped', 'cancelled'
]);
export type StageStatus = z.infer<typeof stageStatusSchema>;

export const stageSpecSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+(?![\s\S])/, 'Stage IDs may contain only ASCII letters, digits, underscores and hyphens.'),
  title: z.string().min(1).default(''),
  role: roleKindSchema,
  agentId: z.string().nullable().default(null),
  acceptanceCommands: z.array(z.string()).default([]),
  allowedFiles: z.array(z.string()).default([]),
  forbiddenFiles: z.array(z.string()).default([]),
  retries: z.number().int().min(0).max(5).default(2)
});
export type StageSpec = z.infer<typeof stageSpecSchema>;

export const pipelineTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  stages: z.array(stageSpecSchema).min(1)
});
export type PipelineTemplate = z.infer<typeof pipelineTemplateSchema>;

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export const agentTierSchema = z.enum(['A', 'B', 'C']);
export type AgentTier = z.infer<typeof agentTierSchema>;

export const agentStatusSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  tier: agentTierSchema,
  family: z.enum(['anthropic', 'openai', 'google', 'cursor', 'other', 'human']),
  detected: z.boolean(),
  version: z.string().default(''),
  installHint: z.string().default(''),
  health: z.enum(['ready', 'not_installed', 'probe_failed']).default('ready'),
  costClass: z.number().min(0).max(1).default(0.5),
  latencyClass: z.number().min(0).max(1).default(0.5),
  roles: z.array(roleKindSchema).default([]),
  authenticated: z.boolean().optional(),
  remainingRequests: z.number().nonnegative().optional()
});
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const agentResultsSchema = z.object({
  status: z.enum(['completed', 'failed']),
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  unresolved: z.array(z.string()).default([]),
  confidence: z.enum(['low', 'medium', 'high']).default('medium')
});
export type AgentResult = z.infer<typeof agentResultsSchema>;

// ---------------------------------------------------------------------------
// Memory ledger (shared between agents)
// ---------------------------------------------------------------------------

export const memoryCategorySchema = z.enum(['conventions', 'decisions', 'failures', 'interfaces']);
export type MemoryCategory = z.infer<typeof memoryCategorySchema>;

export const memoryEntrySchema = z.object({
  id: z.string(),
  category: memoryCategorySchema,
  content: z.string().min(1),
  sourceRunId: z.string().default(''),
  createdAt: z.string(),
  confidence: z.number().min(0).max(1).default(0.9)
});
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const runStatusSchema = z.enum(['pending', 'running', 'escalated', 'done', 'failed', 'cancelled']);

export const gateResultSchema = z.object({
  gate: z.string(),
  result: z.enum(['pass', 'fail', 'error']),
  reason: z.string().default(''),
  durationMs: z.number().nonnegative().default(0)
});
export type GateResult = z.infer<typeof gateResultSchema>;

export const artifactRefSchema = z.object({
  name: z.string(),
  path: z.string()
});
export type ArtifactRef = z.infer<typeof artifactRefSchema>;

export const stageRuntimeSchema = z.object({
  spec: stageSpecSchema,
  status: stageStatusSchema.default('queued'),
  agentId: z.string().nullable().default(null),
  attempt: z.number().int().min(1).default(1),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  summary: z.string().default(''),
  failureReason: z.string().default(''),
  gates: z.array(gateResultSchema).default([]),
  artifacts: z.array(artifactRefSchema).default([])
});
export type StageRuntime = z.infer<typeof stageRuntimeSchema>;

export const runSnapshotSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  projectPath: z.string().min(1),
  projectName: z.string().default(''),
  templateId: z.string().default(''),
  branchPrefix: z.string().default('tawny-orch'),
  requestedOutputs: z.array(z.string()).default([]),
  publishedOutputs: z.array(z.string()).default([]),
  publicationIssues: z.array(z.string()).default([]),
  status: runStatusSchema.default('pending'),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  stages: z.array(stageRuntimeSchema)
});
export type RunSnapshot = z.infer<typeof runSnapshotSchema>;

export const baseBranchSchema = z.object({
  branch: z.string().default('main'),
  detachedHead: z.boolean().default(false)
});

// ---------------------------------------------------------------------------
// Orchestration events (append-only ledger streamed to the renderer)
// ---------------------------------------------------------------------------

export const orchEventSchema = z.object({
  ts: z.string(),
  level: logLevelSchema.default('info'),
  type: z.string(),
  runId: z.string().optional(),
  stageId: z.string().optional(),
  agentId: z.string().optional(),
  message: z.string(),
  data: z.record(z.string(), z.string()).optional()
});
export type OrchEvent = z.infer<typeof orchEventSchema>;

// ---------------------------------------------------------------------------
// Task contract (handoff between stages/agents)
// ---------------------------------------------------------------------------

export const taskContractSchema = z.object({
  runId: z.string(),
  stageId: z.string(),
  role: roleKindSchema,
  agentId: z.string(),
  goal: z.string(),
  projectPath: z.string(),
  projectName: z.string().default(''),
  worktreePath: z.string().default(''),
  requestedOutputs: z.array(z.string()).default([]),
  baseBranch: z.string().default('main'),
  planSummary: z.string().default(''),
  researchSummary: z.string().default(''),
  diffSoFar: z.array(z.string()).default([]),
  testReport: z.string().default(''),
  reviewFindings: z.string().default(''),
  // Verified prior-stage packets are embedded into the next contract so an
  // agent never needs filesystem access to Tawny's private app-data directory.
  verifiedHandoffs: z.array(z.string()).default([]),
  memory: z.array(memoryEntrySchema).default([]),
  constraints: z.object({
    allowedFiles: z.array(z.string()).default([]),
    forbiddenFiles: z.array(z.string()).default([]),
    acceptanceCommands: z.array(z.string()).default([]),
    timeoutMinutes: z.number().int().min(1).max(180).default(15)
  }).default({ allowedFiles: [], forbiddenFiles: [], acceptanceCommands: [], timeoutMinutes: 15 }),
  previousFailure: z.object({
    gate: z.string(),
    reason: z.string()
  }).optional(),
  attempts: z.object({
    attempt: z.number().int().min(1),
    maxAttempts: z.number().int().min(1)
  }).default({ attempt: 1, maxAttempts: 3 }),
  strictOutput: z.object({
    path: z.string(),
    hint: z.string()
  }).optional()
});
export type TaskContract = z.infer<typeof taskContractSchema>;

export const artifactBundleSchema = z.object({
  stdoutSummary: z.string().default(''),
  result: agentResultsSchema.nullable().default(null),
  stderrTail: z.array(z.string()).default([]),
  exitCode: z.number().int().nullable().default(null),
  timedOut: z.boolean().default(false),
  sessionId: z.string().optional()
});
export type ArtifactBundle = z.infer<typeof artifactBundleSchema>;

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const budgetPolicySchema = z.enum(['free-only', 'free-first', 'quality-first']);
export type BudgetPolicy = z.infer<typeof budgetPolicySchema>;

// User-confirmed access to the configured agent/model, never a vendor promotion.
export const agentEntitlementSchema = z.object({
  kind: z.enum(['local', 'free', 'paid', 'unknown']).default('unknown'),
  userConfirmed: z.boolean().default(false),
  authenticated: z.boolean().optional(),
  remainingRequests: z.number().nonnegative().optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  // Upper bound for this dispatch, not a costClass score or average estimate.
  maxCostUsd: z.number().nonnegative().optional()
});
export type AgentEntitlement = z.infer<typeof agentEntitlementSchema>;

export const budgetConfigSchema = z.object({
  policy: budgetPolicySchema.default('free-only'),
  maxUsd: z.number().nonnegative().default(0),
  spentUsd: z.number().nonnegative().default(0),
  entitlements: z.record(z.string(), agentEntitlementSchema).default({})
});
export type BudgetConfig = z.infer<typeof budgetConfigSchema>;
export type BudgetConfigInput = z.input<typeof budgetConfigSchema>;

export const agentScoreRowSchema = z.object({
  agent: z.string(),
  role: roleKindSchema,
  attempts: z.number().int().min(0).default(0),
  passes: z.number().int().min(0).default(0),
  avgLatencyMs: z.number().nonnegative().default(0)
});
export type AgentScoreRow = z.infer<typeof agentScoreRowSchema>;

// ---------------------------------------------------------------------------
// Voice overlay (Tawny parity)
// ---------------------------------------------------------------------------

export const overlayStateSchema = z.enum([
  'idle', 'arming', 'recording', 'finalizing', 'transcribing', 'gating',
  'deciding', 'confirming', 'handling', 'dispatching', 'done', 'failed', 'cancelled'
]);
export type OverlayState = z.infer<typeof overlayStateSchema>;

export const voiceIntentSchema = z.enum([
  'build_in_project', 'new_project', 'attach_folder', 'status',
  'stop_run', 'pause_run', 'resume_run', 'assign_role', 'dictation_goal'
]);
export type VoiceIntent = z.infer<typeof voiceIntentSchema>;

export const voiceDecisionSchema = z.object({
  intent: voiceIntentSchema,
  goal: z.string().default(''),
  projectPath: z.string().default(''),
  projectName: z.string().default(''),
  role: roleKindSchema.optional(),
  agentId: z.string().optional(),
  decidedBy: z.string().default('local'),
  confidence: z.number().min(0).max(1).default(1),
  message: z.string().optional()
});
export type VoiceDecision = z.infer<typeof voiceDecisionSchema>;

export const overlaySnapshotSchema = z.object({
  state: overlayStateSchema,
  stage: stageSchema.optional(),
  elapsedMs: z.number().nonnegative().default(0),
  rms: z.number().min(0).max(1).default(0),
  message: z.string().optional(),
  transcript: z.string().optional(),
  decision: voiceDecisionSchema.optional(),
  runId: z.string().optional(),
  runStageIndex: z.number().int().optional(),
  runStageTotal: z.number().int().optional(),
  runStageTitle: z.string().optional()
});
export type OverlaySnapshot = z.infer<typeof overlaySnapshotSchema>;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const appPreferencesSchema = z.object({
  hotkey: z.string().default('Control+Alt+Space'),
  alwaysRoute: z.boolean().default(false),
  wakePhrases: z.array(z.string()).default(['hey tawny', 'hey buddy'])
});
export type AppPreferences = z.infer<typeof appPreferencesSchema>;

export const appSettingsSchema = z.object({
  groqApiKey: z.string().default(''),
  cloudflareAccountId: z.string().default(''),
  cloudflareApiToken: z.string().default(''),
  budget: budgetConfigSchema.optional(),
  prefs: appPreferencesSchema.default({
    hotkey: 'Control+Alt+Space',
    alwaysRoute: false,
    wakePhrases: ['hey tawny', 'hey buddy']
  })
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

export const providerSettingsSchema = appSettingsSchema;

export const settingsUpdateSchema = z.object({
  settings: appSettingsSchema.partial(),
  prefs: appPreferencesSchema.partial().optional()
});

export const projectAttachmentSchema = z.object({
  path: z.string(),
  name: z.string(),
  isGit: z.boolean()
});
export type ProjectAttachment = z.infer<typeof projectAttachmentSchema>;

// ---------------------------------------------------------------------------
// Project config (.tawny-orch/config.json) — pipeline persistence per project
// ---------------------------------------------------------------------------

export const projectConfigSchema = z.object({
  version: z.literal(1).default(1),
  templateId: z.string().default('solo'),
  stages: z.array(stageSpecSchema).default([]),
  updatedAt: z.string().optional()
});
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
