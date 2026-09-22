/**
 * S20 placement graph — pure.
 *
 * Turns one collection cycle's raw inputs (xiRAID arrays, managed
 * filesystems, `/etc/exports` rules, the nfs-server unit, nfsd versions)
 * into the `shares[]` / `resources[]` of the placement-observations result
 * (docs/control-path/s20-placement-observations-spec.md §4.5). No I/O and no
 * clocks: every timestamp and monotonic stamp comes in through the inputs,
 * so the graph rules are testable as a function.
 *
 * Reason codes are enums (spec §8): nothing here copies command output or
 * free text into the result.
 */

export type CollectionStatus = 'SUCCESS' | 'ERROR' | 'UNKNOWN';
export type ResourceKind = 'ARRAY' | 'FILESYSTEM' | 'EXPORT' | 'NFS_SERVICE';
export type SnapshotStatus = 'COMPLETE' | 'PARTIAL' | 'FAILED';

/** One input source's outcome for the cycle. */
export type Source<T> =
  | { ok: true; value: T; observed_at: string; mono_ms: number }
  | { ok: false; reason: 'COLLECTION_FAILED' | 'COLLECTION_TIMEOUT' };

export interface MemberInput {
  index: number;
  /** null when the daemon entry carried no readable path (parse/raid S20). */
  device_path: string | null;
  /** Control-path Disk id when the disk map knows the path. */
  disk_id?: string;
  raw_states: string[];
  state_valid: boolean;
}

export interface ArrayInput {
  name: string;
  raid_level: string;
  volume_path: string;
  raw_states: string[];
  state_valid: boolean;
  members: MemberInput[];
}

export interface FilesystemInput {
  /** The Filesystem row id (mount unit name) — stable across reboots. */
  id: string;
  mountpoint: string;
  /** The unit's What=. */
  backing_device: string;
  fs_type?: string;
  /** The unit's Options=. */
  mount_options: string[];
  /** Absent when mountinfo was unreadable (SRC-14). */
  mounted?: boolean;
  mountinfo_readable: boolean;
  /** Mount-table facts, present on an exact mountpoint+source match only. */
  mount_source?: string;
  super_options?: string[];
  effective_mount_options?: string[];
  /** The mountpoint is served by this OTHER device (probe S20). */
  mount_source_mismatch?: string;
  /** XFS UUID from the slow (60 s) sweep's blkid, when known. */
  uuid?: string;
}

export interface ExportRuleInput {
  host_pattern: string;
  options: string[];
}

export interface ExportInput {
  export_path: string;
  rules: ExportRuleInput[];
}

export interface NfsServiceInput {
  /** systemd ActiveState, or null when the unit state could not be read. */
  active_state: string | null;
  sub_state?: string;
}

export interface GraphInputs {
  arrays: Source<ArrayInput[]>;
  filesystems: Source<FilesystemInput[]>;
  exports: Source<ExportInput[]>;
  nfs_service: Source<NfsServiceInput>;
  /** parseNfsdVersions output (`['3', '4.0', '4.1', '4.2']` subset). */
  nfsd_versions: Source<string[]>;
  /** null when the package version could not be determined. */
  xiraid_version: { version: string; build: string } | null;
}

export interface PlacementResource {
  id: string;
  incarnation: string;
  collection_status: CollectionStatus;
  observed_at: string | null;
  /** Agent monotonic stamp of the evidence; the api turns it into an age. */
  observed_mono_ms: number | null;
  reason_codes: string[];
  details: Record<string, unknown> & { kind: ResourceKind };
}

export interface PlacementShare {
  share_id: string;
  incarnation: string;
  export_path: string;
  collection_status: CollectionStatus;
  observed_at: string | null;
  observed_mono_ms: number | null;
  filesystem_ref: string | null;
  export_ref: string | null;
  service_ref: string | null;
  reason_codes: string[];
}

export interface PlacementGraph {
  snapshot_status: SnapshotStatus;
  shares: PlacementShare[];
  resources: PlacementResource[];
}

