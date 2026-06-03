import type { Collector, Kind, ObservationDelta } from './base.js';

interface PasswdEntry {
  uid: number;
  name: string;
  gid: number;
  gecos?: string;
  home?: string;
  shell?: string;
  source: 'local' | 'nss';
}

interface GroupEntry {
  gid: number;
  name: string;
  members: string[];
  source: 'local' | 'nss';
}

interface WatchHandle {
  stop(): void;
}

interface UsersProbe {
  /** Runs `getent passwd`; parses via B8. */
  getentPasswd(): Promise<PasswdEntry[]>;
  /** Runs `getent group`; parses via B9. */
  getentGroup(): Promise<GroupEntry[]>;
  /**
   * inotify on /etc/passwd, /etc/group, /etc/nsswitch.conf, /etc/sssd/
   * (all changes that could affect local user/group enumeration).
   */
  watchPasswdFiles(cb: () => void): WatchHandle;
}

interface UsersCollectorOptions {
  probe: UsersProbe;
}

/**
 * Users collector. Wires D8 probe + B8 passwd parser + B9 group parser.
 *
 * One collector emits BOTH User and Group kind deltas. This is intentional:
 * the probes are entangled (getent does both; watch covers both files);
 * splitting them would double the system calls for no benefit.
 *
 * id for User: decimal uid string.
 * id for Group: decimal gid string.
 *
 * Event source: inotify on /etc/passwd + /etc/group + /etc/nsswitch.conf + /etc/sssd/.
 * Poll fallback: 300 s.
 */
export class UsersCollector implements Collector<'User'> {
  readonly kind = 'User' as const;
  readonly pollIntervalMs = 300_000;

  private readonly probe: UsersProbe;
  private _health: { state: 'running' | 'stubbed' | 'error'; reason?: string } = {
    state: 'running',
  };
  private _watch: WatchHandle | null = null;

  constructor({ probe }: UsersCollectorOptions) {
    this.probe = probe;
  }

  async initialSweep(): Promise<ObservationDelta[]> {
    try {
      return await this._buildDeltas();
    } catch (err) {
      this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
      throw err;
    }
  }

  async start(emit: (delta: ObservationDelta) => void): Promise<void> {
    this._health = { state: 'running' };
    this._watch = this.probe.watchPasswdFiles(async () => {
      try {
        const deltas = await this._buildDeltas();
        for (const delta of deltas) emit(delta);
      } catch (err) {
        this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  async stop(): Promise<void> {
    this._watch?.stop();
    this._watch = null;
  }

  health(): { state: 'running' | 'stubbed' | 'error'; reason?: string } {
    return this._health;
  }

  /** This one collector observes both User and Group; report health for both. */
  healthKinds(): Kind[] {
    return ['User', 'Group'];
  }

  private async _buildDeltas(): Promise<ObservationDelta[]> {
    const observedAt = new Date().toISOString();
    const [users, groups] = await Promise.all([
      this.probe.getentPasswd(),
      this.probe.getentGroup(),
    ]);

    const deltas: ObservationDelta[] = [];

    for (const u of users) {
      deltas.push({
        kind: 'User',
        id: String(u.uid),
        op: 'upsert',
        value: {
          kind: 'User',
          id: String(u.uid),
          spec: {
            name: u.name,
            uid: u.uid,
            gid: u.gid,
            ...(u.gecos !== undefined ? { gecos: u.gecos } : {}),
            ...(u.home !== undefined ? { home: u.home } : {}),
            ...(u.shell !== undefined ? { shell: u.shell } : {}),
          },
          status: {
            resolvable: true,
            source: u.source,
            observed_at: observedAt,
          },
        },
      });
    }

    for (const g of groups) {
      deltas.push({
        kind: 'Group',
        id: String(g.gid),
        op: 'upsert',
        value: {
          kind: 'Group',
          id: String(g.gid),
          spec: {
            name: g.name,
            gid: g.gid,
            members: g.members,
          },
          status: {
            resolvable: true,
            source: g.source,
            observed_at: observedAt,
          },
        },
      });
    }

    return deltas;
  }
}
