import { randomUUID } from 'node:crypto';
import type { MetricsRegistry } from '../../lib/metrics.js';
import type { OpenedStateStore } from '../../state/index.js';
import type { AgentRpcClient } from '../agent-client.js';
import type { TaskEngines } from '../context.js';
import { registryConfirmationMetrics } from '../mcp/confirmation/metrics.js';
import { ConfirmationStore } from '../mcp/confirmation/store.js';
import { PlanEngine } from '../plan/engine.js';
import {
  fsCreateProvider,
  fsGrowProvider,
  fsMountProvider,
  fsSetQuotaModeProvider,
  fsUnmanageProvider,
  fsUnmountProvider,
} from '../plan/providers/filesystem.js';
import { netIfaceUpdateProvider, netPoolApplyProvider } from '../plan/providers/network.js';
import { supportBundleProvider } from '../plan/providers/support.js';
import { configRollbackProvider } from '../plan/providers/config-rollback.js';
import {
  poolCreateProvider,
  poolDeleteProvider,
  poolModifyProvider,
} from '../plan/providers/pool.js';
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
  /** SSE fan-out for engine-local synthetic terminals (S10, ADR-0012 §4). */
  taskWatch?: { notify(taskId: string, event: unknown): void };
  /** S15 §13 (mcp.allow_apply): re-checked inside the apply transaction, not just at the route. */
  allowMcpApply?: () => boolean;
  /**
   * S15 §12.2 (Task 13): when supplied, the confirmation counters are
   * registered ONCE on this registry (over the `ConfirmationStore` built
   * below) and threaded into the `TaskEngine` for its `decided('consumed')`
   * / `confirmationToApply()` calls. The same registry MUST be the one
   * `ApiContext.metrics` is set to and `GET /api/v1/metrics` renders —
   * calling `registryConfirmationMetrics` a second time over the same
   * registry throws (duplicate metric names), so app.ts reuses
   * `TaskEngines.confirmationMetrics` for `ConfirmationService` rather than
   * building its own. Omit in contexts that never expose `/metrics`.
   */
  metrics?: MetricsRegistry;
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
  const confirmations = new ConfirmationStore({ db: state.db, now });
  // S15 §12.2 (Task 13): built ONCE here (needs the store above), before the
  // TaskEngine that consumes it — see BuildTaskEnginesOptions.metrics.
  const confirmationMetrics =
    opts.metrics !== undefined
      ? registryConfirmationMetrics(opts.metrics, confirmations)
      : undefined;
  const taskEngine = new TaskEngine({
    db: state.db,
    store,
    leases: state.leases,
    kv: state.kv,
    confirmations,
    audit: state.audit,
    clock: now,
    ...(opts.maxInflight !== undefined ? { maxInflight: opts.maxInflight } : {}),
    ...(opts.taskWatch !== undefined ? { taskWatch: opts.taskWatch } : {}),
    ...(opts.allowMcpApply !== undefined ? { allowMcpApply: opts.allowMcpApply } : {}),
    ...(confirmationMetrics !== undefined ? { metrics: confirmationMetrics } : {}),
  });
  const planEngine = new PlanEngine({ store, ctx: { kv: state.kv }, now });
  planEngine.register(referencePlanProvider);
  // The five real NFS providers (S3 N4.1 + N7.3) — share.* +
  // nfs-profile.update + nfs-idmap.set.
  for (const provider of buildNfsPlanProviders()) planEngine.register(provider);
  planEngine.register(xiraidArrayCreateProvider);
  planEngine.register(xiraidArrayModifyProvider);
  planEngine.register(xiraidArrayImportProvider);
  planEngine.register(xiraidArrayDeleteProvider);
  planEngine.register(fsCreateProvider);
  planEngine.register(fsMountProvider);
  planEngine.register(fsUnmountProvider);
  planEngine.register(fsGrowProvider);
  planEngine.register(fsSetQuotaModeProvider);
  planEngine.register(fsUnmanageProvider);
  planEngine.register(netIfaceUpdateProvider);
  planEngine.register(supportBundleProvider);
  planEngine.register(configRollbackProvider);
  planEngine.register(poolCreateProvider);
  planEngine.register(poolModifyProvider);
  planEngine.register(poolDeleteProvider);
  planEngine.register(netPoolApplyProvider);

  return {
    planEngine,
    taskEngine,
    store,
    leases: state.leases,
    confirmations,
    ...(opts.agentClient ? { agentClient: opts.agentClient } : {}),
    ...(confirmationMetrics !== undefined ? { confirmationMetrics } : {}),
  };
}
