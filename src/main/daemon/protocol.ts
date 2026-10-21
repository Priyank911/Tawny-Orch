import { z } from 'zod';
import {
  budgetConfigSchema, orchEventSchema, pipelineLogSchema, runSnapshotSchema, stageSpecSchema
} from '../../shared/contracts';

export const PROTOCOL_VERSION = 1;
const runId = z.string().min(1).refine((value) => !/[\\/]/.test(value) && value !== '.' && value !== '..', 'Invalid run ID');
const budget = budgetConfigSchema.optional();
const empty = z.object({}).strict();

export const paramsSchemas = {
  configure: z.object({ userDataDir: z.string().min(1), protocolVersion: z.literal(PROTOCOL_VERSION), budget }).strict(),
  createRun: z.object({
    input: z.object({
      goal: z.string().min(1), projectPath: z.string().min(1), projectName: z.string().optional(),
      stages: z.array(stageSpecSchema).min(1), templateId: z.string(), branchPrefix: z.string().optional()
    }).strict(), budget
  }).strict(),
  updateBudget: z.object({ budget: budgetConfigSchema }).strict(),
  listRuns: empty,
  loadRunById: z.object({ runId }).strict(),
  startRun: z.object({ runId, budget }).strict(),
  cancelRun: z.object({ runId }).strict(),
  escalateStage: z.object({
    input: z.object({
      runId, stageId: z.string().min(1), reassignAgentId: z.string().nullable().optional(),
      manualComplete: z.boolean().optional(), manualSummary: z.string().optional(), skipStage: z.boolean().optional()
    }).strict(), budget
  }).strict(),
  shutdown: empty
};

export const resultSchemas = {
  configure: z.object({ protocolVersion: z.literal(PROTOCOL_VERSION), recoveredRunIds: z.array(runId) }).strict(),
  createRun: runSnapshotSchema,
  updateBudget: z.null(),
  listRuns: z.array(runSnapshotSchema),
  loadRunById: runSnapshotSchema.nullable(),
  startRun: z.null(),
  cancelRun: z.null(),
  escalateStage: runSnapshotSchema.nullable(),
  shutdown: z.null()
};

export type Method = keyof typeof paramsSchemas;
export type Params<M extends Method> = z.infer<(typeof paramsSchemas)[M]>;
export type Result<M extends Method> = z.infer<(typeof resultSchemas)[M]>;
export interface Request<M extends Method = Method> {
  jsonrpc: '2.0'; id: number; method: M; params: Params<M>;
}
export interface RpcError { code: number; message: string }
export type Response =
  | { jsonrpc: '2.0'; id: number | null; result: unknown }
  | { jsonrpc: '2.0'; id: number | null; error: RpcError };

export const notificationSchemas = {
  'daemon.ready': z.object({ protocolVersion: z.literal(PROTOCOL_VERSION) }).strict(),
  'run.update': runSnapshotSchema,
  'orch.event': orchEventSchema,
  'log.entry': pipelineLogSchema,
  'daemon.error': z.object({ message: z.string(), runId: runId.optional() }).strict()
};
export type NotificationMethod = keyof typeof notificationSchemas;
export type NotificationParams<M extends NotificationMethod> = z.infer<(typeof notificationSchemas)[M]>;
export type Notification<M extends NotificationMethod = NotificationMethod> = {
  jsonrpc: '2.0'; method: M; params: NotificationParams<M>;
};

export const requestSchema = z.object({
  jsonrpc: z.literal('2.0'), id: z.number().int().nonnegative(), method: z.string(), params: z.unknown()
}).strict();
export const responseSchema = z.union([
  z.object({ jsonrpc: z.literal('2.0'), id: z.number().int().nonnegative().nullable(), result: z.unknown() }).strict(),
  z.object({ jsonrpc: z.literal('2.0'), id: z.number().int().nonnegative().nullable(), error: z.object({ code: z.number().int(), message: z.string() }).strict() }).strict()
]);
export const notificationSchema = z.object({ jsonrpc: z.literal('2.0'), method: z.string(), params: z.unknown() }).strict();

// Strings deliberately enforce JSON semantics on both sides of Electron's structured-clone channel.
export function encode(message: Request | Response | Notification): string { return JSON.stringify(message); }
export function decode(wire: unknown): unknown {
  if (typeof wire !== 'string') throw new Error('Expected a JSON string');
  return JSON.parse(wire) as unknown;
}
export function isMethod(method: string): method is Method { return Object.hasOwn(paramsSchemas, method); }
export function isNotification(method: string): method is NotificationMethod { return Object.hasOwn(notificationSchemas, method); }

export interface Transport {
  send(message: string): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onClose(listener: (error: Error) => void): () => void;
  /** Resolves when the utility process has exited; may force-kill it. */
  terminate(): Promise<void>;
}

export class DaemonRpcError extends Error {
  constructor(public readonly code: number, message: string) { super(message); this.name = 'DaemonRpcError'; }
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
