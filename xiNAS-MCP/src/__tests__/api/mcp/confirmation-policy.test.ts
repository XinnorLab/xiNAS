import { describe, expect, it } from 'vitest';
import { CATALOG } from '../../../api/mcp/catalog.js';
import { McpProtocolError } from '../../../api/mcp/confirmation/errors.js';
import {
  argumentsHash,
  confirmationModeFor,
  elicitationModes,
  isConfirmable,
  parseMrtrParams,
} from '../../../api/mcp/confirmation/policy.js';

const entry = (name: string) => CATALOG.find((e) => e.name === name) as (typeof CATALOG)[number];

describe('confirmation policy (S15 §3, §14)', () => {
  it('maps risk × rollback to the confirmation mode', () => {
    expect(confirmationModeFor('non_disruptive', 'non_disruptive')).toBe('form');
    expect(confirmationModeFor('changing_access', 'changing_access')).toBe('form');
    expect(confirmationModeFor('destructive', 'destructive')).toBe('url');
    expect(confirmationModeFor('unsupported_rollback', 'destructive')).toBe('url');
    expect(confirmationModeFor('non_disruptive', 'unsupported')).toBe('url');
  });

  it('argumentsHash is stable under key order and sensitive to values', () => {
    const a = argumentsHash('shares.update', { id: 's', mode: 'apply', plan_id: 'p' });
    const b = argumentsHash('shares.update', { plan_id: 'p', mode: 'apply', id: 's' });
    expect(a).toBe(b);
    expect(argumentsHash('shares.update', { id: 's', mode: 'apply', plan_id: 'q' })).not.toBe(a);
    expect(argumentsHash('shares.delete', { id: 's', mode: 'apply', plan_id: 'p' })).not.toBe(a);
  });

  it('elicitationModes: absent → none; {} → form; explicit keys → those', () => {
    const key = 'io.modelcontextprotocol/clientCapabilities';
    expect([...elicitationModes(undefined)]).toEqual([]);
    expect([...elicitationModes({ [key]: {} })]).toEqual([]);
    expect([...elicitationModes({ [key]: { elicitation: {} } })]).toEqual(['form']);
    expect([...elicitationModes({ [key]: { elicitation: { url: {} } } })]).toEqual(['url']);
    expect([...elicitationModes({ [key]: { elicitation: { form: {}, url: {} } } })].sort()).toEqual(
      ['form', 'url'],
    );
  });

  it('elicitationModes (F4): array elicitation, null-valued keys, and object-valued keys', () => {
    const key = 'io.modelcontextprotocol/clientCapabilities';
    expect([...elicitationModes({ [key]: { elicitation: [] } })]).toEqual([]);
    expect([...elicitationModes({ [key]: { elicitation: { form: null } } })]).toEqual([]);
    expect([...elicitationModes({ [key]: { elicitation: { form: {}, url: {} } } })].sort()).toEqual(
      ['form', 'url'],
    );
  });

  it('A11 (Task 9 follow-up): an ARRAY-valued capability key declares nothing', () => {
    const key = 'io.modelcontextprotocol/clientCapabilities';
    // A capability object is an OBJECT. `{ form: [] }` is a malformed
    // declaration, and treating it as "form supported" would send an
    // elicitation to a client that cannot answer it.
    expect([...elicitationModes({ [key]: { elicitation: { form: [] } } })]).toEqual([]);
    expect([...elicitationModes({ [key]: { elicitation: { url: [1, 2] } } })]).toEqual([]);
    // …and a malformed key does NOT fall back to the bare-{} form-only rule
    // (a key IS present, it is just not a capability object).
    expect([...elicitationModes({ [key]: { elicitation: { form: [], url: {} } } })]).toEqual([
      'url',
    ]);
  });

  it('isConfirmable: plan_apply+apply, direct+requires_mcp_apply, explicit opt-in; nothing else', () => {
    expect(isConfirmable(entry('shares.update'), { mode: 'apply' })).toBe(true);
    expect(isConfirmable(entry('shares.update'), { mode: 'plan' })).toBe(false);
    expect(isConfirmable(entry('arrays.list'), {})).toBe(false);
    expect(isConfirmable(entry('support.bundle'), {})).toBe(false);
    expect(isConfirmable(entry('tasks.cancel'), { id: 't' })).toBe(false);
    expect(isConfirmable({ ...entry('support.bundle'), requires_mcp_apply: true }, {})).toBe(true);
    expect(isConfirmable({ ...entry('arrays.list'), confirmation: 'required' }, {})).toBe(true);
  });

  it('parseMrtrParams accepts bare ElicitResults and rejects wrappers, bad actions and oversize state', () => {
    expect(parseMrtrParams({})).toEqual({});
    expect(
      parseMrtrParams({
        inputResponses: { confirm_apply: { action: 'accept', content: { decision: 'APPLY' } } },
        requestState: 'xc1.k.b.m',
      }),
    ).toEqual({
      inputResponses: { confirm_apply: { action: 'accept', content: { decision: 'APPLY' } } },
      requestState: 'xc1.k.b.m',
    });
    for (const bad of [
      { inputResponses: 'nope' },
      {
        inputResponses: {
          confirm_apply: { method: 'elicitation/create', result: { action: 'accept' } },
        },
      },
      { inputResponses: { confirm_apply: { action: 'yes' } } },
      { inputResponses: { confirm_apply: { action: 'accept', content: { nested: { a: 1 } } } } },
    ]) {
      expect(() => parseMrtrParams(bad)).toThrow(McpProtocolError);
      expect(() => parseMrtrParams(bad)).toThrow('invalid params: inputResponses');
    }
    expect(() => parseMrtrParams({ requestState: 42 })).toThrow('invalid params: requestState');
    expect(() => parseMrtrParams({ requestState: 'x'.repeat(4097) })).toThrow(
      'invalid params: requestState',
    );
  });
});
