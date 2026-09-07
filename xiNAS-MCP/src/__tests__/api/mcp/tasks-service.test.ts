import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { McpTasksService, classifyCancelResult } from '../../../api/mcp/tasks/service.js';
import type { McpIdentity } from '../../../api/mcp/dispatch.js';
import { errorResult, text } from '../../../api/mcp/results.js';
import type { Task } from '../../../api/tasks/types.js';
import { AuditAppender } from '../../../state/audit.js';
import { runMigrations } from '../../../state/migrations.js';

const T0 = 1_700_000_000_000;
const RET = 30 * 86400 * 1000;
const admin = { principal: 'admin:test', role: 'admin' as const };
const other = { principal: 'admin:two', role: 'admin' as const };
const viewer = { principal: 'viewer:v', role: 'viewer' as const };

function row(over: Partial<Task> = {}): Task {
  return {
    kind: 'share.update',
    task_id: 't-1',
    state: 'running',
    principal: 'admin:test',
    client_type: 'mcp',
    request_id: 'r',
    correlation_id: 'c',
    input_hash: 'h',
    risk_level: 'non_disruptive',
    affected_resources: [],
    last_event_sequence: 1,
    created_at: T0,
    updated_at: T0 + 1,
    stages: [],
    ...over,
  };
}

function harness(tasks: Task[]) {
  const db = new Database(':memory:');
  runMigrations(db);
  const audit = new AuditAppender(db, 'node');
  const store = { get: (id: string) => tasks.find((t) => t.task_id === id) ?? null };
  const service = new McpTasksService({ store, retentionMs: RET, audit, now: () => T0 + 5000 });
  const events = () =>
    (
      db.prepare('SELECT entry_json FROM audit_outbox ORDER BY audit_seq').all() as Array<{
        entry_json: Buffer;
      }>
    ).map(
      (r) =>
        JSON.parse(r.entry_json.toString('utf8')) as {
          kind: string;
          payload: Record<string, unknown>;
        },
    );
  return { service, events };
}
const ctx = (identity: McpIdentity = admin) => ({ identity, correlationId: 'corr-1' });

describe('McpTasksService (S16 §7, §10)', () => {
  it('get: owner sees the projection; every other case is the one generic -32602 and audits read_denied without task metadata', () => {
    const h = harness([
      row(),
      row({ task_id: 't-plan', state: 'plan_only' }),
      row({ task_id: 't-imp', state: 'imported' }),
    ]);
    expect(h.service.get('t-1', ctx())).toMatchObject({
      resultType: 'complete',
      taskId: 't-1',
      status: 'working',
      ttlMs: null,
    });
    for (const [id, who] of [
      ['t-1', other],
      ['nope', admin],
      ['t-plan', admin],
      ['t-imp', admin],
    ] as const) {
      expect(() => h.service.get(id, ctx(who))).toThrow(
        expect.objectContaining({ code: -32602, message: 'task not found or expired' }),
      );
    }
    const denied = h.events().filter((e) => e.kind === 'mcp.task.read_denied');
    expect(denied.map((e) => e.payload.reason)).toEqual([
      'not_owner',
      'unknown_or_pruned',
      'not_projectable',
      'not_projectable',
    ]);
    for (const e of denied) {
      expect(e.payload).not.toHaveProperty('kind');
      expect(e.payload).not.toHaveProperty('state');
      expect(e.payload.requested_by).toBeDefined();
    }
  });
  it('update: acknowledges, changes nothing, audits the response keys only', () => {
    const h = harness([row()]);
    expect(
      h.service.update('t-1', { b: { action: 'accept', content: { secret: 'x' } }, a: {} }, ctx()),
    ).toEqual({ resultType: 'complete' });
    const ev = h.events().find((e) => e.kind === 'mcp.task.update_accepted');
    expect(ev?.payload.detail).toEqual({ response_keys: ['a', 'b'] });
    expect(JSON.stringify(ev)).not.toContain('secret');
    expect(() => h.service.update('t-1', {}, ctx(other))).toThrow(
      expect.objectContaining({ code: -32602 }),
    );
  });
  it('cancel: ack on every core verdict after ownership+role; viewer → -32602; audits outcomes', async () => {
    const h = harness([row()]);
    const ok = await h.service.cancel('t-1', ctx(), async () =>
      text({ result: { task_id: 't-1', state: 'running' } }),
    );
    expect(ok).toEqual({ resultType: 'complete' });
    await h.service.cancel('t-1', ctx(), async () =>
      errorResult('CONFLICT', 'x', { reason: 'irreversible_stage_started', stage: 'mkfs' }),
    );
    await h.service.cancel('t-1', ctx(), async () =>
      errorResult('CONFLICT', 'x', { reason: 'not_cancellable', state: 'success' }),
    );
    await h.service.cancel('t-1', ctx(), async () =>
      errorResult('INTERNAL', 'x', { code: 'EXECUTOR_UNAVAILABLE' }),
    );
    await expect(
      h.service.cancel('t-1', ctx(), async () => errorResult('NOT_FOUND', 'x')),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      h.service.cancel('t-1', ctx(viewer), async () => {
        throw new Error('must not be called');
      }),
    ).rejects.toMatchObject({ code: -32602 });
    const kinds = h.events().map((e) => [e.kind, e.payload.detail]);
    expect(kinds).toContainEqual(['mcp.task.cancel_requested', { outcome: 'accepted' }]);
    expect(kinds).toContainEqual(['mcp.task.cancel_refused_irreversible', { stage: 'mkfs' }]);
    expect(kinds).toContainEqual([
      'mcp.task.cancel_requested',
      { outcome: 'refused', reason: 'not_cancellable' },
    ]);
    expect(kinds).toContainEqual([
      'mcp.task.cancel_requested',
      { outcome: 'undelivered', reason: 'EXECUTOR_UNAVAILABLE' },
    ]);
    expect(
      h
        .events()
        .filter((e) => e.kind === 'mcp.task.read_denied')
        .map((e) => e.payload.reason),
    ).toEqual(['unknown_or_pruned', 'role']);
  });
  it('handleFor: projects the committed row for its owner and audits handle_returned; null otherwise', () => {
    const h = harness([row({ state: 'queued', updated_at: T0 })]);
    expect(h.service.handleFor('t-1', ctx(), { tool_name: 'shares.update' })).toMatchObject({
      resultType: 'task',
      taskId: 't-1',
      status: 'working',
      pollIntervalMs: 2000,
    });
    expect(h.service.handleFor('t-1', ctx(other), { tool_name: 'shares.update' })).toBeNull();
    expect(h.service.handleFor('zzz', ctx(), { tool_name: 'shares.update' })).toBeNull();
    const ev = h.events().find((e) => e.kind === 'mcp.task.handle_returned');
    expect(ev?.payload).toMatchObject({
      task_id: 't-1',
      principal: 'admin:test',
      kind: 'share.update',
      tool_name: 'shares.update',
      correlation_id: 'corr-1',
      detail: { state: 'queued', status: 'working' },
    });
  });
  it('classifyCancelResult', () => {
    expect(classifyCancelResult(text({ result: {} }))).toEqual({ kind: 'accepted' });
    expect(classifyCancelResult(errorResult('PERMISSION_DENIED', 'x'))).toEqual({
      kind: 'permission_denied',
    });
    expect(
      classifyCancelResult(errorResult('CONFLICT', 'x', { reason: 'agent_not_found' })),
    ).toEqual({ kind: 'refused', reason: 'agent_not_found' });
  });
});
