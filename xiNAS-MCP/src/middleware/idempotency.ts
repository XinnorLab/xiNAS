/**
 * In-memory idempotency store.
 * If an idempotency_key is present and cached, returns the stored result without re-executing.
 * TTL: 5 minutes.
 */

const TTL_MS = 5 * 60 * 1000;

interface CachedResult {
  result: unknown;
  expiresAt: number;
}

export class IdempotencyStore {
  private readonly store = new Map<string, CachedResult>();

  check(key: string): { hit: boolean; result?: unknown } {
    const entry = this.store.get(key);
    if (!entry) return { hit: false };
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return { hit: false };
    }
    return { hit: true, result: entry.result };
  }

  store_(key: string, result: unknown): void {
    this.store.set(key, { result, expiresAt: Date.now() + TTL_MS });
  }

  /** Cleanup expired entries */
  purgeExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
  }
}

// Singleton instance
export const idempotencyStore = new IdempotencyStore();

// Cleanup every 10 minutes
setInterval(() => idempotencyStore.purgeExpired(), 10 * 60 * 1000).unref();
