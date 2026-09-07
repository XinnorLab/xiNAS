/**
 * Wire schemas for the MCP Tasks extension, derived from the RELEASED
 * `ext-tasks/schema/2026-07-28/schema.ts` (S16 Appendix B). Explicit and
 * hand-pinned on purpose: the published SDK's typed maps exclude tasks/*,
 * and its 2025-11-25 `experimental/tasks` vocabulary is deprecated and
 * differs (`ttl`, `tasks/result`). Nothing here imports the SDK.
 */
import { z } from 'zod';
import { INVALID_PARAMS, McpProtocolError } from '../confirmation/errors.js';

export const TASKS_EXTENSION_SCHEMA_REVISION = '2026-07-28';

export const TaskStatusSchema = z.enum([
  'working',
  'input_required',
  'completed',
  'failed',
  'cancelled',
]);
const JsonObject = z.record(z.unknown());

const TaskFields = {
  taskId: z.string().min(1),
  statusMessage: z.string().optional(),
  createdAt: z.string().datetime(),
  lastUpdatedAt: z.string().datetime(),
  ttlMs: z.number().int().nonnegative().nullable(),
  pollIntervalMs: z.number().int().positive().optional(),
  _meta: JsonObject.optional(),
};

export const TaskSchema = z.object({ ...TaskFields, status: TaskStatusSchema }).strict();

export const CreateTaskResultSchema = z
  .object({ ...TaskFields, status: TaskStatusSchema, resultType: z.literal('task') })
  .strict();

export const JsonRpcErrorObjectSchema = z
  .object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() })
  .strict();

const variant = <S extends z.ZodRawShape>(extra: S) =>
  z.object({ ...TaskFields, ...extra, resultType: z.literal('complete') }).strict();

/** GetTaskResult = Result & DetailedTask, discriminated on `status`. */
export const GetTaskResultSchema = z.discriminatedUnion('status', [
  variant({ status: z.literal('working') }),
  variant({ status: z.literal('input_required'), inputRequests: JsonObject }),
  variant({ status: z.literal('completed'), result: JsonObject }),
  variant({ status: z.literal('failed'), error: JsonRpcErrorObjectSchema }),
  variant({ status: z.literal('cancelled') }),
]);
export const DetailedTaskSchema = GetTaskResultSchema;

export const GetTaskParamsSchema = z.object({ taskId: z.string().min(1) }).passthrough();
export const CancelTaskParamsSchema = GetTaskParamsSchema;
export const UpdateTaskParamsSchema = z
  .object({ taskId: z.string().min(1), inputResponses: z.record(JsonObject) })
  .passthrough();
export const AckResultSchema = z.object({ resultType: z.literal('complete') }).strict();

/** Validate inbound params; a failure is JSON-RPC -32602 naming the first bad path. */
export function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params ?? {});
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  const path = first !== undefined && first.path.length > 0 ? first.path.join('.') : 'params';
  throw new McpProtocolError(INVALID_PARAMS, `invalid params: ${path}`);
}
