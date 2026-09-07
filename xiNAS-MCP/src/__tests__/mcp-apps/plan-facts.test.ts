import { describe, expect, it } from 'vitest';
import { affectedResourcesText } from '../../mcp-apps/plan-facts.js';

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
