/**
 * File-backed fake NetHost (S6 T4) — fixture mode + e2e, the fake
 * FsHost pattern. State at <dir>/net-host-state.json:
 *
 *   { netplan_files: { <path>: <text> },
 *     kernel: { addrs: { <dev>: [cidr] },
 *               rules: [{ from, table, priority }],
 *               tables: { <id>: [route strings] } },
 *     sys_class_net: [{ name, driver }],
 *     rdma_links: [{ ifname, state, physical_state }],
 *     ops: [] }
 *
 * Modeled netplan-apply quirk (the reason the flush sequence exists):
 * `netplanApply()` re-derives kernel state from the merged parse of
 * `netplan_files` but addresses/rules are ADD-ONLY — config removed
 * from the files SURVIVES apply until the explicit flush verbs remove
 * it from the kernel maps.
 *
 * Deterministic hooks (no randomness):
 *  - `netplanGenerate` rejects when any file fails YAML parse or
 *    contains the marker string `INVALID-NETPLAN`;
 *  - `netplanApply` rejects when any file contains `APPLY-FAIL`;
 *  - `ipAddrFlush` on a dev whose name ends `-fail` rejects.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type ParsedNetplan, parseNetplanFiles } from '../../lib/parse/netplan.js';
import type { NetHost } from './host.js';

interface FakeKernel {
  addrs: Record<string, string[]>;
  rules: Array<{ from: string; table: number; priority: number }>;
  tables: Record<string, string[]>;
}

interface FakeNetState {
  netplan_files: Record<string, string>;
  kernel: FakeKernel;
  sys_class_net: Array<{ name: string; driver: string }>;
  rdma_links: Array<{ ifname: string; state: string; physical_state: string }>;
  ops: string[];
}

function statePath(dir: string): string {
  return join(dir, 'net-host-state.json');
}

function load(dir: string): FakeNetState {
  const path = statePath(dir);
  if (!existsSync(path)) {
    return {
      netplan_files: {},
      kernel: { addrs: {}, rules: [], tables: {} },
      sys_class_net: [],
      rdma_links: [],
      ops: [],
    };
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<FakeNetState>;
  return {
    netplan_files: parsed.netplan_files ?? {},
    kernel: {
      addrs: parsed.kernel?.addrs ?? {},
      rules: parsed.kernel?.rules ?? [],
      tables: parsed.kernel?.tables ?? {},
    },
    sys_class_net: parsed.sys_class_net ?? [],
    rdma_links: parsed.rdma_links ?? [],
    ops: parsed.ops ?? [],
  };
}

function save(dir: string, state: FakeNetState): void {
  mkdirSync(dirname(statePath(dir)), { recursive: true });
  writeFileSync(statePath(dir), JSON.stringify(state, null, 2));
}

function parsedOrThrow(state: FakeNetState): ParsedNetplan {
  for (const [path, text] of Object.entries(state.netplan_files)) {
    if (text.includes('INVALID-NETPLAN')) {
      throw new Error(`fake net host: netplan generate rejected ${path} (INVALID-NETPLAN marker)`);
    }
  }
  const parsed = parseNetplanFiles(state.netplan_files);
  if (parsed.unparsable_files.length > 0) {
    throw new Error(
      `fake net host: netplan generate rejected unparsable ${parsed.unparsable_files.join(', ')}`,
    );
  }
  return parsed;
}

/** Test-support accessors beyond the NetHost contract. */
export interface FakeNetHostHandle {
  ops(): string[];
  files(): Record<string, string>;
  kernel(): FakeKernel;
}

