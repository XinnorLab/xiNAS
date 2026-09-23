import { describe, expect, it } from 'vitest';
import { parseEtab } from '../../../lib/parse/etab.js';

// Verbatim shape of nfs-utils 2.6 etab lines (xinas-box, Ubuntu 24.04):
// every option expanded, `sec=` explicit, one client per line.
const ETAB =
  '/mnt/data\t*(rw,sync,no_wdelay,hide,nocrossmnt,insecure,no_root_squash,no_all_squash,no_subtree_check,secure_locks,acl,no_pnfs,anonuid=65534,anongid=65534,sec=sys,rw,insecure,no_root_squash,no_all_squash)\n' +
  '/srv/ro\t10.10.0.0/16(ro,sync,wdelay,hide,nocrossmnt,secure,root_squash,no_all_squash,no_subtree_check,secure_locks,acl,no_pnfs,anonuid=65534,anongid=65534,sec=sys,ro,secure,root_squash,no_all_squash)\n' +
  '/srv/with\\040space\t@trusted(rw,sync,wdelay,hide,nocrossmnt,secure,root_squash,no_all_squash,no_subtree_check,secure_locks,acl,no_pnfs,anonuid=65534,anongid=65534,sec=krb5p:sys,rw,secure,root_squash,no_all_squash)\n';

describe('parseEtab', () => {
  it('parses path, client and the expanded option list per line', () => {
    const rows = parseEtab(ETAB);
    expect(rows.map((r) => [r.export_path, r.host_pattern])).toEqual([
      ['/mnt/data', '*'],
      ['/srv/ro', '10.10.0.0/16'],
      ['/srv/with space', '@trusted'],
    ]);
    expect(rows[0]?.options.slice(0, 3)).toEqual(['rw', 'sync', 'no_wdelay']);
    expect(rows[0]?.options).toContain('sec=sys');
    expect(rows[1]?.options).toContain('ro');
    expect(rows[2]?.options).toContain('sec=krb5p:sys');
  });

  it('skips blank, comment and malformed lines instead of failing the read', () => {
    const rows = parseEtab(
      '\n# comment\n/broken\n/also broken\tclient-without-parens\n/ok\t*(rw)\n',
    );
    expect(rows).toEqual([{ export_path: '/ok', host_pattern: '*', options: ['rw'] }]);
  });

  it('an empty table is an empty list (nothing exported), not an error', () => {
    expect(parseEtab('')).toEqual([]);
  });
});
