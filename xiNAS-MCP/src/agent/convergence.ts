/**
 * Agent convergence wiring (J3 / deferred F3).
 *
 * Instantiates the real D-phase probes, injects each into its E-phase
 * collector, registers them in a CollectorRegistry, and constructs the
 * Publisher. The caller (agent-server.ts) reads registry.healthSnapshot()
 * for agent.health and, AFTER the RPC server binds, kicks off
 * runBootSequence + registry.start(emit -> publisher.enqueue) in the
 * background.
 *
 * ## Probe <-> collector adapters
 *
 * The E-phase collectors each declare a *local* minimal probe interface in
 * their own module. The D-phase probe factories were authored to their own
 * (richer / differently-named) shapes, so several do not structurally match
 * the collector's expectation. Rather than rewrite either side, this module
 * supplies thin adapters that bridge real probe -> collector interface. Each
 * adapter is documented with exactly what didn't line up:
 *
 *  - Disk:      real probe matches structurally; event-stream stop() is async
 *               (MonitorHandle) vs the collector's sync EventStream.stop() —
 *               wrapped to fire-and-forget the async stop.
 *  - Network:   real startEventStream emits a parsed ObservedNetworkInterface;
 *               the collector expects pre-diffed { id, op, attrs }. Adapter maps
 *               iface -> { id, op:'upsert', attrs:{operstate,mac,mtu,...} }.
 *  - Filesystem:real probe has snapshot() only, no watchMountUnits(). Adapter
 *               adds a no-op watch handle; the collector then relies on its
 *               boot sweep + poll backstop (pollIntervalMs) for reconcile.
 *  - Nfs:       real probe matches (listSessions/listExports); status carries
 *               no observed_at (the collector stamps it).
 *  - NfsIdmap:  real probe exposes snapshot(); collector expects read() plus
 *               two watch subscriptions. Adapter renames snapshot()->read()
 *               and supplies no-op watch handles (poll backstop reconciles).
 *  - Systemd:   real probe is dbus-shaped (isAllowed/start/mapDbusProperties)
 *               and *requires* a connectDbus option; collector expects
 *               { allowList, getUnitState, subscribeAllowListed }. dbus is
 *               integration-only and unavailable on CI, so the adapter wires a
 *               degraded probe: allowList = DEFAULT_ALLOWLIST, getUnitState
 *               throws 'systemd dbus unavailable' (surfaced via collector
 *               health on sweep), subscribeAllowListed is a no-op handle.
 *  - Users:     real probe has getentPasswd/getentGroup but no watchPasswdFiles.
 *               Adapter adds a no-op watch handle (poll backstop reconciles).
 *  - Inventory: real probe.snapshot() returns a NESTED shape; collector expects
 *               read() returning a FLAT { hostname, os_kernel, cpu_*, mem_* }.
 *               Adapter renames snapshot()->read() and flattens.
 */

import { runBootSequence } from './boot.js';
import { CollectorRegistry } from './collectors/base.js';
import { DiskCollector } from './collectors/disk.js';
import { FilesystemCollector } from './collectors/filesystem.js';
import { InventoryCollector } from './collectors/inventory.js';
import { NetworkInterfaceCollector } from './collectors/network.js';
import { NfsIdmapCollector } from './collectors/nfs-idmap.js';
import { NfsProfileCollector } from './collectors/nfs-profile.js';
import { NfsCollector } from './collectors/nfs.js';
import { ManagedFilesStubCollector } from './collectors/stubs.js';
import { SystemdUnitCollector } from './collectors/systemd.js';
import { TuningCollector } from './collectors/tuning.js';
import { ConfigSnapshotCollector } from './collectors/config-snapshot.js';
import { XinasHistoryBridge } from './task/xinas-history-bridge.js';
import { execFileRunSubprocess } from './task/wiring.js';
import { UsersCollector } from './collectors/users.js';
import { XiraidArrayCollector } from './collectors/xiraid.js';
import { PoolCollector } from './collectors/pool.js';
import type { AgentConfig } from './config.js';
import { log } from './log.js';
import { PollDriver } from './poll.js';
import { createDiskProbe } from './probe/disk.js';
import { createFilesystemProbe } from './probe/filesystem.js';
import {
  createFixtureDiskProbe,
  createFixtureFilesystemProbe,
  createFixtureIdmapProbe,
  createFixtureInventoryProbe,
  createFixtureNetworkProbe,
  createFixtureNfsProbe,
  createFixtureNfsProfileProbe,
  createFixtureSnapshotSource,
  createFixtureSystemdProbe,
  createFixtureTuningProbe,
  createFixtureUsersProbe,
  fixtureDir,
} from './probe/fixture.js';
import { createIdmapProbe } from './probe/idmap.js';
import { createInventoryProbe } from './probe/inventory.js';
import { createNetworkProbe } from './probe/network.js';
import { createNfsProfileProbe } from './probe/nfs-profile.js';
import { createNfsProbe } from './probe/nfs.js';
import { createTuningProbe } from './probe/tuning.js';
import { createSystemctlProbe } from './probe/systemd.js';
import { createUsersProbe } from './probe/users.js';
import { Publisher } from './publisher.js';
import { XiraidClient, createGrpcTransport } from './xiraid/client.js';
import { createFakeXiraidTransport } from './xiraid/fake-transport.js';

