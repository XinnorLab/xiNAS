/**
 * Minimal Prometheus text-format parser and metrics fetcher.
 * Uses Node.js built-in fetch (Node 20+). No npm dependencies.
 */

import { loadConfig } from '../config/serverConfig.js';
import { McpToolError, ErrorCode } from '../types/common.js';

export interface PrometheusMetric {
  name: string;
  labels: Record<string, string>;
  value: number;
  timestamp?: number;
}

export interface PerformanceSummary {
  target: string;
  metrics: string[];
  samples: PrometheusMetric[];
  fetched_at: string;
}

/** Parse Prometheus text exposition format */
export function parsePrometheusText(text: string): PrometheusMetric[] {
  const result: PrometheusMetric[] = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // metric_name{label="val",...} value [timestamp]
    const spaceIdx = trimmed.lastIndexOf(' ', trimmed.lastIndexOf('\t'));
    // Find where labels end
    let namePart: string;
    let labels: Record<string, string> = {};
    let rest: string;

    const braceStart = trimmed.indexOf('{');
    if (braceStart !== -1) {
      namePart = trimmed.slice(0, braceStart);
      const braceEnd = trimmed.indexOf('}', braceStart);
      const labelStr = trimmed.slice(braceStart + 1, braceEnd);
      rest = trimmed.slice(braceEnd + 1).trim();

      // Parse labels: key="value",key="value"
      for (const m of labelStr.matchAll(/(\w+)="([^"]*)"/g)) {
        labels[m[1] ?? ''] = m[2] ?? '';
      }
    } else {
      const parts = trimmed.split(/\s+/);
      namePart = parts[0] ?? '';
      rest = parts.slice(1).join(' ');
    }

    const valueParts = rest.trim().split(/\s+/);
    const value = parseFloat(valueParts[0] ?? 'NaN');
    if (isNaN(value)) continue;

    const timestamp = valueParts[1] ? parseInt(valueParts[1]) : undefined;

    result.push({
      name: namePart.trim(),
      labels,
      value,
      ...(timestamp !== undefined ? { timestamp } : {}),
    });
  }

  return result;
}

/** Fetch metrics from xiraid-exporter and filter by metric names */
export async function getPerformanceSummary(
  target: string,
  metricNames: string[],
): Promise<PerformanceSummary> {
  const config = loadConfig();
  const url = config.prometheus_url;

  let text: string;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      throw new McpToolError(ErrorCode.INTERNAL, `Prometheus returned HTTP ${resp.status}`);
    }
    text = await resp.text();
  } catch (err) {
    if (err instanceof McpToolError) throw err;
    throw new McpToolError(
      ErrorCode.INTERNAL,
      `Failed to fetch Prometheus metrics from ${url}: ${String(err)}`
    );
  }

  const allMetrics = parsePrometheusText(text);

  // Filter by metric names and target (raid_name or drive label)
  const filtered = allMetrics.filter(m => {
    if (metricNames.length > 0 && !metricNames.includes(m.name)) return false;
    if (target && target !== '*') {
      // Check if any label value matches the target
      return Object.values(m.labels).some(v => v === target);
    }
    return true;
  });

  return {
    target,
    metrics: metricNames,
    samples: filtered,
    fetched_at: new Date().toISOString(),
  };
}

/** Get all raw metrics (for system.get_performance with no filter) */
export async function getAllMetrics(): Promise<PrometheusMetric[]> {
  const config = loadConfig();
  try {
    const resp = await fetch(config.prometheus_url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return [];
    return parsePrometheusText(await resp.text());
  } catch {
    return [];
  }
}
