import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import yaml from 'js-yaml';
import $RefParser from '@apidevtools/json-schema-ref-parser';
// Ajv 8.x publishes CJS-style `export = Ajv` types. Under tsconfig
// `module: Node16`, the default import is a namespace, not a constructible
// class, so we use type assertions to bridge. Runtime behavior is
// unaffected (vitest's esbuild loader handles it transparently).
import AjvImport from 'ajv';
import addFormatsImport from 'ajv-formats';
import { describe, it, expect, beforeAll } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv = AjvImport as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const addFormats = addFormatsImport as any;

const here = dirname(fileURLToPath(import.meta.url));
const specPath = resolve(here, '..', '..', '..', '..', 'docs', 'control-path', 'api-v1.yaml');
const fixturesDir = resolve(here, 'fixtures');

describe('OpenAPI schema contract', () => {
  let schemas: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ajv: any;

  beforeAll(async () => {
    const raw = yaml.load(readFileSync(specPath, 'utf8')) as Record<string, unknown>;
    const resolved = (await $RefParser.dereference(raw)) as {
      components: { schemas: Record<string, unknown> };
    };
    schemas = resolved.components.schemas;
    ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
  });

  for (const file of readdirSync(fixturesDir).filter((f) => f.endsWith('.json'))) {
    const schemaName = basename(file, '.json');
    it(`${schemaName} fixture conforms to schema`, () => {
      const fixture = JSON.parse(readFileSync(resolve(fixturesDir, file), 'utf8'));
      const schema = schemas[schemaName];
      expect(schema, `schema ${schemaName} not found in api-v1.yaml`).toBeDefined();
      const validate = ajv.compile(schema as object);
      const ok = validate(fixture);
      expect(validate.errors ?? [], `Errors validating ${file}`).toEqual([]);
      expect(ok).toBe(true);
    });
  }

  // S15 AC15 fix round 1 (F2): the McpConfirmation fixture above is a single
  // `approved`/`url` record — one fixture per schema name can only pin one
  // literal per nullable enum. Prove the REST of each enum's literals here by
  // spreading the fixture with one field overridden per case, so every
  // `approval_channel` / `approval_interface` / `expired_reason` value the
  // spec advertises is exercised against the compiled schema, not just the
  // one the fixture happens to carry.
  it('McpConfirmation: every approval_channel/approval_interface/expired_reason literal validates', () => {
    const fixture = JSON.parse(
      readFileSync(resolve(fixturesDir, 'McpConfirmation.json'), 'utf8'),
    ) as Record<string, unknown>;
    const validate = ajv.compile(schemas.McpConfirmation as object);
    const isValid = (overrides: Record<string, unknown>): boolean =>
      validate({ ...fixture, ...overrides }) as boolean;

    for (const value of ['mcp_form', 'bearer', 'uds_break_glass']) {
      expect(isValid({ approval_channel: value }), `approval_channel: ${value}`).toBe(true);
    }
    expect(isValid({ approval_channel: 'form' }), "approval_channel: 'form' is not valid").toBe(
      false,
    );

    for (const value of ['web', 'rest']) {
      expect(isValid({ approval_interface: value }), `approval_interface: ${value}`).toBe(true);
    }
    expect(isValid({ approval_interface: 'cli' }), "approval_interface: 'cli' is not valid").toBe(
      false,
    );

    for (const value of ['ttl', 'round_limit', 'plan_stale', 'revision_changed', 'restart_sweep']) {
      expect(isValid({ expired_reason: value }), `expired_reason: ${value}`).toBe(true);
    }
  });
});