export const NFS_SERVICE_RESOURCE_ID = 'nfs:nfs-server';

/** `encExportId`-style id for an export path; the caller supplies the encoder. */
export type ExportIdEncoder = (path: string) => string;

/**
 * The managed filesystem with the LONGEST mountpoint that contains `path`
 * by path segment (spec §4.5 rule 1). `/mnt/data` contains `/mnt/data/x`
 * and `/mnt/data` itself, never `/mnt/data2`.
 */
export function containingFilesystem<T extends { mountpoint: string }>(
  path: string,
  filesystems: readonly T[],
): T | undefined {
  let best: T | undefined;
  for (const fs of filesystems) {
    const mp = fs.mountpoint;
    if (mp.length === 0) continue;
    const contains = path === mp || (mp === '/' ? path.startsWith('/') : path.startsWith(`${mp}/`));
    if (contains && (best === undefined || mp.length > best.mountpoint.length)) best = fs;
  }
  return best;
}

function superOption(superOptions: readonly string[] | undefined, key: string): string | undefined {
  if (superOptions === undefined) return undefined;
  const prefix = `${key}=`;
  const hit = superOptions.find((o) => o.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

function ruleValue(options: readonly string[], key: string): string | undefined {
  const prefix = `${key}=`;
  const hit = options.find((o) => o.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

function failedResource(
  id: string,
  kind: ResourceKind,
  reason: string,
  extra: Record<string, unknown> = {},
): PlacementResource {
  return {
    id,
    incarnation: '-',
    collection_status: 'ERROR',
    observed_at: null,
    observed_mono_ms: null,
    reason_codes: [reason],
    details: { kind, ...extra },
  };
}

function sourceReason(src: { ok: false; reason: string }, failed: string): string {
  return src.reason === 'COLLECTION_TIMEOUT' ? 'COLLECTION_TIMEOUT' : failed;
}

function arrayResources(
  arrays: Source<ArrayInput[]>,
  version: GraphInputs['xiraid_version'],
): { resources: PlacementResource[]; byVolumePath: Map<string, PlacementResource> } {
  const byVolumePath = new Map<string, PlacementResource>();
  if (!arrays.ok) {
    return {
      resources: [
        failedResource(
          'array:unavailable',
          'ARRAY',
          sourceReason(arrays, 'XIRAID_DAEMON_UNAVAILABLE'),
        ),
      ],
      byVolumePath,
    };
  }
  const resources: PlacementResource[] = [];
  for (const a of arrays.value) {
    const reasons: string[] = [];
    let status: CollectionStatus = 'SUCCESS';
    if (!a.state_valid) reasons.push('ARRAY_STATE_INVALID');
    if (a.members.some((m) => m.device_path === null)) {
      status = 'UNKNOWN';
      reasons.push('MEMBER_DEVICE_UNRESOLVED');
    }
    if (version === null) reasons.push('XIRAID_VERSION_UNAVAILABLE');
    const res: PlacementResource = {
      id: `array:${a.name}`,
      incarnation: `${a.name}:${a.volume_path}:${a.raid_level}:${a.members.length}`,
      collection_status: status,
      observed_at: arrays.observed_at,
      observed_mono_ms: arrays.mono_ms,
      reason_codes: reasons,
      details: {
        kind: 'ARRAY',
        name: a.name,
        volume_path: a.volume_path,
        edition: 'Classic',
        version: version?.version ?? 'unknown',
        build: version?.build ?? 'unknown',
        raid_level: a.raid_level,
        state_valid: a.state_valid,
        raw_states: a.raw_states,
        members: a.members.map((m) => ({
          id: m.disk_id ?? m.device_path ?? `member:${m.index}`,
          index: m.index,
          group: null,
          device_path: m.device_path ?? '-',
          state_valid: m.state_valid,
          raw_states: m.raw_states,
        })),
      },
    };
    resources.push(res);
    byVolumePath.set(a.volume_path, res);
  }
  return { resources, byVolumePath };
}

function filesystemResource(
  fs: FilesystemInput,
  src: { observed_at: string; mono_ms: number },
  arrays: Source<ArrayInput[]>,
  arrayByVolumePath: ReadonlyMap<string, PlacementResource>,
): PlacementResource {
  const reasons: string[] = [];
  let status: CollectionStatus = 'SUCCESS';
  const unknown = (reason: string): void => {
    status = 'UNKNOWN';
    reasons.push(reason);
  };

  const uuid = fs.uuid ?? fs.id;
  if (fs.uuid === undefined) reasons.push('FS_UUID_UNAVAILABLE');
  const sourceDevice = fs.mount_source ?? fs.backing_device;
  const mounted: boolean | null = fs.mountinfo_readable ? (fs.mounted ?? false) : null;
  const effective = fs.effective_mount_options;
  const writable: boolean | null =
    mounted === true && effective !== undefined
      ? effective.includes('ro')
        ? false
        : effective.includes('rw')
          ? true
          : null
      : null;

  if (!fs.mountinfo_readable) unknown('MOUNTINFO_UNREADABLE');
  if (fs.mount_source_mismatch !== undefined) unknown('MOUNT_SOURCE_MISMATCH');
  if ((fs.fs_type ?? 'xfs') !== 'xfs') unknown('FS_TYPE_UNSUPPORTED');

  // Array references (spec §4.5 rule 2).
  const arrayRefs: Array<{ role: 'DATA' | 'LOG' | 'REALTIME'; resource_id: string }> = [];
  let externalResolved = true;
  let logMode: 'INTERNAL' | 'EXTERNAL' | 'UNKNOWN' = 'UNKNOWN';
  if (!arrays.ok) {
    unknown('DEPENDENCY_ARRAY_UNAVAILABLE');
  } else {
    const data = arrayByVolumePath.get(sourceDevice);
    if (data === undefined) unknown('DATA_ARRAY_UNRESOLVED');
    else arrayRefs.push({ role: 'DATA', resource_id: data.id });

    const logdev = superOption(fs.super_options, 'logdev');
    const rtdev = superOption(fs.super_options, 'rtdev');
    if (mounted === true) {
      if (logdev === undefined) logMode = 'INTERNAL';
      else {
        logMode = 'EXTERNAL';
        const log = arrayByVolumePath.get(logdev);
        if (log === undefined) externalResolved = false;
        else arrayRefs.push({ role: 'LOG', resource_id: log.id });
      }
      if (rtdev !== undefined) {
        const rt = arrayByVolumePath.get(rtdev);
        if (rt === undefined) externalResolved = false;
        else arrayRefs.push({ role: 'REALTIME', resource_id: rt.id });
      }
    }
    if (!externalResolved) reasons.push('EXTERNAL_DEVICE_UNRESOLVED');
  }

  return {
    id: `fs:${fs.id}`,
    incarnation: `${uuid}:${sourceDevice}`,
    collection_status: status,
    observed_at: src.observed_at,
    observed_mono_ms: src.mono_ms,
    reason_codes: reasons,
    details: {
      kind: 'FILESYSTEM',
      uuid,
      incarnation: `${uuid}:${sourceDevice}`,
      mountpoint: fs.mountpoint,
      source_device: sourceDevice,
      fs_type: fs.fs_type ?? 'xfs',
      mounted,
      writable,
      mount_options: mounted === true && effective !== undefined ? effective : fs.mount_options,
      super_options: fs.super_options ?? [],
      external_dependencies_resolved: externalResolved,
      array_refs: arrayRefs,
      log_mode: logMode,
      ...(fs.mount_source_mismatch !== undefined
        ? { mount_source_mismatch: fs.mount_source_mismatch }
        : {}),
    },
  };
}

function exportResource(
  e: ExportInput,
  id: string,
  src: { observed_at: string; mono_ms: number },
): PlacementResource {
  return {
    id,
    incarnation: `${id}:${ruleValue(e.rules[0]?.options ?? [], 'fsid') ?? 'none'}`,
    collection_status: 'SUCCESS',
    observed_at: src.observed_at,
    observed_mono_ms: src.mono_ms,
    reason_codes: [],
    details: {
      kind: 'EXPORT',
      export_path: e.export_path,
      present: true,
      // Prototype (spec §6): rules come from /etc/exports, not from the
      // kernel's etab — labelled so the connector can treat it as
      // desired-not-effective.
      source: '/etc/exports',
      rules: e.rules.map((r) => ({
        client: r.host_pattern,
        // exports(5): `ro` is the default when neither is given.
        writable: r.options.includes('rw') ? true : !r.options.includes('ro') ? false : false,
        // exports(5): `sec=sys` is the default.
        security: (ruleValue(r.options, 'sec') ?? 'sys').split(':').filter((s) => s.length > 0),
        options: r.options,
      })),
    },
  };
}

function nfsServiceResource(
  svc: Source<NfsServiceInput>,
  versions: Source<string[]>,
): PlacementResource {
  if (!svc.ok) {
    return failedResource(
      NFS_SERVICE_RESOURCE_ID,
      'NFS_SERVICE',
      sourceReason(svc, 'NFS_SERVICE_STATE_UNAVAILABLE'),
    );
  }
  const reasons: string[] = [];
  let status: CollectionStatus = 'SUCCESS';
  const active = svc.value.active_state;
  const running: boolean | null =
    active === 'active' ? true : active === null || active === 'unknown' ? null : false;
  if (running === null) {
    status = 'UNKNOWN';
    reasons.push('NFS_SERVICE_STATE_UNAVAILABLE');
  }
  let protocols: string[] = [];
  if (versions.ok) {
    protocols = versions.value.map((v) => `NFSv${v}`);
  } else {
    reasons.push(sourceReason(versions, 'NFSD_VERSIONS_UNAVAILABLE'));
    // A running server whose protocol set is unknown cannot be assessed;
    // a stopped one is fully described by running: false.
    if (running === true) status = 'UNKNOWN';
  }
  return {
    id: NFS_SERVICE_RESOURCE_ID,
    incarnation: `${NFS_SERVICE_RESOURCE_ID}:${active ?? 'unknown'}`,
    collection_status: status,
    observed_at: svc.observed_at,
    observed_mono_ms: svc.mono_ms,
    reason_codes: reasons,
    details: {
      kind: 'NFS_SERVICE',
      running,
      protocols,
      reason_codes: reasons,
      ...(svc.value.sub_state !== undefined ? { sub_state: svc.value.sub_state } : {}),
    },
  };
}

function oldest(deps: readonly PlacementResource[]): {
  observed_at: string | null;
  observed_mono_ms: number | null;
} {
  let best: PlacementResource | undefined;
  for (const d of deps) {
    if (d.observed_mono_ms === null) continue;
    if (best === undefined || d.observed_mono_ms < (best.observed_mono_ms as number)) best = d;
  }
  return best === undefined
    ? { observed_at: null, observed_mono_ms: null }
    : { observed_at: best.observed_at, observed_mono_ms: best.observed_mono_ms };
}

/**
 * Build the graph for one cycle. `encodeExportId` is `encExportId` from
 * lib/nfs-export-id (injected so this module stays dependency-free); a
 * path it rejects is skipped with a `share_id`-less EXPORT resource
 * `export:invalid:<n>`.
 */
export function buildPlacementGraph(
  inputs: GraphInputs,
  encodeExportId: ExportIdEncoder,
): PlacementGraph {
  const resources: PlacementResource[] = [];
  const shares: PlacementShare[] = [];

  const { resources: arrayRes, byVolumePath } = arrayResources(
    inputs.arrays,
    inputs.xiraid_version,
  );
  resources.push(...arrayRes);

  const nfs = nfsServiceResource(inputs.nfs_service, inputs.nfsd_versions);

  // Filesystems.
  const fsResources = new Map<string, PlacementResource>(); // by Filesystem input id
  let fsInputs: FilesystemInput[] = [];
  if (!inputs.filesystems.ok) {
    resources.push(
      failedResource(
        'fs:unavailable',
        'FILESYSTEM',
        sourceReason(inputs.filesystems, 'FILESYSTEMS_UNAVAILABLE'),
      ),
    );
  } else {
    fsInputs = inputs.filesystems.value;
    for (const fs of fsInputs) {
      const r = filesystemResource(fs, inputs.filesystems, inputs.arrays, byVolumePath);
      fsResources.set(fs.id, r);
      resources.push(r);
    }
  }

  // Exports and the shares they imply (spec §4.4).
  if (!inputs.exports.ok) {
    resources.push(
      failedResource(
        'export:unavailable',
        'EXPORT',
        sourceReason(inputs.exports, 'EXPORTS_UNAVAILABLE'),
      ),
    );
  } else {
    let invalid = 0;
    for (const e of inputs.exports.value) {
      let encoded: string;
      try {
        encoded = encodeExportId(e.export_path);
      } catch {
        invalid++;
        resources.push({
          ...failedResource(`export:invalid:${invalid}`, 'EXPORT', 'EXPORT_PATH_INVALID', {
            export_path: e.export_path,
          }),
        });
        continue;
      }
      const exportRes = exportResource(e, `export:${encoded}`, inputs.exports);
      resources.push(exportRes);

      // Only exports on a managed filesystem are shares; the api reconciles
      // the desired list against this at read time (spec §5.3).
      if (!inputs.filesystems.ok) continue;
      const fs = containingFilesystem(e.export_path, fsInputs);
      if (fs === undefined) continue;
      const fsRes = fsResources.get(fs.id) as PlacementResource;
      const deps: PlacementResource[] = [fsRes, exportRes, nfs];
      const reasons: string[] = [];
      if (fsRes.collection_status !== 'SUCCESS') reasons.push('DEPENDENCY_FILESYSTEM_UNAVAILABLE');
      if (nfs.collection_status !== 'SUCCESS') reasons.push('DEPENDENCY_NFS_SERVICE_UNAVAILABLE');
      const refs = fsRes.details.array_refs as Array<{ resource_id: string }> | undefined;
      const arraysById = new Map(arrayRes.map((a) => [a.id, a]));
      for (const ref of refs ?? []) {
        const a = arraysById.get(ref.resource_id);
        if (a !== undefined) {
          deps.push(a);
          if (
            a.collection_status !== 'SUCCESS' &&
            !reasons.includes('DEPENDENCY_ARRAY_UNAVAILABLE')
          )
            reasons.push('DEPENDENCY_ARRAY_UNAVAILABLE');
        }
      }
      const fsid = ruleValue(e.rules[0]?.options ?? [], 'fsid');
      const times = oldest(deps);
      shares.push({
        share_id: encoded,
        incarnation: `${encoded}:${fsid ?? 'none'}`,
        export_path: e.export_path,
        collection_status: reasons.length === 0 ? 'SUCCESS' : 'UNKNOWN',
        observed_at: times.observed_at,
        observed_mono_ms: times.observed_mono_ms,
        filesystem_ref: fsRes.id,
        export_ref: exportRes.id,
        service_ref: nfs.id,
        reason_codes: reasons,
      });
    }
  }

  resources.push(nfs);

  const sources = [inputs.arrays, inputs.filesystems, inputs.exports, inputs.nfs_service];
  const failed = sources.filter((s) => !s.ok).length;
  const snapshot_status: SnapshotStatus =
    failed === 0 && inputs.nfsd_versions.ok
      ? 'COMPLETE'
      : failed === sources.length
        ? 'FAILED'
        : 'PARTIAL';

  return { snapshot_status, shares, resources };
}
