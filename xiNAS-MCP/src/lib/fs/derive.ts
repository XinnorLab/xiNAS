/**
 * Stripe-geometry derivation for mkfs.xfs (S5, ADR-0007): su/sw from the
 * BACKING ARRAY's observed spec, mirroring the day-1 raid_fs role
 * (su = the array strip size; sw = data-drive count = members − parity).
 *
 * Pure. No I/O.
 */

export interface BackingArraySpec {
  level: string;
  member_disk_ids: string[];
  strip_size_kib?: number | null;
  group_size?: number | null;
  synd_cnt?: number | null;
}

export interface DerivedStripe {
  su_kb: number;
  sw: number;
}

/** Parity-drive count for a level, or undefined when underivable. */
function parityFor(spec: BackingArraySpec): number | undefined {
  const members = spec.member_disk_ids.length;
  const groups =
    spec.group_size !== undefined && spec.group_size !== null && spec.group_size > 0
      ? members / spec.group_size
      : undefined;
  switch (spec.level) {
    case 'raid0':
      return 0;
    case 'raid1':
      return members - 1;
    case 'raid5':
      return 1;
    case 'raid6':
      return 2;
    case 'raid7':
      return 3;
    case 'raid10':
      return members / 2;
    case 'raid50':
      return groups !== undefined && Number.isInteger(groups) ? groups * 1 : undefined;
    case 'raid60':
      return groups !== undefined && Number.isInteger(groups) ? groups * 2 : undefined;
    case 'raid70':
      return groups !== undefined && Number.isInteger(groups) ? groups * 3 : undefined;
    case 'n+m':
      return spec.synd_cnt ?? undefined;
    default:
      return undefined;
  }
}

/** su/sw for mkfs, or undefined when the geometry is unknown. */
export function deriveStripe(spec: BackingArraySpec): DerivedStripe | undefined {
  const su = spec.strip_size_kib;
  if (su === undefined || su === null || su <= 0) return undefined;
  const parity = parityFor(spec);
  if (parity === undefined) return undefined;
  const sw = spec.member_disk_ids.length - parity;
  if (!Number.isInteger(sw) || sw < 1) return undefined;
  return { su_kb: su, sw };
}
