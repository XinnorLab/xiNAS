"""K8sCsiScreen -- Kubernetes CSI NFS Driver management submenu."""
from __future__ import annotations

import asyncio
import logging
import shutil
import subprocess
import textwrap

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_client.widgets.menu_list import MenuItem, NavigableMenu
from xinas_client.widgets.text_view import ScrollableTextView
from xinas_client.widgets.confirm_dialog import ConfirmDialog
from xinas_client.widgets.input_dialog import InputDialog

_log = logging.getLogger(__name__)

# ── ANSI color constants ──────────────────────────────────────────────
_GRN, _YLW, _RED, _CYN = "\033[32m", "\033[33m", "\033[31m", "\033[36m"
_BLD, _DIM, _NC = "\033[1m", "\033[2m", "\033[0m"

_CSI_NAMESPACE = "kube-system"
_CSI_DRIVER_NAME = "csi-driver-nfs"
_CSI_INSTALL_URL = (
    "https://raw.githubusercontent.com/kubernetes-csi/csi-driver-nfs/"
    "master/deploy/install-driver.sh"
)

_ITEMS = [
    MenuItem("1", "Check Status"),
    MenuItem("2", "Install CSI NFS Driver"),
    MenuItem("3", "Upgrade CSI NFS Driver"),
    MenuItem("4", "Configure Storage Class"),
    MenuItem("5", "Manage Storage Classes"),
    MenuItem("6", "Uninstall CSI NFS Driver"),
    MenuItem("", "", separator=True),
    MenuItem("0", "Back"),
]

_HELP_TEXT = f"""\

  {_CYN}{'─' * 60}{_NC}
  {_BLD}Kubernetes CSI NFS Driver{_NC}
  {_CYN}{'─' * 60}{_NC}

  {_BLD}[1]{_NC} Check Status
  {_DIM}    Show kubectl/helm, cluster, CSI pods, storage classes{_NC}

  {_BLD}[2]{_NC} Install CSI NFS Driver
  {_DIM}    Install via kubectl or helm{_NC}

  {_BLD}[3]{_NC} Upgrade CSI NFS Driver
  {_DIM}    Upgrade an existing installation{_NC}

  {_BLD}[4]{_NC} Configure Storage Class
  {_DIM}    Create an NFS StorageClass for dynamic provisioning{_NC}

  {_BLD}[5]{_NC} Manage Storage Classes
  {_DIM}    List and inspect existing NFS storage classes{_NC}

  {_BLD}[6]{_NC} Uninstall CSI NFS Driver
  {_DIM}    Remove the CSI NFS driver from the cluster{_NC}
"""


