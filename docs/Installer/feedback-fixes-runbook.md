# InstallationFeedback fixes — on-host verification runbook

On-host verification for the `InstallationFeedback*` findings fixed on branch
`claude/focused-jepsen-34af8a` (6 commits, A–F). Run this on the target node
(the feedback used KVM guest `172.16.133.167`). The node is its own Ansible
control node (inventory targets `localhost`), so everything runs locally on it.

This is the "review" half of the fix-review loop: deploy → install → assert →
if a check fails, re-run the owning role and re-assert.

## 0. Deploy the branch

```bash
cd /opt/xiNAS
sudo git fetch origin
sudo git checkout claude/focused-jepsen-34af8a && sudo git pull --ff-only
```

## 1. Clean slate + non-interactive install (#1)

```bash
sudo ./uninstall.sh --yes                                   # reset (uninstall surface exists)
sudo ./autoinstall.sh --preset xinnorVM --license-file /tmp/license
echo "autoinstall exit=$?"                                  # expect 0
```

`/tmp/license` must hold a valid xiRAID license (the feedback's host had one).
If absent, place the real license file there first — recovery from a running
xiRAID is intentionally no longer fabricated (see #4).

## 2. On-host check sweep

Copy-paste block; each line names the finding it proves.

```bash
echo "#12 history CLI:"; sudo xinas-history snapshot list --format json | head -c 80; echo
echo "#13 baseline:   "; sudo ls /var/lib/xinas/config-history/snapshots/ | head
echo "#14 nfs-helper: "; systemctl is-active xinas-nfs-helper; test -S /run/xinas-nfs-helper.sock && echo "socket OK"
echo "#11 THP defrag: "; cat /sys/kernel/mm/transparent_hugepage/defrag
echo "#9  swappiness: "; sysctl -n vm.swappiness
echo "#11 oneshot:    "; systemctl is-enabled xinas-perf-runtime; systemctl is-active xinas-perf-runtime
echo "#16 marker:     "; cat /opt/xiNAS/.installed_preset
echo "#2  state:      "; sudo ./autoinstall.sh --status | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["status"], [r["role"]+":"+r["status"] for r in d["roles"]])'
echo "#3  hwkey note: "; echo "hostname=$(hostname)  license_hwkey=$(xicli license show 2>/dev/null | awk -F': ' '/hwkey/{print $2}')"
```

### Expected results

| # | Check | Expected |
|---|-------|----------|
| 12 | `xinas-history snapshot list` | valid JSON, exit 0 — **not** `No module named xinas_history` |
| 13 | `ls .../config-history/snapshots/` | non-empty (baseline written) |
| 14 | `systemctl is-active xinas-nfs-helper` | `active`; socket present |
| 11 | `.../transparent_hugepage/defrag` | `[never]` |
| 9 | `sysctl -n vm.swappiness` | `1` |
| 11 | `xinas-perf-runtime` | `enabled` + `active` |
| 16 | `/opt/xiNAS/.installed_preset` | `xinnorVM` |
| 2 | `autoinstall.sh --status` | `completed` with a per-role list ending at `motd:ok` |
| 3 | hostname vs license hwkey | the two 16-hex IDs **differ** — this is expected, documented in spec §3.1, not a bug |

### Reboot-persistence (#11, #9)

The oneshot must survive a reboot (that is the whole point of #11/#9):

```bash
sudo systemctl restart xinas-perf-runtime     # simulate the boot-time re-apply
cat /sys/kernel/mm/transparent_hugepage/defrag # -> [never]
sysctl -n vm.swappiness                        # -> 1
# Optional full check: sudo reboot, then re-run the two lines above.
```

### Manual / interactive checks (#4, #5, #8)

These exercise the interactive bash installer and are driven by hand:

- **#4** — with `/tmp/license` removed but a running xiRAID, open the menu's
  license screen and choose "recover from xiRAID". Expect: it does **not**
  write `/tmp/license`; it writes `/tmp/license.recovered` and prompts for
  manual entry. Verify `! test -f /tmp/license` and `test -f /tmp/license.recovered`.
- **#5** — at any yes/no prompt press an unmapped key (e.g. `0`). Expect a beep
  and a red `Unknown key — use ←→, Enter, y/n, or Esc` footer (no silent hang).
- **#8** — start an install via `sudo ./startup_menu.sh`, and during the
  `ansible-playbook` run `sudo pkill -f startup_menu.sh` from another shell.
  Expect: `pgrep -f ansible-playbook` and `pgrep -f apt-get` return nothing
  within a second or two, and `sudo fuser /var/lib/dpkg/lock-frontend` is clear.

### In-repo unit suite (control-side)

```bash
cd /opt/xiNAS && /opt/xiNAS/venv/bin/python -m pytest tests/ -q     # 102 passed
```

## 3. The fix-review loop (if a check fails)

1. Identify the owning role from the failing check (table above) and the
   commit's `Requires-Rebuild:` trailer (`git log --grep Requires-Rebuild`).
2. Re-apply and re-check. The reliable path is a full idempotent re-run
   (`autoinstall.sh` is safe to re-run):
   ```bash
   sudo XINAS_RECORD_INSTALL_STATE=1 ./autoinstall.sh --preset xinnorVM --license-file /tmp/license
   ```
   For roles whose tasks carry tags you can target them — `perf_tuning` →
   `--tags memory`, `motd` → `--tags motd`. Note `xinas_history` and the
   install-state callback are **untagged**: re-run the full playbook for those.
   (Full clean re-run: `sudo ./uninstall.sh --yes && sudo ./autoinstall.sh --preset xinnorVM`.)
3. Root-cause before re-fixing; check `/var/log/xinas/install.log` and
   `sudo ./autoinstall.sh --status` to see which role last ran.
4. Repeat until the sweep is green.
