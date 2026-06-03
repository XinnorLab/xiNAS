import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseIdmapConf } from '../../../lib/parse/idmap.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('parseIdmapConf', () => {
  it('extracts Domain, Local-Realms, and Method from a typical idmapd.conf', () => {
    const raw = readFileSync(join(__dirname, '__fixtures__/idmapd.conf'), 'utf8');
    const result = parseIdmapConf(raw);
    expect(result.domain).toBe('xinas.local');
    expect(result.local_realms).toEqual(['XINAS.LOCAL', 'CORP.EXAMPLE.COM']);
    expect(result.method).toBe('nsswitch');
  });

  it('returns undefined optional fields when keys are absent', () => {
    const result = parseIdmapConf('[General]\nVerbosity = 0\n[Mapping]\nMethod = static');
    expect(result.domain).toBeUndefined();
    expect(result.local_realms).toBeUndefined();
    expect(result.method).toBe('static');
  });

  it('handles an empty or comment-only file gracefully', () => {
    const result = parseIdmapConf('# just a comment\n\n');
    expect(result.domain).toBeUndefined();
    expect(result.local_realms).toBeUndefined();
    expect(result.method).toBeUndefined();
  });
});
