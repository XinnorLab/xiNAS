/**
 * Disk and NVMe info from sysfs — no subprocesses.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface BlockDeviceInfo {
  path: string;
  name: string;
  model: string;
  serial: string;
  firmware: string;
  size_bytes: number;
  logical_block_size: number;
  physical_block_size: number;
  rotational: boolean;
  nvme_ctrl?: string;
  health?: NvmeHealth;
}

export interface NvmeHealth {
  temperature_celsius: number | null;
  available_spare_pct: number | null;
  media_errors: number | null;
  critical_warning: number | null;
  power_on_hours: number | null;
  unsafe_shutdowns: number | null;
}

function readFile(p: string): string {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; }
}

function listDir(p: string): string[] {
  try { return fs.readdirSync(p); } catch { return []; }
}

function readNvmeHealth(ctrlName: string): NvmeHealth {
  const base = `/sys/class/nvme/${ctrlName}`;

  // Temperature from hwmon
  let temperature_celsius: number | null = null;
  const hwmons = listDir(base).filter(e => e.startsWith('hwmon'));
  for (const hwmon of hwmons) {
    const tempRaw = readFile(path.join(base, hwmon, 'temp1_input'));
    if (tempRaw) {
      temperature_celsius = parseInt(tempRaw) / 1000;
      break;
    }
  }

  // NVMe health log fields from sysfs
  const parseHex = (v: string) => v ? parseInt(v, 16) : null;
  const parseInt10 = (v: string) => v ? parseInt(v, 10) : null;

  const availSpareRaw = readFile(path.join(base, 'available_spare'));
  const mediaErrorsRaw = readFile(path.join(base, 'media_errors'));
  const critWarnRaw = readFile(path.join(base, 'critical_warning'));
  const powerOnHoursRaw = readFile(path.join(base, 'power_on_hours'));
  const unsafeShutdownsRaw = readFile(path.join(base, 'unsafe_shutdowns'));

  return {
    temperature_celsius,
    available_spare_pct: parseInt10(availSpareRaw),
    media_errors: parseInt10(mediaErrorsRaw) ?? parseHex(mediaErrorsRaw),
    critical_warning: parseInt10(critWarnRaw) ?? parseHex(critWarnRaw),
    power_on_hours: parseInt10(powerOnHoursRaw),
    unsafe_shutdowns: parseInt10(unsafeShutdownsRaw),
  };
}

/** Map NVMe controller to block device name */
function nvmeCtrlToBlockdev(): Map<string, string> {
  const result = new Map<string, string>();
  const nvmeDir = '/sys/class/nvme';
  for (const ctrl of listDir(nvmeDir)) {
    const nsDir = `/sys/class/nvme/${ctrl}`;
    for (const entry of listDir(nsDir)) {
      if (/^nvme\d+n\d+$/.test(entry)) {
        result.set(`/dev/${entry}`, ctrl);
      }
    }
  }
  return result;
}

export function listBlockDevices(): BlockDeviceInfo[] {
  const blockDir = '/sys/class/block';
  const devices = listDir(blockDir);
  const nvmeCtrlMap = nvmeCtrlToBlockdev();
  const result: BlockDeviceInfo[] = [];

  for (const dev of devices) {
    // Skip partitions and loop devices
    if (/\d$/.test(dev) || dev.startsWith('loop') || dev.startsWith('dm-') || dev.startsWith('sr')) {
      continue;
    }
    // Include nvme namespaces and sata drives
    if (!dev.startsWith('nvme') && !dev.startsWith('sd') && !dev.startsWith('hd')) continue;

    const base = path.join(blockDir, dev);
    const devicePath = `/dev/${dev}`;

    const model = readFile(path.join(base, 'device/model')) ||
                  readFile(path.join(base, 'device/device/model'));
    const serial = readFile(path.join(base, 'device/serial'));
    const firmware = readFile(path.join(base, 'device/firmware_rev')) ||
                     readFile(path.join(base, 'device/firmware_version'));

    const sizeRaw = readFile(path.join(base, 'size'));
    const size_bytes = sizeRaw ? parseInt(sizeRaw) * 512 : 0;

    const logicalBs = parseInt(readFile(path.join(base, 'queue/logical_block_size')) || '512');
    const physBs = parseInt(readFile(path.join(base, 'queue/physical_block_size')) || '512');
    const rotRaw = readFile(path.join(base, 'queue/rotational'));
    const rotational = rotRaw === '1';

    const nvme_ctrl = nvmeCtrlMap.get(devicePath);
    const health = nvme_ctrl ? readNvmeHealth(nvme_ctrl) : undefined;

    result.push({
      path: devicePath,
      name: dev,
      model: model.replace(/\s+/g, ' '),
      serial,
      firmware,
      size_bytes,
      logical_block_size: logicalBs,
      physical_block_size: physBs,
      rotational,
      ...(nvme_ctrl ? { nvme_ctrl } : {}),
      ...(health ? { health } : {}),
    });
  }

  return result;
}
