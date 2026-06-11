import { Router } from 'express';
import { NET_IDENTITY_FIELDS } from '../../lib/net/validate.js';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';
import {
  clientImpact,
  requireInteger,
  requireString,
  taskEnvelope,
  toApplyPlan,
} from '../handlers/plan-apply.js';
import type { RevisionedValue } from '../../state/index.js';
import {
  embedMetadata,
  getOrNull,
  listByPrefix,
  sendOk,
} from '../handlers/reads.js';
import type { PlanProvider } from '../plan/engine.js';
import { netIfaceUpdateProvider, netPoolApplyProvider } from '../plan/providers/network.js';

/**
 * Network routes (S6, ADR-0008).
 *
 * READS are the MERGED model: when a desired row exists (managed +
 * adopted), `spec` is the desired spec verbatim and metadata.revision is
 * the DESIRED row revision (the one mutations bind); otherwise the
 * observed row is returned spec-less with the observed revision.
 *
 * PATCH /network/interfaces/{id} is a CUSTOM S4-style plan/apply route
 * (NOT the shared applyMode — it has no pre-apply hook): identity-field
 * 422 scan → one plan kind → apply with the engine's per-resource
 * desired-revision pins + the world_config_hash re-check.
 */

/** Overlay the desired spec + revision onto an observed row (merged read). */
function mergeIface(
  ctx: ApiContext,
  observedRow: RevisionedValue<Record<string, unknown>>,
): Record<string, unknown> {
  const id = (observedRow.value as { id?: string }).id;
  const desired =
    typeof id === 'string'
      ? getOrNull<Record<string, unknown>>(
          ctx.state,
          `/xinas/v1/desired/NetworkInterface/${id}`,
        )
      : null;
  const base = embedMetadata(observedRow) as Record<string, unknown>;
  if (!desired) return base;
  const desiredSpec = (desired.value as { spec?: unknown }).spec;
  return {
    ...base,
    ...(desiredSpec !== undefined ? { spec: desiredSpec } : {}),
    metadata: {
      ...(base.metadata as Record<string, unknown>),
      revision: desired.revision,
    },
  };
}

/** ADR-0008 writability matrix: identity keys in a PATCH → per-field 422. */
function rejectIdentityKeys(spec: unknown): void {
  if (typeof spec !== 'object' || spec === null) return;
  for (const field of NET_IDENTITY_FIELDS) {
    if (field in (spec as Record<string, unknown>)) {
      throw new ApiException(
        'UNSUPPORTED',
        `spec.${field} is immutable`,
        { reason: 'net_identity_immutable', field },
        'pbr_table_id is allocated once at first manage; managed_by_xinas/name are identity (ADR-0008).',
      );
    }
  }
}

/** Current desired-row revision for an interface (0 = not yet adopted). */
function desiredRevision(ctx: ApiContext, id: string): number {
  return (
    getOrNull<Record<string, unknown>>(ctx.state, `/xinas/v1/desired/NetworkInterface/${id}`)
      ?.revision ?? 0
  );
}

/** Current observed world_config_hash (undefined pre-first-sweep). */
function observedWorldHash(ctx: ApiContext): string | undefined {
  const row = getOrNull<{ status?: { world_config_hash?: string } }>(
    ctx.state,
    '/xinas/v1/observed/NetworkConfig/default',
  );
  return row?.value.status?.world_config_hash;
}

/** apply-recheck providers by plan kind (T8 adds net.pool.apply). */
const NET_PROVIDERS: Record<string, PlanProvider> = {
  'net.iface.update': netIfaceUpdateProvider,
  'net.pool.apply': netPoolApplyProvider,
};

