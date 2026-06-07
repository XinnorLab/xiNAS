/**
 * Stable, validation-safe encoding of an absolute NFS export path for use as an
 * `ExportRule` observed-state id. `isValidObservedId` (internal/observed.ts)
 * rejects ids with a leading/trailing `/`, `//`, or a `.`/`..` segment, so the
 * raw absolute path cannot be an id. encExportId canonicalizes then strips the
 * leading slash; decExportId is the inverse. Layer-neutral (lib) — imported by
 * the agent collector and the api read-time join. (s3-nfs-executor-spec §3)
 */

/**
 * Canonicalize + strip leading slash → a valid observed id. Throws on a path
 * that can't produce a valid id (a `..` segment, or the bare root `/`).
 */
export function encExportId(path: string): string {
  // Canonicalize: split on '/', drop '' (collapses '//', leading/trailing '/')
  // and '.' segments, reject '..'. Export paths are kernel-normalized absolute
  // paths so this is realistically a no-op, but it MUST run so trailing-slash /
  // '//' inputs cannot produce an invalid id.
  const segments = path.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) {
    throw new Error(`encExportId: path must not contain '..' segments: ${path}`);
  }
  const id = segments.join('/');
  if (id.length === 0) {
    throw new Error(`encExportId: path has no exportable segments (e.g. '/'): ${path}`);
  }
  return id;
}

/** Inverse of encExportId for a canonical absolute path. */
export function decExportId(id: string): string {
  return `/${id}`;
}
