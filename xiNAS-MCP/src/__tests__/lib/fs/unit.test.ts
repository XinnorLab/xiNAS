import { describe, expect, it } from 'vitest';
import {
  deviceUnitFor,
  quotaFlagFor,
  renderMountUnit,
  unitNameForMountpoint,
} from '../../../lib/fs/unit.js';

describe('unitNameForMountpoint (systemd-escape -p semantics)', () => {
  it.each([
    ['/mnt/data', 'mnt-data.mount'],
    ['/srv/share01', 'srv-share01.mount'],
    ['/', '-.mount'],
    // embedded dash inside a path component → \x2d
    ['/mnt/my-disk', 'mnt-my\\x2ddisk.mount'],
    // space → \x20
    ['/mnt/a b', 'mnt-a\\x20b.mount'],
    // underscore is allowed, kept verbatim
    ['/mnt/xi_data', 'mnt-xi_data.mount'],
    // trailing slash is normalized away
    ['/mnt/data/', 'mnt-data.mount'],
    // leading dot of a component is escaped
    ['/mnt/.hidden', 'mnt-\\x2ehidden.mount'],
  ])('%s → %s', (mountpoint, expected) => {
    expect(unitNameForMountpoint(mountpoint)).toBe(expected);
  });
});

describe('deviceUnitFor', () => {
  it.each([
    ['/dev/xi_data', 'dev-xi_data.device'],
    ['/dev/xi_log', 'dev-xi_log.device'],
    ['/dev/md/raid-0', 'dev-md-raid\\x2d0.device'],
  ])('%s → %s', (dev, expected) => {
    expect(deviceUnitFor(dev)).toBe(expected);
  });
});

describe('quotaFlagFor', () => {
  it('maps the modes', () => {
    expect(quotaFlagFor('none')).toBeUndefined();
    expect(quotaFlagFor('uquota')).toBe('uquota');
    expect(quotaFlagFor('gquota')).toBe('gquota');
    expect(quotaFlagFor('pquota')).toBe('pquota');
  });
});

describe('renderMountUnit (day-1 template parity)', () => {
  it('full render with log device + quota', () => {
    const text = renderMountUnit({
      what: '/dev/xi_data',
      where: '/mnt/data',
      log_device: '/dev/xi_log',
      mount_options: ['noatime', 'nodiratime', 'logbsize=256k'],
      quota_mode: 'uquota',
    });
    expect(text).toBe(
      [
        '[Unit]',
        'Description=xiNAS data',
        'Requires=dev-xi_data.device dev-xi_log.device',
        'After=dev-xi_data.device dev-xi_log.device',
        'Before=umount.target',
        'Conflicts=umount.target',
        '',
        '[Mount]',
        'What=/dev/xi_data',
        'Where=/mnt/data',
        'Options=defaults,noatime,nodiratime,logbsize=256k,logdev=/dev/xi_log,uquota',
        'Type=xfs',
        '',
        '[Install]',
        'WantedBy=local-fs.target',
        '',
      ].join('\n'),
    );
  });

  it('minimal render: no log device, no extra options, no quota', () => {
    const text = renderMountUnit({ what: '/dev/xi_a', where: '/srv/a' });
    expect(text).toContain('Requires=dev-xi_a.device\n');
    expect(text).toContain('Options=defaults\n');
    expect(text).not.toContain('logdev=');
  });

  it('options never duplicate the quota flag or logdev', () => {
    const text = renderMountUnit({
      what: '/dev/xi_a',
      where: '/srv/a',
      log_device: '/dev/xi_l',
      mount_options: ['logdev=/dev/xi_l', 'uquota', 'noatime'],
      quota_mode: 'uquota',
    });
    const options = /Options=(.*)\n/.exec(text)?.[1]?.split(',') ?? [];
    expect(options.filter((o) => o === 'uquota')).toHaveLength(1);
    expect(options.filter((o) => o.startsWith('logdev='))).toHaveLength(1);
  });
});
