/**
 * RAID producers (S17 §8.2–§8.3): array lifecycle, operation lifecycle,
 * array-state conditions, members, spare pools, restore-after-reboot and
 * the bucketed progress feed — all derived from the observed `XiraidArray`
 * and `Pool` rows, using the raw xiRAID state words the S3 amendment keeps.
 *
 * Vocabulary: xiRAID Classic 4.4, AG / Showing RAID State
 * (https://xinnor.io/docs/xiRAID-4.4.0/E/en/AG/1/showing_raid_state.html).
 *
 * Event order inside one transition is fixed so a client reading a feed
 * sees cause before consequence: operation ends → state conditions →
 * operation starts → members → replacements → progress.
 */

import type { ChangeCtx, Producer, Row, SnapshotCtx } from '../engine.js';
import { META_KEYS } from '../meta.js';
import type { OperationKind, Severity } from '../types.js';
import { SEVERITY_RANK } from '../types.js';

// ── vocabulary ─────────────────────────────────────────────────────────

/** The 16 vendor words plus the alternate spellings the parser accepts. */
const KNOWN_WORDS: ReadonlySet<string> = new Set([
  'online',
  'initialized',
  'initing',
  'inconsistent',
  'degraded',
  'reconstructing',
  'offline',
  'need_recon',
  'need_init',
  'read_only',
  'unrecovered',
  'none',
  'restriping',
  'sdc_scanning',
  'need_resize',
  'need_restripe',
  // alternate spellings tolerated by lib/parse/raid.ts
  'broken',
  'unusable',
  'faulty',
  'failed',
  'initializing',
  'init',
  'recon',
  'resyncing',
  'need_resync',
]);

const UNHEALTHY_WORDS: ReadonlySet<string> = new Set([
  'degraded',
  'need_recon',
  'need_init',
  'inconsistent',
  'read_only',
  'offline',
  'unrecovered',
  'none',
]);

type Condition = 'degraded' | 'read_only' | 'offline' | 'unrecovered';
const CONDITION_SEVERITY: Record<Condition, Severity> = {
  degraded: 'error',
  read_only: 'error',
  offline: 'critical',
  unrecovered: 'critical',
};
const CONDITION_ORDER: Condition[] = ['degraded', 'read_only', 'offline', 'unrecovered'];

const OPERATION_KINDS: OperationKind[] = ['initialization', 'reconstruction'];
const ACTIVE_WORD: Record<OperationKind, string> = {
  initialization: 'initing',
  reconstruction: 'reconstructing',
};
const MEMBER_BLOCKING_WORDS: ReadonlySet<string> = new Set([
  'offline',
  'reconstructing',
  'need_recon',
]);

// ── row view ───────────────────────────────────────────────────────────

