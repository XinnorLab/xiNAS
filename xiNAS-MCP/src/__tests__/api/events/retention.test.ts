import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemorySubscriptionMetrics } from '../../../api/events/metrics.js';
import { RetentionSweeper } from '../../../api/events/retention.js';

describe('RetentionSweeper (S17 §7.3)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const fakeJournal = () => {
    const calls: unknown[] = [];
    return {
      calls,
      retentionSweep: vi.fn((p: unknown) => {
        calls.push(p);
        return { deleted: 3, exhausted: false };
      }),
      count: () => 42,
      oldestAgeSeconds: () => 3600,
    };
  };

  it('runs once on start with the spec batch bounds, then on every interval, and stops cleanly', () => {
    const journal = fakeJournal();
    const metrics = new InMemorySubscriptionMetrics();
    const sweeper = new RetentionSweeper({
      journal,
      policy: { retentionDays: 7, maxRows: 100_000 },
      intervalMs: 60_000,
      metrics,
    });
    sweeper.start();
    expect(journal.calls).toEqual([
      { retentionDays: 7, maxRows: 100_000, batchRows: 500, maxBatches: 50 },
    ]);
    vi.advanceTimersByTime(60_000);
    expect(journal.calls).toHaveLength(2);
    expect(metrics.snapshot()['xinas_operational_event_journal_rows']).toBe(42);
    expect(metrics.snapshot()['xinas_operational_event_journal_oldest_age_seconds']).toBe(3600);
    sweeper.stop();
    vi.advanceTimersByTime(600_000);
    expect(journal.calls).toHaveLength(2);
  });

  it('logs and keeps ticking when a sweep throws', () => {
    const journal = fakeJournal();
    journal.retentionSweep.mockImplementationOnce(() => {
      throw new Error('disk gone');
    });
    const logged: string[] = [];
    const sweeper = new RetentionSweeper({
      journal,
      policy: { retentionDays: 7, maxRows: 10_000 },
      intervalMs: 1000,
      log: (_level, msg) => logged.push(msg),
    });
    sweeper.start();
    expect(logged).toEqual(['event_retention_failed']);
    vi.advanceTimersByTime(1000);
    expect(journal.retentionSweep).toHaveBeenCalledTimes(2);
    sweeper.stop();
  });
});
