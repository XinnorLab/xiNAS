import { describe, expect, it } from 'vitest';
import { HEALTH_PROMPT_DEFAULTS } from '../../api/config.js';
import type { DispatcherOptions } from '../../api/mcp/dispatch.js';
import { INSTRUCTIONS, buildCapabilities } from '../../api/mcp/discover.js';
import { handleModernRequest } from '../../api/mcp/modern.js';
import type { PromptsOptions } from '../../api/mcp/prompts.js';
import {
  HEALTH_PROMPT_NAME,
  HEALTH_PROMPT_TEMPLATE,
  HEALTH_PROMPT_VERSION,
  REPORT_SCHEMA_VERSION,
  createHealthPromptProvider,
} from '../../api/mcp/prompts/health-check.js';

/** S19b T4 — spec §4.1, §5.1: prompts on the modern era, advertised iff installed. */
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' };

const prompts: PromptsOptions = {
  providers: [
    createHealthPromptProvider({
      body: HEALTH_PROMPT_TEMPLATE,
      version: HEALTH_PROMPT_VERSION,
      policyVersion: '1',
      catalogVersion: '1',
      reportSchemaVersion: REPORT_SCHEMA_VERSION,
      probePolicyMax: 'observe_only',
      limits: HEALTH_PROMPT_DEFAULTS.limits,
      profileNames: () => ['quick', 'standard', 'deep'],
      available: {
        context: false,
        baseline: false,
        probe_run: true,
        catalog: false,
        report_schema: false,
        validate: false,
      },
    }),
  ],
};

const opts = (withPrompts: boolean): DispatcherOptions => ({
  loopback: async () => ({ status: 200, body: {} }),
  loopbackToken: () => 'unused',
  allowApply: () => false,
  identity: () => ({ principal: 'viewer:test', role: 'viewer' }),
  client: { era: 'modern', elicitation: new Set(), tasks: false },
  ...(withPrompts ? { prompts } : {}),
});

describe('prompts on the modern path (S19b T4)', () => {
  it('server/discover advertises prompts { listChanged: false } iff a provider is installed', async () => {
    expect(buildCapabilities({ prompts: true }).prompts).toEqual({ listChanged: false });
    expect(buildCapabilities({}).prompts).toBeUndefined();
    const on = await handleModernRequest(
      { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: META } },
      opts(true),
      'corr-d1',
    );
    expect((on.result as { capabilities: Record<string, unknown> }).capabilities.prompts).toEqual({
      listChanged: false,
    });
    const off = await handleModernRequest(
      { jsonrpc: '2.0', id: 2, method: 'server/discover', params: { _meta: META } },
      opts(false),
      'corr-d2',
    );
    expect(
      (off.result as { capabilities: Record<string, unknown> }).capabilities.prompts,
    ).toBeUndefined();
  });

  it('the instructions point at the prompt and say a prompt argument is not a probe permission', () => {
    expect(INSTRUCTIONS).toContain('xinas_health_check prompt');
    expect(INSTRUCTIONS).toContain('never implied by a prompt argument');
  });

  it('prompts/list and prompts/get answer with the modern shapes', async () => {
    const list = await handleModernRequest(
      { jsonrpc: '2.0', id: 'l', method: 'prompts/list', params: { _meta: META } },
      opts(true),
      'corr-l',
    );
    expect(list.error).toBeUndefined();
    expect(list.result).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'private' });
    expect(
      (list.result as { prompts: Array<{ name: string }> }).prompts.map((p) => p.name),
    ).toEqual([HEALTH_PROMPT_NAME]);

    const get = await handleModernRequest(
      {
        jsonrpc: '2.0',
        id: 'g',
        method: 'prompts/get',
        params: { _meta: META, name: HEALTH_PROMPT_NAME, arguments: { analysis_depth: 'triage' } },
      },
      opts(true),
      'corr-g',
    );
    expect(get.error).toBeUndefined();
    const result = get.result as {
      resultType: string;
      description: string;
      messages: Array<{ role: string; content: { type: string; text: string } }>;
    };
    expect(result.resultType).toBe('complete');
    expect(result.description).toContain(`prompt v${HEALTH_PROMPT_VERSION}`);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe('user');
    expect(result.messages[0]?.content.text).toContain('"analysis_depth": "triage"');
  });

  it('a bad argument is -32602 with data.argument; an unknown prompt too', async () => {
    const bad = await handleModernRequest(
      {
        jsonrpc: '2.0',
        id: 'b',
        method: 'prompts/get',
        params: { _meta: META, name: HEALTH_PROMPT_NAME, arguments: { time_window: '1h' } },
      },
      opts(true),
      'corr-b',
    );
    expect(bad.error).toMatchObject({ code: -32602, data: { argument: 'time_window' } });
    const unknown = await handleModernRequest(
      { jsonrpc: '2.0', id: 'u', method: 'prompts/get', params: { _meta: META, name: 'nope' } },
      opts(true),
      'corr-u',
    );
    expect(unknown.error).toMatchObject({ code: -32602, data: { argument: 'name' } });
  });

  it('both methods are -32601 when no provider is installed (like resources without a journal)', async () => {
    for (const method of ['prompts/list', 'prompts/get']) {
      const res = await handleModernRequest(
        { jsonrpc: '2.0', id: method, method, params: { _meta: META, name: HEALTH_PROMPT_NAME } },
        opts(false),
        'corr-off',
      );
      expect(res.error?.code).toBe(-32601);
    }
  });
});
