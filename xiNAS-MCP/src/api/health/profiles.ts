/**
 * Baseline profile catalog (S19b T2; spec §8.2, §6.2 `baselines`).
 *
 * The api lists the Python health engine's YAML profiles ONCE at startup
 * (MCP-03: the prompt's argument catalog is fixed for the process
 * lifetime) and records, per profile, the file hash, the engine timeout,
 * the enabled sections and the enabled sections the engine has no checker
 * for (G-03: `kerberos` is enabled in deep.yml but not registered in the
 * engine's `section_map`, so it silently produces nothing today).
 *
 * `sections_without_checker` is computed against {@link KNOWN_ENGINE_SECTIONS}
 * — a copy of the engine's `section_map` keys — until S19c's
 * `python3 -m xinas_menu.health --sections` publishes the live list
 * (spec §8.5). A missing directory yields the three shipped names with no
 * path, so `prompts/get` keeps validating its default argument on a node
 * that has no profiles installed, and `health.context` says the directory
 * is absent instead of pretending.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import yaml from 'js-yaml';

export interface BaselineProfile {
  name: string;
  /** null = the file is not present (shipped-name fallback). */
  path: string | null;
  /** sha256 of the file bytes; null when absent or unparseable. */
  sha256: string | null;
  timeout_seconds: number | null;
  sections_enabled: string[];
  /** Enabled sections the Python engine cannot run (spec §8.5, AC-06). */
  sections_without_checker: string[];
}

export interface ProfileCatalog {
  dir: string;
  dir_present: boolean;
  profiles: BaselineProfile[];
}

/** The engine's `section_map` keys (xinas_menu/health/engine.py, 2026-09-09). */
export const KNOWN_ENGINE_SECTIONS: readonly string[] = [
  'services',
  'cpu',
  'kernel',
  'vm',
  'network',
  'rdma',
  'storage',
  'nvme_health',
  'filesystem',
  'perf_tuning',
  'nfs',
];

export const SHIPPED_PROFILE_NAMES = ['quick', 'standard', 'deep'] as const;

const PROFILE_NAME = /^[a-z0-9_-]{1,32}$/;

interface ProfileYaml {
  profile?: unknown;
  timeout_seconds?: unknown;
  sections?: Record<string, { enabled?: unknown } | undefined>;
}

function parseProfile(name: string, path: string): BaselineProfile {
  const bytes = readFileSync(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let doc: ProfileYaml;
  try {
    const loaded = yaml.load(bytes.toString('utf8'));
    if (loaded === null || typeof loaded !== 'object') throw new Error('not a mapping');
    doc = loaded as ProfileYaml;
  } catch (err) {
    console.warn(
      `health profiles: ${path} is not valid YAML (${err instanceof Error ? err.message : String(err)}); listed without sections`,
    );
    return {
      name,
      path,
      sha256: null,
      timeout_seconds: null,
      sections_enabled: [],
      sections_without_checker: [],
    };
  }
  const sections = doc.sections !== null && typeof doc.sections === 'object' ? doc.sections : {};
  const enabled = Object.entries(sections)
    .filter(([, v]) => v !== null && typeof v === 'object' && v?.enabled === true)
    .map(([k]) => k);
  return {
    name,
    path,
    sha256,
    timeout_seconds:
      typeof doc.timeout_seconds === 'number' && Number.isFinite(doc.timeout_seconds)
        ? doc.timeout_seconds
        : null,
    sections_enabled: enabled,
    sections_without_checker: enabled.filter((s) => !KNOWN_ENGINE_SECTIONS.includes(s)),
  };
}

export function loadProfileCatalog(dir: string): ProfileCatalog {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return {
      dir,
      dir_present: false,
      profiles: SHIPPED_PROFILE_NAMES.map((name) => ({
        name,
        path: null,
        sha256: null,
        timeout_seconds: null,
        sections_enabled: [],
        sections_without_checker: [],
      })),
    };
  }
  const profiles: BaselineProfile[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.yml')) continue;
    const name = basename(entry, '.yml');
    if (!PROFILE_NAME.test(name)) continue;
    const path = join(dir, entry);
    if (!statSync(path).isFile()) continue;
    profiles.push(parseProfile(name, path));
  }
  return { dir, dir_present: true, profiles };
}
