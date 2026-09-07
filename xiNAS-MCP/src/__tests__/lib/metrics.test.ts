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

  it('F2: a missing declared label is an error, not a silent empty-string substitution', () => {
    const reg = new MetricsRegistry();
    const c = reg.counter('x_kind_total', 'x', ['kind']);
    expect(() => c.inc({})).toThrow(/missing label/);
    expect(() => c.inc({ kind: 'a' })).not.toThrow();

    const bare = reg.counter('x_bare_total', 'x', []);
    expect(() => bare.inc()).not.toThrow();
    expect(() => bare.inc({})).not.toThrow();
  });

  it('F3: an unlabeled counter/histogram render zero samples before any event; a labeled series stays absent', () => {
    const reg = new MetricsRegistry();
    // Registered but never inc'd/observed — that's the point: F3 covers the
    // state before the first event.
    reg.counter('x_bare_total', 'x', []);
    const labeledCounter = reg.counter('x_labeled_total', 'x', ['kind']);
    reg.histogram('x_bare_seconds', 'x', [1, 5], []);
    const labeledHist = reg.histogram('x_labeled_seconds', 'x', [1, 5], ['kind']);

    const before = reg.render();
    expect(before).toContain('x_bare_total 0\n');
    expect(before).toContain('x_bare_seconds_bucket{le="1"} 0\n');
    expect(before).toContain('x_bare_seconds_bucket{le="5"} 0\n');
    expect(before).toContain('x_bare_seconds_bucket{le="+Inf"} 0\n');
    expect(before).toContain('x_bare_seconds_sum 0\n');
    expect(before).toContain('x_bare_seconds_count 0\n');
    // Labeled series stay absent until first use (Prometheus convention) —
    // no zero-sample line for them.
    expect(before).not.toContain('x_labeled_total{');
    expect(before).not.toContain('x_labeled_seconds_bucket{');
    expect(before).not.toContain('x_labeled_seconds_count{');

    labeledCounter.inc({ kind: 'a' });
    labeledHist.observe({ kind: 'a' }, 2);
    const after = reg.render();
    expect(after).toContain('x_labeled_total{kind="a"} 1\n');
    expect(after).toContain('x_labeled_seconds_count{kind="a"} 1\n');
  });

  it('F4: a throwing gaugeCollect does not take down the scrape; the failure lands on xinas_metrics_collect_errors_total', () => {
    const reg = new MetricsRegistry();
    const ok = reg.counter('x_ok_total', 'an ok counter', []);
    ok.inc();
    reg.gaugeCollect('x_broken', 'a broken gauge', ['mode'], () => {
      throw new Error('boom');
    });

    const out = reg.render();
    // HELP/TYPE lines still emitted for the broken gauge; no sample line.
    expect(out).toContain('# HELP x_broken a broken gauge\n# TYPE x_broken gauge');
    expect(out).not.toContain('x_broken{');
    // The other series is unaffected.
    expect(out).toContain('x_ok_total 1\n');
    // The failure is recorded, keyed by the failing metric's own name.
    expect(out).toContain('xinas_metrics_collect_errors_total{metric="x_broken"} 1');
  });

  it('F5: Gauge.inc supports positive and negative deltas', () => {
    const reg = new MetricsRegistry();
    const g = reg.gauge('x_active', 'x', ['transport']);
    g.inc({ transport: 'http' });
    g.inc({ transport: 'http' });
    g.inc({ transport: 'http' }, -1);
    expect(reg.render()).toContain('x_active{transport="http"} 1\n');
  });
});
