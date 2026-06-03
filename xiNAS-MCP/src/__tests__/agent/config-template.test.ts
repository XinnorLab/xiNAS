import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Rendered-template contract tests for the two Ansible config templates.
 *
 * WHY THIS EXISTS: the independent S0+S1 review found a P0 (the agent config
 * template omitted `socket_group`, so the deployed socket was chowned
 * root:root and the api heartbeat could never connect) and a P1 (the api
 * config template never emitted `internalTokensPath`, so the agent token was
 * never loaded and every observation push 401'd). BOTH shipped green because
 * NO test rendered an Ansible template and asserted its key-set — the unit
 * tests always hand-built config objects with the right keys. This test closes
 * that structural gap: it renders each `.j2` (Jinja vars are not the point —
 * the JSON SHAPE is) and asserts every key the runtime loader requires is
 * present. If a key the loader reads is dropped from a template, this fails.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// src/__tests__/agent -> repo root is four levels up (agent -> __tests__ ->
// src -> xiNAS-MCP -> ROOT). Templates live under ROOT/collection/roles/.
const ROOT = resolve(HERE, '..', '..', '..', '..');

/**
 * Render a Jinja-templated JSON file to a parseable object. Every `{{ ... }}`
 * expression — quoted ("{{ x }}" -> "0"), bare ({{ x }} -> 0), or embedded
 * inside a string ("{{ x }}/foo" -> "0/foo") — is replaced with `0`, which is
 * a valid JSON token in all three positions. The result is structurally the
 * rendered config; only the placeholder *values* differ, and this test asserts
 * on KEYS, not values.
 */
function renderTemplateKeys(relPath: string): Record<string, unknown> {
  const raw = readFileSync(resolve(ROOT, relPath), 'utf8');
  const substituted = raw.replace(/\{\{[^}]*\}\}/g, '0');
  return JSON.parse(substituted) as Record<string, unknown>;
}

describe('xinas-agent config template (collection/roles/xinas_agent)', () => {
  const cfg = renderTemplateKeys(
    'collection/roles/xinas_agent/templates/xinas-agent-config.json.j2',
  );

  // Exactly the fields loadAgentConfig() reads off the on-disk JSON
  // (src/agent/config.ts). socket_group is the one the P0 was missing.
  const REQUIRED_KEYS = [
    'api_socket',
    'agent_socket',
    'controller_id_path',
    'agent_token_path',
    'socket_group',
    'heartbeat_interval_ms',
  ];

  for (const key of REQUIRED_KEYS) {
    it(`emits ${key}`, () => {
      expect(cfg).toHaveProperty(key);
    });
  }

  it('socket_group is a non-empty string (chown target for the api↔agent socket)', () => {
    // Rendered to "0" by the substitution; the point is the key is a JSON
    // string position, not a bare/numeric one.
    expect(typeof cfg['socket_group']).toBe('string');
  });
});

describe('xinas-api config template (collection/roles/xinas_api)', () => {
  const cfg = renderTemplateKeys('collection/roles/xinas_api/templates/xinas-api-config.json.j2');

  // Keys loadConfig() reads (src/api/config.ts). internalTokensPath is the one
  // the P1 was missing — without it loadConfig never merges internal-tokens.json
  // and the agent bearer is unknown to the api.
  const REQUIRED_KEYS = [
    'controller_id',
    'listen',
    'tokens',
    'agent',
    'internalTokensPath',
    'state',
  ];

  for (const key of REQUIRED_KEYS) {
    it(`emits ${key}`, () => {
      expect(cfg).toHaveProperty(key);
    });
  }

  it('internalTokensPath points at internal-tokens.json', () => {
    expect(String(cfg['internalTokensPath'])).toContain('internal-tokens.json');
  });
});
