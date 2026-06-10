/**
 * Typed nfs-helper **write** client (S3 N3.1, s3-nfs-executor-spec §2/§6).
 *
 * The agent already talks to the `xinas-nfs-helper` UDS for reads via
 * {@link createNfsProbe} (`callHelper(op, params)` — connect, write one
 * JSON line, read one line, parse). This module wraps that one-request /
 * one-response round-trip with typed *write* methods the NFS executor calls
 * (`add_export` / `remove_export` / `update_export` / `set_idmapd_domain` /
 * `render_nfs_profile`, plus a typed `list_exports` read used by
 * preflight/verify).
 *
 * The transport is injected as a single `roundTrip(req) -> envelope` function
 * so the client is test-hermetic (tests pass a fake that records the request).
 * {@link createNfsHelperClientFromProbe} adapts the real
 * {@link createNfsProbe} transport in production — no new socket layer.
 *
 * Envelope handling mirrors the read path's `checkResponse`: on `ok:true`
 * return `result` (or void); on `ok:false` throw a typed {@link NfsHelperError}
 * carrying the helper's error `code` (`INVALID_ARGUMENT | NOT_FOUND |
 * UNSUPPORTED | INTERNAL`). Like {@link createNfsProbe}, the request carries no
 * `request_id` — the helper accepts a bare `{op,...}` and the read transport
 * the executor reuses adds none.
 */
import { createNfsProbe } from '../probe/nfs.js';

/** One export rule in the helper's wire shape (`{ path, clients:[{host, options}] }`). */
export interface HelperExportEntry {
  path: string;
  clients: Array<{ host: string; options: string[] }>;
}

/** Optional `add_export` knobs (helper mkdir-on-add). */
export interface AddExportOptions {
  /** Helper mkdirs the export path if absent (single level; parent must exist). */
  create_path?: boolean;
  /** Octal mode string (e.g. `"0755"`) for the created directory; ignored without `create_path`. */
  path_mode?: string;
}

/**
 * What `render_nfs_profile` returns (S3 §6.2): per-file sha256 checksums keyed
 * by the absolute production path (feeds `status.effective_files`) plus which
 * post-render service action ran.
 */
export interface RenderNfsProfileResult {
  effective_files: Record<string, string>;
  restarted: boolean;
  reloaded: boolean;
}

/** Typed write/read surface over the nfs-helper, called by the NFS executor. */
export interface NfsHelperClient {
  listExports(): Promise<HelperExportEntry[]>;
  addExport(entry: HelperExportEntry, opts?: AddExportOptions): Promise<void>;
  removeExport(path: string): Promise<void>;
  updateExport(path: string, patch: { clients: HelperExportEntry['clients'] }): Promise<void>;
  setIdmapDomain(domain: string): Promise<void>;
  /** Render the four ADR-0005 effective files from a FULL NfsProfile spec (§6.2). */
  renderNfsProfile(
    spec: Record<string, unknown>,
    restart: boolean,
  ): Promise<RenderNfsProfileResult>;
}

/** The nfs-helper response envelope (newline-delimited JSON, one per request). */
export interface HelperEnvelope {
  ok: boolean;
  result?: unknown;
  code?: string;
  error?: string;
}

/** One request -> one envelope round-trip over the helper UDS (injected; fakeable). */
export type HelperRoundTrip = (req: unknown) => Promise<HelperEnvelope>;

/**
 * A typed error carrying the helper's error code
 * (`INVALID_ARGUMENT | NOT_FOUND | UNSUPPORTED | INTERNAL`), so the executor
 * can branch on `code` (e.g. treat `NOT_FOUND` on remove as already-done).
 */
export class NfsHelperError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'NfsHelperError';
  }
}

/**
 * Await `roundTrip`, returning `result` on success or throwing a typed
 * {@link NfsHelperError} on `ok:false` (code defaulting to `INTERNAL`).
 */
async function call(roundTrip: HelperRoundTrip, req: unknown): Promise<unknown> {
  const resp = await roundTrip(req);
  if (!resp.ok) {
    throw new NfsHelperError(resp.code ?? 'INTERNAL', resp.error ?? 'nfs-helper returned error');
  }
  return resp.result;
}

/**
 * Build the typed client over an injected one-shot round-trip. This is the
 * test-hermetic core: production wires {@link createNfsHelperClientFromProbe},
 * tests pass a fake that records the request and returns a canned envelope.
 */
export function createNfsHelperClient(roundTrip: HelperRoundTrip): NfsHelperClient {
  return {
    async listExports(): Promise<HelperExportEntry[]> {
      const result = await call(roundTrip, { op: 'list_exports' });
      return (result ?? []) as HelperExportEntry[];
    },

    async addExport(entry: HelperExportEntry, opts: AddExportOptions = {}): Promise<void> {
      // Conditional-spread the optional fields so they are absent (not
      // `undefined`) under exactOptionalPropertyTypes; the helper only honors
      // `path_mode` when `create_path` is set.
      const req = {
        op: 'add_export',
        entry,
        ...(opts.create_path ? { create_path: true } : {}),
        ...(opts.create_path && opts.path_mode !== undefined ? { path_mode: opts.path_mode } : {}),
      };
      await call(roundTrip, req);
    },

    async removeExport(path: string): Promise<void> {
      await call(roundTrip, { op: 'remove_export', path });
    },

    async updateExport(
      path: string,
      patch: { clients: HelperExportEntry['clients'] },
    ): Promise<void> {
      await call(roundTrip, { op: 'update_export', path, patch });
    },

    async setIdmapDomain(domain: string): Promise<void> {
      await call(roundTrip, { op: 'set_idmapd_domain', domain });
    },

    async renderNfsProfile(
      spec: Record<string, unknown>,
      restart: boolean,
    ): Promise<RenderNfsProfileResult> {
      const result = await call(roundTrip, { op: 'render_nfs_profile', spec, restart });
      return (result ?? {
        effective_files: {},
        restarted: restart,
        reloaded: !restart,
      }) as RenderNfsProfileResult;
    },
  };
}

/**
 * Adapt the agent's existing nfs-helper UDS transport ({@link createNfsProbe}'s
 * `callHelper`) into a {@link HelperRoundTrip}, then build the typed write
 * client over it. This is the production wiring — it reuses the very same
 * connect / write-one-line / read-one-line / parse layer the NFS read
 * collector already uses, so there is no second socket implementation.
 *
 * `callHelper(op, params)` resolves with the *parsed envelope* (`{ ok, result,
 * code?, error? }`); we split the request's `op` from the rest of the body to
 * fit its `(op, params)` signature.
 */
export function createNfsHelperClientFromProbe(
  opts: { helperSocket?: string; timeoutMs?: number } = {},
): NfsHelperClient {
  const probe = createNfsProbe(opts);
  const roundTrip: HelperRoundTrip = async (req: unknown) => {
    const { op, ...params } = req as { op: string } & Record<string, unknown>;
    return (await probe.callHelper(op, params)) as HelperEnvelope;
  };
  return createNfsHelperClient(roundTrip);
}
