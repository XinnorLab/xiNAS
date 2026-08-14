# Health-Check Remediation — Execution Contract

`xinas_menu/health/remediation.py` turns a health-check finding into an
optional automated fix. `RemediationWizard.apply(action)` either applies a
structured `nfs_conf_fix` or shells out to `action.command`.

## Running `action.command`

Remediation commands run **unattended, from inside the TUI process**. Two
properties follow, and both are contract rather than implementation detail:

1. **Bounded.** The command runs with a timeout (`_COMMAND_TIMEOUT`, 120 s).
   On expiry `apply` returns `(False, "timed out after 120s: <command>")`.
   Without a bound, one command that never returns hangs the wizard with no
   way out — the health screen is the surface an operator reaches for when
   the system is *already* misbehaving, so "the fix command wedged" is not a
   remote scenario.
2. **Never interactive.** stdin is `subprocess.DEVNULL`. A command that
   prompts must fail fast on EOF rather than block forever on a terminal the
   wizard is not driving. Remediation commands that genuinely need operator
   input do not belong here; they belong in the finding's `fix_hint` text.
3. **A failure is a return value, never an exception.** `apply` catches both
   `subprocess.TimeoutExpired` and `OSError` around the `subprocess.run` call
   and turns each into `(False, <detail>)`. `OSError` covers, in particular,
   `FileNotFoundError` when `action.command`'s binary (`modprobe`, `ethtool`,
   …) is not installed on the node — a real case, since remediation commands
   are generated per finding and not all of them are guaranteed present. The
   caller ([xinas_menu/screens/health.py](../../xinas_menu/screens/health.py))
   loops over every selected fix with no `try`/`except` of its own; if `apply`
   let an exception escape, that loop would die on the first missing binary
   and every fix queued after it would silently never run.

`apply` returns `(ok, detail)` where `detail` is stderr, falling back to
stdout. A non-zero exit is a normal failure, not an exception.
