import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Ajv 8.x and ajv-formats publish CJS-style `export =` types. Under tsconfig
// `module: Node16`, the default import is a namespace rather than a
// constructible class / callable, so we bridge with `as any` casts exactly as
// the contracts test does. Runtime behavior is unaffected.
import AjvImport from 'ajv';
import addFormatsImport from 'ajv-formats';
import yaml from 'js-yaml';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv = AjvImport as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const addFormats = addFormatsImport as any;

/**
 * A compiled Ajv validator for one observed kind. Matches what
 * observed.ts (and ApiContext.observedSchemas) expects: a predicate that
 * sets `.errors` on failure. Ajv's compiled validators already have this
 * shape.
 */
export type ValidateFn = ((data: unknown) => boolean) & { errors?: unknown };

/**
 * Observed kinds the agent pushes through /internal/v1/observed whose full
 * kind-object schema (`{ kind, id, metadata, spec, status }`) is enforced on
 * inbound deltas. `inventory` is lowercase to match its observedSegment; its
 * schema may not exist in api-v1.yaml, in which case it is silently skipped.
 */
const OBSERVED_KINDS = [
  'Disk',
  'NetworkInterface',
  'Filesystem',
  'NfsSession',
  'NfsIdmap',
  'SystemdUnit',
  'User',
  'Group',
  'ExportRule',
  'inventory',
] as const;

/**
 * Resolve api-v1.yaml relative to this module. The spec lives at the
 * worktree root under docs/control-path/; from src/api/ (and the mirrored
 * dist/api/) that is three levels up. Production hosts may ship dist/ without
 * docs/ — that case is handled by the existsSync guard below (returns null →
 * validation skipped).
 */
function specPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', 'docs', 'control-path', 'api-v1.yaml');
}

function warn(msg: string, extra: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ level: 'warn', msg, ...extra })}\n`);
}

/**
 * Compile per-kind inbound-observation validators from api-v1.yaml.
 *
 * Returns `{ schemas, ajv }` where `schemas` is keyed by observed kind name
 * (Disk, NetworkInterface, …) and each value validates a full kind object,
 * and `ajv` exposes `errorsText(errors)` for rendering a failed validator's
 * `.errors`. The /internal/v1/observed handler validates each upsert delta's
 * `value` against its kind's schema and fail-closes the whole batch on the
 * first failure.
 *
 * Returns `null` when api-v1.yaml is not present (production hosts may not
 * ship docs/) or on any load/parse failure — callers then leave
 * ctx.observedSchemas undefined and inbound schema validation is skipped (the
 * existing graceful behavior; the id-shape check still runs). A single
 * structured warning line is written to stderr so the disabled state is
 * observable.
 *
 * Implementation note: the kind schemas in api-v1.yaml use internal
 * `$ref: '#/components/schemas/Metadata'` references. Rather than the
 * contracts test's async `$RefParser.dereference` (loadObservedSchemas must
 * stay synchronous so server.ts can call it without awaiting), the whole spec
 * document is registered with Ajv under the `api-v1.yaml` id so Ajv resolves
 * those internal refs at compile time — equivalent inlining, no async.
 */
export function loadObservedSchemas(): {
  schemas: Record<string, ValidateFn>;
  ajv: { errorsText(e: unknown): string };
} | null {
  const path = specPath();
  if (!existsSync(path)) {
    warn('observation schema validation disabled: api-v1.yaml not found', { path });
    return null;
  }

  try {
    const doc = yaml.load(readFileSync(path, 'utf8')) as {
      components?: { schemas?: Record<string, unknown> };
    };
    const allSchemas = doc.components?.schemas;
    if (!allSchemas) {
      warn('observation schema validation disabled: api-v1.yaml has no components.schemas', {
        path,
      });
      return null;
    }

    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    // Register the full spec so internal `$ref: '#/components/schemas/...'`
    // pointers (e.g. Metadata) resolve when each kind schema is compiled.
    ajv.addSchema(doc, 'api-v1.yaml');

    const schemas: Record<string, ValidateFn> = {};
    for (const kind of OBSERVED_KINDS) {
      if (!allSchemas[kind]) continue; // kind has no schema (e.g. lowercase `inventory`) → skip
      schemas[kind] = ajv.getSchema(`api-v1.yaml#/components/schemas/${kind}`) as ValidateFn;
    }

    return {
      schemas,
      ajv: { errorsText: (e: unknown) => ajv.errorsText(e) },
    };
  } catch (err) {
    warn('observation schema validation disabled: failed to load api-v1.yaml', {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
