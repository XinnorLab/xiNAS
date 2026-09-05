/**
 * System producer (S17 §8.6): xiNAS service units, network and RDMA links,
 * reboot detection (with the restore-pending set for the RAID producer),
 * plus the heartbeat-driven agent-state and collector-state events that
 * arrive outside an observation batch (`emitAgentState`,
 * `applyCollectorMap`) and the per-kind freshness stamp every accepted
 * batch leaves (`onAccepted`).
 *
 * A failed or stale collector is reported as itself and never as a domain
 * event (SUBS-GEN-002); recovery from `failed` needs a newer accepted batch,
 * recovery from `stale` IS the next accepted batch.
 */

import type { Kind } from '../../../agent/collectors/base.js';
import type { AcceptedCtx, ChangeCtx, Producer, Row, TransitionEngine } from '../engine.js';
import { META_KEYS } from '../meta.js';
import type { Feed, Severity } from '../types.js';
import { NFS_UNITS, emitUnitTransition, unitTransition } from './nfs.js';

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// ── services (D-18) ────────────────────────────────────────────────────

/** Units with the full unavailable/recovered rule. */
const SYSTEM_UNITS: ReadonlySet<string> = new Set([
  'xinas-agent.service',
  'xinas-nfs-helper.service',
  'xiraid-server.service',
]);
/** The api cannot observe its own outage (V-72): recovery only. */
const RECOVERY_ONLY_UNITS: ReadonlySet<string> = new Set(['xinas-api.service']);

function onUnitChange(ctx: ChangeCtx): void {
  if (NFS_UNITS.has(ctx.id)) return; // the NFS producer owns those
  const full = SYSTEM_UNITS.has(ctx.id);
  const recoveryOnly = RECOVERY_ONLY_UNITS.has(ctx.id);
  if (!full && !recoveryOnly) return;
  const t = unitTransition(ctx.previous, ctx.current);
  if (t === null) return;
  if (recoveryOnly && t.kind !== 'recovered') return;
  emitUnitTransition(ctx, 'system', 'system.service', t);
}

// ── links ──────────────────────────────────────────────────────────────

const LINK_WORDS: ReadonlySet<string> = new Set(['up', 'down']);

function linkState(row: Row | null, field: 'link_state' | 'rdma_link_state'): 'up' | 'down' | null {
  const v = asRecord(row?.status)[field];
  return typeof v === 'string' && LINK_WORDS.has(v) ? (v as 'up' | 'down') : null;
}

function onInterfaceChange(ctx: ChangeCtx): void {
  if (ctx.previous === null || ctx.current === null) return;
  const id = ctx.id;
  const status = asRecord(ctx.current.status);
  const managed = ctx.kv.get(`/xinas/v1/desired/NetworkInterface/${id}`) !== null;
  const capable = status.rdma_capable === true;
  if (!managed && !capable) return; // not service-relevant by default (S6 amendment)

  const pairs: Array<{
    field: 'link_state' | 'rdma_link_state';
    down: string;
    up: string;
  }> = [
    { field: 'link_state', down: 'system.network.link_down', up: 'system.network.link_up' },
    { field: 'rdma_link_state', down: 'system.rdma.link_down', up: 'system.rdma.link_up' },
  ];
  for (const p of pairs) {
    const before = linkState(ctx.previous, p.field);
    const after = linkState(ctx.current, p.field);
    // `unknown` or a partial monitor record on either side compares nothing.
    if (before === null || after === null || before === after) continue;
    const goingDown = after === 'down';
    ctx.emit({
      feed: 'system',
      type: goingDown ? p.down : p.up,
      subject: { kind: 'NetworkInterface', id },
      args: { interface: id },
      previous: { [p.field]: before, ...(goingDown ? {} : { severity: 'warning' as Severity }) },
      current: { [p.field]: after },
      details: {
        interface: id,
        ...(p.field === 'link_state' ? { linkState: after } : { rdmaLinkState: after }),
        managed,
        observedAt: ctx.batch.observedAt,
      },
    });
  }
}

// ── reboot (D-23) ──────────────────────────────────────────────────────

