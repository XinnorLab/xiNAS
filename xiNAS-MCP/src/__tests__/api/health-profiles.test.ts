import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  KNOWN_ENGINE_SECTIONS,
  SHIPPED_PROFILE_NAMES,
  loadProfileCatalog,
} from '../../api/health/profiles.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_PROFILES = resolve(here, '../../../../healthcheck_profiles');
const tmp = mkdtempSync(join(tmpdir(), 'xinas-profiles-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** S19b T2 — spec §8.2 / §6.2 `baselines`: the profile catalog the api loads at startup. */
describe('loadProfileCatalog', () => {
  it('lists the shipped profiles with hashes, timeouts and enabled sections', () => {
    const cat = loadProfileCatalog(REPO_PROFILES);
    expect(cat.dir_present).toBe(true);
    expect(cat.dir).toBe(REPO_PROFILES);
    expect(cat.profiles.map((p) => p.name).sort()).toEqual(['deep', 'quick', 'standard']);
    const standard = cat.profiles.find((p) => p.name === 'standard');
    expect(standard?.path).toBe(join(REPO_PROFILES, 'standard.yml'));
    expect(standard?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(standard?.timeout_seconds).toBe(300);
    expect(standard?.sections_enabled).toContain('storage');
    expect(standard?.sections_enabled).not.toContain('nvme_health');
    expect(standard?.sections_without_checker).toEqual([]);
    const deep = cat.profiles.find((p) => p.name === 'deep');
    expect(deep?.sections_enabled).toContain('nvme_health');
    // kerberos is enabled in deep.yml but the Python engine has no checker for it (G-03)
    expect(deep?.sections_without_checker).toEqual(['kerberos']);
    expect(KNOWN_ENGINE_SECTIONS).not.toContain('kerberos');
  });

  it('accepts only sane names, keeps a broken file with sha256 null, ignores non-yml files', () => {
    const dir = join(tmp, 'custom');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'custom.yml'),
      'profile: custom\ntimeout_seconds: 42\nsections:\n  storage: { enabled: true, checks: [raid_status] }\n  zzz: { enabled: true, checks: [x] }\n',
    );
    writeFileSync(join(dir, 'weird name.yml'), 'profile: weird\n');
    writeFileSync(join(dir, 'broken.yml'), 'profile: [unterminated\n');
    writeFileSync(join(dir, 'notes.txt'), 'not a profile');
    const cat = loadProfileCatalog(dir);
    expect(cat.profiles.map((p) => p.name).sort()).toEqual(['broken', 'custom']);
    const custom = cat.profiles.find((p) => p.name === 'custom');
    expect(custom).toMatchObject({
      timeout_seconds: 42,
      sections_enabled: ['storage', 'zzz'],
      sections_without_checker: ['zzz'],
    });
    const broken = cat.profiles.find((p) => p.name === 'broken');
    expect(broken?.sha256).toBeNull();
    expect(broken?.timeout_seconds).toBeNull();
    expect(broken?.sections_enabled).toEqual([]);
  });

  it('a missing directory yields the three shipped names with no path, and says the dir is absent', () => {
    const cat = loadProfileCatalog(join(tmp, 'does-not-exist'));
    expect(cat.dir_present).toBe(false);
    expect(cat.profiles.map((p) => p.name)).toEqual([...SHIPPED_PROFILE_NAMES]);
    for (const p of cat.profiles) {
      expect(p.path).toBeNull();
      expect(p.sha256).toBeNull();
      expect(p.timeout_seconds).toBeNull();
    }
  });
});
