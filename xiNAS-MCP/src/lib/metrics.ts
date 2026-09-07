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
 * `labels` carries a key the series was not declared with — catches a typo
 * or a drifted call site at the first scrape/observe, not silently.
 */
function key(labelNames: string[], labels: Labels): string {
  for (const k of Object.keys(labels)) {
    if (!labelNames.includes(k)) throw new Error(`unknown label '${k}'`);
  }
  return labelNames.map((n) => `${n}=${labels[n] ?? ''}`).join('\u0001');
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
      render: () =>
        [...values].map(([k, v]) => `${name}${renderLabels(labelNames, k)} ${v}`).join('\n'),
    });
    return {
      inc: (labels = {}, by = 1) => {
        const k = key(labelNames, labels);
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
        values.set(key(labelNames, labels), value);
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
          .map((s) => `${name}${renderLabels(labelNames, key(labelNames, s.labels))} ${s.value}`)
          .join('\n'),
    });
  }

  histogram(name: string, help: string, buckets: number[], labelNames: string[]): Histogram {
    const sorted = [...buckets].sort((a, b) => a - b);
    const data = new Map<string, HistogramData>();
    this.register(name, {
      help,
      type: 'histogram',
      render: () =>
        [...data]
          .flatMap(([k, d]) => {
            const base = renderLabels(labelNames, k);
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
          })
          .join('\n'),
    });
    return {
      observe: (labels, value) => {
        const k = key(labelNames, labels);
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

  /** Render every registered series in Prometheus text exposition format 0.0.4. */
  render(): string {
    const out: string[] = [];
    for (const [name, s] of this.series) {
      out.push(`# HELP ${name} ${s.help}`, `# TYPE ${name} ${s.type}`);
      const body = s.render();
      if (body.length > 0) out.push(body);
    }
    return `${out.join('\n')}\n`;
  }

  private register(name: string, s: Series): void {
    if (this.series.has(name)) throw new Error(`metric '${name}' already registered`);
    this.series.set(name, s);
  }
}