class K8sCsiScreen(Screen):
    """Kubernetes CSI NFS Driver management submenu."""

    BINDINGS = [
        Binding("escape", "go_back", "Back", show=True, key_display="0/Esc"),
        Binding("0", "go_back", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  Kubernetes CSI NFS", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_ITEMS, id="csi-nav")
            yield ScrollableTextView(_HELP_TEXT, id="csi-content")
        yield Footer()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key.upper()
        if key == "1":
            self._check_status()
        elif key == "2":
            self._install_driver()
        elif key == "3":
            self._upgrade_driver()
        elif key == "4":
            self._configure_storage_class()
        elif key == "5":
            self._manage_storage_classes()
        elif key == "6":
            self._uninstall_driver()
        elif key == "0":
            self.app.pop_screen()

    def action_go_back(self) -> None:
        self.app.pop_screen()

    # ── [1] Check Status ─────────────────────────────────────────────

    @work(exclusive=True)
    async def _check_status(self) -> None:
        view = self.query_one("#csi-content", ScrollableTextView)
        loop = asyncio.get_running_loop()
        try:
            text = await loop.run_in_executor(None, _build_csi_status)
        except Exception:
            _log.debug("CSI status build failed", exc_info=True)
            text = f"  {_RED}Error building CSI status{_NC}"
        view.set_content(text)

    # ── [2] Install ──────────────────────────────────────────────────

    @work(exclusive=True)
    async def _install_driver(self) -> None:
        view = self.query_one("#csi-content", ScrollableTextView)
        loop = asyncio.get_running_loop()

        # Pre-flight checks
        kubectl = shutil.which("kubectl")
        if not kubectl:
            view.set_content(
                f"  {_RED}[FAIL]{_NC} kubectl not found.\n"
                f"  {_DIM}Install kubectl before proceeding.{_NC}"
            )
            return

        cluster_ok = await loop.run_in_executor(None, _check_cluster_access)
        if not cluster_ok:
            view.set_content(
                f"  {_RED}[FAIL]{_NC} Cannot connect to Kubernetes cluster.\n"
                f"  {_DIM}Ensure kubeconfig is set and cluster is accessible.{_NC}"
            )
            return

        helm = shutil.which("helm")
        method = "helm" if helm else "kubectl"

        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                f"Install CSI NFS Driver via {method}?\n\n"
                f"This will deploy the NFS CSI driver pods\n"
                f"into the {_CSI_NAMESPACE} namespace.",
                "Install CSI NFS Driver",
            )
        )
        if not confirmed:
            return

        view.set_content(f"  {_BLD}Installing CSI NFS Driver via {method}...{_NC}\n")

        if method == "helm":
            rc, out, err = await loop.run_in_executor(None, _install_via_helm)
        else:
            rc, out, err = await loop.run_in_executor(None, _install_via_kubectl)

        if rc == 0:
            view.append(f"  {_GRN}[OK]{_NC}   CSI NFS Driver installed successfully")
            if out.strip():
                for line in out.strip().splitlines()[-5:]:
                    view.append(f"    {_DIM}{line}{_NC}")
        else:
            view.append(f"  {_RED}[FAIL]{_NC} Installation failed (exit code {rc})")
            errmsg = err.strip() or out.strip()
            if errmsg:
                for line in errmsg.splitlines()[-5:]:
                    view.append(f"    {_DIM}{line}{_NC}")

        view.append(f"\n  {_DIM}Run \"Check Status\" to verify the installation.{_NC}")

    # ── [3] Upgrade ──────────────────────────────────────────────────

    @work(exclusive=True)
    async def _upgrade_driver(self) -> None:
        view = self.query_one("#csi-content", ScrollableTextView)
        loop = asyncio.get_running_loop()

        helm = shutil.which("helm")
        if not helm:
            view.set_content(
                f"  {_YLW}[INFO]{_NC} Upgrade via helm is recommended.\n"
                f"  {_DIM}For kubectl-based installs, uninstall and reinstall.{_NC}"
            )
            return

        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                "Upgrade CSI NFS Driver?\n\n"
                "This will upgrade the helm release to the latest chart version.",
                "Upgrade CSI NFS Driver",
            )
        )
        if not confirmed:
            return

        view.set_content(f"  {_BLD}Upgrading CSI NFS Driver...{_NC}\n")

        rc, out, err = await loop.run_in_executor(None, _upgrade_via_helm)
        if rc == 0:
            view.append(f"  {_GRN}[OK]{_NC}   CSI NFS Driver upgraded successfully")
            if out.strip():
                for line in out.strip().splitlines()[-5:]:
                    view.append(f"    {_DIM}{line}{_NC}")
        else:
            view.append(f"  {_RED}[FAIL]{_NC} Upgrade failed (exit code {rc})")
            errmsg = err.strip() or out.strip()
            if errmsg:
                for line in errmsg.splitlines()[-5:]:
                    view.append(f"    {_DIM}{line}{_NC}")

    # ── [4] Configure Storage Class ──────────────────────────────────

    @work(exclusive=True)
    async def _configure_storage_class(self) -> None:
        view = self.query_one("#csi-content", ScrollableTextView)
        loop = asyncio.get_running_loop()

        # Ask for NFS server IP
        server_ip = await self.app.push_screen_wait(
            InputDialog(
                "Enter the NFS server IP address:",
                title="NFS Server",
                placeholder="e.g. 192.168.1.100",
            )
        )
        if not server_ip or not server_ip.strip():
            return
        server_ip = server_ip.strip()

        # Ask for share path
        share_path = await self.app.push_screen_wait(
            InputDialog(
                "Enter the NFS share path:",
                title="NFS Share",
                default="/",
                placeholder="e.g. /export/data",
            )
        )
        if not share_path or not share_path.strip():
            return
        share_path = share_path.strip()

        # Ask for mount options
        mount_opts = await self.app.push_screen_wait(
            InputDialog(
                "Enter mount options (comma-separated, or leave empty):",
                title="Mount Options",
                default="nfsvers=4.1,hard",
                placeholder="e.g. nfsvers=4.1,hard,rsize=1048576",
            )
        )
        if mount_opts is None:
            return
        mount_opts = mount_opts.strip()

        # Build StorageClass YAML
        sc_name = f"nfs-{server_ip.replace('.', '-')}"
        sc_yaml = _build_storage_class_yaml(sc_name, server_ip, share_path, mount_opts)

        view.set_content(
            f"  {_BLD}Creating StorageClass: {sc_name}{_NC}\n\n"
            f"  {_DIM}Server:{_NC}  {server_ip}\n"
            f"  {_DIM}Share:{_NC}   {share_path}\n"
            f"  {_DIM}Options:{_NC} {mount_opts or '(default)'}\n"
        )

        rc, out, err = await loop.run_in_executor(
            None, _kubectl_apply_yaml, sc_yaml
        )
        if rc == 0:
            view.append(f"\n  {_GRN}[OK]{_NC}   StorageClass \"{sc_name}\" created")
        else:
            view.append(f"\n  {_RED}[FAIL]{_NC} Failed to create StorageClass")
            errmsg = err.strip() or out.strip()
            if errmsg:
                for line in errmsg.splitlines()[-5:]:
                    view.append(f"    {_DIM}{line}{_NC}")

    # ── [5] Manage Storage Classes ───────────────────────────────────

    @work(exclusive=True)
    async def _manage_storage_classes(self) -> None:
        view = self.query_one("#csi-content", ScrollableTextView)
        loop = asyncio.get_running_loop()

        text = await loop.run_in_executor(None, _build_storage_class_list)
        view.set_content(text)

    # ── [6] Uninstall ────────────────────────────────────────────────

    @work(exclusive=True)
    async def _uninstall_driver(self) -> None:
        view = self.query_one("#csi-content", ScrollableTextView)
        loop = asyncio.get_running_loop()

        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                "Uninstall the CSI NFS Driver?\n\n"
                "This will remove all CSI NFS driver pods.\n"
                "Existing NFS PVCs will NOT be deleted.",
                "Uninstall CSI NFS Driver",
            )
        )
        if not confirmed:
            return

        view.set_content(f"  {_BLD}Uninstalling CSI NFS Driver...{_NC}\n")

        helm = shutil.which("helm")
        if helm:
            rc, out, err = await loop.run_in_executor(None, _uninstall_via_helm)
        else:
            rc, out, err = await loop.run_in_executor(None, _uninstall_via_kubectl)

        if rc == 0:
            view.append(f"  {_GRN}[OK]{_NC}   CSI NFS Driver removed")
        else:
            view.append(f"  {_RED}[FAIL]{_NC} Uninstall failed (exit code {rc})")
            errmsg = err.strip() or out.strip()
            if errmsg:
                for line in errmsg.splitlines()[-5:]:
                    view.append(f"    {_DIM}{line}{_NC}")


