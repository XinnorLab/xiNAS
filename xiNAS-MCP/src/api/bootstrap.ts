import os from 'node:os';
import type { OpenedStateStore } from '../state/index.js';
import type { ApiConfig } from './config.js';

const CLUSTER_KEY = '/xinas/v1/cluster';

/** Origin tag stamped on every bootstrap write (RevisionedValue.source);
 *  embedMetadata surfaces it in GET /system so operators can see the
 *  singletons were self-seeded, not installer- or operator-written. */
const PUT_SOURCE = { source: 'api:bootstrap' } as const;

interface ClusterRow {
  kind: string;
  id: string;
  spec: Record<string, unknown>;
  status: {
    mode: string;
    capabilities: Record<string, unknown>;
    member_node_ids: string[];
  };
}

/**
 * ADR-0016: seed the infrastructure singletons the read routes hard-require
 * (/xinas/v1/cluster + /xinas/v1/nodes/<controller_id>) so a fresh install —
 * or a wiped/restored state DB — serves GET /system and /capabilities without
 * any installer or agent involvement.
 *
 * Called from startServer() before any listener binds, so there is exactly
 * one writer and plain put() (no CAS) is safe. Existing rows are never
 * overwritten, with one exception: the advertised `mcp.allow_apply`
 * capability is refreshed to match the current api config (the MCP
 * dispatcher reads the config directly — this keeps /capabilities truthful,
 * it is not the gate itself).
 */
export function seedInfrastructure(state: OpenedStateStore, config: ApiConfig): void {
  const allowApply = config.mcp?.allow_apply === true;

  const cluster = state.kv.get<ClusterRow>(CLUSTER_KEY);
  if (cluster === null) {
    state.kv.put(
      CLUSTER_KEY,
      {
        kind: 'Cluster',
        id: 'default',
        spec: { display_name: os.hostname() },
        status: {
          mode: 'single_node',
          capabilities: {
            ha: 'not_enabled',
            quorum: 'not_enabled',
            witness: 'not_enabled',
            'nfs.v3_locking_managed': false,
            'nfs.recovery_state_managed': false,
            'mcp.allow_apply': allowApply,
          },
          member_node_ids: [config.controller_id],
        },
      } satisfies ClusterRow,
      PUT_SOURCE,
    );
  } else if (cluster.value.status.capabilities['mcp.allow_apply'] !== allowApply) {
    const next = structuredClone(cluster.value);
    next.status.capabilities['mcp.allow_apply'] = allowApply;
    state.kv.put(CLUSTER_KEY, next, PUT_SOURCE);
  }

  const nodeKey = `/xinas/v1/nodes/${config.controller_id}`;
  if (state.kv.get(nodeKey) === null) {
    state.kv.put(
      nodeKey,
      {
        kind: 'Node',
        id: config.controller_id,
        spec: { hostname: os.hostname() },
        // Static cold default — GET /system surfaces live heartbeat state
        // under node.status.agent; nothing keeps this flat field current
        // (ADR-0016 decision 2).
        status: { agent_state: 'offline', observation_age_seconds: 0 },
      },
      PUT_SOURCE,
    );
  }
}