function onInventoryChange(ctx: ChangeCtx): void {
  if (ctx.current === null) return;
  const bootId = asRecord(ctx.current.status).boot_id;
  if (typeof bootId !== 'string' || bootId.length === 0) return;
  const stored = ctx.meta.get<string>(META_KEYS.bootId);
  if (stored === bootId) return;
  if (stored !== null) {
    const knownArrays = ctx.kv
      .list<Row>({ prefix: '/xinas/v1/observed/XiraidArray/' })
      .map((r) => (typeof r.value.id === 'string' ? r.value.id : ''))
      .filter((id) => id.length > 0);
    ctx.emit({
      feed: 'system',
      type: 'system.reboot.detected',
      subject: { kind: 'Node', id: ctx.controllerId },
      source: { kind: 'inventory', component: 'inventory' },
      args: {},
      reasonCode: 'reboot',
      previous: { boot_id: stored },
      current: { boot_id: bootId },
      details: { previousBootId: stored, bootId, observedAt: ctx.batch.observedAt },
    });
    ctx.meta.set(META_KEYS.restorePending, { bootId, knownArrays });
  }
  ctx.meta.set(META_KEYS.bootId, bootId);
}

// ── collector freshness (D-24) ─────────────────────────────────────────

/** Expected refresh per observed kind (agent spec Flow D; backstop 300 s). */
export const COLLECTOR_POLL_MS = {
  Disk: 60_000,
  NetworkInterface: 30_000,
  NetworkConfig: 30_000,
  Filesystem: 60_000,
  NfsSession: 30_000,
  ExportRule: 30_000,
  NfsIdmap: 60_000,
  NfsProfile: 60_000,
  SystemdUnit: 30_000,
  XiraidArray: 30_000,
  Pool: 30_000,
  Tuning: 60_000,
  inventory: 300_000,
  User: 300_000,
  Group: 300_000,
  ConfigSnapshot: 300_000,
  managed_files: 300_000,
} as const satisfies Record<string, number>;
const DEFAULT_POLL_MS = 300_000;
export const pollIntervalFor = (kind: string): number =>
  (COLLECTOR_POLL_MS as Record<string, number>)[kind] ?? DEFAULT_POLL_MS;

interface CollectorState {
  state: 'running' | 'failed' | 'stale';
  since: number;
  failedAt?: number;
}

const REASON_MAX = 256;

function onAccepted(ctx: AcceptedCtx): void {
  for (const kind of ctx.kinds) {
    ctx.meta.set(META_KEYS.collectorLastAccepted(kind), ctx.batch.detectedAtMs);
    const st = ctx.meta.get<CollectorState>(META_KEYS.collectorState(kind));
    if (st?.state === 'stale') {
      ctx.emit({
        feed: 'system',
        type: 'system.collector.recovered',
        subject: { kind: 'Collector', id: kind },
        source: { kind: 'observed_snapshot', component: kind },
        args: { collector: kind },
        previous: { severity: 'warning', state: 'stale' },
        current: { state: 'running' },
        details: {
          collector: kind,
          lastAcceptedAt: new Date(ctx.batch.detectedAtMs).toISOString(),
        },
      });
      ctx.meta.set(META_KEYS.collectorState(kind), {
        state: 'running',
        since: ctx.batch.detectedAtMs,
      } satisfies CollectorState);
    }
  }
}

/**
 * Apply one heartbeat's collector map (`<Kind>: running | stubbed | error: …`).
 * Returns the feeds that gained rows so the caller can notify listeners.
 */
