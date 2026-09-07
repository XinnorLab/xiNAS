import { describe, expect, it } from 'vitest';
import { createSystemctlProbe } from '../../../agent/probe/systemd.js';

/** S17 D-18 (agent-spec amendment): the units the system feed watches. */
describe('systemd probe allow-list — S17 additions', () => {
  it('observes the nfs-helper and the xiRAID daemon units alongside the S7 set', () => {
    const { allowList } = createSystemctlProbe({ execFile: (() => {}) as never });
    for (const unit of [
      'nfs-server.service',
      'nfs-mountd.service',
      'nfs-idmapd.service',
      'xinas-api.service',
      'xinas-agent.service',
      'xinas-nfs-helper.service',
      'xiraid-server.service',
    ]) {
      expect(allowList, unit).toContain(unit);
    }
    expect(allowList).not.toContain('xinas-mcp.service');
    expect(new Set(allowList).size).toBe(allowList.length);
  });
});
