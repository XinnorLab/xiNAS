/**
 * NFS sessions producer (S17 §8.5, decision D-20): connect / disconnect
 * with a batch-based debounce, protocol changes and the optional lock
 * threshold, from the observed `NfsSession` rows.
 *
 * Debounce: a row that appears (after the kind's baseline) or vanishes
 * (a reconcile delete) becomes a *candidate*; the next complete `NfsSession`
 * snapshot from a LATER batch (a later sequence of the same engine instance,
 * or the first snapshot after an api restart) confirms or cancels it. A
 * batch without a session snapshot — the helper failed, or another
 * collector's batch — touches no candidate, so a helper outage never reads
 * as a disconnect.
 *
 * Privacy (SUBS-SESSION-004): only the client address, export path,
 * protocol version and lock count leave this module — never the hostname
 * enrichment, users, file names or RPC payloads.
 */

import type { ChangeCtx, Producer, Row, SnapshotCtx } from '../engine.js';
import { META_KEYS } from '../meta.js';

interface SessionView {
  clientAddr: string;
  exportPath: string;
  protoVersion: string | undefined;
  lockedFiles: number | null;
}

interface Candidate {
  kind: 'connect' | 'disconnect';
  /** The engine instance that created the candidate; absent on rows persisted before epochs existed. */
  epoch?: string;
  /** That instance's batch sequence; a later batch of the same instance, or any batch of another, confirms. */
  seq: number;
  view: SessionView;
}

type Candidates = Record<string, Candidate>;

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function sessionView(row: Row | null, id: string): SessionView | null {
  if (row === null) return null;
  const spec = asRecord(row.spec);
  const status = asRecord(row.status);
  const sep = id.indexOf(':');
  return {
    clientAddr:
      typeof spec.client_addr === 'string' ? spec.client_addr : sep > 0 ? id.slice(0, sep) : id,
    exportPath:
      typeof spec.export_path === 'string' ? spec.export_path : sep > 0 ? id.slice(sep + 1) : '',
    protoVersion: typeof status.proto_version === 'string' ? status.proto_version : undefined,
    lockedFiles:
      typeof status.locked_files === 'number' && Number.isFinite(status.locked_files)
        ? status.locked_files
        : null,
  };
}

const details = (v: SessionView, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  clientAddr: v.clientAddr,
  exportPath: v.exportPath,
  ...(v.protoVersion !== undefined ? { protoVersion: v.protoVersion } : {}),
  ...(v.lockedFiles !== null ? { lockedFiles: v.lockedFiles } : {}),
  ...extra,
});

const args = (v: SessionView): Record<string, string | number | undefined> => ({
  clientAddr: v.clientAddr,
  exportPath: v.exportPath,
  protoVersion: v.protoVersion,
  lockedFiles: v.lockedFiles ?? undefined,
});

function loadCandidates(ctx: ChangeCtx | SnapshotCtx): Candidates {
  return ctx.meta.get<Candidates>(META_KEYS.sessionCandidates) ?? {};
}

function saveCandidates(ctx: ChangeCtx | SnapshotCtx, c: Candidates): void {
  if (Object.keys(c).length === 0) ctx.meta.delete(META_KEYS.sessionCandidates);
  else ctx.meta.set(META_KEYS.sessionCandidates, c);
}

