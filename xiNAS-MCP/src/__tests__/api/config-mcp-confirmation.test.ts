import { describe, expect, it } from 'vitest';
import {
  type ApiConfig,
  confirmationKeyPathFor,
  loadConfig,
  resolveConfirmationConfig,
} from '../../api/config.js';

function inline(mcp: Record<string, unknown>): ApiConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = {
    controller_id: '00000000-0000-0000-0000-0000000000aa',
    listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
    tokens: {},
    state: { databasePath: '/var/lib/xinas/state/xinas.db', auditJsonlPath: '/tmp/a.jsonl' },
  };
  if (Object.keys(mcp).length > 0) {
    result.mcp = mcp;
  }
  return result as ApiConfig;
}

describe('mcp.confirmation config (S15 §13)', () => {
  it('applies the defaults when the section is absent', () => {
    const r = resolveConfirmationConfig(inline({}));
    expect(r).toEqual({
      ttl_seconds: 300,
      url_wait_seconds: 25,
      max_pending_per_principal: 5,
      max_pending_total: 100,
      create_rate_per_minute: 10,
      approval_url_base: undefined,
      approver_policy: 'distinct_principal',
      allow_uds_approval: false,
    });
    expect(confirmationKeyPathFor(inline({}))).toBe(
      '/var/lib/xinas/state/mcp-confirmation-keys.json',
    );
  });

  it.each([
    ['ttl_seconds', 59],
    ['ttl_seconds', 901],
    ['url_wait_seconds', 0],
    ['url_wait_seconds', 56],
    ['max_pending_per_principal', 51],
    ['max_pending_total', 0],
    ['create_rate_per_minute', 601],
  ])('rejects %s = %s at load', (key, value) => {
    expect(() => loadConfig({ inline: inline({ confirmation: { [key]: value } }) })).toThrow(
      new RegExp(`mcp.confirmation.${key}`),
    );
  });

  it('rejects an unknown approver_policy and a non-boolean allow_uds_approval', () => {
    expect(() =>
      loadConfig({ inline: inline({ confirmation: { approver_policy: 'anyone' } }) }),
    ).toThrow(/approver_policy/);
    expect(() =>
      loadConfig({ inline: inline({ confirmation: { allow_uds_approval: 'yes' } }) }),
    ).toThrow(/allow_uds_approval/);
  });

  it('approval_url_base must be https, or http on a loopback host; trailing slash is stripped', () => {
    expect(
      resolveConfirmationConfig(
        inline({ confirmation: { approval_url_base: 'https://nas-01.example.com/' } }),
      ).approval_url_base,
    ).toBe('https://nas-01.example.com');
    expect(
      resolveConfirmationConfig(
        inline({ confirmation: { approval_url_base: 'http://127.0.0.1:8080' } }),
      ).approval_url_base,
    ).toBe('http://127.0.0.1:8080');
    expect(() =>
      loadConfig({ inline: inline({ confirmation: { approval_url_base: 'http://nas-01:8080' } }) }),
    ).toThrow(/approval_url_base/);
    expect(() =>
      loadConfig({ inline: inline({ confirmation: { approval_url_base: 'not a url' } }) }),
    ).toThrow(/approval_url_base/);
  });
});