export function networkRouter(ctx: ApiContext): Router {
  const r = Router();

  r.get('/network', (req, res) => {
    const ifaces = listByPrefix<Record<string, unknown>>(
      ctx.state,
      '/xinas/v1/observed/NetworkInterface/',
    );
    sendOk(
      req,
      res,
      { interfaces: ifaces.map((row) => mergeIface(ctx, row)) },
      ifaces.map((x) => x.revision),
    );
  });

  r.get('/network/interfaces', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(
      ctx.state,
      '/xinas/v1/observed/NetworkInterface/',
    );
    sendOk(
      req,
      res,
      rows.map((row) => mergeIface(ctx, row)),
      rows.map((x) => x.revision),
    );
  });

  r.get('/network/interfaces/:id', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(
      ctx.state,
      `/xinas/v1/observed/NetworkInterface/${req.params.id}`,
    );
    if (!row) throw new ApiException('NOT_FOUND', `interface ${req.params.id} not found`);
    const merged = mergeIface(ctx, row);
    const revision = (merged.metadata as { revision: number }).revision;
    sendOk(req, res, merged, [revision]);
  });

  r.get('/service-ips', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/desired/ServiceIP/');
    sendOk(
      req,
      res,
      rows.map((row) => embedMetadata(row)),
      rows.map((x) => x.revision),
    );
  });

  r.patch('/network/interfaces/:id', async (req, res) => {
    const tasks = ctx.tasks;
    if (!tasks) {
      throw new ApiException(
        'INTERNAL',
        'task engine is not available in this build',
        { code: 'EXECUTOR_UNAVAILABLE' },
        'the api was started without a task engine',
      );
    }

    const rc = req.context!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const mode = body.mode;
    const id = req.params.id as string;

    if (mode === 'plan') {
      rejectIdentityKeys(body.spec);
      const { task, planResult } = await tasks.planEngine.plan({
        operation_kind: 'net.iface.update',
        spec: { ...(typeof body.spec === 'object' && body.spec !== null ? body.spec : {}), id },
        principal: rc.principal,
        client_type: rc.client_type,
        request_id: rc.request_id,
        correlation_id: rc.correlation_id,
      });
      rc.operation_id = task.task_id;
      const revision = task.state_revision_expected ?? 0;
      sendOk(
        req,
        res,
        {
          plan_id: task.task_id,
          plan_hash: task.plan_hash,
          state_revision_expected: revision,
          observed_revision_expected: null,
          observed_at: planResult.observed_at ?? null,
          affected_resources: task.affected_resources,
          risk_level: planResult.risk_level,
          client_impact: clientImpact(planResult.risk_level),
          blockers: planResult.blockers,
          warnings: planResult.warnings,
          diff: planResult.diff,
          rollback_model: planResult.rollback_model,
        },
        [revision],
      );
      return;
    }

    if (mode === 'apply') {
      const planId = requireString(body.plan_id, 'plan_id');
      const idempotencyKey = requireString(body.idempotency_key, 'idempotency_key');
      const expectedRevision = requireInteger(body.expected_revision, 'expected_revision');

      const planTask = tasks.store.get(planId);
      const provider = planTask ? NET_PROVIDERS[planTask.kind] : undefined;
      if (
        !planTask ||
        planTask.state !== 'plan_only' ||
        provider === undefined ||
        (planTask.spec as { id?: string } | undefined)?.id !== id
      ) {
        throw new ApiException(
          'NOT_FOUND',
          `no network PATCH plan_only task with plan_id ${planId} for ${id}`,
          undefined,
          'Re-run mode=plan to obtain a fresh plan_id.',
        );
      }

      // The body echoes the plan's pinned desired revision; per-resource
      // staleness is enforced inside the engine txn from the
      // affected_resources[].revision pins.
      const planRevision = planTask.state_revision_expected ?? 0;
      if (expectedRevision !== planRevision) {
        throw new ApiException(
          'PRECONDITION_FAILED',
          `expected_revision ${expectedRevision} does not match the plan's state_revision_expected ${planRevision}`,
          { expected_revision: expectedRevision, plan_revision: planRevision },
          "Echo the plan's state_revision_expected, or re-run plan.",
        );
      }

      // S4 §8: re-run the matching preflight; everything except the
      // engine-owned dangerous code blocks the apply.
      const recheck = await provider.preflight({ kv: ctx.state.kv }, planTask.spec);
      const blocking = recheck.blockers.filter((b) => b.code !== 'dangerous_flag_required');
      if (blocking.length > 0) {
        throw new ApiException(
          'PRECONDITION_FAILED',
          'the plan has unresolved blockers',
          { blockers: blocking },
          'Resolve every blocker, re-plan, then apply the fresh plan.',
        );
      }

      // ADR-0008 world-state gate: ANY netplan file change since plan
      // invalidates it (content-addressed; observed revisions are pinned
      // on desired rows only).
      const plannedHash = (planTask.spec as { world_config_hash?: string }).world_config_hash;
      const currentHash = observedWorldHash(ctx);
      if (plannedHash !== undefined && currentHash !== undefined && plannedHash !== currentHash) {
        throw new ApiException(
          'PRECONDITION_FAILED',
          'the netplan file set changed since this plan was computed',
          { reason: 'netplan_changed', planned: plannedHash, current: currentHash },
          'Re-run plan against the current netplan state, then apply the fresh plan.',
        );
      }

      const applyPlan = toApplyPlan(planTask);
      const task = tasks.taskEngine.apply({
        plan: applyPlan,
        applyReq: {
          input_hash: planTask.input_hash,
          idempotency_key: idempotencyKey,
          principal: rc.principal,
          client_type: rc.client_type,
          request_id: rc.request_id,
          correlation_id: rc.correlation_id,
        },
      });
      rc.operation_id = task.task_id;

      if (task.state !== 'queued') {
        res.status(202);
        sendOk(req, res, taskEnvelope(task), [task.state_revision_at_apply ?? 0]);
        return;
      }

      const dispatched = await tasks.taskEngine.admitAndDispatch({
        task,
        agentClient: tasks.agentClient,
        spec: planTask.spec,
        plan: applyPlan,
      });

      res.status(202);
      sendOk(req, res, taskEnvelope(dispatched), [dispatched.state_revision_at_apply ?? 0]);
      return;
    }

    throw new ApiException(
      'INVALID_ARGUMENT',
      `unknown mode '${String(mode)}'; expected 'plan' or 'apply'`,
      undefined,
      "Send { mode: 'plan', spec } or { mode: 'apply', plan_id, expected_revision, idempotency_key }.",
    );
  });

  // POST /network/ip-pool — net.pool.apply (addresses-only reallocation;
  // same custom apply pipeline as the PATCH route).
  r.post('/network/ip-pool', async (req, res) => {
    const tasks = ctx.tasks;
    if (!tasks) {
      throw new ApiException(
        'INTERNAL',
        'task engine is not available in this build',
        { code: 'EXECUTOR_UNAVAILABLE' },
        'the api was started without a task engine',
      );
    }

    const rc = req.context!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const mode = body.mode;

    if (mode === 'plan') {
      const { task, planResult } = await tasks.planEngine.plan({
        operation_kind: 'net.pool.apply',
        spec: body.spec,
        principal: rc.principal,
        client_type: rc.client_type,
        request_id: rc.request_id,
        correlation_id: rc.correlation_id,
      });
      rc.operation_id = task.task_id;
      const revision = task.state_revision_expected ?? 0;
      sendOk(
        req,
        res,
        {
          plan_id: task.task_id,
          plan_hash: task.plan_hash,
          state_revision_expected: revision,
          observed_revision_expected: null,
          observed_at: planResult.observed_at ?? null,
          affected_resources: task.affected_resources,
          risk_level: planResult.risk_level,
          client_impact: clientImpact(planResult.risk_level),
          blockers: planResult.blockers,
          warnings: planResult.warnings,
          diff: planResult.diff,
          rollback_model: planResult.rollback_model,
        },
        [revision],
      );
      return;
    }

    if (mode === 'apply') {
      const planId = requireString(body.plan_id, 'plan_id');
      const idempotencyKey = requireString(body.idempotency_key, 'idempotency_key');
      const expectedRevision = requireInteger(body.expected_revision, 'expected_revision');

      const planTask = tasks.store.get(planId);
      if (!planTask || planTask.state !== 'plan_only' || planTask.kind !== 'net.pool.apply') {
        throw new ApiException(
          'NOT_FOUND',
          `no net.pool.apply plan_only task with plan_id ${planId}`,
          undefined,
          'Re-run mode=plan to obtain a fresh plan_id.',
        );
      }

      const planRevision = planTask.state_revision_expected ?? 0;
      if (expectedRevision !== planRevision) {
        throw new ApiException(
          'PRECONDITION_FAILED',
          `expected_revision ${expectedRevision} does not match the plan's state_revision_expected ${planRevision}`,
          { expected_revision: expectedRevision, plan_revision: planRevision },
          "Echo the plan's state_revision_expected, or re-run plan.",
        );
      }

      const recheck = await netPoolApplyProvider.preflight({ kv: ctx.state.kv }, planTask.spec);
      const blocking = recheck.blockers.filter((b) => b.code !== 'dangerous_flag_required');
      if (blocking.length > 0) {
        throw new ApiException(
          'PRECONDITION_FAILED',
          'the plan has unresolved blockers',
          { blockers: blocking },
          'Resolve every blocker, re-plan, then apply the fresh plan.',
        );
      }

      const plannedHash = (planTask.spec as { world_config_hash?: string }).world_config_hash;
      const currentHash = observedWorldHash(ctx);
      if (plannedHash !== undefined && currentHash !== undefined && plannedHash !== currentHash) {
        throw new ApiException(
          'PRECONDITION_FAILED',
          'the netplan file set changed since this plan was computed',
          { reason: 'netplan_changed', planned: plannedHash, current: currentHash },
          'Re-run plan against the current netplan state, then apply the fresh plan.',
        );
      }

      const applyPlan = toApplyPlan(planTask);
      const task = tasks.taskEngine.apply({
        plan: applyPlan,
        applyReq: {
          input_hash: planTask.input_hash,
          idempotency_key: idempotencyKey,
          principal: rc.principal,
          client_type: rc.client_type,
          request_id: rc.request_id,
          correlation_id: rc.correlation_id,
        },
      });
      rc.operation_id = task.task_id;

      if (task.state !== 'queued') {
        res.status(202);
        sendOk(req, res, taskEnvelope(task), [task.state_revision_at_apply ?? 0]);
        return;
      }

      const dispatched = await tasks.taskEngine.admitAndDispatch({
        task,
        agentClient: tasks.agentClient,
        spec: planTask.spec,
        plan: applyPlan,
      });

      res.status(202);
      sendOk(req, res, taskEnvelope(dispatched), [dispatched.state_revision_at_apply ?? 0]);
      return;
    }

    throw new ApiException(
      'INVALID_ARGUMENT',
      `unknown mode '${String(mode)}'; expected 'plan' or 'apply'`,
      undefined,
      "Send { mode: 'plan', spec } or { mode: 'apply', plan_id, expected_revision, idempotency_key }.",
    );
  });

  return r;
}

/** Re-exported for the T8 pool route to extend. */
export { NET_PROVIDERS, desiredRevision, observedWorldHash };
