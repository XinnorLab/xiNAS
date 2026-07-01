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
  poolActivate,
  poolAdd,
  poolCreate,
  poolDeactivate,
  poolDelete,
  poolRemove,
  poolShow,
} from '../../grpc/pool.js';
import {
  type RaidCreateRequest,
  type RaidDestroyRequest,
  type RaidModifyRequest,
  raidCreate,
  raidDestroy,
  raidImportApply,
  raidImportShow,
  raidModify,
  raidShow,
} from '../../grpc/raid.js';

export interface XiraidTransport {
  /** Parsed raid_show payload (an array of per-array objects). */
  raidShow(): Promise<unknown>;
  raidCreate(req: RaidCreateRequest): Promise<void>;
  raidDestroy(req: RaidDestroyRequest): Promise<void>;
  // --- S4 verbs ---
  raidModify(req: RaidModifyRequest): Promise<void>;
  poolCreate(req: { name: string; drives: string[] }): Promise<void>;
  poolDelete(req: { name: string }): Promise<void>;
  poolAdd(req: { name: string; drives: string[] }): Promise<void>;
  poolRemove(req: { name: string; drives: string[] }): Promise<void>;
  poolActivate(req: { name: string }): Promise<void>;
  poolDeactivate(req: { name: string }): Promise<void>;
  /** Parsed pool_show payload (an array of per-pool objects). */
  poolShow(): Promise<unknown>;
  /** Parsed raid_import_show payload (an array of candidate objects). */
  raidImportShow(): Promise<unknown>;
  raidImportApply(req: { uuid: string; new_name?: string }): Promise<void>;
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

  async raidModify(req: RaidModifyRequest): Promise<void> {
    await this.#track(() => this.#transport.raidModify(req));
  }

  async poolCreate(req: { name: string; drives: string[] }): Promise<void> {
    await this.#track(() => this.#transport.poolCreate(req));
  }

  async poolDelete(req: { name: string }): Promise<void> {
    await this.#track(() => this.#transport.poolDelete(req));
  }

  async poolAdd(req: { name: string; drives: string[] }): Promise<void> {
    await this.#track(() => this.#transport.poolAdd(req));
  }

  async poolRemove(req: { name: string; drives: string[] }): Promise<void> {
    await this.#track(() => this.#transport.poolRemove(req));
  }

  async poolActivate(req: { name: string }): Promise<void> {
    await this.#track(() => this.#transport.poolActivate(req));
  }

  async poolDeactivate(req: { name: string }): Promise<void> {
    await this.#track(() => this.#transport.poolDeactivate(req));
  }

  async poolShow(): Promise<unknown> {
    return this.#track(() => this.#transport.poolShow());
  }

  async raidImportShow(): Promise<unknown> {
    return this.#track(() => this.#transport.raidImportShow());
  }

  async raidImportApply(req: { uuid: string; new_name?: string }): Promise<void> {
    await this.#track(() => this.#transport.raidImportApply(req));
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
      // units:'g' is required — the xiRAID daemon's formatter throws
      // "13 INTERNAL: Unsupported unit: None" on an unset unit (finding #17),
      // which otherwise fails every array observation sweep.
      const res = await raidShow(client, { units: 'g' });
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
    async raidModify(req: RaidModifyRequest): Promise<void> {
      const client = await getClient();
      await raidModify(client, req);
    },
    async poolCreate(req: { name: string; drives: string[] }): Promise<void> {
      const client = await getClient();
      await poolCreate(client, req);
    },
    async poolDelete(req: { name: string }): Promise<void> {
      const client = await getClient();
      await poolDelete(client, req);
    },
    async poolAdd(req: { name: string; drives: string[] }): Promise<void> {
      const client = await getClient();
      await poolAdd(client, req);
    },
    async poolRemove(req: { name: string; drives: string[] }): Promise<void> {
      const client = await getClient();
      await poolRemove(client, req);
    },
    async poolActivate(req: { name: string }): Promise<void> {
      const client = await getClient();
      await poolActivate(client, req);
    },
    async poolDeactivate(req: { name: string }): Promise<void> {
      const client = await getClient();
      await poolDeactivate(client, req);
    },
    async poolShow(): Promise<unknown> {
      const client = await getClient();
      // units:'g' — same daemon "Unsupported unit: None" crash as raidShow (#17).
      const res = await poolShow(client, { units: 'g' });
      return res.data ?? [];
    },
    async raidImportShow(): Promise<unknown> {
      // No drives filter: scan all (confirm exact daemon semantics for an
      // unset `drives` list on real hardware — fixture/e2e use the fake).
      const client = await getClient();
      const res = await raidImportShow(client, {});
      return res.data ?? [];
    },
    async raidImportApply(req: { uuid: string; new_name?: string }): Promise<void> {
      const client = await getClient();
      await raidImportApply(client, req);
    },
  };
}
