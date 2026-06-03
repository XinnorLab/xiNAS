import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCpuinfo, parseMeminfo } from '../../../lib/parse/inventory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, '__fixtures__');

describe('parseCpuinfo', () => {
  it('parses a 4-thread Xeon fixture into model, cores, threads, arch', () => {
    const raw = readFileSync(join(fixtureDir, 'cpuinfo.txt'), 'utf8');
    const result = parseCpuinfo(raw);
    expect(result.model).toBe('Intel(R) Xeon(R) Gold 6130 CPU @ 2.10GHz');
    expect(result.threads).toBe(4); // 4 processor stanzas
    expect(result.cores).toBe(16); // cpu cores field
    expect(result.arch).toBe('x86_64');
  });

  it('handles a single-processor entry gracefully', () => {
    const raw = 'processor\t: 0\nmodel name\t: QEMU Virtual CPU\ncpu cores\t: 1\n';
    const result = parseCpuinfo(raw);
    expect(result.model).toBe('QEMU Virtual CPU');
    expect(result.threads).toBe(1);
    expect(result.cores).toBe(1);
  });

  it('returns undefined optional fields when keys are absent', () => {
    const result = parseCpuinfo('processor\t: 0\n');
    expect(result.model).toBeUndefined();
    expect(result.cores).toBeUndefined();
    expect(result.threads).toBe(1);
  });

  it('counts TOTAL physical cores across sockets on a dual-socket system', () => {
    // Fixture: 2 distinct physical_id values (0 and 1), each with cpu cores: 16.
    // Total physical cores = 2 sockets × 16 = 32 (not 16 as single-socket read would give).
    const raw = readFileSync(join(fixtureDir, 'cpuinfo-dual-socket.txt'), 'utf8');
    const result = parseCpuinfo(raw);
    expect(result.cores).toBe(32); // 2 sockets × 16 cores per socket
    expect(result.threads).toBe(4); // 4 processor stanzas in the fixture
  });
});

describe('parseMeminfo', () => {
  it('parses a typical /proc/meminfo and extracts total, available, swap_total in kB', () => {
    const raw = readFileSync(join(fixtureDir, 'meminfo.txt'), 'utf8');
    const result = parseMeminfo(raw);
    expect(result.total_kb).toBe(131548736);
    expect(result.available_kb).toBe(98765432);
    expect(result.swap_total_kb).toBe(4194304);
  });

  it('returns zeros for keys that are absent (minimal meminfo)', () => {
    const result = parseMeminfo('MemTotal: 1024 kB\n');
    expect(result.total_kb).toBe(1024);
    expect(result.available_kb).toBe(0);
    expect(result.swap_total_kb).toBe(0);
  });

  it('returns all zeros for empty input', () => {
    const result = parseMeminfo('');
    expect(result.total_kb).toBe(0);
    expect(result.available_kb).toBe(0);
    expect(result.swap_total_kb).toBe(0);
  });
});
