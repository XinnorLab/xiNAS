import { describe, expect, it } from 'vitest';
import {
  AckResultSchema,
  CancelTaskParamsSchema,
  CreateTaskResultSchema,
  GetTaskParamsSchema,
  GetTaskResultSchema,
  TASKS_EXTENSION_SCHEMA_REVISION,
  UpdateTaskParamsSchema,
} from '../../../api/mcp/tasks/schema.js';

const base = {
  taskId: '0192c5f6-0000-7000-8000-000000000001',
  createdAt: '2026-09-04T19:40:00.000Z',
  lastUpdatedAt: '2026-09-04T19:40:00.000Z',
};

describe('released 2026-07-28 extension schema (S16 Appendix B)', () => {
  it('is pinned to the released revision', () => {
    expect(TASKS_EXTENSION_SCHEMA_REVISION).toBe('2026-07-28');
  });
  it('CreateTaskResult: flat, resultType task, ttlMs null-or-int, pollIntervalMs optional', () => {
    expect(
      CreateTaskResultSchema.safeParse({
        ...base,
        resultType: 'task',
        status: 'working',
        ttlMs: null,
        pollIntervalMs: 2000,
      }).success,
    ).toBe(true);
    expect(
      CreateTaskResultSchema.safeParse({
        ...base,
        resultType: 'task',
        status: 'completed',
        ttlMs: 2592000000,
      }).success,
    ).toBe(true);
    expect(
      CreateTaskResultSchema.safeParse({
        resultType: 'task',
        task: { ...base, status: 'working', ttlMs: null },
      }).success,
    ).toBe(false);
    expect(
      CreateTaskResultSchema.safeParse({ ...base, resultType: 'task', status: 'working' }).success,
    ).toBe(false); // ttlMs missing
    expect(
      CreateTaskResultSchema.safeParse({
        ...base,
        resultType: 'complete',
        status: 'working',
        ttlMs: null,
      }).success,
    ).toBe(false);
    expect(
      CreateTaskResultSchema.safeParse({
        ...base,
        resultType: 'task',
        status: 'working',
        ttl: 1000,
      }).success,
    ).toBe(false); // 2025-11-25 vocabulary
  });
  it('GetTaskResult: status-specific shapes', () => {
    const ok = (v: unknown) => GetTaskResultSchema.safeParse(v).success;
    expect(
      ok({
        ...base,
        resultType: 'complete',
        status: 'working',
        ttlMs: null,
        pollIntervalMs: 5000,
        statusMessage: 'x',
      }),
    ).toBe(true);
    expect(
      ok({
        ...base,
        resultType: 'complete',
        status: 'completed',
        ttlMs: 1,
        result: { content: [] },
      }),
    ).toBe(true);
    expect(ok({ ...base, resultType: 'complete', status: 'completed', ttlMs: 1 })).toBe(false); // result required
    expect(
      ok({
        ...base,
        resultType: 'complete',
        status: 'failed',
        ttlMs: 1,
        error: { code: -32603, message: 'x' },
      }),
    ).toBe(true);
    expect(ok({ ...base, resultType: 'complete', status: 'failed', ttlMs: 1 })).toBe(false);
    expect(ok({ ...base, resultType: 'complete', status: 'input_required', ttlMs: null })).toBe(
      false,
    );
    expect(
      ok({
        ...base,
        resultType: 'complete',
        status: 'input_required',
        ttlMs: null,
        inputRequests: {},
      }),
    ).toBe(true);
    expect(ok({ ...base, resultType: 'complete', status: 'cancelled', ttlMs: 1 })).toBe(true);
    expect(ok({ ...base, resultType: 'task', status: 'working', ttlMs: null })).toBe(false);
  });
  it('params and acks', () => {
    expect(GetTaskParamsSchema.safeParse({ taskId: 't', _meta: {} }).success).toBe(true);
    expect(GetTaskParamsSchema.safeParse({ taskId: '' }).success).toBe(false);
    expect(GetTaskParamsSchema.safeParse({}).success).toBe(false);
    expect(
      UpdateTaskParamsSchema.safeParse({ taskId: 't', inputResponses: { k: { action: 'accept' } } })
        .success,
    ).toBe(true);
    expect(UpdateTaskParamsSchema.safeParse({ taskId: 't', inputResponses: [] }).success).toBe(
      false,
    );
    expect(
      UpdateTaskParamsSchema.safeParse({ taskId: 't', inputResponses: { k: 'x' } }).success,
    ).toBe(false);
    expect(UpdateTaskParamsSchema.safeParse({ taskId: 't' }).success).toBe(false);
    expect(CancelTaskParamsSchema.safeParse({ taskId: 't' }).success).toBe(true);
    expect(AckResultSchema.safeParse({ resultType: 'complete' }).success).toBe(true);
    expect(AckResultSchema.safeParse({ resultType: 'complete', extra: 1 }).success).toBe(false);
  });
});
