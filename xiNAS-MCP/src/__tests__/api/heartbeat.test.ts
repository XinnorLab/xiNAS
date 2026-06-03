import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeartbeatTracker, type HeartbeatTrackerOptions } from '../../api/heartbeat.js';
import type { OpenedStateStore } from '../../state/index.js';
import { openStateStore } from '../../state/index.js';

async function makeStore(dir: string): Promise<OpenedStateStore> {
  return openStateStore({
    databasePath: join(dir, 'xinas.db'),
    auditJsonlPath: join(dir, 'audit.jsonl'),
    nodeId: '00000000-0000-0000-0000-0000000000aa',
  });
}

describe('HeartbeatTracker — state transitions', () => {
  let dir: string;
  let state: OpenedStateStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-hb-test-'));
    state = await makeStore(dir);
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await state.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeTracker(opts?: Partial<HeartbeatTrackerOptions>): HeartbeatTracker {
    return new HeartbeatTracker({
      intervalMs: 5_000,
      controllerId: '00000000-0000-0000-0000-0000000000aa',
      state,
      agentSocketPath: '/tmp/nonexistent.sock',
      ...opts,
    });
  }

  it('starts in offline state', () => {
    const tracker = makeTracker();
    expect(tracker.currentState()).toBe('offline');
  });

  it('transitions to healthy after recordHeartbeatSuccess', () => {
    const tracker = makeTracker();
    tracker.recordHeartbeatSuccess(new Date());
    expect(tracker.currentState()).toBe('healthy');
  });

  it('transitions from healthy to degraded after 2× interval without success', () => {
    const tracker = makeTracker({ intervalMs: 5_000 });
    const t0 = new Date('2026-05-28T12:00:00.000Z');
    vi.setSystemTime(t0);
    tracker.recordHeartbeatSuccess(t0);
    expect(tracker.currentState()).toBe('healthy');

    // Advance 11 seconds (> 2 × 5000ms = 10s)
    vi.setSystemTime(new Date(t0.getTime() + 11_000));
    expect(tracker.currentState()).toBe('degraded');
  });

  it('transitions from degraded to offline after 6× interval', () => {
    const tracker = makeTracker({ intervalMs: 5_000 });
    const t0 = new Date('2026-05-28T12:00:00.000Z');
    vi.setSystemTime(t0);
    tracker.recordHeartbeatSuccess(t0);

    // Advance 31 seconds (> 6 × 5000ms = 30s)
    vi.setSystemTime(new Date(t0.getTime() + 31_000));
    expect(tracker.currentState()).toBe('offline');
  });

  it('transitions immediately to offline on recordHeartbeatFailure with connect-refused', () => {
    const tracker = makeTracker();
    const t0 = new Date('2026-05-28T12:00:00.000Z');
    vi.setSystemTime(t0);
    tracker.recordHeartbeatSuccess(t0);
    expect(tracker.currentState()).toBe('healthy');

    tracker.recordHeartbeatFailure(new Date(), { connectRefused: true });
    expect(tracker.currentState()).toBe('offline');
  });

  it('recordObservationPush does not change heartbeat state', () => {
    const tracker = makeTracker({ intervalMs: 5_000 });
    const t0 = new Date('2026-05-28T12:00:00.000Z');
    vi.setSystemTime(t0);
    tracker.recordHeartbeatSuccess(t0);

    // Advance past 2× interval — should be degraded
    vi.setSystemTime(new Date(t0.getTime() + 11_000));
    expect(tracker.currentState()).toBe('degraded');

    // An observation push does NOT reset the heartbeat timer
    tracker.recordObservationPush(new Date());
    expect(tracker.currentState()).toBe('degraded');
  });

  it('emits an agent_state_changed event to the KV store on transition', () => {
    const tracker = makeTracker({ intervalMs: 5_000 });
    const t0 = new Date('2026-05-28T12:00:00.000Z');
    vi.setSystemTime(t0);
    tracker.recordHeartbeatSuccess(t0);

    // Advance to degrade
    vi.setSystemTime(new Date(t0.getTime() + 11_000));
    // Calling currentState re-evaluates and emits on transition
    tracker.currentState();

    // Check that an event was written at an /xinas/v1/events/* path
    const events = state.kv.list({ prefix: '/xinas/v1/events/' });
    expect(events.length).toBeGreaterThanOrEqual(1);
    const evt = events[0]?.value as {
      kind: string;
      from: string;
      to: string;
      controller_id: string;
    };
    expect(evt.kind).toBe('agent_state_changed');
    expect(evt.from).toBe('healthy');
    expect(evt.to).toBe('degraded');
    expect(evt.controller_id).toBe('00000000-0000-0000-0000-0000000000aa');
  });

  it('currentWarnings returns EXECUTOR_DEGRADED only when degraded + routeIsMutating=true', () => {
    const tracker = makeTracker({ intervalMs: 5_000 });
    const t0 = new Date('2026-05-28T12:00:00.000Z');
    vi.setSystemTime(t0);
    tracker.recordHeartbeatSuccess(t0);

    vi.setSystemTime(new Date(t0.getTime() + 11_000));

    const warnings = tracker.currentWarnings({ routeIsMutating: true });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('EXECUTOR_DEGRADED');

    const readWarnings = tracker.currentWarnings({ routeIsMutating: false });
    expect(readWarnings).toHaveLength(0);
  });

  it('currentWarnings returns nothing when healthy', () => {
    const tracker = makeTracker();
    tracker.recordHeartbeatSuccess(new Date());
    expect(tracker.currentWarnings({ routeIsMutating: true })).toHaveLength(0);
  });

  // Regression for the independent-review J finding: an on-schedule heartbeat
  // whose agent.health reports a collector in error must read as `degraded`
  // (spec §668), not `healthy`. The tracker previously ignored #collectors.
  describe('collector-error → degraded (review J, spec §668)', () => {
    it('downgrades a fresh heartbeat to degraded when a collector is in error', () => {
      const tracker = makeTracker();
      tracker.recordHeartbeatSuccess(new Date(), {
        version: '1.0.0',
        collectors: { Disk: 'running', SystemdUnit: 'error: systemd dbus probe unavailable' },
      });
      expect(tracker.currentState()).toBe('degraded');
    });

    it('stays healthy when all collectors are running/stubbed (stubbed is not a fault)', () => {
      const tracker = makeTracker();
      tracker.recordHeartbeatSuccess(new Date(), {
        version: '1.0.0',
        collectors: { Disk: 'running', XiraidArray: 'stubbed' },
      });
      expect(tracker.currentState()).toBe('healthy');
    });

    it('emits EXECUTOR_DEGRADED on mutating routes when a collector errors', () => {
      const tracker = makeTracker();
      tracker.recordHeartbeatSuccess(new Date(), {
        collectors: { SystemdUnit: 'error: dbus unavailable' },
      });
      const warnings = tracker.currentWarnings({ routeIsMutating: true });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.code).toBe('EXECUTOR_DEGRADED');
    });

    it('a collector error does NOT override offline (connect-refused wins)', () => {
      const tracker = makeTracker();
      tracker.recordHeartbeatSuccess(new Date(), {
        collectors: { SystemdUnit: 'error: dbus unavailable' },
      });
      tracker.recordHeartbeatFailure(new Date(), { connectRefused: true });
      expect(tracker.currentState()).toBe('offline');
    });

    it('clears back to healthy once the collector recovers', () => {
      const tracker = makeTracker();
      const t0 = new Date('2026-05-28T12:00:00.000Z');
      vi.setSystemTime(t0);
      tracker.recordHeartbeatSuccess(t0, { collectors: { SystemdUnit: 'error: boom' } });
      expect(tracker.currentState()).toBe('degraded');
      // Next heartbeat reports the collector running again.
      tracker.recordHeartbeatSuccess(new Date(t0.getTime() + 1_000), {
        collectors: { SystemdUnit: 'running' },
      });
      expect(tracker.currentState()).toBe('healthy');
    });
  });
});
