/**
 * Unit tests for the layer-neutral NfsProfile spec logic (S3 N7.3,
 * s3-nfs-executor-spec §3.4, ADR-0005) — the ONE derivation both the api
 * (route merge + provider risk) and the agent executor (helper restart flag)
 * import:
 *
 *  - DEFAULT_NFS_PROFILE_SPEC pins every ADR-0005 default value.
 *  - mergeProfilePatch accepts the mutable sections (threads/rdma/
 *    service_policy), rejects readOnly (versions/v3_locking/v4_recovery) and
 *    unknown sections, and never mutates its inputs.
 *  - deriveProfileServiceAction's restart truth table: restart iff a CHANGED
 *    dimension's `next.service_policy.on_<dim>_change` is 'restart'.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NFS_PROFILE_SPEC,
  deriveProfileServiceAction,
  mergeProfilePatch,
  type NfsProfileSpec,
} from '../../lib/nfs-profile.js';

/** A full spec to derive against; overrides replace top-level sections. */
function spec(overrides: Record<string, unknown> = {}): NfsProfileSpec {
  return { ...structuredClone(DEFAULT_NFS_PROFILE_SPEC), ...overrides };
}

describe('DEFAULT_NFS_PROFILE_SPEC', () => {
  it('pins the ADR-0005 defaults exactly', () => {
    expect(DEFAULT_NFS_PROFILE_SPEC).toEqual({
      versions: {
        v3: { enabled: false },
        v4_0: { enabled: false },
        v4_1: { enabled: true },
        v4_2: { enabled: true },
      },
      rdma: { enabled: true, port: 20049 },
      threads: { count: 64 },
      v3_locking: {
        enabled: false,
        fixed_rpc_ports: {
          nfsd: 2049,
          mountd: 20048,
          lockd_udp: 32803,
          lockd_tcp: 32803,
          statd: 32765,
          statd_outgoing: 32766,
        },
      },
      v4_recovery: {
        backend: 'nfsdcltrack',
        recovery_root: '/var/lib/nfs/v4recovery',
        server_scope: '',
      },
      service_policy: {
        on_thread_count_change: 'reload',
        on_version_change: 'restart',
        on_rdma_change: 'restart',
        on_v3_settings_change: 'restart',
      },
    });
  });
});

describe('mergeProfilePatch', () => {
  it('merges a mutable section key-by-key over the prior section', () => {
    const prior = spec();
    const merged = mergeProfilePatch(prior, { threads: { count: 128 } });
    expect(merged.threads).toEqual({ count: 128 });
    // Untouched sections carried through verbatim.
    expect(merged.versions).toEqual(prior.versions);
    expect(merged.rdma).toEqual(prior.rdma);
    expect(merged.service_policy).toEqual(prior.service_policy);
  });

  it('merges within a section: an rdma {port} patch keeps the prior enabled', () => {
    const merged = mergeProfilePatch(spec(), { rdma: { port: 20050 } });
    expect(merged.rdma).toEqual({ enabled: true, port: 20050 });
  });

  it('accepts all three mutable sections in one patch', () => {
    const merged = mergeProfilePatch(spec(), {
      threads: { count: 16 },
      rdma: { enabled: false },
      service_policy: { on_thread_count_change: 'restart' },
    });
    expect(merged.threads).toEqual({ count: 16 });
    expect(merged.rdma).toEqual({ enabled: false, port: 20049 });
    expect(merged.service_policy).toEqual({
      on_thread_count_change: 'restart',
      on_version_change: 'restart',
      on_rdma_change: 'restart',
      on_v3_settings_change: 'restart',
    });
  });

  it('rejects each readOnly section (versions/v3_locking/v4_recovery)', () => {
    expect(() => mergeProfilePatch(spec(), { versions: { v3: { enabled: true } } })).toThrow(
      /spec\.versions is read-only/,
    );
    expect(() => mergeProfilePatch(spec(), { v3_locking: { enabled: true } })).toThrow(
      /spec\.v3_locking is read-only/,
    );
    expect(() => mergeProfilePatch(spec(), { v4_recovery: { server_scope: 'x' } })).toThrow(
      /spec\.v4_recovery is read-only/,
    );
  });

  it('rejects an unknown top-level section and a non-object section value', () => {
    expect(() => mergeProfilePatch(spec(), { turbo: { enabled: true } })).toThrow(
      /unknown NfsProfile spec section 'turbo'/,
    );
    expect(() => mergeProfilePatch(spec(), { threads: 128 })).toThrow(/spec\.threads must be/);
    expect(() => mergeProfilePatch(spec(), { threads: [128] })).toThrow(/spec\.threads must be/);
  });

  it('rejects a non-object patch', () => {
    expect(() => mergeProfilePatch(spec(), 'threads=128')).toThrow(/must be an object/);
    expect(() => mergeProfilePatch(spec(), [{ threads: { count: 128 } }])).toThrow(
      /must be an object/,
    );
  });

  it('does not mutate the prior spec (pure)', () => {
    const prior = spec();
    const snapshot = structuredClone(prior);
    mergeProfilePatch(prior, { threads: { count: 999 } });
    expect(prior).toEqual(snapshot);
  });

  it('an empty patch returns the prior spec content unchanged', () => {
    const prior = spec();
    expect(mergeProfilePatch(prior, {})).toEqual(prior);
  });
});

