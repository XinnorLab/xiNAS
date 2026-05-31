import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mountUnitToFilesystem } from '../../../lib/parse/filesystem.js';
import { parseSystemdUnit } from '../../../lib/parse/systemd-unit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('mountUnitToFilesystem', () => {
  it('converts a real .mount unit file into an ObservedFilesystem', () => {
    const raw = readFileSync(join(__dirname, '__fixtures__/srv-share01.mount'), 'utf8');
    const parsed = parseSystemdUnit(raw);
    const fs = mountUnitToFilesystem(parsed, 'srv-share01.mount', true);

    expect(fs.kind).toBe('Filesystem');
    expect(fs.id).toBe('srv-share01.mount');
    expect(fs.spec.mountpoint).toBe('/srv/share01');
    expect(fs.spec.fs_type).toBe('xfs');
    expect(fs.spec.backing_device).toBe('/dev/md/xinas-data');
    expect(fs.status.mount_unit_name).toBe('srv-share01.mount');
    expect(fs.status.mount_unit_enabled).toBe(true);
  });

  it('marks a disabled unit as mount_unit_enabled = false', () => {
    const raw = readFileSync(
      fileURLToPath(new URL('./__fixtures__/srv-share01.mount', import.meta.url)),
      'utf8',
    );
    const parsed = parseSystemdUnit(raw);
    const fs = mountUnitToFilesystem(parsed, 'srv-share01.mount', false);
    expect(fs.status.mount_unit_enabled).toBe(false);
  });

  it('handles a minimal .mount unit with only [Mount] What/Where', () => {
    const parsed = parseSystemdUnit('[Mount]\nWhat=/dev/sdb1\nWhere=/data');
    const fs = mountUnitToFilesystem(parsed, 'data.mount', true);
    expect(fs.spec.mountpoint).toBe('/data');
    expect(fs.spec.backing_device).toBe('/dev/sdb1');
    expect(fs.spec.fs_type).toBeUndefined();
  });
});