interface ArrayView {
  rawStates: string[];
  /** device (control-path Disk id) → lower-cased member state words */
  members: Map<string, string[]>;
  memberIds: string[];
  sparePool: string | undefined;
  spareDisks: string[];
  level: string | undefined;
  init: number | null;
  recon: number | null;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function words(v: unknown): string[] {
  if (typeof v === 'string') return [v.toLowerCase()];
  if (Array.isArray(v)) {
    return [
      ...new Set(v.filter((w): w is string => typeof w === 'string').map((w) => w.toLowerCase())),
    ];
  }
  return [];
}

function pct(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function arrayView(row: Row | null): ArrayView | null {
  if (row === null) return null;
  const status = asRecord(row.status);
  const spec = asRecord(row.spec);
  const members = new Map<string, string[]>();
  if (Array.isArray(status.member_states)) {
    for (const m of status.member_states) {
      const rec = asRecord(m);
      if (typeof rec.device === 'string' && rec.device.length > 0) {
        members.set(rec.device, words(rec.states));
      }
    }
  }
  const memberIds = strings(spec.member_disk_ids);
  const ids = memberIds.length > 0 ? memberIds : [...members.keys()];
  return {
    rawStates: words(status.raw_states),
    members,
    memberIds: ids,
    sparePool:
      typeof spec.spare_pool === 'string' && spec.spare_pool.length > 0
        ? spec.spare_pool
        : undefined,
    spareDisks: strings(spec.spare_disk_ids),
    level: typeof spec.level === 'string' ? spec.level : undefined,
    init: pct(status.init_progress_pct),
    recon: pct(status.recon_progress_pct),
  };
}

// ── predicates (spec §8.2) ─────────────────────────────────────────────

export const isActive = (v: ArrayView, kind: OperationKind): boolean =>
  v.rawStates.includes(ACTIVE_WORD[kind]);

const membersHealthy = (v: ArrayView): boolean => {
  for (const states of v.members.values()) {
    if (states.some((w) => MEMBER_BLOCKING_WORDS.has(w))) return false;
  }
  return true;
};

export const isHealthy = (v: ArrayView): boolean =>
  v.rawStates.includes('online') &&
  !v.rawStates.some((w) => UNHEALTHY_WORDS.has(w)) &&
  !isActive(v, 'initialization') &&
  !isActive(v, 'reconstruction') &&
  membersHealthy(v);

export function conditions(v: ArrayView): Set<Condition> {
  const out = new Set<Condition>();
  const has = (w: string) => v.rawStates.includes(w);
  if (has('degraded') || has('need_recon')) out.add('degraded');
  if (has('read_only')) out.add('read_only');
  if (has('offline') || has('none')) out.add('offline');
  if (has('unrecovered')) out.add('unrecovered');
  return out;
}

const worstSeverity = (conds: Iterable<Condition>): Severity => {
  let worst: Severity = 'info';
  for (const c of conds) {
    if (SEVERITY_RANK[CONDITION_SEVERITY[c]] > SEVERITY_RANK[worst]) worst = CONDITION_SEVERITY[c];
  }
  return worst;
};

// ── meta shapes ────────────────────────────────────────────────────────

interface OpMeta {
  generation: number;
  active: boolean;
}
interface ProgressMeta {
  generation: number;
  lastPct: number;
  lastBucket: number;
  lastEmitAt: number;
}
interface ConditionMeta {
  conditions: Condition[];
  severity: Severity;
}
interface RestorePending {
  bootId: string;
  knownArrays: string[];
}

const projection = (v: ArrayView): Record<string, unknown> => ({ raw_states: v.rawStates });

// ── the XiraidArray producer ───────────────────────────────────────────

function onArrayChange(ctx: ChangeCtx): void {
  const { id, meta } = ctx;
  const prev = arrayView(ctx.previous);
  const cur = arrayView(ctx.current);
  const subject = { kind: 'XiraidArray' as const, id };
  const observedAt = ctx.batch.observedAt;

  if (cur === null) {
    if (prev === null) return;
    const pending = meta.get<RestorePending>(META_KEYS.restorePending);
    if (pending === null) {
      const inProgress = OPERATION_KINDS.find(
        (k) => meta.get<OpMeta>(META_KEYS.raidOp(id, k))?.active === true,
      );
      const cause = ctx.correlate(['xiraid.array.delete'], subject);
      ctx.emit({
        feed: 'raid',
        type: 'raid.array.removed',
        subject,
        args: { array: id },
        previous: projection(prev),
        details: {
          array: id,
          observedAt,
          ...(inProgress !== undefined ? { operationInProgress: inProgress } : {}),
        },
        ...(cause !== undefined ? { cause, timeAccuracy: 'task' } : {}),
      });
    }
    clearArrayMeta(ctx, id);
    return;
  }

  // Source warnings first: an unknown word is reported once per (array, word).
  warnUnknownWords(ctx, id, cur);

  if (prev === null) {
    if (ctx.baselineDone('XiraidArray')) {
      const cause = ctx.correlate(['xiraid.array.create', 'xiraid.array.import'], subject);
      ctx.emit({
        feed: 'raid',
        type: 'raid.array.created',
        subject,
        args: { array: id },
        current: projection(cur),
        details: {
          array: id,
          observedAt,
          ...(cur.level !== undefined ? { level: cur.level } : {}),
          memberCount: cur.memberIds.length,
          ...(cur.sparePool !== undefined ? { sparePool: cur.sparePool } : {}),
        },
        ...(cause !== undefined ? { cause, timeAccuracy: 'task' } : {}),
      });
    }
    // Baseline exceptions (spec §8.0): an already-running operation, and an
    // array first seen offline / unrecovered.
    for (const kind of OPERATION_KINDS) {
      if (!isActive(cur, kind)) continue;
      const existing = meta.get<OpMeta>(META_KEYS.raidOp(id, kind));
      const generation = existing?.generation ?? 1;
      meta.set(META_KEYS.raidOp(id, kind), { generation, active: true });
      ctx.emit({
        feed: 'raid',
        type: 'raid.operation.observed_running',
        subject,
        args: { array: id, kind },
        current: projection(cur),
        operation: { kind, generation },
        details: { array: id, kind, generation, observedAt },
      });
      recordProgress(ctx, id, kind, cur, false);
    }
    const conds = conditions(cur);
    const critical = CONDITION_ORDER.filter(
      (c) => conds.has(c) && CONDITION_SEVERITY[c] === 'critical',
    );
    if (critical.length > 0) {
      for (const c of critical) emitCondition(ctx, id, c, cur, prev, 'baseline');
      meta.set(META_KEYS.raidCondition(id), {
        conditions: critical,
        severity: worstSeverity(critical),
      } satisfies ConditionMeta);
    }
    return;
  }

  // 1. Operation ends.
  for (const kind of OPERATION_KINDS) {
    if (isActive(prev, kind) && !isActive(cur, kind)) {
      const op = meta.get<OpMeta>(META_KEYS.raidOp(id, kind));
      const generation = op?.generation ?? 1;
      const healthy = isHealthy(cur);
      ctx.emit({
        feed: 'raid',
        type: healthy ? 'raid.operation.completed' : 'raid.operation.failed',
        subject,
        args: { array: id, kind },
        previous: projection(prev),
        current: projection(cur),
        operation: { kind, generation },
        details: { array: id, kind, generation, finalStates: cur.rawStates, observedAt },
      });
      meta.set(META_KEYS.raidOp(id, kind), { generation, active: false } satisfies OpMeta);
      meta.delete(META_KEYS.progress(id, kind));
    }
  }

  // 2. State conditions entered, and recovery.
  const prevConds = conditions(prev);
  const curConds = conditions(cur);
  const entered = CONDITION_ORDER.filter((c) => curConds.has(c) && !prevConds.has(c));
  if (entered.length > 0) {
    for (const c of entered) emitCondition(ctx, id, c, cur, prev);
    const known = meta.get<ConditionMeta>(META_KEYS.raidCondition(id));
    const all = new Set<Condition>([...(known?.conditions ?? []), ...entered]);
    meta.set(META_KEYS.raidCondition(id), {
      conditions: [...all],
      severity: worstSeverity(all),
    } satisfies ConditionMeta);
  }
  if (curConds.size === 0 && isHealthy(cur)) {
    const known = meta.get<ConditionMeta>(META_KEYS.raidCondition(id));
    if (known !== null) {
      ctx.emit({
        feed: 'raid',
        type: 'raid.state.recovered',
        subject,
        args: { array: id },
        previous: {
          severity: known.severity,
          conditions: known.conditions,
          raw_states: prev.rawStates,
        },
        current: projection(cur),
        details: { array: id, rawStates: cur.rawStates, observedAt },
      });
      meta.delete(META_KEYS.raidCondition(id));
    }
  }

  // 3. Operation starts.
  for (const kind of OPERATION_KINDS) {
    if (!isActive(prev, kind) && isActive(cur, kind)) {
      const op = meta.get<OpMeta>(META_KEYS.raidOp(id, kind));
      const generation = (op?.generation ?? 0) + 1;
      meta.set(META_KEYS.raidOp(id, kind), { generation, active: true } satisfies OpMeta);
      meta.delete(META_KEYS.progress(id, kind));
      ctx.emit({
        feed: 'raid',
        type: 'raid.operation.started',
        subject,
        args: { array: id, kind },
        previous: projection(prev),
        current: projection(cur),
        operation: { kind, generation },
        details: { array: id, kind, generation, observedAt },
      });
    }
  }

  // 4. Members present in both rows.
  for (const [device, states] of cur.members) {
    const before = prev.members.get(device);
    if (before === undefined) continue;
    const wasOffline = before.includes('offline');
    const isOffline = states.includes('offline');
    if (wasOffline === isOffline) continue;
    ctx.emit({
      feed: 'raid',
      type: isOffline ? 'raid.member.offline' : 'raid.member.returned',
      subject: { kind: 'Disk', id: device },
      args: { array: id, device },
      relatedResources: [{ kind: 'XiraidArray', id }],
      previous: { states: before },
      current: { states },
      details: { array: id, device, states, observedAt },
    });
  }

  // 5. Automatic replacement: a new member that was one of the array's
  //    spare drives in the previous observation (an observed fact — the
  //    previous row's spare_disk_ids — never timing proximity).
  const prevSet = new Set(prev.memberIds);
  const curSet = new Set(cur.memberIds);
  const added = cur.memberIds.filter((d) => !prevSet.has(d));
  const removed = prev.memberIds.filter((d) => !curSet.has(d));
  for (const replacement of added) {
    if (!prev.spareDisks.includes(replacement)) continue;
    const replaced = removed.shift();
    if (replaced === undefined) continue;
    const pool = prev.sparePool ?? cur.sparePool ?? '';
    ctx.emit({
      feed: 'raid',
      type: 'raid.spare.replacement.completed',
      subject,
      args: { array: id, replaced, replacement, pool },
      relatedResources: [
        { kind: 'Disk', id: replaced },
        { kind: 'Disk', id: replacement },
        ...(pool.length > 0 ? [{ kind: 'Pool', id: pool }] : []),
      ],
      details: { array: id, replaced, replacement, pool, observedAt },
    });
    if (pool.length > 0) {
      const key = META_KEYS.spareReplacementRecent(pool);
      const recent = meta.get<string[]>(key) ?? [];
      meta.set(key, [...new Set([...recent, replacement])]);
    }
  }

  // 6. Progress (the raid/progress feed).
  for (const kind of OPERATION_KINDS) {
    if (isActive(cur, kind)) recordProgress(ctx, id, kind, cur, isActive(prev, kind));
  }
}

function emitCondition(
  ctx: ChangeCtx,
  id: string,
  c: Condition,
  cur: ArrayView,
  prev: ArrayView | null,
  reason?: 'baseline',
): void {
  const viaNone =
    c === 'offline' && !cur.rawStates.includes('offline') && cur.rawStates.includes('none');
  ctx.emit({
    feed: 'raid',
    type: `raid.state.${c}`,
    subject: { kind: 'XiraidArray', id },
    args: { array: id },
    ...(prev !== null ? { previous: projection(prev) } : {}),
    current: projection(cur),
    ...(reason !== undefined
      ? { reasonCode: reason }
      : viaNone
        ? { reasonCode: 'state_none' }
        : {}),
    details: { array: id, rawStates: cur.rawStates, observedAt: ctx.batch.observedAt },
  });
}

function warnUnknownWords(ctx: ChangeCtx, id: string, cur: ArrayView): void {
  const unknown = cur.rawStates.filter((w) => !KNOWN_WORDS.has(w));
  if (unknown.length === 0) return;
  const key = META_KEYS.unknownStateWarned(id);
  const warned = new Set(ctx.meta.get<string[]>(key) ?? []);
  let changed = false;
  for (const word of unknown) {
    if (warned.has(word)) continue;
    warned.add(word);
    changed = true;
    ctx.emit({
      feed: 'raid',
      type: 'raid.source.unknown_state',
      subject: { kind: 'XiraidArray', id },
      args: { array: id, word },
      reasonCode: 'unknown_word',
      details: { array: id, word, observedAt: ctx.batch.observedAt },
    });
  }
  if (changed) ctx.meta.set(key, [...warned]);
}

/**
 * Bucketed progress (spec §8.3). The first sample of a generation is
 * recorded silently unless it is already past bucket 0; afterwards a new
 * bucket (subject to the minimum interval), a changed value after the
 * maximum silence, or a regression (new generation) emits one event.
 */
function recordProgress(
  ctx: ChangeCtx,
  id: string,
  kind: OperationKind,
  cur: ArrayView,
  wasActive: boolean,
): void {
  const p = kind === 'initialization' ? cur.init : cur.recon;
  if (p === null) return;
  const op = ctx.meta.get<OpMeta>(META_KEYS.raidOp(id, kind));
  if (op === null || !op.active) return;
  const { bucket_pct, min_interval_s, max_silence_s } = ctx.config.progress;
  const now = ctx.batch.detectedAtMs;
  const bucket = Math.floor(p / bucket_pct) * bucket_pct;
  const key = META_KEYS.progress(id, kind);
  const st = ctx.meta.get<ProgressMeta>(key);
  let generation = op.generation;
  let emit = false;
  let reason: 'regression' | undefined;

  if (st === null) {
    emit = bucket > 0;
  } else if (wasActive && p < st.lastPct - 1) {
    generation = op.generation + 1;
    ctx.meta.set(META_KEYS.raidOp(id, kind), { generation, active: true } satisfies OpMeta);
    reason = 'regression';
    emit = true;
  } else if (bucket !== st.lastBucket && now - st.lastEmitAt >= min_interval_s * 1000) {
    emit = true;
  } else if (p !== st.lastPct && now - st.lastEmitAt >= max_silence_s * 1000) {
    emit = true;
  }

  if (emit) {
    ctx.emit({
      feed: 'raid/progress',
      type: 'raid.operation.progress',
      subject: { kind: 'XiraidArray', id },
      args: { array: id, kind, progressPct: p },
      operation: { kind, generation, progressPct: p, bucket },
      ...(reason !== undefined ? { reasonCode: reason } : {}),
      details: {
        array: id,
        kind,
        observedAt: ctx.batch.observedAt,
        ...(reason !== undefined ? { reasonCode: reason } : {}),
      },
    });
  }
  ctx.meta.set(key, {
    generation,
    lastPct: p,
    lastBucket: emit || st === null ? bucket : st.lastBucket,
    lastEmitAt: emit || st === null ? now : st.lastEmitAt,
  } satisfies ProgressMeta);
}

function clearArrayMeta(ctx: ChangeCtx | SnapshotCtx, id: string): void {
  for (const kind of OPERATION_KINDS) {
    ctx.meta.delete(META_KEYS.raidOp(id, kind));
    ctx.meta.delete(META_KEYS.progress(id, kind));
  }
  ctx.meta.delete(META_KEYS.raidCondition(id));
  ctx.meta.delete(META_KEYS.unknownStateWarned(id));
}

/** Restore outcomes on the first complete XiraidArray snapshot after a reboot (spec §8.2). */
function onArraySnapshot(ctx: SnapshotCtx): void {
  const pending = ctx.meta.get<RestorePending>(META_KEYS.restorePending);
  if (pending === null) return;
  for (const name of pending.knownArrays) {
    const subject = { kind: 'XiraidArray' as const, id: name };
    const row = ctx.present.has(name)
      ? ctx.kv.get<Row>(`/xinas/v1/observed/XiraidArray/${name}`)
      : null;
    const v = row === null ? null : arrayView(row.value);
    let result: 'healthy' | 'read_only' | 'offline' | 'not_restored';
    if (v === null || v.rawStates.includes('none')) result = 'not_restored';
    else if (v.rawStates.includes('offline')) result = 'offline';
    else if (v.rawStates.includes('read_only')) result = 'read_only';
    else result = 'healthy';
    ctx.emit({
      feed: 'raid',
      type: result === 'not_restored' ? 'raid.restore.failed' : 'raid.restore.completed',
      subject,
      args: { array: name, result },
      reasonCode: 'reboot',
      ...(v !== null ? { current: projection(v) } : {}),
      details: {
        array: name,
        result,
        bootId: pending.bootId,
        ...(v !== null ? { rawStates: v.rawStates } : {}),
        observedAt: ctx.batch.observedAt,
      },
    });
  }
  ctx.meta.delete(META_KEYS.restorePending);
}

export const raidProducer: Producer = {
  kinds: ['XiraidArray'],
  onChange: onArrayChange,
  onSnapshot: onArraySnapshot,
};

// ── the Pool producer ──────────────────────────────────────────────────

interface PoolView {
  name: string;
  drives: string[];
}

function poolView(row: Row | null): PoolView | null {
  if (row === null) return null;
  const status = asRecord(row.status);
  return {
    name: typeof status.name === 'string' ? status.name : typeof row.id === 'string' ? row.id : '',
    drives: strings(status.drives),
  };
}

/** Arrays whose spec names this pool as their spare pool. */
function referencedBy(ctx: ChangeCtx, pool: string): string[] {
  return ctx.kv
    .list<Row>({ prefix: '/xinas/v1/observed/XiraidArray/' })
    .filter((r) => asRecord(r.value.spec).spare_pool === pool)
    .map((r) => (typeof r.value.id === 'string' ? r.value.id : ''))
    .filter((id) => id.length > 0);
}

function onPoolChange(ctx: ChangeCtx): void {
  const prev = poolView(ctx.previous);
  const cur = poolView(ctx.current);
  const pool = ctx.id;
  const subject = { kind: 'Pool' as const, id: pool };
  const observedAt = ctx.batch.observedAt;
  if (cur === null) {
    // A pool that vanishes from pool_show is a configuration change; its
    // drives were not "disconnected". Only the state is cleaned up.
    ctx.meta.delete(META_KEYS.poolExhausted(pool));
    ctx.meta.delete(META_KEYS.spareReplacementRecent(pool));
    return;
  }
  if (prev === null) return;

  const before = new Set(prev.drives);
  const after = new Set(cur.drives);
  const recentKey = META_KEYS.spareReplacementRecent(pool);
  const recent = new Set(ctx.meta.get<string[]>(recentKey) ?? []);
  let recentChanged = false;
  for (const device of prev.drives) {
    if (after.has(device)) continue;
    if (recent.has(device)) {
      // Consumed by an automatic replacement already reported on the array.
      recent.delete(device);
      recentChanged = true;
      continue;
    }
    ctx.emit({
      feed: 'raid',
      type: 'raid.spare.disconnected',
      subject,
      args: { pool, device },
      relatedResources: [{ kind: 'Disk', id: device }],
      details: { pool, device, observedAt },
    });
  }
  if (recentChanged) {
    if (recent.size === 0) ctx.meta.delete(recentKey);
    else ctx.meta.set(recentKey, [...recent]);
  }
  for (const device of cur.drives) {
    if (before.has(device)) continue;
    ctx.emit({
      feed: 'raid',
      type: 'raid.spare.returned',
      subject,
      args: { pool, device },
      relatedResources: [{ kind: 'Disk', id: device }],
      details: { pool, device, observedAt },
    });
  }

  const exhaustedKey = META_KEYS.poolExhausted(pool);
  const wasExhausted = ctx.meta.get<boolean>(exhaustedKey) === true;
  if (cur.drives.length === 0 && prev.drives.length > 0 && !wasExhausted) {
    const refs = referencedBy(ctx, pool);
    if (refs.length > 0) {
      ctx.emit({
        feed: 'raid',
        type: 'raid.spare_pool.exhausted',
        subject,
        args: { pool },
        relatedResources: refs.map((id) => ({ kind: 'XiraidArray', id })),
        details: { pool, referencedBy: refs, observedAt },
      });
      ctx.meta.set(exhaustedKey, true);
    }
  } else if (cur.drives.length > 0 && wasExhausted) {
    ctx.emit({
      feed: 'raid',
      type: 'raid.spare_pool.replenished',
      subject,
      args: { pool },
      previous: { severity: 'warning' },
      details: { pool, drives: cur.drives, observedAt },
    });
    ctx.meta.delete(exhaustedKey);
  }
}

export const poolProducer: Producer = { kinds: ['Pool'], onChange: onPoolChange };
