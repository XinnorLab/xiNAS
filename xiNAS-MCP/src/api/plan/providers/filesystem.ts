/**
 * S5 filesystem plan providers (ADR-0007 / s5-filesystem-spec §4):
 * fs.create here in T7; mount/unmount/grow/set_quota_mode/delete join in
 * T9–T11 sharing `gatherFsFacts`.
 *
 * The route injects the path id into PATCH/DELETE specs (the S4 modify
 * pattern); create derives its own id from the mountpoint. Enriched specs
 * carry the fully-resolved executor inputs so the agent needs no KV.
 */

import { type BackingArraySpec, deriveStripe } from '../../../lib/fs/derive.js';
import { buildMkfsArgs, humanToBytes } from '../../../lib/fs/mkfs.js';
import { renderMountUnit, unitNameForMountpoint } from '../../../lib/fs/unit.js';
import {
  type FsCreateFacts,
  isUnderPath,
  parseFsCreateSpec,
  validateFsCreate,
  validateFsGrow,
  validateFsMount,
  validateFsUnmanage,
  validateFsUnmount,
} from '../../../lib/fs/validate.js';
import { ApiException } from '../../errors.js';
import type { ResourceRef } from '../../tasks/types.js';
import type { PlanContext, PlanProvider, PlanResult } from '../engine.js';

interface ObservedArrayRow {
  spec?: {
    name?: string;
    level?: string;
    member_disk_ids?: string[];
    strip_size_kib?: number | null;
    group_size?: number | null;
    synd_cnt?: number | null;
  };
  status?: { volume_path?: string; state?: string };
}

interface ObservedFsRow {
  id?: string;
  status?: { mountpoint?: string; backing_device?: string; mounted?: boolean };
}

interface DesiredShareRow {
  id?: string;
  spec?: { path?: string };
}

interface ObservedSessionRow {
  id?: string;
  spec?: { export_path?: string };
}

export interface FsFacts {
  arraysByVolume: Map<string, BackingArraySpec & { name: string; state?: string }>;
  filesystems: Array<{
    id: string;
    mountpoint?: string;
    backing_device?: string;
    mounted?: boolean;
  }>;
  sessions: Array<{ id: string; export_path: string }>;
  /** Real absolute export paths from observed ExportRule rows. The OBSERVED
   *  id is encExportId(path) (N0b — the raw path would fail the id guard);
   *  the real path lives in spec.export_path, which is what we read. */
  exportPaths: string[];
  desiredShares: Array<{ id: string; path: string }>;
}

export function gatherFsFacts(ctx: PlanContext): FsFacts {
  const arraysByVolume = new Map<string, BackingArraySpec & { name: string; state?: string }>();
  for (const row of ctx.kv.list<ObservedArrayRow>({ prefix: '/xinas/v1/observed/XiraidArray/' })) {
    const s = row.value.spec;
    const volume = row.value.status?.volume_path;
    if (typeof s?.name !== 'string' || typeof volume !== 'string') continue;
    arraysByVolume.set(volume, {
      name: s.name,
      level: s.level ?? 'unknown',
      member_disk_ids: s.member_disk_ids ?? [],
      ...(s.strip_size_kib !== undefined ? { strip_size_kib: s.strip_size_kib } : {}),
      ...(s.group_size !== undefined ? { group_size: s.group_size } : {}),
      ...(s.synd_cnt !== undefined ? { synd_cnt: s.synd_cnt } : {}),
      ...(row.value.status?.state !== undefined ? { state: row.value.status.state } : {}),
    });
  }

  const filesystems: FsFacts['filesystems'] = [];
  for (const row of ctx.kv.list<ObservedFsRow>({ prefix: '/xinas/v1/observed/Filesystem/' })) {
    if (typeof row.value.id !== 'string') continue;
    filesystems.push({
      id: row.value.id,
      ...(row.value.status?.mountpoint !== undefined
        ? { mountpoint: row.value.status.mountpoint }
        : {}),
      ...(row.value.status?.backing_device !== undefined
        ? { backing_device: row.value.status.backing_device }
        : {}),
      ...(row.value.status?.mounted !== undefined ? { mounted: row.value.status.mounted } : {}),
    });
  }

  const sessions: FsFacts['sessions'] = [];
  for (const row of ctx.kv.list<ObservedSessionRow>({ prefix: '/xinas/v1/observed/NfsSession/' })) {
    const exportPath = row.value.spec?.export_path;
    if (typeof row.value.id !== 'string' || typeof exportPath !== 'string') continue;
    sessions.push({ id: row.value.id, export_path: exportPath });
  }

  const exportPaths: string[] = [];
  for (const row of ctx.kv.list<{ spec?: { export_path?: string } }>({
    prefix: '/xinas/v1/observed/ExportRule/',
  })) {
    const path = row.value.spec?.export_path;
    if (typeof path === 'string') exportPaths.push(path);
  }

  const desiredShares: FsFacts['desiredShares'] = [];
  for (const row of ctx.kv.list<DesiredShareRow>({ prefix: '/xinas/v1/desired/Share/' })) {
    const path = row.value.spec?.path;
    if (typeof row.value.id !== 'string' || typeof path !== 'string') continue;
    desiredShares.push({ id: row.value.id, path });
  }

  return { arraysByVolume, filesystems, sessions, exportPaths, desiredShares };
}

