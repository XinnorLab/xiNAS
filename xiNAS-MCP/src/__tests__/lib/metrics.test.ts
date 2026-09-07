import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from '../../lib/metrics.js';

describe('MetricsRegistry (S15 §12.2)', () => {
  it('renders counters, gauges and histograms in the text exposition format', () => {
    const reg = new MetricsRegistry();
    const c = reg.counter('xinas_test_total', 'a counter', ['kind']);
    c.inc({ kind: 'a' });
    c.inc({ kind: 'a' }, 2);
    c.inc({ kind: 'b' });
    const g = reg.gauge('xinas_test_pending', 'a gauge', ['mode']);
    g.set({ mode: 'form' }, 3);
    const h = reg.histogram('xinas_test_seconds', 'a histogram', [1, 5], []);
    h.observe({}, 0.5);
    h.observe({}, 7);
    const out = reg.render();
    expect(out).toContain('# HELP xinas_test_total a counter\n# TYPE xinas_test_total counter\n');
    expect(out).toContain('xinas_test_total{kind="a"} 3\n');
    expect(out).toContain('xinas_test_total{kind="b"} 1\n');
    expect(out).toContain('# TYPE xinas_test_pending gauge\nxinas_test_pending{mode="form"} 3\n');
    expect(out).toContain('xinas_test_seconds_bucket{le="1"} 1\n');
    expect(out).toContain('xinas_test_seconds_bucket{le="5"} 1\n');
    expect(out).toContain('xinas_test_seconds_bucket{le="+Inf"} 2\n');
    expect(out).toContain('xinas_test_seconds_sum 7.5\n');
    expect(out).toContain('xinas_test_seconds_count 2\n');
  });

  it('gaugeCollect samples are recomputed on every render (review P2)', () => {
    const reg = new MetricsRegistry();
    let form = 1;
    reg.gaugeCollect('x_pending', 'open by mode', ['mode'], () => [
      { labels: { mode: 'form' }, value: form },
      { labels: { mode: 'url' }, value: 0 },
    ]);
    expect(reg.render()).toContain('x_pending{mode="form"} 1\n');
    form = 4;
    expect(reg.render()).toContain('x_pending{mode="form"} 4\n');
    expect(reg.render()).toContain('x_pending{mode="url"} 0\n');
  });

  it('escapes label values and rejects unknown labels', () => {
    const reg = new MetricsRegistry();
    const c = reg.counter('x_total', 'x', ['reason']);
    c.inc({ reason: 'a"b\\c\nd' });
    expect(reg.render()).toContain('x_total{reason="a\\"b\\\\c\\nd"} 1');
    expect(() => c.inc({ nope: 'v' })).toThrow(/label/);
  });
});
