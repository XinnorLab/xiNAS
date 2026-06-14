/**
 * S12 T2 — captureDesired is called on terminal-success (before releaseLeases),
 * skipped on terminal-failed and on config.rollback ops.
 *
 * Drives `applyEvent` directly (unit-level, no HTTP, no DB).
 */

import { describe, expect, it, vi } from 'vitest';
import { applyEvent } from '../../../api/tasks/progress.js';
import type { Task } from '../../../api/tasks/types.js';

// ---------------------------------------------------------------------------
// Minimal fake store: only `transition` is called by the terminal branch.
// ---------------------------------------------------------------------------
function makeStore() {
  return {
    transition: vi.fn(),
    upsertStage: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Minimal Task fixture (only the fields the terminal branch touches).
// ---------------------------------------------------------------------------
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    task_id: 'task-abc',
    kind: 'share.create',
    state: 'running',
    principal: 'admin:test',
    client_type: 'rest',
    request_id: 'req-1',
    correlation_id: 'corr-1',
    input_hash: 'abc',
    risk_level: 'non_disruptive',
    affected_resources: [],
    last_event_sequence: 0,
    created_at: 1000,
    updated_at: 1000,
    stages: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('applyEvent terminal branch – captureDesired integration', () => {
  it('success + snapshot_id + non-rollback op → captureDesired called BEFORE releaseLeases', () => {
    const callOrder: string[] = [];
    const store = makeStore();
    const captureDesired = vi.fn(() => {
      callOrder.push('captureDesired');
    });
    const releaseLeases = vi.fn(() => {
      callOrder.push('releaseLeases');
    });
    const revertDesired = vi.fn();

    applyEvent({
      store: store as never,
      task: makeTask(),
      event: {
        task_id: 'task-abc',
        sequence: 5,
        event_type: 'terminal',
        status: 'success',
        snapshot_id: 'snap-xyz',
      },
      spillDir: '/tmp',
      heartbeat: vi.fn(),
      releaseLeases,
      revertDesired,
      captureDesired,
    });

    expect(captureDesired).toHaveBeenCalledOnce();
    expect(captureDesired).toHaveBeenCalledWith('snap-xyz');

    // captureDesired MUST be called before releaseLeases.
    const captureIdx = callOrder.indexOf('captureDesired');
    const releaseIdx = callOrder.indexOf('releaseLeases');
    expect(captureIdx).toBeGreaterThanOrEqual(0);
    expect(releaseIdx).toBeGreaterThan(captureIdx);

    // success keeps intent — revertDesired must NOT fire.
    expect(revertDesired).not.toHaveBeenCalled();
  });

  it('terminal failed → captureDesired NOT called', () => {
    const store = makeStore();
    const captureDesired = vi.fn();
    const releaseLeases = vi.fn();
    const revertDesired = vi.fn();

    applyEvent({
      store: store as never,
      task: makeTask(),
      event: {
        task_id: 'task-abc',
        sequence: 5,
        event_type: 'terminal',
        status: 'failed',
        snapshot_id: 'snap-xyz',
      },
      spillDir: '/tmp',
      heartbeat: vi.fn(),
      releaseLeases,
      revertDesired,
      captureDesired,
    });

    expect(captureDesired).not.toHaveBeenCalled();
    // revertDesired IS called on failure
    expect(revertDesired).toHaveBeenCalledOnce();
  });

  it('success + task.kind is config.rollback → captureDesired NOT called', () => {
    const store = makeStore();
    const captureDesired = vi.fn();
    const releaseLeases = vi.fn();
    const revertDesired = vi.fn();

    applyEvent({
      store: store as never,
      task: makeTask({ kind: 'config.rollback' }),
      event: {
        task_id: 'task-abc',
        sequence: 5,
        event_type: 'terminal',
        status: 'success',
        snapshot_id: 'snap-xyz',
      },
      spillDir: '/tmp',
      heartbeat: vi.fn(),
      releaseLeases,
      revertDesired,
      captureDesired,
    });

    expect(captureDesired).not.toHaveBeenCalled();
    // leases still released on success
    expect(releaseLeases).toHaveBeenCalledOnce();
    // revertDesired NOT called on success
    expect(revertDesired).not.toHaveBeenCalled();
  });

  it('success + no snapshot_id → captureDesired NOT called', () => {
    const store = makeStore();
    const captureDesired = vi.fn();

    applyEvent({
      store: store as never,
      task: makeTask(),
      event: {
        task_id: 'task-abc',
        sequence: 5,
        event_type: 'terminal',
        status: 'success',
        // no snapshot_id
      },
      spillDir: '/tmp',
      heartbeat: vi.fn(),
      releaseLeases: vi.fn(),
      revertDesired: vi.fn(),
      captureDesired,
    });

    expect(captureDesired).not.toHaveBeenCalled();
  });

  it('captureDesired throws → leases still released (best-effort)', () => {
    const store = makeStore();
    const releaseLeases = vi.fn();

    applyEvent({
      store: store as never,
      task: makeTask(),
      event: {
        task_id: 'task-abc',
        sequence: 5,
        event_type: 'terminal',
        status: 'success',
        snapshot_id: 'snap-xyz',
      },
      spillDir: '/tmp',
      heartbeat: vi.fn(),
      releaseLeases,
      revertDesired: vi.fn(),
      captureDesired: () => {
        throw new Error('KV write failed');
      },
    });

    // Despite captureDesired throwing, releaseLeases MUST still be called.
    expect(releaseLeases).toHaveBeenCalledOnce();
  });
});