function onSessionChange(ctx: ChangeCtx): void {
  const { id } = ctx;
  const prev = sessionView(ctx.previous, id);
  const cur = sessionView(ctx.current, id);
  const subject = { kind: 'NfsSession' as const, id };

  if (cur === null) {
    if (prev === null) return;
    const candidates = loadCandidates(ctx);
    const existing = candidates[id];
    if (existing?.kind === 'connect') {
      // Gone before it was ever confirmed: never reported at all.
      delete candidates[id];
    } else {
      candidates[id] = {
        kind: 'disconnect',
        epoch: ctx.batch.epoch,
        seq: ctx.batch.seq,
        view: prev,
      };
    }
    saveCandidates(ctx, candidates);
    ctx.meta.delete(META_KEYS.lockThreshold(id));
    return;
  }

  if (prev === null) {
    const candidates = loadCandidates(ctx);
    if (candidates[id]?.kind === 'disconnect') {
      // Reappeared before the disconnect was confirmed: it never left.
      delete candidates[id];
      saveCandidates(ctx, candidates);
      return;
    }
    if (!ctx.baselineDone('NfsSession')) return;
    candidates[id] = { kind: 'connect', epoch: ctx.batch.epoch, seq: ctx.batch.seq, view: cur };
    saveCandidates(ctx, candidates);
    return;
  }

  if (
    prev.protoVersion !== undefined &&
    cur.protoVersion !== undefined &&
    prev.protoVersion !== cur.protoVersion
  ) {
    ctx.emit({
      feed: 'nfs/sessions',
      type: 'nfs.session.protocol_changed',
      subject,
      args: args(cur),
      previous: { proto_version: prev.protoVersion },
      current: { proto_version: cur.protoVersion },
      details: details(cur, { previousProtoVersion: prev.protoVersion }),
    });
  }

  const { enter, clear } = ctx.config.nfs_lock_threshold;
  if (enter > 0 && cur.lockedFiles !== null) {
    const key = META_KEYS.lockThreshold(id);
    const crossed = ctx.meta.get<boolean>(key) === true;
    if (!crossed && cur.lockedFiles >= enter) {
      ctx.emit({
        feed: 'nfs/sessions',
        type: 'nfs.session.lock_threshold_crossed',
        subject,
        args: { ...args(cur), threshold: enter },
        threshold: { metric: 'locked_files', value: cur.lockedFiles, unit: 'files', enter, clear },
        details: details(cur, { threshold: enter }),
      });
      ctx.meta.set(key, true);
    } else if (crossed && cur.lockedFiles < clear) {
      ctx.emit({
        feed: 'nfs/sessions',
        type: 'nfs.session.lock_threshold_cleared',
        subject,
        args: { ...args(cur), threshold: enter },
        threshold: { metric: 'locked_files', value: cur.lockedFiles, unit: 'files', enter, clear },
        previous: { severity: 'warning' },
        details: details(cur, { threshold: enter }),
      });
      ctx.meta.delete(key);
    }
  }
}

/** Confirm or cancel candidates against a complete snapshot from a later batch. */
function onSessionSnapshot(ctx: SnapshotCtx): void {
  const candidates = loadCandidates(ctx);
  let changed = false;
  for (const [id, c] of Object.entries(candidates)) {
    // Same batch of the same engine instance: not a second observation yet.
    // A candidate from another instance (the api restarted) or without an
    // epoch (persisted before epochs existed) is judged by this snapshot.
    if (c.epoch === ctx.batch.epoch && c.seq >= ctx.batch.seq) continue;
    const present = ctx.present.has(id);
    if (c.kind === 'connect' && present) {
      ctx.emit({
        feed: 'nfs/sessions',
        type: 'nfs.session.connected',
        subject: { kind: 'NfsSession', id },
        args: args(c.view),
        current: { proto_version: c.view.protoVersion },
        details: details(c.view),
      });
    } else if (c.kind === 'disconnect' && !present) {
      ctx.emit({
        feed: 'nfs/sessions',
        type: 'nfs.session.disconnected',
        subject: { kind: 'NfsSession', id },
        args: args(c.view),
        previous: { proto_version: c.view.protoVersion },
        reasonCode: 'reconcile_absent',
        details: details(c.view),
      });
    }
    delete candidates[id];
    changed = true;
  }
  if (changed) saveCandidates(ctx, candidates);
}

export const sessionsProducer: Producer = {
  kinds: ['NfsSession'],
  onChange: onSessionChange,
  onSnapshot: onSessionSnapshot,
};
