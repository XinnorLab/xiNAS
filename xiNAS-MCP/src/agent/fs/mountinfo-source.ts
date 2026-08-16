/**
 * Where the agent reads the mount table from.
 *
 * **`/proc/self/mountinfo` is the wrong file for this daemon.** It reports the
 * mount table of the reading process's *mount namespace*, and
 * `xinas-agent.service` runs with `ProtectSystem=strict`, `ProtectHome=yes` and
 * `PrivateTmp=yes` — any one of which puts the service in a namespace of its
 * own. Observed on the reference node, same device (`259:93`), same instant:
 *
 * ```text
 * agent ns mnt:[4026548149]
 *   464 418 259:93 / /mnt/data ro,nosuid,noatime,nodiratime shared:370 master:76 - xfs /dev/xi_data rw,…
 * host  ns mnt:[4026531841]
 *   51   30 259:93 / /mnt/data rw,noatime,nodiratime        shared:76            - xfs /dev/xi_data rw,…
 * ```
 *
 * `ProtectSystem=strict` makes the whole hierarchy read-only for the service
 * except its `ReadWritePaths`, so the agent's own view of `/mnt/data` is
 * `ro,nosuid`. Published as `Filesystem.status.effective_mount_options`, that
 * told every client the data filesystem was read-only while NFS was exporting
 * it `rw` and clients were writing to it.
 *
 * PID 1 is by definition in the root mount namespace, so `/proc/1/mountinfo`
 * is the host's table. The agent runs as root and can read it.
 *
 * **There is deliberately no fallback to `/proc/self/mountinfo`.** Falling back
 * would restore exactly the wrong-but-plausible reading this constant exists to
 * remove, and the codebase's rule is that an unobserved value must not render
 * as a confident one: a failed sweep is handled (`runBootSequence` skips
 * reconcile and leaves prior state alone; `PollDriver` retries), a silently
 * wrong one is not. Hosts without `/proc` use the fixture probe mode, and both
 * call sites keep an injectable path override for tests.
 *
 * Note what is NOT affected: the fs-specific *super* options (everything after
 * the `-` separator) are a property of the superblock, not of the mount, so
 * they read identically in both namespaces. That is why the xiRAID delete
 * guard — which matches on `source` and on `logdev=`/`rtdev=` in the super
 * options — stayed correct throughout.
 */
export const HOST_MOUNTINFO_PATH = '/proc/1/mountinfo';