export const fsCreateProvider: PlanProvider = {
  operation_kind: 'fs.create',

  async preflight(ctx: PlanContext, rawSpec: unknown): Promise<PlanResult> {
    let spec: ReturnType<typeof parseFsCreateSpec>;
    try {
      spec = parseFsCreateSpec(rawSpec);
    } catch (err) {
      throw new ApiException(
        'INVALID_ARGUMENT',
        err instanceof Error ? err.message : String(err),
        undefined,
        'Send a create-shaped spec: { backing_device, mountpoint, ... } per ADR-0007.',
      );
    }

    const facts = gatherFsFacts(ctx);
    const createFacts: FsCreateFacts = {
      arraysByVolume: facts.arraysByVolume,
      filesystems: facts.filesystems,
    };
    const blockers = validateFsCreate(spec, createFacts);

    // --- resolve the executor inputs (ADR-0007 §Schema extension) ---
    const unitName = unitNameForMountpoint(spec.mountpoint);
    const leaf = spec.mountpoint.split('/').filter(Boolean).pop() ?? 'fs';
    const label = spec.label ?? leaf;
    const backing = facts.arraysByVolume.get(spec.backing_device);
    const derived = backing ? deriveStripe(backing) : undefined;
    const suKb = spec.su_kb ?? derived?.su_kb;
    const sw = spec.sw ?? derived?.sw;
    const sectorSize = spec.sector_size ?? 4096;
    const logSizeBytes =
      spec.log_size !== undefined && spec.log_size !== null
        ? humanToBytes(spec.log_size)
        : undefined;

    const resolved =
      suKb !== undefined && sw !== undefined
        ? {
            device: spec.backing_device,
            label,
            su_kb: suKb,
            sw,
            sector_size: sectorSize,
            ...(spec.log_device !== undefined && spec.log_device !== null
              ? { log_device: spec.log_device }
              : {}),
            ...(logSizeBytes !== undefined ? { log_size_bytes: logSizeBytes } : {}),
          }
        : undefined;

    const affected: ResourceRef[] = [
      { kind: 'Filesystem', id: unitName },
      ...(backing ? [{ kind: 'XiraidArray', id: backing.name } as ResourceRef] : []),
      ...(spec.log_device !== undefined && spec.log_device !== null
        ? (() => {
            const logArray = facts.arraysByVolume.get(spec.log_device);
            return logArray ? [{ kind: 'XiraidArray', id: logArray.name } as ResourceRef] : [];
          })()
        : []),
    ];

    const unitText = renderMountUnit({
      what: spec.backing_device,
      where: spec.mountpoint,
      ...(spec.log_device !== undefined && spec.log_device !== null
        ? { log_device: spec.log_device }
        : {}),
      ...(spec.mount_options !== undefined ? { mount_options: spec.mount_options } : {}),
      ...(spec.quota_mode !== undefined ? { quota_mode: spec.quota_mode } : {}),
    });

    const destructive = spec.force === true;
    return {
      affected_resources: affected,
      blockers,
      warnings: [],
      diff: {
        summary: `mkfs.xfs on ${spec.backing_device}, mounted at ${spec.mountpoint} via ${unitName}`,
        ...(resolved !== undefined
          ? {
              // The executor clamps log size to blockdev --getsize64 at run
              // time (the day-1 _effective_log_size formula); this preview
              // shows the UNCLAMPED request.
              mkfs_argv_preview: buildMkfsArgs(resolved),
            }
          : {}),
        mount_unit: unitText,
      },
      risk_level: destructive ? 'destructive' : 'non_disruptive',
      rollback_model: destructive ? 'unsupported' : 'non_disruptive',
      enriched_spec: {
        ...spec,
        unit_name: unitName,
        ...(resolved !== undefined ? { resolved } : {}),
        unit_text: unitText,
      },
    };
  },
};

