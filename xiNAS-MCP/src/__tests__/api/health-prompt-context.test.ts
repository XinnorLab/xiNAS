import { describe, expect, it } from 'vitest';
import type { ApiConfig, McpHealthPromptConfig } from '../../api/config.js';
import { buildHealthPromptContext } from '../../api/health/prompt-context.js';
import type { ProfileCatalog } from '../../api/health/profiles.js';
import { HEALTH_PROMPT_TEMPLATE, sha256Hex } from '../../api/mcp/prompts/health-check.js';

const config = (health_prompt?: McpHealthPromptConfig): ApiConfig => ({
  controller_id: '00000000-0000-0000-0000-0000000000aa',
  listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
  tokens: {},
  state: { databasePath: '/tmp/x/xinas.db', auditJsonlPath: '/tmp/x/audit.jsonl' },
  ...(health_prompt !== undefined ? { mcp: { health_prompt } } : {}),
});

const catalog = (names: string[]): ProfileCatalog => ({
  dir: '/nowhere',
  dir_present: false,
  profiles: names.map((name) => ({
    name,
    path: null,
    sha256: null,
    timeout_seconds: null,
    sections_enabled: [],
    sections_without_checker: [],
  })),
});

const ctx = { identity: { principal: 'p', role: 'viewer' as const }, correlationId: 'c' };

/** S19b T4 — spec §5.5, §12.1: what app.ts builds once at startup. */
describe('buildHealthPromptContext', () => {
  it('is undefined when mcp.health_prompt.enabled is false', () => {
    expect(buildHealthPromptContext(config({ enabled: false }))).toBeUndefined();
  });

  it('ships the constant template, hashes it, and lists the loaded profile names', () => {
    const hp = buildHealthPromptContext(config(), {
      loadProfiles: () => catalog(['quick', 'site']),
    });
    expect(hp?.body).toBe(HEALTH_PROMPT_TEMPLATE);
    expect(hp?.templateSha256).toBe(sha256Hex(HEALTH_PROMPT_TEMPLATE));
    expect(hp?.versions).toEqual({
      prompt: '1.0.0',
      policy: '1',
      catalog: '1',
      report_schema: '1',
    });
    expect(hp?.profiles.profiles.map((p) => p.name)).toEqual(['quick', 'site']);
    const provider = hp?.prompts.providers[0];
    expect(() =>
      provider?.get('xinas_health_check', { baseline_profile: 'site' }, ctx),
    ).not.toThrow();
    expect(() => provider?.get('xinas_health_check', { baseline_profile: 'deep' }, ctx)).toThrow(
      /baseline_profile/,
    );
    // no audit sink was given: the option is absent, not undefined-valued
    expect(hp?.prompts).not.toHaveProperty('audit');
  });

  it('reads the operator override once and reports its hash and the configured versions', () => {
    const hp = buildHealthPromptContext(
      config({
        template_path: '/etc/xinas/health-prompt.md',
        policy_version: 'site-2',
        probe_policy_max: 'bounded_active',
      }),
      {
        loadProfiles: () => catalog(['standard']),
        readTemplate: (p) =>
          `# Site prompt\n\n> notes\n\n## Prompt body\n\nSite body from ${p}\n\nSecond paragraph.\n`,
      },
    );
    expect(hp?.body).toBe('Site body from /etc/xinas/health-prompt.md\n\nSecond paragraph.\n');
    expect(hp?.templateSha256).toBe(sha256Hex(hp?.body ?? ''));
    expect(hp?.versions.policy).toBe('site-2');
    expect(hp?.versions.prompt).toBe('1.0.0+local');
    const text =
      hp?.prompts.providers[0]?.get('xinas_health_check', { probe_policy: 'bounded_active' }, ctx)
        .messages[0]?.content.text ?? '';
    expect(text.startsWith('Site body from')).toBe(true);
    expect(text).toContain('"effective": "bounded_active"');
    expect(text).toContain('"policy_version": "site-2"');
    expect(text).toContain('"prompt_version": "1.0.0+local"');
  });

  it.each([
    [
      'unreadable',
      () => {
        throw new Error('ENOENT');
      },
      /template_path: cannot read \/etc\/xinas\/x.md: ENOENT/,
    ],
    ['marker-less', () => 'Just a body without the section marker\n', /no "## Prompt body" marker/],
    ['empty after the marker', () => '# t\n## Prompt body\n  \n', /is empty after the marker/],
    ['NUL-bearing', () => `## Prompt body\nbody${String.fromCharCode(0)}\n`, /NUL byte/],
    ['oversized', () => `## Prompt body\n${'x'.repeat(64 * 1024)}\n`, /exceeds 65536 bytes/],
  ])('fails startup loudly on an %s override', (_label, readTemplate, message) => {
    expect(() =>
      buildHealthPromptContext(config({ template_path: '/etc/xinas/x.md' }), {
        loadProfiles: () => catalog(['standard']),
        readTemplate,
      }),
    ).toThrow(message);
  });

  it('available.* reflects the catalog entries that exist today', () => {
    const hp = buildHealthPromptContext(config(), { loadProfiles: () => catalog(['standard']) });
    const text =
      hp?.prompts.providers[0]?.get('xinas_health_check', {}, ctx).messages[0]?.content.text ?? '';
    const block = JSON.parse(
      text.slice(text.indexOf('---\n{') + 4, text.indexOf('\n<user_symptom>')),
    ) as { available: Record<string, boolean> };
    // S19a shipped health.probe.run, S19b health.context / health.catalog,
    // S19c health.baseline; report_schema / validate land with S19c T6.
    expect(block.available.probe_run).toBe(true);
    expect(block.available.context).toBe(true);
    expect(block.available.catalog).toBe(true);
    expect(block.available.baseline).toBe(true);
    expect(block.available.report_schema).toBe(false);
    expect(block.available.validate).toBe(false);
  });
});
