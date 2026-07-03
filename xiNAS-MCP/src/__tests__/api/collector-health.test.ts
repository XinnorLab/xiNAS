import { describe, it, expect } from 'vitest';
import { degradedCollectorWarnings } from '../../api/handlers/collector-health.js';
import type { ApiContext } from '../../api/context.js';

function ctxWith(collectors: Record<string, string> | undefined): ApiContext {
  const tracker =
    collectors === undefined
      ? undefined
      : ({ currentSnapshot: () => ({ collectors }) } as unknown as ApiContext['tracker']);
  return { tracker } as ApiContext;
}

describe('degradedCollectorWarnings', () => {
  it('warns when the collector is errored', () => {
    const w = degradedCollectorWarnings(
      ctxWith({ XiraidArray: 'error: XIRAID_DAEMON_UNAVAILABLE: boom' }),
      'XiraidArray',
    );
    expect(w).toHaveLength(1);
    expect(w[0]?.code).toBe('DEGRADED_BACKEND_UNAVAILABLE');
    expect(w[0]?.message).toContain('XiraidArray');
  });

  it('is silent for running / stubbed / other-kind / no tracker', () => {
    expect(degradedCollectorWarnings(ctxWith({ XiraidArray: 'running' }), 'XiraidArray')).toEqual(
      [],
    );
    expect(degradedCollectorWarnings(ctxWith({ XiraidArray: 'stubbed' }), 'XiraidArray')).toEqual(
      [],
    );
    expect(degradedCollectorWarnings(ctxWith({ Disk: 'error: x' }), 'XiraidArray')).toEqual([]);
    expect(degradedCollectorWarnings(ctxWith(undefined), 'XiraidArray')).toEqual([]);
  });
});
