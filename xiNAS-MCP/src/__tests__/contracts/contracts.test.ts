import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import yaml from 'js-yaml';
import $RefParser from '@apidevtools/json-schema-ref-parser';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, it, expect, beforeAll } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const specPath = resolve(
  here,
  '..',
  '..',
  '..',
  '..',
  'docs',
  'control-path',
  'api-v1.yaml',
);
const fixturesDir = resolve(here, 'fixtures');

describe('OpenAPI schema contract', () => {
  let schemas: Record<string, unknown> = {};
  let ajv: Ajv;

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
});