describe('deriveProfileServiceAction', () => {
  it('nothing changed → no restart, empty changed[]', () => {
    expect(deriveProfileServiceAction(spec(), spec())).toEqual({ restart: false, changed: [] });
  });

  it('thread change + restart policy → restart', () => {
    const next = spec({
      threads: { count: 128 },
      service_policy: {
        on_thread_count_change: 'restart',
        on_version_change: 'restart',
        on_rdma_change: 'restart',
        on_v3_settings_change: 'restart',
      },
    });
    expect(deriveProfileServiceAction(spec(), next)).toEqual({
      restart: true,
      changed: ['thread_count'],
    });
  });

  it('thread change + reload policy (the ADR default) → no restart', () => {
    const next = spec({ threads: { count: 128 } });
    expect(deriveProfileServiceAction(spec(), next)).toEqual({
      restart: false,
      changed: ['thread_count'],
    });
  });

  it('rdma change (enabled OR port) reads on_rdma_change', () => {
    const enabledFlip = spec({ rdma: { enabled: false, port: 20049 } });
    expect(deriveProfileServiceAction(spec(), enabledFlip)).toEqual({
      restart: true, // default on_rdma_change: restart
      changed: ['rdma'],
    });

    const portOnly = spec({
      rdma: { enabled: true, port: 20050 },
      service_policy: {
        on_thread_count_change: 'reload',
        on_version_change: 'restart',
        on_rdma_change: 'none',
        on_v3_settings_change: 'restart',
      },
    });
    expect(deriveProfileServiceAction(spec(), portOnly)).toEqual({
      restart: false, // on_rdma_change: none → no restart
      changed: ['rdma'],
    });
  });

  it('versions change reads on_version_change (always unchanged in S3, implemented anyway)', () => {
    const next = spec({
      versions: {
        v3: { enabled: true },
        v4_0: { enabled: false },
        v4_1: { enabled: true },
        v4_2: { enabled: true },
      },
    });
    expect(deriveProfileServiceAction(spec(), next)).toEqual({
      restart: true, // default on_version_change: restart
      changed: ['versions'],
    });
  });

  it('v3_locking change reads on_v3_settings_change', () => {
    const v3Locking = {
      enabled: true,
      fixed_rpc_ports: {
        nfsd: 2049,
        mountd: 20048,
        lockd_udp: 32803,
        lockd_tcp: 32803,
        statd: 32765,
        statd_outgoing: 32766,
      },
    };
    expect(deriveProfileServiceAction(spec(), spec({ v3_locking: v3Locking }))).toEqual({
      restart: true, // default on_v3_settings_change: restart
      changed: ['v3_settings'],
    });
  });

  it('multiple changed dimensions: restart iff ANY changed dimension says restart', () => {
    const next = spec({
      threads: { count: 32 }, // policy reload
      rdma: { enabled: false, port: 20049 }, // policy restart
    });
    expect(deriveProfileServiceAction(spec(), next)).toEqual({
      restart: true,
      changed: ['thread_count', 'rdma'],
    });
  });

  it('service_policy-only change is NOT itself a dimension → no restart', () => {
    const next = spec({
      service_policy: {
        on_thread_count_change: 'restart',
        on_version_change: 'restart',
        on_rdma_change: 'restart',
        on_v3_settings_change: 'restart',
      },
    });
    expect(deriveProfileServiceAction(spec(), next)).toEqual({ restart: false, changed: [] });
  });

  it('missing service_policy falls back to the ADR defaults per dimension', () => {
    const bare = (threads: number): NfsProfileSpec => ({
      versions: spec().versions,
      rdma: { enabled: true, port: 20049 },
      threads: { count: threads },
    });
    // Thread change, no policy declared → default 'reload' → no restart.
    expect(deriveProfileServiceAction(bare(64), bare(128))).toEqual({
      restart: false,
      changed: ['thread_count'],
    });
    // Rdma change, no policy declared → default 'restart'.
    const rdmaOff: NfsProfileSpec = { ...bare(64), rdma: { enabled: false, port: 20049 } };
    expect(deriveProfileServiceAction(bare(64), rdmaOff)).toEqual({
      restart: true,
      changed: ['rdma'],
    });
  });

  it('key-order-insensitive comparison: a re-serialized identical spec is no change', () => {
    const reordered = spec({ rdma: { port: 20049, enabled: true } });
    expect(deriveProfileServiceAction(spec(), reordered)).toEqual({ restart: false, changed: [] });
  });
});
