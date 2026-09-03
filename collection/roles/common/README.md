# Role: common

Baseline configuration for all storage nodes. Installs essential packages, configures timezone, NTP, basic kernel tuning and security updates.

## Variables
* **`common_timezone`** – system timezone (default `Europe/Amsterdam`).
* **`common_packages`** – list of baseline packages to install.
* **`common_sysctl`** – dictionary of sysctl parameters. Written to
  `/etc/sysctl.d/80-xinas-common.conf`; the role never writes to the shared
  `/etc/sysctl.conf` and strips the keys older versions left there. See
  [docs/Installer/spec.md](../../../docs/Installer/spec.md) §3.1.
* **`chrony_service_name`** – name of the chrony service to manage (default `chrony`).
* **`chrony_package_name`** – name of the chrony package to install (default `chrony`).
* **`xinas_hostname`** – hostname to set. Defaults to `xiNAS-HWKEY`.
* **`xinas_require_avx`** – fail the play before the first `apt` call when
  the CPU does not report the `avx` flag, which xiRAID's kernel-module
  package refuses to install without (default `true`). Skipped
  automatically when `xiraid_skip_install` is true. See
  [docs/Installer/spec.md](../../../docs/Installer/spec.md) §3.1.
* **`xinas_cpuinfo_path`** – file the AVX preflight reads the `flags` line
  from (default `/proc/cpuinfo`; override only to exercise the check
  against a fixture).

## Example
```yaml
- hosts: storage_nodes
  roles:
    - role: common
```
