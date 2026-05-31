/**
 * Architecture boundary test: pure-vs-probe import isolation.
 *
 * Enforces the rule from docs/control-path/xinas-agent-s0s1-spec.md
 * §"Code layout — pure vs. probe boundary":
 *
 *   src/agent/probe/*  must NOT be imported from outside src/agent/.
 *
 * The biome noRestrictedImports rule (biome 1.9.4) only matches exact
 * specifiers, so sub-path imports like '../../agent/probe/disk.js' slip
 * past it. This test is the real gate: it scans every .ts file under
 * src/ that is NOT inside src/agent/ and fails loudly if any such file
 * contains a static or dynamic import whose specifier contains 'agent/probe'.
 *
 * The test is vacuously green until agent code actually lands; once it
 * does, any attempt to break the boundary is caught immediately.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
// Resolve to xiNAS-MCP/src
const srcDir = join(here, '..', '..');

/** Recursively collect all .ts files under a directory. */
function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

/** Patterns that match any import/export-from referencing agent/probe. */
const STATIC_IMPORT = /from\s+['"][^'"]*agent\/probe[^'"]*['"]/g;
const DYNAMIC_IMPORT = /import\(\s*['"][^'"]*agent\/probe[^'"]*['"]/g;

describe('probe-boundary', () => {
  it('no file outside src/agent/ imports from agent/probe', () => {
    const agentDir = join(srcDir, 'agent');

    // Determine whether src/agent/ exists yet; if not the boundary holds vacuously.
    let agentExists = false;
    try {
      agentExists = statSync(agentDir).isDirectory();
    } catch {
      // src/agent/ not yet created — vacuously passing
    }

    const allFiles = collectTsFiles(srcDir);

    // Keep only files that are NOT under src/agent/
    const outsideAgent = allFiles.filter((f) => !f.startsWith(agentDir + '/') && f !== agentDir);

    const violations: string[] = [];

    for (const file of outsideAgent) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');
      const offendingLines: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (STATIC_IMPORT.test(line) || DYNAMIC_IMPORT.test(line)) {
          offendingLines.push(`  line ${i + 1}: ${line.trim()}`);
        }
        // Reset lastIndex after global regex test
        STATIC_IMPORT.lastIndex = 0;
        DYNAMIC_IMPORT.lastIndex = 0;
      }

      if (offendingLines.length > 0) {
        const rel = relative(srcDir, file);
        violations.push(`src/${rel}:\n${offendingLines.join('\n')}`);
      }
    }

    expect(
      violations,
      `Files outside src/agent/ must not import from agent/probe.\nViolations:\n${violations.join('\n\n')}`,
    ).toHaveLength(0);

    // Suppress unused-var warning when agent dir doesn't exist yet
    void agentExists;
  });
});
