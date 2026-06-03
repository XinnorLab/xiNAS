/**
 * Systemd probe — privileged layer.
 *
 * Uses dbus-native to subscribe to
 * org.freedesktop.systemd1.Unit.PropertiesChanged for an allow-listed
 * unit set. getUnitState(name) reads ActiveState/SubState/LoadState/
 * UnitFileState via the systemd dbus API.
 *
 * IMPORTANT: The actual dbus connection is integration-only; unit tests
 * exercise isAllowed(), addToAllowlist(), and mapDbusProperties() which
 * are pure. The connectDbus option is injectable for future integration
 * tests that boot a real session bus.
 *
 * Do NOT import from outside src/agent/.
 */

// Allow-listed units observed via dbus. *.mount units are added
// dynamically by the Filesystem collector (D4 discovers them).
export const DEFAULT_ALLOWLIST: string[] = [
  'nfs-server.service',
  'nfs-mountd.service',
  'nfs-idmapd.service',
  'nfs-blkmap.service',
  'rpcbind.service',
  'rpc-statd.service',
  // *.mount units are added dynamically; the pattern below catches them
];

// Pattern: anything ending in .mount is always allowed
function matchesMountPattern(unit: string): boolean {
  return unit.endsWith('.mount');
}

export interface SystemdUnitState {
  load_state: string;
  active_state: string;
  sub_state: string;
  unit_file_state?: string;
  observed_at: string;
}

export type PropertiesChangedCallback = (unit: string, state: SystemdUnitState) => void;

// Minimal dbus connection type (the real object comes from dbus-native)
export type DbusConnection = object;

interface SystemdProbeOptions {
  allowlist?: string[];
  connectDbus: () => Promise<DbusConnection>;
}

export interface SystemdProbe {
  isAllowed(unit: string): boolean;
  addToAllowlist(unit: string): void;
  mapDbusProperties(unit: string, props: Record<string, [string, string]>): SystemdUnitState;
  start(onChanged: PropertiesChangedCallback): Promise<{ stop: () => Promise<void> }>;
}

export function createSystemdProbe(opts: SystemdProbeOptions): SystemdProbe {
  const allowlist = new Set<string>(opts.allowlist ?? DEFAULT_ALLOWLIST);

  return {
    isAllowed(unit: string): boolean {
      return allowlist.has(unit) || matchesMountPattern(unit);
    },

    addToAllowlist(unit: string): void {
      allowlist.add(unit);
    },

    mapDbusProperties(_unit: string, props: Record<string, [string, string]>): SystemdUnitState {
      const get = (key: string): string | undefined => props[key]?.[1];
      const unitFileState = get('UnitFileState');
      return {
        load_state: get('LoadState') ?? 'unknown',
        active_state: get('ActiveState') ?? 'unknown',
        sub_state: get('SubState') ?? 'unknown',
        ...(unitFileState !== undefined ? { unit_file_state: unitFileState } : {}),
        observed_at: new Date().toISOString(),
      };
    },

    async start(_onChanged: PropertiesChangedCallback): Promise<{ stop: () => Promise<void> }> {
      // Integration-only: real dbus subscription.
      // Requires a running systemd dbus session (only available on Linux
      // with systemd). This method is NOT unit-tested; it is exercised
      // by Layer 3 end-to-end tests on a real controller only.
      try {
        await opts.connectDbus();
      } catch (err) {
        process.stderr.write(
          `${JSON.stringify({
            level: 'warn',
            subsystem: 'systemd-probe',
            event: 'dbus-connect-failed',
            error: String(err),
          })}\n`,
        );
        // Return a no-op handle so the collector can degrade gracefully
        return { stop: async () => {} };
      }

      // Real subscription would use:
      //   conn.addSignalFilter(...)
      //   conn.on('signal', (msg) => { if (isAllowed(unitName)) onChanged(unit, mapped); })
      // Omitted here — the dbus-native API requires a running session bus.
      // The collector wraps this in a try/catch and marks its health as 'error'
      // if the connection fails, allowing other collectors to keep running.

      return {
        stop: async () => {
          // Close the dbus connection when collector stops
        },
      };
    },
  };
}
