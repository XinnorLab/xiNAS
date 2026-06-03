import { describe, expect, it, vi } from 'vitest';
import type { ObservationDelta } from '../../../agent/collectors/base.js';
import { NfsCollector } from '../../../agent/collectors/nfs.js';

function makeFakeNfsProbe(
  options: {
    sessions?: Array<{
      client_addr: string;
      export_path: string;
      proto_version?: string;
      locked_files?: number;
    }>;
    exports?: Array<{ export_path: string; host_pattern: string; options: string[] }>;
  } = {},
) {
  return {
    listSessions: vi.fn().mockResolvedValue(
      (
        options.sessions ?? [
          {
            client_addr: '10.1.2.3',
            export_path: '/srv/share01',
            proto_version: 'v4.1',
            locked_files: 2,
          },
        ]
      ).map((s) => ({
        kind: 'NfsSession' as const,
        id: `${s.client_addr}:${s.export_path}`,
        spec: { client_addr: s.client_addr, export_path: s.export_path },
        status: {
          proto_version: s.proto_version ?? 'v4',
          locked_files: s.locked_files ?? 0,
          observed_at: new Date().toISOString(),
        },
      })),
    ),
    listExports: vi.fn().mockResolvedValue(
      (
        options.exports ?? [
          { export_path: '/srv/share01', host_pattern: '*', options: ['rw', 'no_root_squash'] },
        ]
      ).map((e) => ({
        export_path: e.export_path,
        host_pattern: e.host_pattern,
        options: e.options,
      })),
    ),
  };
}

describe('NfsCollector', () => {
  it('initialSweep: returns NfsSession upsert deltas', async () => {
    const probe = makeFakeNfsProbe({
      sessions: [
        {
          client_addr: '10.1.2.3',
          export_path: '/srv/share01',
          proto_version: 'v4.1',
          locked_files: 2,
        },
      ],
      exports: [],
    });
    const col = new NfsCollector({ probe });
    const deltas = await col.initialSweep();
    const sessionDelta = deltas.find((d) => d.kind === 'NfsSession');
    expect(sessionDelta).toBeDefined();
    expect(sessionDelta).toMatchObject({
      kind: 'NfsSession',
      id: '10.1.2.3:/srv/share01',
      op: 'upsert',
    });
    expect(typeof (sessionDelta?.value?.status as Record<string, unknown>)?.observed_at).toBe(
      'string',
    );
  });

  it('initialSweep: emits a real ExportRule delta keyed by export_path', async () => {
    const probe = makeFakeNfsProbe({
      sessions: [],
      exports: [
        {
          export_path: '/srv/share01',
          host_pattern: '10.1.0.0/16',
          options: ['rw', 'root_squash'],
        },
      ],
    });
    const col = new NfsCollector({ probe });
    const deltas = await col.initialSweep();
    const exportDelta = deltas.find((d) => d.kind === 'ExportRule');
    expect(exportDelta).toMatchObject({
      kind: 'ExportRule',
      id: '/srv/share01',
      op: 'upsert',
    });
    const status = (exportDelta?.value as Record<string, unknown>).status as Record<
      string,
      unknown
    >;
    expect(status.rules).toHaveLength(1);
    expect((status.rules as Array<{ host_pattern: string }>)[0]?.host_pattern).toBe('10.1.0.0/16');
    expect(typeof status.observed_at).toBe('string');
    // The collector implements Collector<'NfsSession'> but emits a second kind
    // (ExportRule) — same dual-kind pattern as E8 (User+Group). No Share rows touched.
    expect(deltas.find((d) => d.kind === 'NfsSession')).toBeUndefined();
  });

  it('start: polls every 30 s (pollIntervalMs = 30000)', () => {
    const probe = makeFakeNfsProbe();
    const col = new NfsCollector({ probe });
    expect(col.pollIntervalMs).toBe(30_000);
  });

  it('start: each poll emits fresh session deltas', async () => {
    const probe = makeFakeNfsProbe({
      sessions: [
        {
          client_addr: '10.1.2.3',
          export_path: '/srv/share01',
          proto_version: 'v4',
          locked_files: 0,
        },
      ],
      exports: [],
    });
    const col = new NfsCollector({ probe });
    const received: ObservationDelta[] = [];
    await col.start((d) => received.push(d));
    // Manually trigger a poll (simulated via the internal _poll method)
    await col['_poll'](received.push.bind(received));
    const sessionDeltas = received.filter((d) => d.kind === 'NfsSession');
    expect(sessionDeltas.length).toBeGreaterThan(0);
    await col.stop();
  });

  it('health: reports running after start', async () => {
    const probe = makeFakeNfsProbe();
    const col = new NfsCollector({ probe });
    await col.start(() => {});
    expect(col.health().state).toBe('running');
    await col.stop();
  });
});
