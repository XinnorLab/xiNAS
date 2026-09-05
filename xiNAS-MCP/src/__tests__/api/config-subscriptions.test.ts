import { describe, expect, it } from 'vitest';
import {
  type ApiConfig,
  type McpSubscriptionsConfig,
  SUBSCRIPTIONS_DEFAULTS,
  loadConfig,
  resolveSubscriptionsConfig,
} from '../../api/config.js';

const base = (): ApiConfig => ({
  controller_id: '00000000-0000-0000-0000-0000000000aa',
  listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
  tokens: {},
  state: { databasePath: '/tmp/x/xinas.db', auditJsonlPath: '/tmp/x/audit.jsonl' },
});

const withSubs = (subscriptions: Record<string, unknown>): ApiConfig => ({
  ...base(),
  mcp: { subscriptions: subscriptions as McpSubscriptionsConfig },
});

describe('mcp.subscriptions (S17 §10)', () => {
  it('resolves to the spec defaults when absent', () => {
    const r = resolveSubscriptionsConfig(base());
    expect(r).toEqual({
      enabled: true,
      retention_days: 7,
      max_rows: 100_000,
      cleanup_interval_s: 3600,
      read_limit_default: 100,
      read_limit_max: 500,
      max_uris_per_listen: 6,
      max_listeners_per_principal: 4,
      max_listeners_per_process: 32,
      max_pending_per_stream: 256,
      keepalive_ms: 15_000,
      coalesce_ms: 250,
      progress: { bucket_pct: 10, min_interval_s: 30, max_silence_s: 600 },
      capacity: {
        warning_enter: 80,
        warning_clear: 75,
        critical_enter: 90,
        critical_clear: 85,
        per_filesystem: {},
      },
      nfs_lock_threshold: { enter: 0, clear: 0 },
      disk_temperature_c: null,
    });
    expect(SUBSCRIPTIONS_DEFAULTS.retention_days).toBe(7);
  });

  it('merges overrides, including per-filesystem capacity thresholds', () => {
    const r = resolveSubscriptionsConfig(
      withSubs({
        retention_days: 14,
        capacity: {
          warning_enter: 85,
          per_filesystem: { 'srv-data.mount': { warning_enter: 95, warning_clear: 90 } },
        },
        nfs_lock_threshold: { enter: 100, clear: 50 },
        enabled: false,
      }),
    );
    expect(r.retention_days).toBe(14);
    expect(r.enabled).toBe(false);
    expect(r.capacity).toEqual({
      warning_enter: 85,
      warning_clear: 75,
      critical_enter: 90,
      critical_clear: 85,
      per_filesystem: { 'srv-data.mount': { warning_enter: 95, warning_clear: 90 } },
    });
    expect(r.nfs_lock_threshold).toEqual({ enter: 100, clear: 50 });
  });

  it.each([
    [
      { retention_days: 31 },
      'mcp.subscriptions.retention_days must be an integer in [1, 30], got 31',
    ],
    [
      { retention_days: 0 },
      'mcp.subscriptions.retention_days must be an integer in [1, 30], got 0',
    ],
    [{ max_rows: 9999 }, 'mcp.subscriptions.max_rows must be an integer in [10000, 1000000]'],
    [
      { cleanup_interval_s: 59 },
      'mcp.subscriptions.cleanup_interval_s must be an integer in [60, 86400]',
    ],
    [
      { read_limit_default: 501 },
      'mcp.subscriptions.read_limit_default must be an integer in [1, 500]',
    ],
    [{ read_limit_max: 50 }, 'mcp.subscriptions.read_limit_max must be >= read_limit_default'],
    [
      { max_uris_per_listen: 7 },
      'mcp.subscriptions.max_uris_per_listen must be an integer in [1, 6]',
    ],
    [
      { max_listeners_per_principal: 65 },
      'mcp.subscriptions.max_listeners_per_principal must be an integer in [1, 64]',
    ],
    [
      { max_listeners_per_process: 0 },
      'mcp.subscriptions.max_listeners_per_process must be an integer in [1, 1024]',
    ],
    [
      { max_pending_per_stream: 15 },
      'mcp.subscriptions.max_pending_per_stream must be an integer in [16, 4096]',
    ],
    [{ keepalive_ms: 999 }, 'mcp.subscriptions.keepalive_ms must be an integer in [1000, 60000]'],
    [{ coalesce_ms: 5001 }, 'mcp.subscriptions.coalesce_ms must be an integer in [0, 5000]'],
    [
      { progress: { bucket_pct: 51 } },
      'mcp.subscriptions.progress.bucket_pct must be an integer in [1, 50]',
    ],
    [
      { progress: { min_interval_s: 3601 } },
      'mcp.subscriptions.progress.min_interval_s must be an integer in [1, 3600]',
    ],
    [
      { progress: { min_interval_s: 100, max_silence_s: 99 } },
      'mcp.subscriptions.progress.max_silence_s must be >= min_interval_s',
    ],
    [
      { capacity: { warning_enter: 80, warning_clear: 80 } },
      'mcp.subscriptions.capacity: warning_clear must be < warning_enter',
    ],
    [
      { capacity: { critical_enter: 90, critical_clear: 95 } },
      'mcp.subscriptions.capacity: critical_clear must be < critical_enter',
    ],
    [
      { capacity: { warning_enter: 90, critical_enter: 90 } },
      'mcp.subscriptions.capacity: critical_enter must be > warning_enter',
    ],
    [
      { capacity: { warning_enter: 101 } },
      'mcp.subscriptions.capacity.warning_enter must be an integer in [1, 100]',
    ],
    [
      { capacity: { per_filesystem: { 'srv-data.mount': { warning_enter: 95 } } } },
      'mcp.subscriptions.capacity.per_filesystem[srv-data.mount]: critical_enter must be > warning_enter',
    ],
    [
      { capacity: { per_filesystem: { 'srv-data.mount': { bogus: 1 } } } },
      'mcp.subscriptions.capacity.per_filesystem[srv-data.mount]: unknown key bogus',
    ],
    [
      { nfs_lock_threshold: { enter: 10, clear: 20 } },
      'mcp.subscriptions.nfs_lock_threshold: clear must be < enter when enabled',
    ],
    [
      { nfs_lock_threshold: { enter: -1 } },
      'mcp.subscriptions.nfs_lock_threshold.enter must be an integer in [0, 1000000]',
    ],
    [{ enabled: 'yes' }, 'mcp.subscriptions.enabled must be a boolean'],
    [
      { disk_temperature_c: 200 },
      'mcp.subscriptions.disk_temperature_c must be an integer in [1, 150] or null',
    ],
    [{ bogus: 1 }, 'mcp.subscriptions: unknown key bogus'],
  ])('rejects %j', (subscriptions, message) => {
    expect(() => loadConfig({ inline: withSubs(subscriptions) })).toThrow(message);
  });

  it('accepts a valid full section through loadConfig', () => {
    expect(() =>
      loadConfig({
        inline: withSubs({
          enabled: true,
          retention_days: 1,
          max_rows: 10_000,
          progress: { bucket_pct: 5, min_interval_s: 10, max_silence_s: 10 },
          capacity: {
            warning_enter: 70,
            warning_clear: 60,
            critical_enter: 95,
            critical_clear: 90,
            per_filesystem: { 'srv-data.mount': { warning_enter: 80, warning_clear: 70 } },
          },
          nfs_lock_threshold: { enter: 100, clear: 50 },
          disk_temperature_c: 70,
        }),
      }),
    ).not.toThrow();
  });
});