# ── Helpers (run in executor threads) ─────────────────────────────────


def _run_cmd(cmd: list[str], timeout: int = 30) -> tuple[int, str, str]:
    """Run a command. Returns (rc, stdout, stderr)."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 1, "", f"Command timed out after {timeout}s"
    except FileNotFoundError:
        return 1, "", f"{cmd[0]} not found"
    except Exception as exc:
        return 1, "", str(exc)


def _check_cluster_access() -> bool:
    """Check if kubectl can reach the cluster."""
    rc, _, _ = _run_cmd(["kubectl", "cluster-info"], timeout=10)
    return rc == 0


def _build_csi_status() -> str:
    """Build the CSI NFS status text."""
    lines: list[str] = []
    rule = f"  {_CYN}{'─' * 60}{_NC}"

    lines.append(f"\n{rule}")
    lines.append(f"  {_BLD}CSI NFS Driver Status{_NC}")
    lines.append(rule)
    lines.append("")

    # kubectl
    kubectl = shutil.which("kubectl")
    if kubectl:
        lines.append(f"  {_GRN}\u25cf{_NC} kubectl {_GRN}available{_NC}")
    else:
        lines.append(f"  {_RED}\u25cf{_NC} kubectl {_RED}not found{_NC}")
        lines.append(f"    {_DIM}Install kubectl to manage Kubernetes.{_NC}")
        return "\n".join(lines)

    # helm
    helm = shutil.which("helm")
    if helm:
        lines.append(f"  {_GRN}\u25cf{_NC} helm {_GRN}available{_NC}")
    else:
        lines.append(f"  {_DIM}\u25cf{_NC} helm {_DIM}not found{_NC} (optional)")

    lines.append("")

    # Cluster connectivity
    if _check_cluster_access():
        lines.append(f"  {_GRN}\u25cf{_NC} Cluster {_GRN}connected{_NC}")
    else:
        lines.append(f"  {_RED}\u25cf{_NC} Cluster {_RED}not reachable{_NC}")
        lines.append(f"    {_DIM}Check kubeconfig and cluster status.{_NC}")
        return "\n".join(lines)

    lines.append("")

    # CSI driver pods
    lines.append(f"  {_BLD}CSI NFS Driver Pods{_NC}")
    rc, out, _ = _run_cmd([
        "kubectl", "get", "pods", "-n", _CSI_NAMESPACE,
        "-l", f"app.kubernetes.io/name={_CSI_DRIVER_NAME}",
        "--no-headers",
    ])
    if rc == 0 and out.strip():
        for pod_line in out.strip().splitlines():
            parts = pod_line.split()
            name = parts[0] if parts else pod_line
            status = parts[2] if len(parts) > 2 else "Unknown"
            if status == "Running":
                lines.append(f"    {_GRN}\u25cf{_NC} {name}  {_GRN}{status}{_NC}")
            else:
                lines.append(f"    {_YLW}\u25cf{_NC} {name}  {_YLW}{status}{_NC}")
    else:
        lines.append(f"    {_DIM}No CSI NFS driver pods found{_NC}")

    lines.append("")

    # Storage classes
    lines.append(f"  {_BLD}NFS Storage Classes{_NC}")
    rc, out, _ = _run_cmd([
        "kubectl", "get", "storageclass",
        "-o", "custom-columns=NAME:.metadata.name,PROVISIONER:.provisioner",
        "--no-headers",
    ])
    if rc == 0 and out.strip():
        nfs_classes = [
            l for l in out.strip().splitlines()
            if "nfs.csi.k8s.io" in l
        ]
        if nfs_classes:
            for sc_line in nfs_classes:
                lines.append(f"    {_GRN}\u25cf{_NC} {sc_line.strip()}")
        else:
            lines.append(f"    {_DIM}No NFS storage classes configured{_NC}")
    else:
        lines.append(f"    {_DIM}Could not list storage classes{_NC}")

    lines.append("")

    # NFS PVCs
    lines.append(f"  {_BLD}NFS PersistentVolumeClaims{_NC}")
    rc, out, _ = _run_cmd([
        "kubectl", "get", "pvc", "--all-namespaces",
        "-o", "custom-columns="
        "NAMESPACE:.metadata.namespace,"
        "NAME:.metadata.name,"
        "STATUS:.status.phase,"
        "CLASS:.spec.storageClassName",
        "--no-headers",
    ])
    if rc == 0 and out.strip():
        nfs_pvcs = [l for l in out.strip().splitlines() if "nfs" in l.lower()]
        if nfs_pvcs:
            for pvc_line in nfs_pvcs:
                lines.append(f"    {_CYN}\u25cf{_NC} {pvc_line.strip()}")
        else:
            lines.append(f"    {_DIM}No NFS PVCs found{_NC}")
    else:
        lines.append(f"    {_DIM}No PVCs found{_NC}")

    lines.append("")
    return "\n".join(lines)


def _install_via_helm() -> tuple[int, str, str]:
    """Install CSI NFS Driver via helm."""
    # Add repo
    _run_cmd([
        "helm", "repo", "add", _CSI_DRIVER_NAME,
        f"https://raw.githubusercontent.com/kubernetes-csi/{_CSI_DRIVER_NAME}/master/charts",
    ], timeout=30)
    _run_cmd(["helm", "repo", "update"], timeout=30)

    return _run_cmd([
        "helm", "install", _CSI_DRIVER_NAME,
        f"{_CSI_DRIVER_NAME}/{_CSI_DRIVER_NAME}",
        "-n", _CSI_NAMESPACE,
        "--wait",
    ], timeout=120)


def _install_via_kubectl() -> tuple[int, str, str]:
    """Install CSI NFS Driver via kubectl apply."""
    return _run_cmd([
        "bash", "-c",
        f"curl -skSL {_CSI_INSTALL_URL} | bash -s -- --",
    ], timeout=120)


def _upgrade_via_helm() -> tuple[int, str, str]:
    """Upgrade CSI NFS Driver via helm."""
    _run_cmd(["helm", "repo", "update"], timeout=30)
    return _run_cmd([
        "helm", "upgrade", _CSI_DRIVER_NAME,
        f"{_CSI_DRIVER_NAME}/{_CSI_DRIVER_NAME}",
        "-n", _CSI_NAMESPACE,
        "--wait",
    ], timeout=120)


def _uninstall_via_helm() -> tuple[int, str, str]:
    """Uninstall CSI NFS Driver via helm."""
    return _run_cmd([
        "helm", "uninstall", _CSI_DRIVER_NAME,
        "-n", _CSI_NAMESPACE,
    ], timeout=60)


def _uninstall_via_kubectl() -> tuple[int, str, str]:
    """Uninstall CSI NFS Driver via kubectl."""
    return _run_cmd([
        "bash", "-c",
        f"curl -skSL {_CSI_INSTALL_URL} | bash -s -- --uninstall",
    ], timeout=60)


def _build_storage_class_yaml(
    name: str,
    server: str,
    share: str,
    mount_options: str,
) -> str:
    """Build a Kubernetes StorageClass YAML manifest."""
    mount_opt_lines = ""
    if mount_options:
        opts = [o.strip() for o in mount_options.split(",") if o.strip()]
        if opts:
            items = "\n".join(f"  - {o}" for o in opts)
            mount_opt_lines = f"mountOptions:\n{items}"

    yaml = textwrap.dedent(f"""\
        apiVersion: storage.k8s.io/v1
        kind: StorageClass
        metadata:
          name: {name}
        provisioner: nfs.csi.k8s.io
        parameters:
          server: {server}
          share: {share}
        reclaimPolicy: Delete
        volumeBindingMode: Immediate
    """)
    if mount_opt_lines:
        yaml += mount_opt_lines + "\n"
    return yaml


def _kubectl_apply_yaml(yaml_content: str) -> tuple[int, str, str]:
    """Apply a YAML manifest via kubectl."""
    try:
        r = subprocess.run(
            ["kubectl", "apply", "-f", "-"],
            input=yaml_content,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return r.returncode, r.stdout, r.stderr
    except Exception as exc:
        return 1, "", str(exc)


def _build_storage_class_list() -> str:
    """Build a detailed listing of NFS-related storage classes."""
    lines: list[str] = []
    rule = f"  {_CYN}{'─' * 60}{_NC}"

    lines.append(f"\n{rule}")
    lines.append(f"  {_BLD}NFS Storage Classes{_NC}")
    lines.append(rule)
    lines.append("")

    rc, out, err = _run_cmd([
        "kubectl", "get", "storageclass",
        "-o", "custom-columns="
        "NAME:.metadata.name,"
        "PROVISIONER:.provisioner,"
        "RECLAIM:.reclaimPolicy,"
        "BINDING:.volumeBindingMode",
        "--no-headers",
    ])

    if rc != 0:
        lines.append(f"  {_RED}[FAIL]{_NC} Could not list storage classes")
        if err.strip():
            lines.append(f"    {_DIM}{err.strip()}{_NC}")
        return "\n".join(lines)

    if not out.strip():
        lines.append(f"  {_DIM}No storage classes found.{_NC}")
        return "\n".join(lines)

    nfs_found = False
    for sc_line in out.strip().splitlines():
        if "nfs" in sc_line.lower():
            nfs_found = True
            parts = sc_line.split()
            name = parts[0] if parts else sc_line
            lines.append(f"  {_GRN}\u25cf{_NC} {_BLD}{name}{_NC}")
            if len(parts) >= 2:
                lines.append(f"    {_DIM}Provisioner:{_NC}  {parts[1]}")
            if len(parts) >= 3:
                lines.append(f"    {_DIM}Reclaim:{_NC}      {parts[2]}")
            if len(parts) >= 4:
                lines.append(f"    {_DIM}Binding:{_NC}      {parts[3]}")
            lines.append("")

            # Get detailed info for this storage class
            rc2, detail, _ = _run_cmd([
                "kubectl", "get", "storageclass", name,
                "-o", "jsonpath="
                "{.parameters.server} {.parameters.share}",
            ])
            if rc2 == 0 and detail.strip():
                detail_parts = detail.strip().split()
                if len(detail_parts) >= 1 and detail_parts[0]:
                    lines.append(f"    {_DIM}Server:{_NC}      {detail_parts[0]}")
                if len(detail_parts) >= 2 and detail_parts[1]:
                    lines.append(f"    {_DIM}Share:{_NC}       {detail_parts[1]}")
                lines.append("")

    if not nfs_found:
        lines.append(f"  {_DIM}No NFS storage classes found.{_NC}")
        lines.append(
            f"  {_DIM}Use \"Configure Storage Class\" to create one.{_NC}"
        )

    return "\n".join(lines)