export function applyCollectorMap(
  engine: TransitionEngine,
  map: Record<string, string>,
  opts: { agentHealthy: boolean; nowMs: number },
): Set<Feed> {
  const feeds = new Set<Feed>();
  const meta = engine.meta;
  for (const [kind, health] of Object.entries(map)) {
    if (typeof health !== 'string') continue;
    const failed = health.startsWith('error');
    const key = META_KEYS.collectorState(kind);
    const st = meta.get<CollectorState>(key) ?? { state: 'running', since: opts.nowMs };
    const lastAccepted = meta.get<number>(META_KEYS.collectorLastAccepted(kind));
    const lastAcceptedAt = lastAccepted === null ? null : new Date(lastAccepted).toISOString();

    if (failed) {
      if (st.state === 'failed') continue;
      const reason = health.replace(/^error:?\s*/, '').slice(0, REASON_MAX);
      const r = engine.emitDirect({
        feed: 'system',
        type: 'system.collector.failed',
        subject: { kind: 'Collector', id: kind },
        source: { kind: 'heartbeat', component: kind },
        args: { collector: kind },
        reasonCode: 'collector_error',
        previous: { state: st.state },
        current: { state: 'failed' },
        details: { collector: kind, reason, lastAcceptedAt },
      });
      for (const f of r.feeds) feeds.add(f);
      meta.set(key, {
        state: 'failed',
        since: opts.nowMs,
        failedAt: opts.nowMs,
      } satisfies CollectorState);
      continue;
    }

    if (st.state === 'failed') {
      // Recovery needs evidence: a batch accepted AFTER the failure.
      if (lastAccepted !== null && st.failedAt !== undefined && lastAccepted > st.failedAt) {
        const r = engine.emitDirect({
          feed: 'system',
          type: 'system.collector.recovered',
          subject: { kind: 'Collector', id: kind },
          source: { kind: 'heartbeat', component: kind },
          args: { collector: kind },
          previous: { severity: 'warning', state: 'failed' },
          current: { state: 'running' },
          details: { collector: kind, lastAcceptedAt },
        });
        for (const f of r.feeds) feeds.add(f);
        meta.set(key, { state: 'running', since: opts.nowMs } satisfies CollectorState);
      }
      continue;
    }

    if (st.state === 'running' && opts.agentHealthy && lastAccepted !== null) {
      const poll = pollIntervalFor(kind);
      if (opts.nowMs - lastAccepted > engine.config.staleness_multiplier * poll) {
        const r = engine.emitDirect({
          feed: 'system',
          type: 'system.collector.stale',
          subject: { kind: 'Collector', id: kind },
          source: { kind: 'heartbeat', component: kind },
          args: { collector: kind },
          reasonCode: 'no_valid_update',
          previous: { state: 'running' },
          current: { state: 'stale' },
          details: { collector: kind, lastAcceptedAt, pollIntervalMs: poll },
        });
        for (const f of r.feeds) feeds.add(f);
        meta.set(key, { state: 'stale', since: opts.nowMs } satisfies CollectorState);
      }
    }
  }
  return feeds;
}

// ── agent state (heartbeat) ────────────────────────────────────────────

export type AgentState = 'healthy' | 'degraded' | 'offline';
export interface AgentStateTransition {
  from: AgentState;
  to: AgentState;
  reason: 'connect_refused' | 'heartbeat_timeout';
  lastHeartbeatAt: string | null;
}

const AGENT_SEVERITY: Record<AgentState, Severity> = {
  healthy: 'info',
  degraded: 'warning',
  offline: 'error',
};

/** One heartbeat-tracker transition → one `system.agent.*` row. */
export function emitAgentState(engine: TransitionEngine, t: AgentStateTransition): Set<Feed> {
  const type =
    t.to === 'healthy'
      ? 'system.agent.recovered'
      : t.to === 'degraded'
        ? 'system.agent.degraded'
        : 'system.agent.offline';
  return engine.emitDirect({
    feed: 'system',
    type,
    subject: { kind: 'Agent', id: 'xinas-agent' },
    source: { kind: 'heartbeat', component: 'heartbeat' },
    args: {},
    ...(t.to === 'healthy' ? {} : { reasonCode: t.reason }),
    previous: { severity: AGENT_SEVERITY[t.from], state: t.from },
    current: { state: t.to },
    details: { lastSuccessfulHeartbeatAt: t.lastHeartbeatAt, reason: t.reason },
  }).feeds;
}

export const systemProducer: Producer = {
  kinds: ['SystemdUnit', 'NetworkInterface', 'inventory'],
  onChange(ctx) {
    switch (ctx.kind) {
      case 'SystemdUnit':
        onUnitChange(ctx);
        break;
      case 'NetworkInterface':
        onInterfaceChange(ctx);
        break;
      case 'inventory':
        onInventoryChange(ctx);
        break;
      default:
        break;
    }
  },
  onAccepted,
};

/** Kinds whose freshness the system producer tracks (every observed kind). */
export const isTrackedKind = (kind: string): kind is Kind => kind in COLLECTOR_POLL_MS;
