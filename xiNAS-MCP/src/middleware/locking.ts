/**
 * Per-array async mutex to prevent concurrent conflicting operations.
 */

import { McpToolError, ErrorCode } from '../types/common.js';

interface LockState {
  promise: Promise<void>;
  owner: string;
  resolve: () => void;
}

export class ArrayLockManager {
  private readonly locks = new Map<string, LockState>();

  async withLock<T>(arrayId: string, toolName: string, fn: () => Promise<T>): Promise<T> {
    if (this.locks.has(arrayId)) {
      const existing = this.locks.get(arrayId)!;
      throw new McpToolError(
        ErrorCode.CONFLICT,
        `Array '${arrayId}' is currently locked by '${existing.owner}'. Try again after it completes.`
      );
    }

    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    this.locks.set(arrayId, { promise, owner: toolName, resolve });

    try {
      return await fn();
    } finally {
      resolve();
      this.locks.delete(arrayId);
    }
  }

  isLocked(arrayId: string): boolean {
    return this.locks.has(arrayId);
  }

  lockedBy(arrayId: string): string | null {
    return this.locks.get(arrayId)?.owner ?? null;
  }
}

// Singleton instance
export const arrayLocks = new ArrayLockManager();
