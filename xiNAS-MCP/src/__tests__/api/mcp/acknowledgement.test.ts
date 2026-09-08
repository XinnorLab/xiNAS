import { describe, expect, it } from 'vitest';
import {
  ACK_DATA_LOSS,
  ACK_NO_ROLLBACK,
  requiredAcknowledgement,
} from '../../../api/mcp/confirmation/types.js';

// S15 §9.2 — the exhaustive risk × rollback table, written out as literal
// expectations (not recomputed with the function's own conditional) so the
// test can actually catch a wrong branch instead of restating it. Data loss
// is the worse fact, so a destructive record requires the data-loss phrase
// even when its rollback is also unsupported (report S-02: the page's
// rollback_limitation sentence carries the second fact).
describe('requiredAcknowledgement (S15 §9.2)', () => {
  it.each([
    ['non_disruptive', 'non_disruptive', undefined],
    ['non_disruptive', 'changing_access', undefined],
    ['non_disruptive', 'destructive', undefined],
    ['non_disruptive', 'unsupported', ACK_NO_ROLLBACK],
    ['changing_access', 'non_disruptive', undefined],
    ['changing_access', 'changing_access', undefined],
    ['changing_access', 'destructive', undefined],
    ['changing_access', 'unsupported', ACK_NO_ROLLBACK],
    ['destructive', 'non_disruptive', ACK_DATA_LOSS],
    ['destructive', 'changing_access', ACK_DATA_LOSS],
    ['destructive', 'destructive', ACK_DATA_LOSS],
    ['destructive', 'unsupported', ACK_DATA_LOSS],
    ['unsupported_rollback', 'non_disruptive', ACK_NO_ROLLBACK],
    ['unsupported_rollback', 'changing_access', ACK_NO_ROLLBACK],
    ['unsupported_rollback', 'destructive', ACK_NO_ROLLBACK],
    ['unsupported_rollback', 'unsupported', ACK_NO_ROLLBACK],
  ])('risk %s × rollback %s', (risk_level, rollback_model, expected) => {
    expect(requiredAcknowledgement({ risk_level, rollback_model })).toBe(expected);
  });

  it('destructive + unsupported rollback requires the data-loss phrase, not the rollback phrase', () => {
    expect(
      requiredAcknowledgement({ risk_level: 'destructive', rollback_model: 'unsupported' }),
    ).toBe(ACK_DATA_LOSS);
  });
});