export function createFakeNetHost(dir: string): NetHost & FakeNetHostHandle {
  return {
    // ---- test-support handle ----
    ops(): string[] {
      return load(dir).ops;
    },
    files(): Record<string, string> {
      return load(dir).netplan_files;
    },
    kernel(): FakeKernel {
      return load(dir).kernel;
    },

    // ---- NetHost ----
    async readNetplanDir(): Promise<Record<string, string>> {
      return load(dir).netplan_files;
    },

    async writeNetplanFile(path: string, text: string): Promise<void> {
      const state = load(dir);
      state.ops.push(`writeNetplanFile:${path}`);
      state.netplan_files[path] = text;
      save(dir, state);
    },

    async netplanGenerate(): Promise<void> {
      const state = load(dir);
      state.ops.push('netplan-generate');
      save(dir, state);
      parsedOrThrow(state);
    },

    async netplanApply(): Promise<void> {
      const state = load(dir);
      state.ops.push('netplan-apply');
      for (const [path, text] of Object.entries(state.netplan_files)) {
        if (text.includes('APPLY-FAIL')) {
          save(dir, state);
          throw new Error(`fake net host: netplan apply forced failure (${path})`);
        }
      }
      const parsed = parsedOrThrow(state);
      // ADD-ONLY kernel programming (the real netplan-apply quirk):
      // configured addresses/rules/routes are added; stale ones survive
      // until the flush verbs remove them.
      for (const [iface, stanza] of Object.entries(parsed.stanzas)) {
        const addrs = (state.kernel.addrs[iface] ??= []);
        for (const cidr of stanza.addresses) {
          if (!addrs.includes(cidr)) addrs.push(cidr);
        }
        if (stanza.pbr_table_id !== undefined) {
          for (const cidr of stanza.addresses) {
            const from = cidr.split('/')[0] as string;
            if (
              !state.kernel.rules.some((r) => r.from === from && r.table === stanza.pbr_table_id)
            ) {
              state.kernel.rules.push({
                from,
                table: stanza.pbr_table_id,
                priority: stanza.pbr_table_id,
              });
            }
          }
          const routes = (state.kernel.tables[String(stanza.pbr_table_id)] ??= []);
          const route = `${stanza.addresses[0] ?? ''} dev ${iface}`;
          if (!routes.includes(route)) routes.push(route);
        }
      }
      save(dir, state);
    },

    async ipRuleShow(): Promise<string> {
      const state = load(dir);
      return state.kernel.rules
        .map((r) => `${r.priority}:\tfrom ${r.from} lookup ${r.table}`)
        .join('\n');
    },

    async ipRuleDel(spec: string): Promise<void> {
      const state = load(dir);
      state.ops.push(`ip-rule-del:${spec}`);
      const m = /from (\S+) lookup (\d+)/.exec(spec);
      if (m) {
        state.kernel.rules = state.kernel.rules.filter(
          (r) => !(r.from === m[1] && r.table === Number(m[2])),
        );
      }
      save(dir, state);
    },

    async ipRouteFlushTable(id: number): Promise<void> {
      const state = load(dir);
      state.ops.push(`ip-route-flush-table:${id}`);
      delete state.kernel.tables[String(id)];
      save(dir, state);
    },

    async ipAddrFlush(dev: string): Promise<void> {
      if (dev.endsWith('-fail')) {
        throw new Error(`fake net host: forced addr-flush failure for '${dev}'`);
      }
      const state = load(dir);
      state.ops.push(`ip-addr-flush:${dev}`);
      state.kernel.addrs[dev] = [];
      save(dir, state);
    },

    async ipAddrShow(): Promise<string> {
      const state = load(dir);
      const json = state.sys_class_net.map((iface) => ({
        ifname: iface.name,
        operstate: 'UP',
        addr_info: (state.kernel.addrs[iface.name] ?? []).map((cidr) => ({
          family: 'inet',
          local: cidr.split('/')[0],
          prefixlen: Number(cidr.split('/')[1]),
        })),
      }));
      return JSON.stringify(json);
    },

    async listSysClassNet(): Promise<Array<{ name: string; driver: string }>> {
      return load(dir).sys_class_net;
    },

    async rdmaLinkShow(): Promise<string> {
      return JSON.stringify(load(dir).rdma_links);
    },
  };
}

/** Every verb throws — partial test fakes spread this (the S4 pattern). */
export function makeUnimplementedNetHost(): NetHost {
  const unused = (verb: string) => async (): Promise<never> => {
    throw new Error(`unimplemented test net host verb: ${verb}`);
  };
  return {
    readNetplanDir: unused('readNetplanDir'),
    writeNetplanFile: unused('writeNetplanFile'),
    netplanGenerate: unused('netplanGenerate'),
    netplanApply: unused('netplanApply'),
    ipRuleShow: unused('ipRuleShow'),
    ipRuleDel: unused('ipRuleDel'),
    ipRouteFlushTable: unused('ipRouteFlushTable'),
    ipAddrFlush: unused('ipAddrFlush'),
    ipAddrShow: unused('ipAddrShow'),
    listSysClassNet: unused('listSysClassNet'),
    rdmaLinkShow: unused('rdmaLinkShow'),
  };
}
