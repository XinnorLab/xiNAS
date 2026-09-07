import { describe, expect, it } from 'vitest';
import {
  TASKS_EXTENSION_ID,
  missingTasksCapability,
  parseTasksCapability,
} from '../../../api/mcp/tasks/capability.js';

const meta = (caps: unknown) => ({ 'io.modelcontextprotocol/clientCapabilities': caps });

describe('parseTasksCapability (S16 §3.1)', () => {
  it('absent → false', () => {
    expect(parseTasksCapability(undefined)).toBe(false);
    expect(parseTasksCapability({})).toBe(false);
    expect(parseTasksCapability(meta({}))).toBe(false);
    expect(parseTasksCapability(meta({ elicitation: {} }))).toBe(false);
    expect(parseTasksCapability(meta({ extensions: {} }))).toBe(false);
    expect(parseTasksCapability(meta({ extensions: { 'io.example/other': {} } }))).toBe(false);
  });
  it('declared → true', () => {
    expect(parseTasksCapability(meta({ extensions: { [TASKS_EXTENSION_ID]: {} } }))).toBe(true);
    expect(parseTasksCapability(meta({ extensions: { [TASKS_EXTENSION_ID]: { x: 1 } } }))).toBe(
      true,
    );
  });
  it('malformed → -32602', () => {
    for (const bad of [null, true, 'yes', [], 1]) {
      expect(() =>
        parseTasksCapability(meta({ extensions: { [TASKS_EXTENSION_ID]: bad } })),
      ).toThrow(expect.objectContaining({ code: -32602 }));
    }
    expect(() => parseTasksCapability(meta({ extensions: 'nope' }))).toThrow(
      expect.objectContaining({ code: -32602 }),
    );
  });
  it('the -32021 error carries the exact requiredCapabilities and HTTP 400', () => {
    const err = missingTasksCapability();
    expect(err.code).toBe(-32021);
    expect(err.httpStatus).toBe(400);
    expect(err.message).toBe('Missing required client capability');
    expect(err.data).toEqual({
      requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } },
    });
    expect(JSON.parse(JSON.stringify(err))).not.toHaveProperty('reasonClass');
  });
});
