import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALLOWLIST,
  type PropertiesChangedCallback,
  type SystemdUnitState,
  createSystemdProbe,
} from '../../../agent/probe/systemd.js';

/**
 * The dbus connection itself is integration-only and cannot run in unit
 * tests. We test the pure logic: allow-list filtering and state mapping.
 */
describe('SystemdProbe — allow-list filtering (pure logic)', () => {
  it('DEFAULT_ALLOWLIST contains the required NFS service units', () => {
    expect(DEFAULT_ALLOWLIST).toContain('nfs-server.service');
    expect(DEFAULT_ALLOWLIST).toContain('nfs-mountd.service');
    expect(DEFAULT_ALLOWLIST).toContain('nfs-idmapd.service');
  });

  it('isAllowed() returns true for listed units and false for unlisted', () => {
    const probe = createSystemdProbe({ connectDbus: async () => null as never });
    expect(probe.isAllowed('nfs-server.service')).toBe(true);
    expect(probe.isAllowed('srv-share01.mount')).toBe(true);
    expect(probe.isAllowed('unknown-custom.service')).toBe(false);
    expect(probe.isAllowed('sshd.service')).toBe(false);
  });

  it('addToAllowlist() dynamically extends the allow-list for discovered mount units', () => {
    const probe = createSystemdProbe({ connectDbus: async () => null as never });
    probe.addToAllowlist('srv-newshare.mount');
    expect(probe.isAllowed('srv-newshare.mount')).toBe(true);
  });
});

describe('SystemdProbe — state mapping (pure logic)', () => {
  it('mapDbusProperties() maps dbus property bag to SystemdUnitState', () => {
    const probe = createSystemdProbe({ connectDbus: async () => null as never });
    const state: SystemdUnitState = probe.mapDbusProperties('nfs-server.service', {
      ActiveState: ['s', 'active'],
      SubState: ['s', 'running'],
      LoadState: ['s', 'loaded'],
      UnitFileState: ['s', 'enabled'],
    });
    expect(state.active_state).toBe('active');
    expect(state.sub_state).toBe('running');
    expect(state.load_state).toBe('loaded');
    expect(state.unit_file_state).toBe('enabled');
  });

  it('mapDbusProperties() handles missing UnitFileState gracefully', () => {
    const probe = createSystemdProbe({ connectDbus: async () => null as never });
    const state = probe.mapDbusProperties('foo.service', {
      ActiveState: ['s', 'inactive'],
      SubState: ['s', 'dead'],
      LoadState: ['s', 'not-found'],
    });
    expect(state.unit_file_state).toBeUndefined();
    expect(state.active_state).toBe('inactive');
  });

  it('exposes a PropertiesChangedCallback type compatible with mapped state', () => {
    const seen: Array<{ unit: string; state: SystemdUnitState }> = [];
    const cb: PropertiesChangedCallback = (unit, state) => {
      seen.push({ unit, state });
    };
    const probe = createSystemdProbe({ connectDbus: async () => null as never });
    cb('nfs-server.service', probe.mapDbusProperties('nfs-server.service', {}));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.state.active_state).toBe('unknown');
  });
});
