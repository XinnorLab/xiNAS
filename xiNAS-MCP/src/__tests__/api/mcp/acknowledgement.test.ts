import { describe, expect, it } from 'vitest';
import {
  ACK_DATA_LOSS,
  ACK_NO_ROLLBACK,
  requiredAcknowledgement,
} from '../../../api/mcp/confirmation/types.js';

// S15 §9.2 — the exhaustive risk × rollback table. Data loss is the worse
// fact, so a destructive record requires the data-loss phrase even when its
// rollback is also unsupported (report S-02: the page's rollback_limitation
// sentence carries the second fact).
describe('requiredAcknowledgement (S15 §9.2)', () => {
  const risks = ['non_disruptive', 'changing_access', 'destructive', 'unsupported_rollback'];
  const models = ['non_disruptive', 'changing_access', 'destructive', 'unsupported'];

  it.each(
    risks.flatMap((risk_level) => models.map((rollback_model) => [risk_level, rollback_model])),
  )('risk %s × rollback %s', (risk_level, rollback_model) => {
    const expected =
      risk_level === 'destructive'
        ? ACK_DATA_LOSS
        : risk_level === 'unsupported_rollback' || rollback_model === 'unsupported'
          ? ACK_NO_ROLLBACK
          : undefined;
    expect(requiredAcknowledgement({ risk_level, rollback_model })).toBe(expected);
  });

  it('destructive + unsupported rollback requires the data-loss phrase, not the rollback phrase', () => {
    expect(
      requiredAcknowledgement({ risk_level: 'destructive', rollback_model: 'unsupported' }),
    ).toBe(ACK_DATA_LOSS);
  });
});