// ---- shared helpers for the id-addressed ops (T9–T11) ----

interface FsRowFacts {
  facts: FsFacts;
  row: { id: string; mountpoint?: string; backing_device?: string; mounted?: boolean };
  mountpoint: string;
  backingArray: (BackingArraySpec & { name: string; state?: string }) | undefined;
}

/**
 * Resolve the target observed Filesystem row for an id-addressed op.
 * Absent row → NOT_FOUND; a pre-normalization row without a mountpoint
 * cannot be operated on → FAILED_PRECONDITION (resolves on the next
 * collector sweep).
 */
function requireFsRow(ctx: PlanContext, rawSpec: unknown, op: string): FsRowFacts {
  if (
    typeof rawSpec !== 'object' ||
    rawSpec === null ||
    typeof (rawSpec as { id?: unknown }).id !== 'string'
  ) {
    throw new ApiException(
      'INVALID_ARGUMENT',
      `${op} spec must carry the target filesystem id`,
      undefined,
      'PATCH/DELETE /filesystems/{id} injects the id from the path.',
    );
  }
  const id = (rawSpec as { id: string }).id;
  const facts = gatherFsFacts(ctx);
  const row = facts.filesystems.find((f) => f.id === id);
  if (!row) {
    throw new ApiException(
      'NOT_FOUND',
      `filesystem ${id} not found in observed state`,
      undefined,
      'GET /filesystems lists the observed mount units.',
    );
  }
  if (row.mountpoint === undefined) {
    throw new ApiException(
      'PRECONDITION_FAILED',
      `observed row for ${id} carries no mountpoint yet (pre-normalization sweep)`,
      { reason: 'fs_observation_incomplete' },
      'Wait for the next agent observation sweep, then re-plan.',
    );
  }
  const backingArray =
    row.backing_device !== undefined ? facts.arraysByVolume.get(row.backing_device) : undefined;
  return { facts, row, mountpoint: row.mountpoint, backingArray };
}

function fsAffected(row: FsRowFacts): ResourceRef[] {
  return [
    { kind: 'Filesystem', id: row.row.id },
    ...(row.backingArray
      ? [{ kind: 'XiraidArray', id: row.backingArray.name } as ResourceRef]
      : []),
  ];
}

/**
 * fs.mount (PATCH {mounted:true}) — enable --now the existing unit.
 * Blocked only by a FAILED backing array; mounting an already-mounted
 * filesystem is an idempotent no-op (warning, not blocker).
 */
export const fsMountProvider: PlanProvider = {
  operation_kind: 'fs.mount',

  async preflight(ctx: PlanContext, rawSpec: unknown): Promise<PlanResult> {
    const r = requireFsRow(ctx, rawSpec, 'fs.mount');
    const blockers = validateFsMount({ arrayState: r.backingArray?.state });
    const warnings =
      r.row.mounted === true
        ? [{ code: 'fs_already_mounted', message: `${r.row.id} is already mounted (no-op apply)` }]
        : [];
    return {
      affected_resources: fsAffected(r),
      blockers,
      warnings,
      diff: { summary: `systemctl enable --now ${r.row.id} (${r.mountpoint})` },
      risk_level: 'non_disruptive',
      rollback_model: 'non_disruptive',
      enriched_spec: { id: r.row.id, mounted: true, mountpoint: r.mountpoint },
    };
  },
};

/**
 * fs.unmount (PATCH {mounted:false}) — stop + disable the unit. The WS6
 * milestone blockers live here: active NFS sessions under the
 * mountpoint AND exported paths under it both block; dependent desired
 * Shares are surfaced as the blast radius.
 */
