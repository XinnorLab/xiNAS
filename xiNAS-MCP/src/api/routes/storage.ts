import { Router } from 'express';
import { ApiException } from '../errors.js';
import {
  embedMetadata,
  getOrNull,
  listByPrefix,
  sendOk,
  unwrapResources,
} from '../handlers/reads.js';
import type { ApiContext } from '../context.js';

/**
 * Parse a boolean query param. Accepts the strings "true" / "false"
 * (case-insensitive); anything else throws INVALID_ARGUMENT. Per
 * OpenAPI: { type: boolean } query params are serialized as those
 * two strings.
 */
function parseBoolQuery(raw: unknown, name: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw new ApiException('INVALID_ARGUMENT', `query param '${name}' must be a single value`);
  }
  if (raw.toLowerCase() === 'true') return true;
  if (raw.toLowerCase() === 'false') return false;
  throw new ApiException(
    'INVALID_ARGUMENT',
    `query param '${name}' must be 'true' or 'false', got '${raw}'`,
  );
}

export function storageRouter(ctx: ApiContext): Router {
  const r = Router();

  r.get('/disks', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/observed/Disk/');
    // Per api-v1.yaml: optional safe_for_use boolean filter on
    // disk.status.safe_for_use.
    const safeForUse = parseBoolQuery(req.query.safe_for_use, 'safe_for_use');
    let values = unwrapResources(rows);
    if (safeForUse !== undefined) {
      values = values.filter((v) => {
        const status = (v as { status?: { safe_for_use?: boolean } }).status;
        return status?.safe_for_use === safeForUse;
      });
    }
    sendOk(
      req,
      res,
      values,
      rows.map((x) => x.revision),
    );
  });

  // S8 T5 (ADR-0010): single-disk read — covers the legacy
  // disk.get_smart (status.health is the S7 field; absent on hosts
  // whose probe does not report it).
  r.get('/disks/:id', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(
      ctx.state,
      `/xinas/v1/observed/Disk/${req.params.id}`,
    );
    if (row === null) {
      throw new ApiException('NOT_FOUND', `no such disk: ${req.params.id}`);
    }
    sendOk(req, res, row.value, [row.revision]);
  });

  r.get('/arrays', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(
      ctx.state,
      '/xinas/v1/observed/XiraidArray/',
    );
    sendOk(
      req,
      res,
      unwrapResources(rows),
      rows.map((x) => x.revision),
    );
  });

  r.get('/arrays/:id', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(
      ctx.state,
      `/xinas/v1/observed/XiraidArray/${req.params.id}`,
    );
    if (!row) throw new ApiException('NOT_FOUND', `array ${req.params.id} not found`);
    sendOk(req, res, embedMetadata(row), [row.revision]);
  });

  r.get('/filesystems', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/observed/Filesystem/');
    sendOk(
      req,
      res,
      unwrapResources(rows),
      rows.map((x) => x.revision),
    );
  });

  r.get('/filesystems/:id', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(
      ctx.state,
      `/xinas/v1/observed/Filesystem/${req.params.id}`,
    );
    if (!row) throw new ApiException('NOT_FOUND', `filesystem ${req.params.id} not found`);
    sendOk(req, res, embedMetadata(row), [row.revision]);
  });

  return r;
}