/** A synchronous-stop event handle (the shape collectors expect). */
interface SyncStopHandle {
  stop(): void;
}

/** No-op watch/subscription handle for collectors whose real probe has no
 *  matching event source. The collector falls back to its poll backstop. */
const NOOP_HANDLE: SyncStopHandle = { stop(): void {} };

export interface Convergence {
  registry: CollectorRegistry;
  publisher: Publisher;
  pollDriver: PollDriver;
  /** Shared xiRAID gRPC client (collector + create executor, S3). */
  xiraidClient: XiraidClient;
  controllerId: string;
}

/**
 * Build the real probes, collectors, registry, and publisher. Pure
 * construction — does NOT run the boot sweep or start event streams; the
 * caller does that in the background after the RPC server is up.
 */
export function buildConvergence(config: AgentConfig): Convergence {
  const registry = new CollectorRegistry();

  // Fixture probe mode (J3): when XINAS_AGENT_PROBE_MODE=fixture:<dir>, swap the
  // real privileged probes for fixture-backed ones that read <dir>/<file>.json
  // and spawn NO subprocesses. The collector adapters below are identical in
  // both modes — only the probe object they wrap changes. disks/users/nfs-idmap
  // are populated from fixtures; the rest return empty in fixture mode (the e2e
  // suite asserts only those three kinds). When the env var is unset, fdir is
  // null and the real-probe path is taken unchanged.
  const fdir = fixtureDir();

  // --- Disk: real probe matches; bridge async stop -> sync stop. ---
  const diskProbe = fdir !== null ? createFixtureDiskProbe(fdir) : createDiskProbe();
  registry.register(
    new DiskCollector({
      probe: {
        snapshot: () =>
          diskProbe.snapshot().then((disks) =>
            disks.map((d) => ({
              ...d,
              status: { ...d.status, observed_at: new Date().toISOString() },
            })),
          ),
        startEventStream(onDelta) {
          const handle = diskProbe.startEventStream(onDelta);
          return {
            stop(): void {
              void handle.stop();
            },
          };
        },
      },
    }),
  );

  // --- Network: pass the (S6-enriched) status through + the NetworkConfig
  //     summary; poll override for e2e (XINAS_AGENT_NETWORK_POLL_MS). ---
  const networkProbe = fdir !== null ? createFixtureNetworkProbe(fdir) : createNetworkProbe();
  const networkPollMs = Number(process.env.XINAS_AGENT_NETWORK_POLL_MS ?? '');
  registry.register(
    new NetworkInterfaceCollector({
      ...(Number.isFinite(networkPollMs) && networkPollMs > 0
        ? { pollIntervalMs: networkPollMs }
        : {}),
      probe: {
        netplanSummary: () =>
          networkProbe.netplanSummary().then((s) => s as Record<string, unknown> | undefined),
        snapshot: () =>
          networkProbe.snapshot().then((ifaces) =>
            ifaces.map((iface) => ({
              kind: 'NetworkInterface' as const,
              id: iface.id,
              status: {
                ...iface.status,
                observed_at: new Date().toISOString(),
              },
            })),
          ),
        startEventStream(onEvent) {
          const handle = networkProbe.startEventStream((iface) => {
            onEvent({
              id: iface.id,
              op: 'upsert',
              attrs: {
                operstate: iface.status.operstate,
                ...(iface.status.mac !== undefined ? { mac: iface.status.mac } : {}),
                ...(iface.status.mtu !== undefined ? { mtu: iface.status.mtu } : {}),
                ip4_addresses: iface.status.ip4_addresses,
                ip6_addresses: iface.status.ip6_addresses,
              },
            });
          });
          return {
            stop(): void {
              void handle.stop();
            },
          };
        },
      },
    }),
  );

  // --- Filesystem: snapshot() only (no observed_at, no watcher). Stamp
  //     observed_at and supply a no-op watch handle. ---
  const filesystemProbe =
    fdir !== null ? createFixtureFilesystemProbe(fdir) : createFilesystemProbe();
  registry.register(
    new FilesystemCollector({
      probe: {
        snapshot: () =>
          filesystemProbe.snapshot().then((rows) =>
            rows.map((r) => ({
              kind: 'Filesystem' as const,
              id: r.id,
              status: { ...r.status, observed_at: new Date().toISOString() },
            })),
          ),
        watchMountUnits(): SyncStopHandle {
          return NOOP_HANDLE;
        },
      },
    }),
  );

  // --- NFS: real probe matches listSessions/listExports; sessions carry no
  //     observed_at (the collector stamps the delta's, but its local probe
  //     type requires status.observed_at). Stamp it here. ---
  const nfsProbe = fdir !== null ? createFixtureNfsProbe(fdir) : createNfsProbe();
  registry.register(
    new NfsCollector({
      probe: {
        listSessions: () =>
          nfsProbe.listSessions().then((sessions) =>
            sessions.map((s) => ({
              kind: 'NfsSession' as const,
              id: s.id,
              spec: s.spec,
              status: { ...s.status, observed_at: new Date().toISOString() },
            })),
          ),
        listExports: () => nfsProbe.listExports(),
      },
    }),
  );

  // --- NfsIdmap: snapshot() -> read(); no-op watch/dbus handles. ---
  const idmapProbe = fdir !== null ? createFixtureIdmapProbe(fdir) : createIdmapProbe();
  registry.register(
    new NfsIdmapCollector({
      probe: {
        read: () => idmapProbe.snapshot(),
        watchIdmapdConf(): SyncStopHandle {
          return NOOP_HANDLE;
        },
        subscribeIdmapdUnit(): SyncStopHandle {
          return NOOP_HANDLE;
        },
      },
    }),
  );

  // --- NfsProfile: snapshot() -> read(); poll-only (60 s), no watchers in v1. ---
  const nfsProfileProbe =
    fdir !== null ? createFixtureNfsProfileProbe(fdir) : createNfsProfileProbe();
  registry.register(
    new NfsProfileCollector({
      probe: {
        read: () => nfsProfileProbe.snapshot(),
      },
    }),
  );

  // --- Systemd (S7 T1b promotion, ADR-0009): real unit state via the
  //     systemctl-show subprocess probe (the dbus subscription stays
  //     deferred — the 30 s poll backstop refreshes). Fixture mode reads
  //     systemd-units.json rows verbatim. ---
  const systemdProbe = fdir !== null ? createFixtureSystemdProbe(fdir) : createSystemctlProbe();
  registry.register(
    new SystemdUnitCollector({
      probe: {
        allowList: systemdProbe.allowList,
        getUnitState: (name) => systemdProbe.getUnitState(name),
        subscribeAllowListed(): SyncStopHandle {
          return NOOP_HANDLE;
        },
      },
    }),
  );

  // --- Users: getentPasswd/getentGroup return ParsedPasswd/GroupLine, which
  //     carry no `source` discriminator. getent resolves through NSS (local
  //     files + any directory backend), so tag everything 'nss'. No watcher
  //     on the real probe -> no-op handle. ---
  const usersProbe = fdir !== null ? createFixtureUsersProbe(fdir) : createUsersProbe();
  registry.register(
    new UsersCollector({
      probe: {
        getentPasswd: () =>
          usersProbe.getentPasswd().then((rows) =>
            rows.map((u) => ({
              uid: u.uid,
              name: u.name,
              gid: u.gid,
              gecos: u.gecos,
              home: u.home,
              shell: u.shell,
              source: 'nss' as const,
            })),
          ),
        getentGroup: () =>
          usersProbe.getentGroup().then((rows) =>
            rows.map((g) => ({
              gid: g.gid,
              name: g.name,
              members: g.members,
              source: 'nss' as const,
            })),
          ),
        watchPasswdFiles(): SyncStopHandle {
          return NOOP_HANDLE;
        },
      },
    }),
  );

  // --- Inventory: snapshot() (nested) -> read() (flat). ---
  const inventoryProbe = fdir !== null ? createFixtureInventoryProbe() : createInventoryProbe();
  registry.register(
    new InventoryCollector({
      probe: {
        read: () =>
          inventoryProbe.snapshot().then((s) => ({
            hostname: s.hostname,
            os_kernel: s.os.kernel,
            ...(s.cpu.model !== undefined ? { cpu_model: s.cpu.model } : {}),
            ...(s.cpu.cores !== undefined ? { cpu_cores: s.cpu.cores } : {}),
            cpu_threads: s.cpu.threads,
            mem_total_kb: s.memory.total_kb,
            arch: s.cpu.arch,
          })),
      },
    }),
  );

  // --- XiraidArray: real collector over the shared xiRAID client (S3 T6).
  // Fixture mode swaps the gRPC transport for the file-backed fake, same
  // pattern as the probes above. The client is exported so the agent
  // process can hand it to the create executor (one connection for both).
  const xiraidClient = new XiraidClient(
    fdir !== null ? createFakeXiraidTransport(fdir) : createGrpcTransport(),
  );
  // Poll cadence override for tests (e2e shortens 30 s → ~500 ms so the
  // observe assertion after a create doesn't wait a full cycle).
  const xiraidPollMs = Number(process.env.XINAS_AGENT_XIRAID_POLL_MS ?? '');
  registry.register(
    new XiraidArrayCollector({
      client: xiraidClient,
      diskSnapshot: () => diskProbe.snapshot(),
      ...(Number.isFinite(xiraidPollMs) && xiraidPollMs > 0
        ? { pollIntervalMs: xiraidPollMs }
        : {}),
    }),
  );

  // --- Pool (S9, ADR-0011): spare pools via the same xiRAID client. ---
  const poolPollMs = Number(process.env.XINAS_AGENT_POOL_POLL_MS ?? '');
  registry.register(
    new PoolCollector({
      source: { poolShow: () => xiraidClient.poolShow() },
      ...(Number.isFinite(poolPollMs) && poolPollMs > 0 ? { pollIntervalMs: poolPollMs } : {}),
    }),
  );

  // --- Tuning (S7): sysctl expected-vs-actual singleton. ---
  const tuningProbe = fdir !== null ? createFixtureTuningProbe(fdir) : createTuningProbe();
  registry.register(new TuningCollector({ probe: tuningProbe }));

  // --- ConfigSnapshot (S9, ADR-0011): xinas_history manifests projected
  //     onto the public shape; the store is root-only, so the bridge
  //     subprocess is the only read path. ---
  const snapshotSource =
    fdir !== null
      ? createFixtureSnapshotSource(fdir)
      : new XinasHistoryBridge({ runSubprocess: execFileRunSubprocess });
  const configPollMs = Number(process.env.XINAS_AGENT_CONFIG_POLL_MS ?? '');
  registry.register(
    new ConfigSnapshotCollector({
      source: snapshotSource,
      ...(Number.isFinite(configPollMs) && configPollMs > 0
        ? { pollIntervalMs: configPollMs }
        : {}),
    }),
  );

  // --- Deferred-capability stubs (managed_files). ---
  registry.register(new ManagedFilesStubCollector());

  const publisher = new Publisher({
    apiSocketPath: config.api_socket,
    agentToken: config.agent_token,
    controllerId: config.controller_id,
  });

  // Steady-state poll/backstop driver (started in runConvergence after the
  // boot sweep). Drives pollIntervalMs collectors + the 5-min reconcile
  // backstop and consumes publisher.pendingReconcile.
  const pollDriver = new PollDriver({ registry, publisher });

  return { registry, publisher, pollDriver, xiraidClient, controllerId: config.controller_id };
}

/**
 * Background convergence: run the boot sweep, then start steady-state event
 * streams routing emits into the publisher's queue. MUST NOT throw — boot
 * failures (api briefly down, a tool missing on the host) are logged and
 * absorbed; the publisher's retry/pendingReconcile path recovers later.
 *
 * Returns the publisher's pendingReconcile membership for nothing in
 * particular; the function resolves regardless of partial failure so the
 * caller's `void runConvergence()` never produces an unhandled rejection.
 */
export async function runConvergence(c: Convergence): Promise<void> {
  const { registry, publisher, pollDriver, controllerId } = c;
  try {
    await runBootSequence({ publisher, registry, controllerId });
  } catch (err) {
    log('error', 'boot', 'boot_sequence_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await registry.start((delta) => publisher.enqueue(delta));
  } catch (err) {
    log('error', 'boot', 'registry_start_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // Start the steady-state poll/backstop loop AFTER the boot sweep + event
  // streams. Pure timer setup — never throws — but guard anyway so a future
  // change can't break convergence startup.
  try {
    pollDriver.start();
  } catch (err) {
    log('error', 'boot', 'poll_driver_start_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