export const fsUnmountProvider: PlanProvider = {
  operation_kind: 'fs.unmount',

  async preflight(ctx: PlanContext, rawSpec: unknown): Promise<PlanResult> {
    const r = requireFsRow(ctx, rawSpec, 'fs.unmount');
    const sessionsUnder = r.facts.sessions.filter((s) => isUnderPath(s.export_path, r.mountpoint));
    const exportsUnder = r.facts.exportPaths.filter((p) => isUnderPath(p, r.mountpoint));
    const blockers = validateFsUnmount({ sessionsUnder, exportsUnder });
    const blastRadius = r.facts.desiredShares.filter((s) => isUnderPath(s.path, r.mountpoint));
    const warnings =
      r.row.mounted === false
        ? [
            {
              code: 'fs_already_unmounted',
              message: `${r.row.id} is already unmounted (apply only disables the unit)`,
            },
          ]
        : [];
    return {
      affected_resources: fsAffected(r),
      blockers,
      warnings,
      diff: {
        summary: `systemctl stop+disable ${r.row.id} (${r.mountpoint})`,
        blast_radius: blastRadius.map((s) => ({ kind: 'Share', id: s.id, path: s.path })),
      },
      risk_level: 'changing_access',
      rollback_model: 'non_disruptive',
      enriched_spec: { id: r.row.id, mounted: false, mountpoint: r.mountpoint },
    };
  },
};

/**
 * fs.grow (PATCH {grow:true}) — xfs_growfs to the (already grown)
 * backing device. Requires the filesystem mounted; irreversible (XFS
 * cannot shrink) → rollback_model 'unsupported', risk non_disruptive
 * (online grow).
 */
export const fsGrowProvider: PlanProvider = {
  operation_kind: 'fs.grow',

  async preflight(ctx: PlanContext, rawSpec: unknown): Promise<PlanResult> {
    const r = requireFsRow(ctx, rawSpec, 'fs.grow');
    const blockers = validateFsGrow({ mounted: r.row.mounted === true });
    return {
      affected_resources: fsAffected(r),
      blockers,
      warnings: [],
      diff: { summary: `xfs_growfs ${r.mountpoint}` },
      risk_level: 'non_disruptive',
      rollback_model: 'unsupported',
      enriched_spec: { id: r.row.id, grow: true, mountpoint: r.mountpoint },
    };
  },
};

/**
 * fs.set_quota_mode (PATCH {quota_mode}) — rewrite the unit's Options=
 * quota flag and remount. Client-visible (the remount) → 'changing_access';
 * rollback restores the captured pre-task unit text.
 */
export const fsSetQuotaModeProvider: PlanProvider = {
  operation_kind: 'fs.set_quota_mode',

  async preflight(ctx: PlanContext, rawSpec: unknown): Promise<PlanResult> {
    const r = requireFsRow(ctx, rawSpec, 'fs.set_quota_mode');
    const mode = (rawSpec as { quota_mode?: unknown }).quota_mode;
    if (mode !== 'none' && mode !== 'uquota' && mode !== 'gquota' && mode !== 'pquota') {
      throw new ApiException(
        'INVALID_ARGUMENT',
        `quota_mode must be one of none, uquota, gquota, pquota (got ${String(mode)})`,
        undefined,
        'Send PATCH { spec: { quota_mode: "pquota" } }.',
      );
    }
    return {
      affected_resources: fsAffected(r),
      blockers: [],
      warnings: [
        {
          code: 'remount_required',
          message: `${r.row.id} will be remounted to apply ${mode} — connected clients see a pause`,
        },
      ],
      diff: { summary: `rewrite ${r.row.id} Options= quota flag to ${mode}, remount` },
      risk_level: 'changing_access',
      rollback_model: 'non_disruptive',
      enriched_spec: { id: r.row.id, quota_mode: mode, mountpoint: r.mountpoint },
    };
  },
};

/**
 * fs.unmanage (DELETE /filesystems/{id}) — remove the .mount unit, data
 * untouched (ADR-0007: DELETE never destroys; the only destruction path
 * is create force:true). Blocked while mounted; non-destructive, so the
 * dangerous flag is NOT required.
 */
export const fsUnmanageProvider: PlanProvider = {
  operation_kind: 'fs.unmanage',

  async preflight(ctx: PlanContext, rawSpec: unknown): Promise<PlanResult> {
    const r = requireFsRow(ctx, rawSpec, 'fs.unmanage');
    const blockers = validateFsUnmanage({ mounted: r.row.mounted === true });
    return {
      affected_resources: fsAffected(r),
      blockers,
      warnings: [
        {
          code: 'data_left_in_place',
          message: `${r.row.id} is removed from management only — the filesystem on ${r.row.backing_device ?? 'the device'} is untouched and re-adoptable via observe`,
        },
      ],
      diff: { summary: `remove ${r.row.id} (disable + rm + daemon-reload); data untouched` },
      risk_level: 'non_disruptive',
      rollback_model: 'non_disruptive',
      enriched_spec: { id: r.row.id, mountpoint: r.mountpoint },
    };
  },
};
