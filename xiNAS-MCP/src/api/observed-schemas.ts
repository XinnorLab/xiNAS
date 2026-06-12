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
 * Observed kinds the agent pushes through /internal/v1/observed. This list MUST
 * be kept exhaustively in sync with every `kind` the agent's collectors emit
 * (see src/agent/collectors/base.ts `Kind`), because a delta whose kind is not
 * here is rejected as an "unknown kind" 400 — which fail-closes the WHOLE batch
 * and silently drops every co-batched real kind (e.g. an absent ExportRule
 * would poison the NfsSession deltas it ships with). The independent S0+S1
 * review found `XiraidArray` and `managed_files` missing here, and `inventory`
 * present but schema-less (so it 400'd too), causing exactly that batch loss.
 *
 * Each kind WITH a kind-object schema in api-v1.yaml gets a TYPE-ONLY inbound
 * validator (see stripRequired + loadObservedSchemas for why completeness is
 * NOT enforced). Each kind WITHOUT a schema (`inventory`, `managed_files` are
 * lowercase intermediate/deferred kinds with no public schema) gets a
 * permissive object-validator so it is still RECOGNIZED and accepted — inbound
 * validation is a type/garbage net, not a completeness gate.
 */
const OBSERVED_KINDS = [
  'Disk',
  'NetworkInterface',
  'Filesystem',
  'NfsSession',
  'NfsIdmap',
  'NfsProfile',
  'SystemdUnit',
  'User',
  'Group',
  'ExportRule',
  'XiraidArray',
  'NetworkConfig',
  'Tuning',
  'ConfigSnapshot',
  'Pool',
  'managed_files',
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
 * Recursively delete every `required` array anywhere in a JSON Schema object
 * graph: at the top level, inside `properties` / `items` / `$defs` /
 * `definitions`, and within every `allOf` / `anyOf` / `oneOf` branch.
 *
 * WHY: the agent emits PARTIAL "intermediate" observation shapes, not the full
 * public kind objects. A real DiskCollector delta is
 * `{ kind, id, status: { name, model, serial, transport, observed_at } }` —
 * it has no `metadata`, no `spec`, and its `status` omits `device_path`,
 * `capacity_bytes`, `safe_for_use`, etc. The full api-v1.yaml Disk schema
 * marks all of those `required`, so compiling it as-is would 400 the agent's
 * own observations. Inbound validation is a TYPE / garbage safety net — it
 * verifies that the fields the agent DID send have the right types (and that
 * the value is a structurally valid object for the kind, and the kind is
 * known) — NOT a completeness gate. The full required-field guarantees belong
 * to the public READ schemas (what clients GET back), not to inbound
 * observations. Stripping `required` keeps the type checks while letting
 * absent fields through.
 *
 * `additionalProperties` is intentionally left untouched (not tightened): an
 * extra field the agent adds should not be rejected by the inbound net.
 */
function stripRequired(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) stripRequired(item);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  // Delete `required` only when it is the JSON-Schema keyword (an array of
  // property-name strings). A `required` key nested under `properties` would
  // be a real property NAMED "required" whose value is a subschema object —
  // leave that alone and recurse into it like any other property.
  if (Array.isArray(obj['required'])) delete obj['required'];
  for (const value of Object.values(obj)) stripRequired(value);
}

/**
 * Compile per-kind inbound-observation validators from api-v1.yaml.
 *
 * Returns `{ schemas, ajv }` where `schemas` is keyed by observed kind name
 * (Disk, NetworkInterface, …) and each value is a TYPE-ONLY validator for
 * that kind, and `ajv` exposes `errorsText(errors)` for rendering a failed
 * validator's `.errors`. The /internal/v1/observed handler validates each
 * upsert delta's `value` against its kind's schema and fail-closes the whole
 * batch on the first failure.
 *
 * TYPE-ONLY, not completeness: before compiling, the whole spec document's
 * `components.schemas` is deep-cloned and every `required` array is stripped
 * recursively (see stripRequired). The agent emits PARTIAL observations, so
 * inbound validation must NOT demand the full set of fields the public READ
 * schemas guarantee — it only rejects unknown kinds, non-object values, and
 * fields whose TYPE is wrong (a string where the schema says boolean, etc.).
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

    // Deep-clone the whole spec doc, then strip every `required` array from
    // its component schemas so the registered subschemas — and any internal
    // `$ref: '#/components/schemas/...'` (e.g. Metadata) they resolve through —
    // are all type-only. We register the STRIPPED doc (not the original) so a
    // ref from Disk → Metadata also lands on the required-stripped Metadata.
    const strippedDoc = structuredClone(doc) as typeof doc;
    if (strippedDoc.components?.schemas) stripRequired(strippedDoc.components.schemas);
    // Register the stripped spec so internal `$ref` pointers resolve to the
    // required-stripped subschemas when each kind schema is compiled.
    ajv.addSchema(strippedDoc, 'api-v1.yaml');

    // Permissive validator for kinds with no api-v1.yaml schema: accept any
    // structurally-valid (non-null) object. This is what makes a schema-less
    // observed kind RECOGNIZED instead of 400'd as "unknown kind" (which would
    // fail-close the batch). Type-completeness for these intermediate/deferred
    // kinds is enforced by the public READ schema if/when one is added.
    const acceptObject: ValidateFn = (data: unknown) => typeof data === 'object' && data !== null;

    const schemas: Record<string, ValidateFn> = {};
    for (const kind of OBSERVED_KINDS) {
      // A kind in OBSERVED_KINDS is intended to be accepted. If it has a
      // component schema, compile a TYPE-ONLY validator; otherwise (lowercase
      // intermediate kinds like `inventory` / `managed_files`) register the
      // permissive object-validator so the delta isn't rejected.
      schemas[kind] = strippedDoc.components?.schemas?.[kind]
        ? (ajv.getSchema(`api-v1.yaml#/components/schemas/${kind}`) as ValidateFn)
        : acceptObject;
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
