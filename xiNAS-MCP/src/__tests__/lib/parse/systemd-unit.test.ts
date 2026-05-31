import { describe, it, expect } from 'vitest';
import { parseSystemdUnit } from '../../../lib/parse/systemd-unit.js';

const MOUNT_UNIT = `
[Unit]
Description=XFS mount for share01
After=local-fs.target

[Mount]
What=/dev/md/xinas-data
Where=/srv/share01
Type=xfs
Options=defaults,noatime

[Install]
WantedBy=local-fs.target
`.trim();

const SERVICE_UNIT = `
[Unit]
Description=xinas-api service

[Service]
ExecStart=/usr/bin/node /opt/xinas/server.js
Environment=NODE_ENV=production
Environment=PORT=8080
Restart=on-failure

[Install]
WantedBy=multi-user.target
`.trim();

describe('parseSystemdUnit', () => {
  it('parses a .mount unit with [Unit], [Mount], and [Install] sections', () => {
    const result = parseSystemdUnit(MOUNT_UNIT);
    expect(result.unit?.['Description']).toBe('XFS mount for share01');
    expect(result.mount?.['What']).toBe('/dev/md/xinas-data');
    expect(result.mount?.['Where']).toBe('/srv/share01');
    expect(result.mount?.['Type']).toBe('xfs');
    expect(result.mount?.['Options']).toBe('defaults,noatime');
    expect(result.install?.['WantedBy']).toBe('local-fs.target');
  });

  it('collects repeated keys as an array for the last-value-wins case (Environment=)', () => {
    const result = parseSystemdUnit(SERVICE_UNIT);
    expect(result.service?.['ExecStart']).toBe('/usr/bin/node /opt/xinas/server.js');
    // Environment appears twice — multi-value; stored as string[] when repeated
    const env = result.service?.['Environment'];
    expect(Array.isArray(env)).toBe(true);
    expect(env).toContain('NODE_ENV=production');
    expect(env).toContain('PORT=8080');
  });

  it('returns empty section maps for unknown/absent sections', () => {
    const result = parseSystemdUnit('[Unit]\nDescription=Bare unit');
    expect(result.unit?.['Description']).toBe('Bare unit');
    expect(result.mount).toBeUndefined();
    expect(result.service).toBeUndefined();
    expect(result.install).toBeUndefined();
  });
});
