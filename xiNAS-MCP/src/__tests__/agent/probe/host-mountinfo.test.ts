import { describe, expect, it } from 'vitest';
import { HOST_MOUNTINFO_PATH } from '../../../agent/fs/mountinfo-source.js';
import { parseMountinfo } from '../../../lib/parse/mountinfo.js';

/*
 * The agent runs with ProtectSystem=strict / ProtectHome / PrivateTmp, any of
 * which puts the service in its OWN mount namespace. Reading
 * /proc/self/mountinfo there reports the SANDBOX's view of a mount, not the
 * host's.
 *
 * Both lines below are verbatim from the reference node, captured at the same
 * instant for the same device (259:93):
 *   agent ns mnt:[4026548149], host ns mnt:[4026531841]
 * The VFS options differ; the fs-specific super options do not.
 */
const AGENT_NS =
  '464 418 259:93 / /mnt/data ro,nosuid,noatime,nodiratime shared:370 master:76 - xfs /dev/xi_data rw,swalloc,attr2,largeio,inode64,allocsize=131072k,logbufs=8,logbsize=256k,logdev=/dev/xi_log,sunit=256,swidth=5376,usrquota';
const HOST_NS =
  '51 30 259:93 / /mnt/data rw,noatime,nodiratime shared:76 - xfs /dev/xi_data rw,swalloc,attr2,largeio,inode64,allocsize=131072k,logbufs=8,logbsize=256k,logdev=/dev/xi_log,sunit=256,swidth=5376,usrquota';

describe('host mount table source', () => {
  it('reads PID 1, which is by definition in the root mount namespace', () => {
    expect(HOST_MOUNTINFO_PATH).toBe('/proc/1/mountinfo');
    // The bug: /proc/self is the READING process's namespace.
    expect(HOST_MOUNTINFO_PATH).not.toBe('/proc/self/mountinfo');
  });

  it('the two namespaces genuinely disagree about the same mount', () => {
    const [agent] = parseMountinfo(AGENT_NS);
    const [host] = parseMountinfo(HOST_NS);

    // Same device, same mountpoint...
    expect(agent?.source).toBe(host?.source);
    expect(agent?.mountpoint).toBe(host?.mountpoint);
    // ...but the sandbox reports the filesystem as read-only, and invents
    // nosuid. This is what reached the TUI as `Options: ro,nosuid,...` for a
    // filesystem that was mounted rw and being written to.
    expect(agent?.options).toEqual(['ro', 'nosuid', 'noatime', 'nodiratime']);
    expect(host?.options).toEqual(['rw', 'noatime', 'nodiratime']);
  });

  it('super options are namespace-independent — which is why the delete guard held', () => {
    const [agent] = parseMountinfo(AGENT_NS);
    const [host] = parseMountinfo(HOST_NS);
    expect(agent?.super_options).toEqual(host?.super_options);
    // The xiRAID delete guard looks for logdev=/rtdev= to catch a filesystem
    // using the doomed volume as its external log; that lives here.
    expect(host?.super_options).toContain('logdev=/dev/xi_log');
  });
});
