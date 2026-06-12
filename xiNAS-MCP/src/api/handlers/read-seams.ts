/**
 * Read seams for the promoted legacy read routes (S8 T5, ADR-0010
 * §read-route promotion).
 *
 * Each seam degrades to `null` instead of throwing — the routes
 * answer with an empty result plus a DEGRADED warning so clients
 * (MCP tools included) get honest, structured behavior when a
 * backend is absent.
 *
 * The gRPC trio is the ONE deliberate, deprecated-until-agent-coverage
 * exception to the privileged-adapter extraction (read-only localhost
 * xiRAID gRPC; ADR-0010). journalctl output is scrubbed with the
 * bundle redaction rules before leaving the process.
 */

import { execFile } from 'node:child_process';
import * as http from 'node:http';
import { scrubSecrets } from '../../lib/health/redact.js';

export interface ReadSeams {
  /** journalctl tail; null = journalctl unavailable/unreadable. */
  journalTail(unit: string | undefined, lines: number): Promise<string | null>;
  /** Raw Prometheus metrics text; null = exporter unreachable. */
  prometheusMetrics(): Promise<string | null>;
  /** Raw `repquota -a` output; null = unavailable (often needs privilege). */
  repquota(): Promise<string | null>;
  /** xiRAID gRPC reads (parsed payloads); null = daemon unreachable. */
  grpcMailShow(): Promise<unknown | null>;
  grpcSettingsMailShow(): Promise<unknown | null>;
  grpcSettingsAuthShow(): Promise<unknown | null>;
}

function execText(file: string, args: string[], timeoutMs = 10_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err !== null ? null : stdout);
    });
  });
}

function httpGetText(url: string, timeoutMs = 5_000): Promise<string | null> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      if ((res.statusCode ?? 0) !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function grpcRead(call: (client: unknown) => Promise<unknown>): Promise<unknown | null> {
  try {
    // Lazy import: the legacy read client stays out of the api's boot
    // path; absence/unreachability degrades to null.
    const { getClient } = await import('../../grpc/client.js');
    const client = (await getClient()) as unknown;
    return await call(client);
  } catch {
    return null;
  }
}

export function createReadSeams(opts: { prometheusUrl?: string } = {}): ReadSeams {
  const prometheusUrl = opts.prometheusUrl ?? 'http://localhost:9827/metrics';
  return {
    async journalTail(unit, lines) {
      const args = [
        ...(unit !== undefined ? ['-u', unit] : []),
        '-n',
        String(lines),
        '--no-pager',
        '-o',
        'short-iso',
      ];
      const out = await execText('journalctl', args);
      return out === null ? null : scrubSecrets(out);
    },

    prometheusMetrics() {
      return httpGetText(prometheusUrl);
    },

    repquota() {
      return execText('repquota', ['-a']);
    },

    grpcMailShow() {
      return grpcRead(async (client) => {
        const { mailShow } = await import('../../grpc/mail.js');
        return mailShow(client as never);
      });
    },

    grpcSettingsMailShow() {
      return grpcRead(async (client) => {
        const { settingsMailShow } = await import('../../grpc/settings.js');
        return settingsMailShow(client as never);
      });
    },

    grpcSettingsAuthShow() {
      return grpcRead(async (client) => {
        const { settingsAuthShow } = await import('../../grpc/settings.js');
        return settingsAuthShow(client as never);
      });
    },
  };
}
