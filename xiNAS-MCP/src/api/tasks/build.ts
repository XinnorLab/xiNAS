import { randomUUID } from 'node:crypto';
import type { OpenedStateStore } from '../../state/index.js';
import type { AgentRpcClient } from '../agent-client.js';
import type { TaskEngines } from '../context.js';
import { PlanEngine } from '../plan/engine.js';
import { fsCreateProvider } from '../plan/providers/filesystem.js';
import { buildNfsPlanProviders } from '../plan/providers/nfs.js';
import { referencePlanProvider } from '../plan/providers/reference.js';
import {
  xiraidArrayCreateProvider,
  xiraidArrayDeleteProvider,
  xiraidArrayImportProvider,
  xiraidArrayModifyProvider,
} from '../plan/providers/xiraid-array.js';
import { TaskEngine } from './engine.js';
import { TaskStore } from './store.js';

export interface BuildTaskEnginesOptions {
  state: OpenedStateStore;
  /** Injected to dispatch `task.begin`; omit in contexts with no agent. */
  agentClient?: AgentRpcClient;
  /** Overridable for deterministic tests. Default: Date.now / randomUUID. */
  now?: () => number;
  newId?: () => string;
  /** Worker-pool cap (§5.3), from `ApiConfig.tasks?.max_inflight`. Default 4. */
  maxInflight?: number;
}

/**
 * Construct the S2 task-engine bundle (s2-task-envelope-spec §2) from an
 * opened state store. Builds the `TaskStore` over the shared SQLite handle,
 * the apply-side `TaskEngine`, and the `PlanEngine` with the built-in
 * `reference.echo` provider registered. The `LeaseManager` is reused from
 * `state.leases` (NOT re-created) so the apply txn and any sweep share the
 * same prepared statements over one db.
 *
 * Hung off ApiContext.tasks by startServer() / the test helpers; consumed by
 * the mutating engine routes (T4 reference route, later real executors).
 */
export function buildTaskEngines(opts: BuildTaskEnginesOptions): TaskEngines {
  const { state } = opts;
  const now = opts.now ?? (() => Date.now());
  const newId = opts.newId ?? (() => randomUUID());

  const store = new TaskStore({ db: state.db, now, newId });
  const taskEngine = new TaskEngine({
    db: state.db,
    store,
    leases: state.leases,
    kv: state.kv,
    ...(opts.maxInflight !== undefined ? { maxInflight: opts.maxInflight } : {}),
  });
  const planEngine = new PlanEngine({ store, ctx: { kv: state.kv } });
  planEngine.register(referencePlanProvider);
  // The five real NFS providers (S3 N4.1 + N7.3) — share.* +
  // nfs-profile.update + nfs-idmap.set.
  for (const provider of buildNfsPlanProviders()) planEngine.register(provider);
  planEngine.register(xiraidArrayCreateProvider);
  planEngine.register(xiraidArrayModifyProvider);
  planEngine.register(xiraidArrayImportProvider);
  planEngine.register(xiraidArrayDeleteProvider);
  planEngine.register(fsCreateProvider);

  return {
    planEngine,
    taskEngine,
    store,
    leases: state.leases,
    ...(opts.agentClient ? { agentClient: opts.agentClient } : {}),
  };
}
