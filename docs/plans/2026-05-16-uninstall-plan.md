# Uninstaller — implementation plan (2026-05-16)

Pairs with [2026-05-16-uninstall-design.md](./2026-05-16-uninstall-design.md)
and the live spec at
[docs/Installer/uninstall-spec.md](../Installer/uninstall-spec.md).

## Files to add

| Path | Purpose |
|------|---------|
| `uninstall.sh` | Bash entry point: prompts, hostname gate, ansible-playbook wrapper, final summary. |
| `playbooks/uninstall.yml` | Single-play playbook running the `xinas_uninstall` role against `localhost`. Asserts `uninstall_confirmed=true` in pre-tasks. |
| `collection/roles/xinas_uninstall/defaults/main.yml` | Default values for `uninstall_remove_xiraid`, `uninstall_remove_ofed`, `uninstall_revert_perf`, `uninstall_confirmed`. |
| `collection/roles/xinas_uninstall/tasks/main.yml` | Orchestrator — includes the phase task files in order. |
| `collection/roles/xinas_uninstall/tasks/00_preflight.yml` | Asserts confirmation, gathers prior install facts (history baseline if present), opens summary fact. |
| `collection/roles/xinas_uninstall/tasks/10_quiesce_services.yml` | Phase A. |
| `collection/roles/xinas_uninstall/tasks/20_remove_exports.yml` | Phase B. |
| `collection/roles/xinas_uninstall/tasks/30_teardown_raid.yml` | Phase C. |
| `collection/roles/xinas_uninstall/tasks/40_remove_mounts.yml` | Phase D. |
| `collection/roles/xinas_uninstall/tasks/50_remove_services.yml` | Phase E. |
| `collection/roles/xinas_uninstall/tasks/60_remove_binaries.yml` | Phase F. |
| `collection/roles/xinas_uninstall/tasks/70_remove_paths.yml` | Phase G. |
| `collection/roles/xinas_uninstall/tasks/80_revert_inplace_edits.yml` | Phase H. |
| `collection/roles/xinas_uninstall/tasks/90_remove_packages.yml` | Phase I. |
| `collection/roles/xinas_uninstall/tasks/91_optional_xiraid.yml` | xiRAID package + repo + DKMS removal (gated). |
| `collection/roles/xinas_uninstall/tasks/92_optional_ofed.yml` | DOCA / OFED removal (gated). |
| `collection/roles/xinas_uninstall/tasks/93_optional_perf.yml` | Perf-tuning revert (gated). |
| `collection/roles/xinas_uninstall/tasks/99_finalize.yml` | daemon-reload, sysctl --system, write summary JSON. |
| `collection/roles/xinas_uninstall/README.md` | Role reference doc. |

## Files to modify

| Path | Change |
|------|--------|
| `xinas_menu/screens/management.py` | Add `MenuItem("4", "Uninstall xiNAS")` and wire to a handler that suspends the TUI and `exec`s `/opt/xiNAS/uninstall.sh`. |
| `docs/Installer/spec.md` | Add a §5 row pointing to the uninstall spec, and a small mapping table linking each install role to the uninstall phase that cleans it. |
| `CLAUDE.md` | Update the `docs/Installer/` row in the spec table to list `uninstall-spec.md`. |

## Sequencing

1. **Role skeleton.** Empty role with the 14 phase files (each containing
   a single `- name: TODO …` debug task) plus defaults. Wire it into
   `playbooks/uninstall.yml`. Verify `ansible-playbook playbooks/uninstall.yml
   -e uninstall_confirmed=true --check` runs cleanly.
2. **Preflight + summary fact (`00`, `99`).** Add the confirmation assert
   and the JSON-summary collection so every later phase can append to it.
3. **Phases A–D** (quiesce, exports, RAID teardown, mounts). These
   touch services and storage — get them right first so a dry-run on a
   real demo node is verifiable.
4. **Phases E–G** (services, binaries, paths). Trivial `state: absent`
   work; runs in a few seconds.
5. **Phase H** (in-place edits). Marker-bounded edits + match-only
   edits. Each edit reports skip-with-reason on divergence.
6. **Phase I** (xiNAS-deployed packages). `apt purge` with the
   "not installed" tolerance.
7. **Optional phases 91, 92, 93.** Each is gated by its own variable.
8. **Finalize (`99`).** daemon-reload, sysctl --system, summary JSON.
9. **Bash entry (`uninstall.sh`).** Banner, three prompts, hostname
   gate, `--yes/--dry-run/--remove-*` flag parsing, ansible-playbook
   call, summary-JSON read + colorized print.
10. **TUI wiring.** Add the menu entry and the `screen.suspend()` shell-out
    in `xinas_menu/screens/management.py`.
11. **Docs.** Update `docs/Installer/spec.md` and `CLAUDE.md`.

## Verification

This is infra-as-code with no test framework. Verification is manual,
done on the demo node and recorded in the PR description.

1. `ansible-lint collection/roles/xinas_uninstall/` — must be clean.
2. `ansible-playbook playbooks/uninstall.yml --syntax-check` — no errors.
3. `ansible-playbook playbooks/uninstall.yml -e uninstall_confirmed=true
   --check --diff` on a fully provisioned demo node — output lists the
   expected file removals and unit stops, nothing more.
4. Real run on a demo node with all three optional answers = no:
   - Confirm xiRAID arrays gone, but `xicli` still on PATH.
   - Confirm OFED kernel modules still loaded.
   - Confirm `/etc/sysctl.d/90-perf-vm.conf` still present.
   - Re-run the script; expect "no changes" and the §8 summary listing
     everything as already removed.
5. Real run with all three optional answers = yes:
   - Confirm `xicli` no longer on PATH.
   - Confirm `mlx5_core` no longer loaded.
   - Confirm `/etc/sysctl.d/90-perf-vm.conf` gone.
   - Reboot, then re-install xiNAS from scratch and confirm install
     succeeds.

## Out of scope for this change

- A `uninstall_confirmed` extra-var carrying anything other than `true`.
- A "dry preview" mode beyond `--dry-run` (which forwards to
  `ansible-playbook --check`).
- Reverting hostname or removing the user account xiNAS may have used.
