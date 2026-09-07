// @vitest-environment node
/**
 * S16 §16.3 contract: the MCP Tasks extension's wire shapes.
 *
 * Five of the seven fixtures are quoted verbatim in Appendix B
 * (`docs/control-path/s16-mcp-tasks-spec.md`): `create-task-result-working`,
 * `get-task-result-completed`, `get-task-result-cancelled`, `ack-result`, and
 * `missing-capability-error`. The other two — `create-task-result-completed.json`
 * and `get-task-result-working.json` — are constructed from the Appendix B
 * TypeScript interfaces (`CreateTaskResult` has no status-conditional fields;
 * `GetTaskResult`'s `working` branch is `TaskFields` alone) to cover the
 * `completed` handle and `working` get variants the excerpt does not quote.
 * Every fixture validates against the hand-rolled zod schemas in
 * `src/api/mcp/tasks/schema.ts` and, when the released extension schema
 * could be downloaded, against the matching definition in the vendored
 * `ext-tasks/2026-07-28/schema.json` (Ajv 2020, draft 2020-12). The pinned
 * schema revision string is asserted directly. A `ttl`-instead-of-`ttlMs`
 * mutant (the 2025-11-25 vocabulary) must fail both validators — this is
 * the guard against silently reverting to the deprecated shape.
 *
 * A dedicated negative test also covers a `GetTaskResult` discriminator gap:
 * the vendored JSON schema's `anyOf` branches carry no
 * `additionalProperties: false`, so on their own they do not discriminate on
 * `status` — a "completed" fixture with `status` swapped to `"working"` (and
 * `result` still present) passes Ajv. Only the zod discriminated `.strict()`
 * union rejects it; see the comment above the JSON-schema assertions below.
 *
 * The final assertion is the spec's "advertised ⇒ schema-valid" rule: the
 * SERVED `server/discover` result (a real api process via `startServer`,
 * same pattern as `mcp-wire.test.ts`) validates against the vendored
 * CORE `2026-07-28` schema's `DiscoverResult` definition, with
 * `capabilities.extensions['io.modelcontextprotocol/tasks']` present and
 * equal to `{}`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Ajv publishes CJS-style `export =` types; bridge with a cast like contracts.test.ts.
import Ajv2020Import from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../../api/server.js';
import {
  AckResultSchema,
  CreateTaskResultSchema,
  GetTaskResultSchema,
  JsonRpcErrorObjectSchema,
  TASKS_EXTENSION_SCHEMA_REVISION,
} from '../../api/mcp/tasks/schema.js';

// biome-ignore lint/suspicious/noExplicitAny: CJS/ESM interop for ajv
const Ajv2020 = Ajv2020Import as any;

const here = dirname(fileURLToPath(import.meta.url));
const CORE_SCHEMA = JSON.parse(readFileSync(resolve(here, 'mcp/2026-07-28/schema.json'), 'utf8'));

const EXT_SCHEMA_PATH = resolve(here, 'mcp/ext-tasks-2026-07-28/schema.json');
let EXT_SCHEMA: Record<string, unknown> | undefined;
try {
  EXT_SCHEMA = JSON.parse(readFileSync(EXT_SCHEMA_PATH, 'utf8'));
} catch {
  EXT_SCHEMA = undefined;
}

const fixturesDir = resolve(here, 'mcp-tasks-fixtures');
const loadFixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8'));

const CID = '00000000-0000-0000-0000-000000000921';

describe('S16 MCP Tasks extension: fixtures pin the wire shapes', () => {
  // biome-ignore lint/suspicious/noExplicitAny: ajv instance
  let coreAjv: any;
  // biome-ignore lint/suspicious/noExplicitAny: ajv instance
  let extAjv: any;

  beforeAll(() => {
    coreAjv = new Ajv2020({ strict: false, allErrors: true });
    coreAjv.addSchema(CORE_SCHEMA, 'mcp');
    if (EXT_SCHEMA !== undefined) {
      extAjv = new Ajv2020({ strict: false, allErrors: true });
      extAjv.addSchema(EXT_SCHEMA, 'ext-tasks');
    }
  });

  const validateCore = (def: string, value: unknown): string[] => {
    const validate =
      coreAjv.getSchema(`mcp#/$defs/${def}`) ?? coreAjv.compile({ $ref: `mcp#/$defs/${def}` });
    return validate(value)
      ? []
      : (validate.errors ?? []).map(
          (e: { instancePath: string; message?: string }) => `${e.instancePath} ${e.message ?? ''}`,
        );
  };

  /** Validate against the released extension schema's `def`, when it was downloaded. */
  const validateExt = (def: string, value: unknown): string[] | undefined => {
    if (extAjv === undefined) return undefined;
    const validate =
      extAjv.getSchema(`ext-tasks#/$defs/${def}`) ??
      extAjv.compile({ $ref: `ext-tasks#/$defs/${def}` });
    return validate(value)
      ? []
      : (validate.errors ?? []).map(
          (e: { instancePath: string; message?: string }) => `${e.instancePath} ${e.message ?? ''}`,
        );
  };

  it('TASKS_EXTENSION_SCHEMA_REVISION is pinned to 2026-07-28', () => {
    expect(TASKS_EXTENSION_SCHEMA_REVISION).toBe('2026-07-28');
  });

  // Review F4: every `extErrors`/`validateExt` assertion below is guarded by
  // `if (… !== undefined)` — that guard exists so a MISSING vendored schema
  // (never downloaded) degrades this suite to zod-only instead of failing
  // it. Without this assertion, a CORRUPTED or accidentally deleted schema
  // file would silently take the same "not vendored" path and every
  // ext-tasks assertion below would be skipped rather than failing.
  it('the vendored ext-tasks schema file loaded successfully', () => {
    expect(EXT_SCHEMA).toBeDefined();
  });

  // NOTE: a passing `extErrors` assertion below is not, by itself, a discriminating pin on `status` — the vendored schema's `anyOf` branches carry no `additionalProperties: false` (see the discriminator-gap test below), so the zod schema above each assertion is the half that actually discriminates; do not drop the zod assertion on the assumption Ajv alone covers it.
  it('create-task-result-working: zod + (when vendored) ext-tasks CreateTaskResult', () => {
    const fixture = loadFixture('create-task-result-working');
    expect(CreateTaskResultSchema.safeParse(fixture).success).toBe(true);
    const extErrors = validateExt('CreateTaskResult', fixture);
    if (extErrors !== undefined) expect(extErrors).toEqual([]);
  });

  it('create-task-result-completed: zod + (when vendored) ext-tasks CreateTaskResult', () => {
    const fixture = loadFixture('create-task-result-completed');
    expect(CreateTaskResultSchema.safeParse(fixture).success).toBe(true);
    const extErrors = validateExt('CreateTaskResult', fixture);
    if (extErrors !== undefined) expect(extErrors).toEqual([]);
  });

  it('get-task-result-working: zod + (when vendored) ext-tasks GetTaskResult', () => {
    const fixture = loadFixture('get-task-result-working');
    expect(GetTaskResultSchema.safeParse(fixture).success).toBe(true);
    const extErrors = validateExt('GetTaskResult', fixture);
    if (extErrors !== undefined) expect(extErrors).toEqual([]);
  });

  it('get-task-result-completed: zod + (when vendored) ext-tasks GetTaskResult', () => {
    const fixture = loadFixture('get-task-result-completed');
    expect(GetTaskResultSchema.safeParse(fixture).success).toBe(true);
    const extErrors = validateExt('GetTaskResult', fixture);
    if (extErrors !== undefined) expect(extErrors).toEqual([]);
  });

  it('get-task-result-cancelled: zod + (when vendored) ext-tasks GetTaskResult', () => {
    const fixture = loadFixture('get-task-result-cancelled');
    expect(GetTaskResultSchema.safeParse(fixture).success).toBe(true);
    const extErrors = validateExt('GetTaskResult', fixture);
    if (extErrors !== undefined) expect(extErrors).toEqual([]);
  });

  it('ack-result: zod AckResultSchema + (when vendored) ext-tasks UpdateTaskResult/CancelTaskResult', () => {
    const fixture = loadFixture('ack-result');
    expect(AckResultSchema.safeParse(fixture).success).toBe(true);
    const updateErrors = validateExt('UpdateTaskResult', fixture);
    if (updateErrors !== undefined) expect(updateErrors).toEqual([]);
    const cancelErrors = validateExt('CancelTaskResult', fixture);
    if (cancelErrors !== undefined) expect(cancelErrors).toEqual([]);
  });

  it('missing-capability-error: zod JsonRpcErrorObjectSchema + the -32021 data shape + (when vendored) ext-tasks Error', () => {
    const fixture = loadFixture('missing-capability-error');
    const parsed = JsonRpcErrorObjectSchema.safeParse(fixture);
    expect(parsed.success).toBe(true);
    expect(fixture.data).toEqual({
      requiredCapabilities: { extensions: { 'io.modelcontextprotocol/tasks': {} } },
    });
    // The released schema names this definition `Error`, not `JSONRPCErrorObject`.
    const extErrors = validateExt('Error', fixture);
    if (extErrors !== undefined) expect(extErrors).toEqual([]);
  });

  it('the 2025-11-25 vocabulary pin: ttl instead of ttlMs fails zod and the JSON schema', () => {
    const working = loadFixture('create-task-result-working');
    const { ttlMs: _ttlMs, ...rest } = working;
    const mutant = { ...rest, ttl: 2592000000 };
    expect(CreateTaskResultSchema.safeParse(mutant).success).toBe(false);
    const extErrors = validateExt('CreateTaskResult', mutant);
    if (extErrors !== undefined) expect(extErrors.length).toBeGreaterThan(0);
  });

  it('discriminator gap: a completed fixture with status swapped to "working" fails zod but the vendored JSON schema alone reports it valid', () => {
    const completed = loadFixture('get-task-result-completed');
    const mutant = { ...completed, status: 'working' };
    // (a) The zod discriminated union picks the "working" variant by `status` and that
    // variant is `.strict()` with no `result` field, so the leftover `result` key is
    // rejected as an unrecognized key — this is the actual discriminating validator.
    expect(GetTaskResultSchema.safeParse(mutant).success).toBe(false);
    if (extAjv !== undefined) {
      // (b) The released `GetTaskResult` schema's `anyOf` branches carry no
      // `additionalProperties: false`. The "working" branch only requires
      // taskId/status/createdAt/lastUpdatedAt/ttlMs (all present) and does not
      // constrain extra properties, so the leftover `result` key is simply ignored
      // and Ajv reports this mutant VALID. This is not a defect to "fix" in the
      // vendored schema — it is the released schema, verbatim — it demonstrates that
      // the JSON-schema half of this contract does not discriminate on `status` by
      // itself; the zod schema in assertion (a) is the discriminating half.
      const ajvValidate =
        extAjv.getSchema('ext-tasks#/$defs/GetTaskResult') ??
        extAjv.compile({ $ref: 'ext-tasks#/$defs/GetTaskResult' });
      expect(ajvValidate(mutant)).toBe(true);
    }
  });

  describe('the served server/discover result advertises a schema-valid tasks extension', () => {
    let dir: string;
    let handle: Awaited<ReturnType<typeof startServer>>;
    let port: number;

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'xinas-mcp-tasks-'));
      const configPath = join(dir, 'config.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          controller_id: CID,
          listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
          tokens: { 'tok-admin': { principal: 'admin:test', role: 'admin' } },
          state: { databasePath: join(dir, 'x.db'), auditJsonlPath: join(dir, 'a.jsonl') },
        }),
      );
      handle = await startServer({ configPath });
      port = (handle.address as AddressInfo).port;
    });

    afterAll(async () => {
      await handle.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('server/discover -> DiscoverResult with capabilities.extensions["io.modelcontextprotocol/tasks"] === {}', async () => {
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: 'discover-tasks',
        method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'tasks-contract-test', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      });
      const body = await new Promise<Record<string, unknown>>((resolveP, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: '/mcp',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              'content-length': Buffer.byteLength(payload),
              authorization: 'Bearer tok-admin',
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () =>
              resolveP(
                JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
              ),
            );
          },
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });

      const result = body.result as { capabilities: { extensions?: Record<string, unknown> } };
      expect(validateCore('DiscoverResult', result)).toEqual([]);
      expect(validateCore('ServerCapabilities', result.capabilities)).toEqual([]);
      expect(result.capabilities.extensions).toMatchObject({ 'io.modelcontextprotocol/tasks': {} });
    });
  });
});
