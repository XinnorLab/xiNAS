/**
 * Dependency-free Prometheus-style metrics (S15 §12.2, decision D-05).
 * Counters, gauges and fixed-bucket histograms with label sets, rendered in
 * the text exposition format 0.0.4. Values are held in memory per process —
 * there is no persistence and no cross-process aggregation; a restart
 * resets every series to zero.
 *
 * Label values must always be bounded (mode, risk, outcome, reason class —
 * never a principal, id or path): a Prometheus series cardinality explodes
 * with one time series per distinct label-value combination ever observed.
 */

type Labels = Record<string, string>;

/**
 * Order-independent map key over the fixed `labelNames` set. Throws when
 * `labels` carries a key the series was not declared with (a typo or a
 * drifted call site), and equally throws when a DECLARED label is missing
 * from `labels` (F2 fix, S15 §12.2 fix round 1) — a silent `''`
 * substitution there would render a real value as an empty label instead
 * of surfacing the bug at the first scrape/observe.
 */
function key(name: string, labelNames: string[], labels: Labels): string {
  for (const k of Object.keys(labels)) {
    if (!labelNames.includes(k)) throw new Error(`metric ${name}: unknown label '${k}'`);
  }
  return labelNames
    .map((n) => {
      const v = labels[n];
      if (v === undefined) throw new Error(`metric ${name}: missing label '${n}'`);
      return `${n}=${v}`;
    })
    .join('\u0001');
}

