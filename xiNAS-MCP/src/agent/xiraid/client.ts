/**
 * Agent-side xiRAID client adapter (S3 T5, ADR-0006 §Transport).
 *
 * One injectable {@link XiraidTransport} shared by the observe collector
 * and the create executor. The default transport wraps the existing typed
 * gRPC wrappers in src/grpc/ (TLS-TCP per /etc/xraid/net.conf — requires
 * the T1 unit-sandbox change on a real node); tests and the agent's
 * fixture mode inject a fake (see fake-transport.ts).
 *
 * The adapter tracks daemon availability across calls: the collector
 * reports `XIRAID_DAEMON_UNAVAILABLE` (node → degraded) and a mutating
 * apply fails with EXECUTOR_UNAVAILABLE when the daemon is unreachable.
 */

import { getClient } from '../../grpc/client.js';
import {
  type RaidCreateRequest,
  type RaidDestroyRequest,
  raidCreate,
  raidDestroy,
  raidShow,
} from '../../grpc/raid.js';

export interface XiraidTransport {
  /** Parsed raid_show payload (an array of per-array objects). */
  raidShow(): Promise<unknown>;
  raidCreate(req: RaidCreateRequest): Promise<void>;
  raidDestroy(req: RaidDestroyRequest): Promise<void>;
}

export type XiraidAvailability = 'unknown' | 'available' | 'unavailable';

export class XiraidClient {
  readonly #transport: XiraidTransport;
  #availability: XiraidAvailability = 'unknown';
  #lastError: string | undefined;

  constructor(transport: XiraidTransport) {
    this.#transport = transport;
  }

  availability(): XiraidAvailability {
    return this.#availability;
  }

  lastError(): string | undefined {
    return this.#lastError;
  }

  async raidShow(): Promise<unknown> {
    return this.#track(() => this.#transport.raidShow());
  }

  async raidCreate(req: RaidCreateRequest): Promise<void> {
    await this.#track(() => this.#transport.raidCreate(req));
  }

  async raidDestroy(req: RaidDestroyRequest): Promise<void> {
    await this.#track(() => this.#transport.raidDestroy(req));
  }

  async #track<T>(call: () => Promise<T>): Promise<T> {
    try {
      const result = await call();
      this.#availability = 'available';
      this.#lastError = undefined;
      return result;
    } catch (err) {
      this.#availability = 'unavailable';
      this.#lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }
}

/**
 * The real transport: lazy gRPC channel from /etc/xraid/net.conf via the
 * existing client pool. raid_show returns the parsed JSON payload.
 */
export function createGrpcTransport(): XiraidTransport {
  return {
    async raidShow(): Promise<unknown> {
      const client = await getClient();
      const res = await raidShow(client, {});
      return res.data ?? [];
    },
    async raidCreate(req: RaidCreateRequest): Promise<void> {
      const client = await getClient();
      await raidCreate(client, req);
    },
    async raidDestroy(req: RaidDestroyRequest): Promise<void> {
      const client = await getClient();
      await raidDestroy(client, req);
    },
  };
}
