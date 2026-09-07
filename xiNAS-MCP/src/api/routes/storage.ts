import { Router } from 'express';
import { ApiException } from '../errors.js';
import {
  embedMetadata,
  getOrNull,
  listByPrefix,
  sendOk,
  unwrapResources,
} from '../handlers/reads.js';
import { degradedCollectorWarnings } from '../handlers/collector-health.js';
import type { ApiContext } from '../context.js';
import {
  BLOCK_SIZES,
  GROUP_SIZE_MAX,
  GROUP_SIZE_MIN,
  LEVELS,
  LEVEL_CONSTRAINTS,
  STRIP_SIZES_KIB,
  SYND_CNT_MAX,
  SYND_CNT_MIN,
} from '../../lib/xiraid/schema.js';
import { RAID_CREATE_APP_URI } from '../mcp/apps.js';

/** S18: server-owned wizard constraints; generated from the validator tables. */
export function raidCreateAppConfig(): Record<string, unknown> {
  return {
    app: 'raid_create',
    resource_uri: RAID_CREATE_APP_URI,
    levels: [...LEVELS],
    constraints: Object.fromEntries(
      LEVELS.map((level) => {
        const rule = LEVEL_CONSTRAINTS[level];
        return [
          level,
          {
            min_drives: rule.minDrives,
            even_members: rule.evenMembers === true,
            needs_group_size: rule.needsGroupSize,
            group_size_min: rule.groupSizeMin ?? GROUP_SIZE_MIN,
            group_size_max: GROUP_SIZE_MAX,
            needs_synd_cnt: rule.needsSyndCnt,
            synd_cnt_min: SYND_CNT_MIN,
            synd_cnt_max: SYND_CNT_MAX,
          },
        ];
      }),
    ),
    strip_sizes_kib: [...STRIP_SIZES_KIB],
    block_sizes: [...BLOCK_SIZES],
    defaults: { level: 'raid6', strip_size_kib: 128, block_size: 4096 },
    name: {
      pattern: '^[A-Za-z0-9_]{1,28}$',
      reserved: ['power', 'uevent'],
    },
    tools: {
      disks: 'disks.list',
      arrays: 'arrays.list',
      pools: 'pools.list',
      create: 'arrays.create',
      task_wait: 'tasks.wait',
    },
  };
}

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

  // S18: read-only bootstrap for the MCP RAID Create App. Inventory is read
  // through the ordinary tools so the View sees the same RBAC/audit surface
  // as every other client. This endpoint exposes only canonical constraints.
  r.get('/mcp/apps/raid-create', (req, res) => {
    sendOk(req, res, raidCreateAppConfig());
  });

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
      degradedCollectorWarnings(ctx, 'Disk'),
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
      degradedCollectorWarnings(ctx, 'XiraidArray'),
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
      degradedCollectorWarnings(ctx, 'Filesystem'),
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
