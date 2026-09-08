import { describe, expect, it } from 'vitest';
import {
  affectedResourcesText,
  handoffArguments,
  handoffMessage,
} from '../../mcp-apps/plan-facts.js';

// S18 spec §7.1: the View shows the plan's affected resources. The text
// follows the S15 confirmation message convention (`kind id`, `; `-joined)
// so the operator reads the same list in the App and in the MRTR prompt.
describe('affectedResourcesText (S18 plan panel)', () => {
  it('lists every affected resource as "kind id", separated by "; "', () => {
    expect(
      affectedResourcesText([
        { kind: 'Array', id: 'data' },
        { kind: 'Disk', id: 'disk-01' },
      ]),
    ).toBe('Array data; Disk disk-01');
  });

  it('says "(none listed)" for an empty or absent list', () => {
    expect(affectedResourcesText([])).toBe('(none listed)');
    expect(affectedResourcesText(undefined)).toBe('(none listed)');
  });

  it('keeps an entry with a missing id readable instead of printing "undefined"', () => {
    expect(affectedResourcesText([{ kind: 'Array' }])).toBe('Array');
  });
});

describe('handoff (S18 §7.2, §8)', () => {
  it('builds exactly the four apply arguments, defaulting the revision to 0', () => {
    expect(handoffArguments({ plan_id: 'p1', state_revision_expected: 7 }, 'k1')).toEqual({
      mode: 'apply',
      plan_id: 'p1',
      expected_revision: 7,
      idempotency_key: 'k1',
    });
    expect(Object.keys(handoffArguments({ plan_id: 'p2' }, 'k2'))).toEqual([
      'mode',
      'plan_id',
      'expected_revision',
      'idempotency_key',
    ]);
    expect(handoffArguments({ plan_id: 'p2' }, 'k2').expected_revision).toBe(0);
  });

  it('tells the host to follow the native task handle or the tasks.wait fallback, whichever it receives', () => {
    const args = handoffArguments({ plan_id: 'p1' }, 'k1');
    const text = handoffMessage({ create: 'arrays.create', task_wait: 'tasks.wait' }, args);
    expect(text).toContain('Call arrays.create with exactly these arguments:');
    expect(text).toContain(JSON.stringify(args, null, 2));
    expect(text).toContain('resultType "task"');
    expect(text).toContain('tasks/get');
    expect(text).toContain('pollIntervalMs');
    expect(text).toContain('isError');
    expect(text).toContain('resultType "complete"');
    expect(text).toContain('tasks.wait');
    expect(text).toContain('initialization continues in the background');
    expect(text).not.toMatch(/bearer|token|requestState/i);
  });
});
