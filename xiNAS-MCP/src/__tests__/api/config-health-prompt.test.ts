import { describe, expect, it } from 'vitest';
import {
  type ApiConfig,
  HEALTH_PROMPT_DEFAULTS,
  type McpHealthPromptConfig,
  resolveHealthPromptConfig,
  validateHealthPromptSection,
} from '../../api/config.js';

const base = (): ApiConfig => ({
  controller_id: '00000000-0000-0000-0000-0000000000aa',
  listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
  tokens: {},
  state: { databasePath: '/tmp/x/xinas.db', auditJsonlPath: '/tmp/x/audit.jsonl' },
});

const withHp = (health_prompt: Record<string, unknown>): ApiConfig => ({
  ...base(),
  mcp: { health_prompt: health_prompt as McpHealthPromptConfig },
});

/** S19b T1 — spec §12.1: the mcp.health_prompt block, its defaults and bounds. */
describe('mcp.health_prompt (spec §12.1)', () => {
  it('resolves to the §12.1 defaults when absent', () => {
    expect(resolveHealthPromptConfig(base())).toEqual(HEALTH_PROMPT_DEFAULTS);
    expect(HEALTH_PROMPT_DEFAULTS).toEqual({
      enabled: true,
      template_path: null,
      policy_version: '1',
      probe_policy_max: 'observe_only',
      limits: {
        analysis_seconds: 180,
        tool_calls: 40,
        roles: 3,
        active_probes_per_node: 1,
        probes_per_run: 4,
        retries: 2,
        run_ttl_seconds: 900,
      },
      baseline: {
        profiles_dir: '/opt/xiNAS/healthcheck_profiles',
        timeout_s: { quick: 60, standard: 180, deep: 300 },
        max_age_s_default: 0,
      },
    });
  });

  it('overrides merge per key, nested blocks included', () => {
    const r = resolveHealthPromptConfig(
      withHp({
        enabled: false,
        template_path: '/etc/xinas/health-prompt.md',
        policy_version: 'site-2',
        probe_policy_max: 'bounded_active',
        limits: { probes_per_run: 0, run_ttl_seconds: 300 },
        baseline: { timeout_s: { deep: 120 }, profiles_dir: '/srv/profiles' },
      }),
    );
    expect(r.enabled).toBe(false);
    expect(r.template_path).toBe('/etc/xinas/health-prompt.md');
    expect(r.policy_version).toBe('site-2');
    expect(r.probe_policy_max).toBe('bounded_active');
    expect(r.limits).toEqual({
      analysis_seconds: 180,
      tool_calls: 40,
      roles: 3,
      active_probes_per_node: 1,
      probes_per_run: 0,
      retries: 2,
      run_ttl_seconds: 300,
    });
    expect(r.baseline).toEqual({
      profiles_dir: '/srv/profiles',
      timeout_s: { quick: 60, standard: 180, deep: 120 },
      max_age_s_default: 0,
    });
  });

  it.each([
    [{ unknown_key: 1 }, 'unknown key unknown_key'],
    [{ enabled: 'yes' }, 'enabled'],
    [{ limits: { analysis_seconds: 10 } }, 'analysis_seconds'],
    [{ limits: { tool_calls: 1000 } }, 'tool_calls'],
    [{ limits: { roles: 0 } }, 'roles'],
    [{ limits: { active_probes_per_node: 2 } }, 'active_probes_per_node'],
    [{ limits: { probes_per_run: 17 } }, 'probes_per_run'],
    [{ limits: { retries: 9 } }, 'retries'],
    [{ limits: { run_ttl_seconds: 100 } }, 'run_ttl_seconds'],
    [{ limits: { nope: 1 } }, 'limits: unknown key nope'],
    [{ probe_policy_max: 'anything' }, 'probe_policy_max'],
    [{ policy_version: 'has space' }, 'policy_version'],
    [{ template_path: 'relative.md' }, 'template_path'],
    [{ baseline: { profiles_dir: 'relative/dir' } }, 'profiles_dir'],
    [{ baseline: { timeout_s: { quick: 5 } } }, 'timeout_s.quick'],
    [{ baseline: { timeout_s: { deep: 5000 } } }, 'timeout_s.deep'],
    [{ baseline: { max_age_s_default: -1 } }, 'max_age_s_default'],
    [{ baseline: { nope: 1 } }, 'baseline: unknown key nope'],
  ])('rejects %j naming %s', (over, needle) => {
    expect(() => validateHealthPromptSection(withHp(over))).toThrow(needle);
  });

  it('accepts the boundaries of every range', () => {
    expect(() =>
      validateHealthPromptSection(
        withHp({
          limits: {
            analysis_seconds: 30,
            tool_calls: 500,
            roles: 8,
            active_probes_per_node: 1,
            probes_per_run: 16,
            retries: 5,
            run_ttl_seconds: 7200,
          },
          baseline: { timeout_s: { quick: 10, standard: 900, deep: 900 }, max_age_s_default: 3600 },
        }),
      ),
    ).not.toThrow();
  });
});
