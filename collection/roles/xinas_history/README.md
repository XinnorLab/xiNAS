# xinas_history

Deploys the **xiNAS Configuration History** package (`xinas_history/`) — the
snapshot, drift-detection, and rollback library described in
[`docs/config-history/architecture.md`](../../../docs/config-history/architecture.md).

## What the role does

1. Creates the store at `/var/lib/xinas/config-history/{snapshots,state}`
   (`root:root`, `0700`) and purges any prior history on install.
2. Copies the package to `/opt/xiNAS/xinas_history/`.
3. **Editable-installs the package into the shared venv** `/opt/xiNAS/venv`.
   The package is declared in the repo-root `pyproject.toml`
   (`[tool.setuptools.packages.find] include = ["xinas_menu*", "xinas_history*"]`),
   so the install runs `pip install -e /opt/xiNAS` — the same repo root, venv,
   and PEP 660 mechanism the `xinas_menu` role uses (pip/setuptools/wheel are
   upgraded first). PyYAML is installed as a runtime dependency.
4. Installs `/usr/local/bin/xinas-history`, a wrapper that sets
   `PYTHONPATH=/opt/xiNAS` and execs `python3 -m xinas_history`. The
   `PYTHONPATH` is belt-and-suspenders: the CLI resolves even if the editable
   install is absent.
5. Creates the initial **baseline** snapshot. Baseline-creation failure is
   **fatal** — a broken backend fails the install rather than reporting success
   with no anchor for drift detection.

> Steps 3–5 are the fix for InstallationFeedback findings #12 (the package was
> never installed into the venv → `No module named xinas_history`) and #13 (the
> baseline task swallowed that failure with `failed_when: false`).

## Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `xinas_history_store_path` | `/var/lib/xinas/config-history` | Store root |
| `xinas_history_max_snapshots` | `10` | Retention cap |
| `xinas_history_repo_path` | `/opt/xiNAS` | Repo root the package is editable-installed from |

## Verify

```bash
xinas-history snapshot list                     # JSON, exit 0
ls /var/lib/xinas/config-history/snapshots/      # baseline present (non-empty)
```