function escapeLabelValue(v: string): string {
  return v.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

/** Render the `{name="value",...}` label suffix from a `key()`-encoded map key. */
function renderLabels(labelNames: string[], k: string): string {
  if (labelNames.length === 0) return '';
  const values = k.split('\u0001').map((pair) => pair.slice(pair.indexOf('=') + 1));
  return `{${labelNames.map((n, i) => `${n}="${escapeLabelValue(values[i] ?? '')}"`).join(',')}}`;
}

interface Series {
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
  render(): string;
}

export interface Counter {
  inc(labels?: Labels, by?: number): void;
}

export interface Gauge {
  set(labels: Labels, value: number): void;
  /**
   * F5 (S15 §12.2 fix round 1): increment/decrement in place, `by` defaults
   * to 1 and may be negative — lets an adapter (e.g. the S17
   * `subscriptionsActive(transport, ±1)` series) map straight onto this
   * gauge without keeping its own running-total state to `.set()` from.
   */
  inc(labels?: Labels, by?: number): void;
}

export interface Histogram {
  observe(labels: Labels, value: number): void;
}

interface HistogramData {
  counts: number[];
  sum: number;
  count: number;
}

/**
 * In-memory registry of counters/gauges/histograms, rendered as Prometheus
 * text exposition format 0.0.4 (`# HELP` / `# TYPE`, cumulative
 * `_bucket{le="..."}` + `+Inf`, `_sum`, `_count`). No metrics client
 * library dependency — S15 decision D-05 keeps the control path's
 * dependency surface minimal for this one small piece of surface area.
 */
export class MetricsRegistry {
  private readonly series = new Map<string, Series>();

  counter(name: string, help: string, labelNames: string[]): Counter {
    const values = new Map<string, number>();
    this.register(name, {
      help,
      type: 'counter',
      render: () => {
        // F3 (S15 §12.2 fix round 1): an UNLABELED series has exactly one
        // possible sample, so its existence can be reported before the
        // first `inc()` — a scrape right after boot then already shows the
        // series. A labeled series can't do this (which label-value
        // combination would it report?) and stays absent until first use,
        // the standard Prometheus convention.
        if (values.size === 0) return labelNames.length === 0 ? `${name} 0` : '';
        return [...values].map(([k, v]) => `${name}${renderLabels(labelNames, k)} ${v}`).join('\n');
      },
    });
    return {
      inc: (labels = {}, by = 1) => {
        const k = key(name, labelNames, labels);
        values.set(k, (values.get(k) ?? 0) + by);
      },
    };
  }

  gauge(name: string, help: string, labelNames: string[]): Gauge {
    const values = new Map<string, number>();
    this.register(name, {
      help,
      type: 'gauge',
      render: () =>
        [...values].map(([k, v]) => `${name}${renderLabels(labelNames, k)} ${v}`).join('\n'),
    });
    return {
      set: (labels, value) => {
        values.set(key(name, labelNames, labels), value);
      },
      inc: (labels = {}, by = 1) => {
        const k = key(name, labelNames, labels);
        values.set(k, (values.get(k) ?? 0) + by);
      },
    };
  }

  /**
   * A gauge whose samples are computed at scrape time: `collect()` runs on
   * every `render()` rather than the value being pushed via `.set()`. Used
   * when the source of truth already lives elsewhere (e.g. the confirmation
   * store's open-by-mode counts) so there is no second copy of the count to
   * keep in sync — review P2.
   */
  gaugeCollect(
    name: string,
    help: string,
    labelNames: string[],
    collect: () => Array<{ labels: Labels; value: number }>,
  ): void {
    this.register(name, {
      help,
      type: 'gauge',
      render: () =>
        collect()
          .map(
            (s) => `${name}${renderLabels(labelNames, key(name, labelNames, s.labels))} ${s.value}`,
          )
          .join('\n'),
    });
  }

  histogram(name: string, help: string, buckets: number[], labelNames: string[]): Histogram {
    const sorted = [...buckets].sort((a, b) => a - b);
    const data = new Map<string, HistogramData>();
    // Shared by the normal per-entry render and the F3 zero-sample render
    // below, so the two paths can never drift out of the same shape.
    const renderEntry = (base: string, d: HistogramData): string[] => {
      const withLe = (le: string) =>
        base === '' ? `{le="${le}"}` : `${base.slice(0, -1)},le="${le}"}`;
      let cumulative = 0;
      const lines = sorted.map((b, i) => {
        cumulative += d.counts[i] ?? 0;
        return `${name}_bucket${withLe(String(b))} ${cumulative}`;
      });
      lines.push(
        `${name}_bucket${withLe('+Inf')} ${d.count}`,
        `${name}_sum${base} ${d.sum}`,
        `${name}_count${base} ${d.count}`,
      );
      return lines;
    };
    this.register(name, {
      help,
      type: 'histogram',
      render: () => {
        if (data.size === 0) {
          // F3 (S15 §12.2 fix round 1): same rule as counter() — an
          // unlabeled histogram has exactly one possible sample set, so
          // report it at zero before the first observe(); a labeled one
          // stays absent (which label-value combination would it report?).
          if (labelNames.length === 0) {
            return renderEntry('', { counts: sorted.map(() => 0), sum: 0, count: 0 }).join('\n');
          }
          return '';
        }
        return [...data]
          .flatMap(([k, d]) => renderEntry(renderLabels(labelNames, k), d))
          .join('\n');
      },
    });
    return {
      observe: (labels, value) => {
        const k = key(name, labelNames, labels);
        const d = data.get(k) ?? { counts: sorted.map(() => 0), sum: 0, count: 0 };
        // Non-cumulative per-bucket tally: only the first bucket whose `le`
        // the value satisfies is incremented; render() below accumulates the
        // running sum across buckets to produce the required cumulative
        // counts.
        for (let i = 0; i < sorted.length; i += 1) {
          const threshold = sorted[i];
          if (threshold !== undefined && value <= threshold) {
            d.counts[i] = (d.counts[i] ?? 0) + 1;
            break;
          }
        }
        d.sum += value;
        d.count += 1;
        data.set(k, d);
      },
    };
  }

  /**
   * Render every registered series in Prometheus text exposition format
   * 0.0.4. F4 (S15 §12.2 fix round 1): a `gaugeCollect()` collector reads
   * from elsewhere (e.g. a store query) and can throw — that must not take
   * the whole scrape down. A collector that throws still gets its `# HELP`
   * / `# TYPE` lines (the series is registered either way) but no sample
   * line, and the failure is counted on a lazily-registered
   * `xinas_metrics_collect_errors_total{metric}` series. Registering it
   * mid-loop is safe: `Map` iteration visits entries added during the
   * iteration, so the same `render()` call that first observes a failure
   * also reports it.
   */
  render(): string {
    const out: string[] = [];
    for (const [name, s] of this.series) {
      out.push(`# HELP ${name} ${s.help}`, `# TYPE ${name} ${s.type}`);
      let body: string;
      try {
        body = s.render();
      } catch {
        this.collectErrorsCounter().inc({ metric: name });
        body = '';
      }
      if (body.length > 0) out.push(body);
    }
    return `${out.join('\n')}\n`;
  }

  /** Lazily-registered on the first `gaugeCollect()` failure (F4). */
  private collectErrorsCounterHandle: Counter | undefined;
  private collectErrorsCounter(): Counter {
    if (this.collectErrorsCounterHandle === undefined) {
      this.collectErrorsCounterHandle = this.counter(
        'xinas_metrics_collect_errors_total',
        'gaugeCollect() collector failures, by the failing metric name',
        ['metric'],
      );
    }
    return this.collectErrorsCounterHandle;
  }

  private register(name: string, s: Series): void {
    if (this.series.has(name)) throw new Error(`metric '${name}' already registered`);
    this.series.set(name, s);
  }
}
