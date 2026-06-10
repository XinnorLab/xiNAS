import { Router } from 'express';
import { observedSegment } from '../../agent/collectors/base.js';
import { encExportId } from '../../lib/nfs-export-id.js';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';
import {
  embedMetadata,
  getOrNull,
  listByPrefix,
  sendOk,
  unwrapResources,
} from '../handlers/reads.js';

/**
 * Read-time join: for a desired Share, look up the observed ExportRule
 * whose spec.export_path matches the share's spec.path and set
 * status.exports to that rule's status.rules[] (or [] if none). ExportRule
 * is an internal observed kind (no public endpoint of its own); this is the
 * only place it surfaces. Returns a new object — does not mutate the row,
 * and is safe when the desired Share has no status field.
 *
 * JOIN KEY: the desired Share has no `export_path` field — the api-v1.yaml
 * Share schema requires [path, clients, fsid]; `path` IS the exported
 * directory that lands in /etc/exports. The agent stamps that same directory
 * onto the observed ExportRule/NfsSession as `spec.export_path`. So the
 * correct join is `share.spec.path === exportRule.spec.export_path`. (The
 * plan flagged this spec.path-vs-export_path trap twice; the original impl
 * keyed off the non-existent `share.spec.export_path` and so returned [] for
 * every real Share.)
 *
 * LOOKUP: the observed ExportRule is keyed by encExportId(export_path) (N0b.2 —
 * the raw absolute path has a leading `/` and fails isValidObservedId), so we
 * resolve it with a single keyed getOrNull using the SAME encoding applied to
 * the share's path. Encoding both sides canonicalizes them, so this is robust to
 * `//` / trailing-slash skew. If the share path can't be encoded (e.g. the bare
 * root `/`), treat it as no exports rather than throwing the read.
 */
function joinExports(
  state: ApiContext['state'],
  share: Record<string, unknown>,
): Record<string, unknown> {
  const shareSpec = share.spec as Record<string, unknown> | undefined;
  const exportPath = shareSpec?.path as string | undefined;

  let exports: unknown[] = [];
  if (exportPath) {
    let key: string | null = null;
    try {
      key = `/xinas/v1/observed/ExportRule/${encExportId(exportPath)}`;
    } catch {
      key = null; // unencodable share path → no exports.
    }
    const match = key ? getOrNull<Record<string, unknown>>(state, key) : null;
    if (match) {
      const ruleStatus = match.value.status as Record<string, unknown> | undefined;
      exports = (ruleStatus?.rules as unknown[]) ?? [];
    }
  }

  const existingStatus = (share.status ?? {}) as Record<string, unknown>;
  return { ...share, status: { ...existingStatus, exports } };
}

/**
 * Read-time status fold (N7.2): merge the observed NfsProfile row's
 * status.effective_files + status.observed_at into the rendered desired
 * profile's status. The observed row is the NfsProfileCollector's singleton —
 * same id as the desired profile ('default'), keyed at
 * /xinas/v1/observed/<segment>/<id> where the segment is derived through
 * observedSegment('NfsProfile') so this reader can never disagree with the
 * H3 observed write path. status.running stays deferred beyond S3.
 *
 * Absent or malformed observed row → the profile is returned unchanged
 * (existing desired-only behavior). When both sides carry one of the two
 * folded keys, observed wins; all other desired status fields are preserved.
 */
function foldObservedProfileStatus(
  state: ApiContext['state'],
  profile: Record<string, unknown>,
): Record<string, unknown> {
  const id = profile.id;
  if (typeof id !== 'string') return profile;

  const row = getOrNull<Record<string, unknown>>(
    state,
    `/xinas/v1/observed/${observedSegment('NfsProfile')}/${id}`,
  );
  if (!row || row.value === null || typeof row.value !== 'object') return profile;

  const observedStatus = (row.value as Record<string, unknown>).status;
  if (observedStatus === null || typeof observedStatus !== 'object') return profile;
  const s = observedStatus as Record<string, unknown>;

  const fold: Record<string, unknown> = {};
  if (s.effective_files !== null && typeof s.effective_files === 'object') {
    fold.effective_files = s.effective_files;
  }
  if (typeof s.observed_at === 'string') fold.observed_at = s.observed_at;
  if (Object.keys(fold).length === 0) return profile;

  const existingStatus = (profile.status ?? {}) as Record<string, unknown>;
  return { ...profile, status: { ...existingStatus, ...fold } };
}

export function nfsRouter(ctx: ApiContext): Router {
  const r = Router();

  r.get('/shares', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/desired/Share/');
    sendOk(
      req,
      res,
      unwrapResources(rows).map((s) => joinExports(ctx.state, s)),
      rows.map((x) => x.revision),
    );
  });

  r.get('/shares/:id', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(
      ctx.state,
      `/xinas/v1/desired/Share/${req.params.id}`,
    );
    if (!row) throw new ApiException('NOT_FOUND', `share ${req.params.id} not found`);
    sendOk(req, res, joinExports(ctx.state, embedMetadata(row)), [row.revision]);
  });

  r.get('/shares/:id/sessions', (req, res) => {
    // The Share itself lives in desired state (same prefix the list/get
    // handlers read). 404 if it doesn't exist.
    const shareRow = getOrNull<Record<string, unknown>>(
      ctx.state,
      `/xinas/v1/desired/Share/${req.params.id}`,
    );
    if (!shareRow) throw new ApiException('NOT_FOUND', `share ${req.params.id} not found`);

    // Sessions are observed NfsSession entries (pushed by the agent). Filter
    // the full observed set to those whose spec.export_path matches this
    // share's spec.path (the exported directory — see joinExports for why the
    // Share side keys off `path`, not a non-existent `export_path`). A
    // defensive client_addr type guard skips any malformed observed row.
    const shareSpec = shareRow.value.spec as Record<string, unknown> | undefined;
    const exportPath = shareSpec?.path as string | undefined;
    const sessions = listByPrefix<Record<string, unknown>>(
      ctx.state,
      '/xinas/v1/observed/NfsSession/',
    ).filter((row) => {
      const spec = row.value.spec as Record<string, unknown> | undefined;
      return typeof spec?.client_addr === 'string' && spec?.export_path === exportPath;
    });

    sendOk(
      req,
      res,
      unwrapResources(sessions),
      sessions.map((row) => row.revision),
    );
  });

  r.get('/nfs-profiles', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/desired/NfsProfile/');
    sendOk(
      req,
      res,
      unwrapResources(rows).map((p) => foldObservedProfileStatus(ctx.state, p)),
      rows.map((x) => x.revision),
    );
  });

  r.get('/nfs-profiles/:id', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(
      ctx.state,
      `/xinas/v1/desired/NfsProfile/${req.params.id}`,
    );
    if (!row) throw new ApiException('NOT_FOUND', `nfs profile ${req.params.id} not found`);
    sendOk(req, res, foldObservedProfileStatus(ctx.state, embedMetadata(row)), [row.revision]);
  });

  r.get('/export-groups', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/desired/ExportGroup/');
    sendOk(
      req,
      res,
      unwrapResources(rows),
      rows.map((x) => x.revision),
    );
  });

  return r;
}
