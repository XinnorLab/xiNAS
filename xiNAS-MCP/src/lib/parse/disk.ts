/**
 * Pure parser for `lsblk --json` output. Emits typed Disk objects
 * matching api-v1.yaml's Disk schema (subset — full status fields
 * stamped by the agent's probe layer, not here).
 *
 * No side effects. Safe to import from anywhere.
 */

interface RawBlockDevice {
  name: string;
  type?: string;
  size?: string;
  model?: string;
  serial?: string;
  tran?: string;
  wwn?: string;
  children?: RawBlockDevice[];
}

export interface ObservedDisk {
  kind: 'Disk';
  id: string;
  status: {
    name: string;
    model?: string;
    serial?: string;
    transport?: string;
    wwn?: string;
    size_text?: string;
  };
}

export function parseLsblkOutput(raw: string): ObservedDisk[] {
  let parsed: { blockdevices?: RawBlockDevice[] };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `parseLsblkOutput: invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const devices = parsed.blockdevices ?? [];
  return devices
    .filter((d) => d.type === 'disk' || d.type === undefined)
    .map<ObservedDisk>((d) => ({
      kind: 'Disk',
      // PROVISIONAL: id is the device name here; the Phase E (E2) collector
      // replaces it with the stable serial+namespace key before the observation
      // is published to the api-v1.yaml Disk schema.
      id: d.name,
      status: {
        name: d.name,
        ...(d.model !== undefined ? { model: d.model } : {}),
        ...(d.serial !== undefined ? { serial: d.serial } : {}),
        ...(d.tran !== undefined ? { transport: d.tran } : {}),
        ...(d.wwn !== undefined ? { wwn: d.wwn } : {}),
        ...(d.size !== undefined ? { size_text: d.size } : {}),
      },
    }));
}
