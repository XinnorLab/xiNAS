# Role: common

Baseline configuration for all storage nodes. Installs essential packages, configures timezone, NTP, basic kernel tuning and security updates.

## Variables
* **`common_timezone`** – system timezone (default `Europe/Amsterdam`).
* **`common_packages`** – list of baseline packages to install.
* **`common_sysctl`** – dictionary of sysctl parameters.
* **`chrony_service_name`** – name of the chrony service to manage (default `chrony`).
* **`chrony_package_name`** – name of the chrony package to install (default `chrony`).
* **`xinas_hostname`** – hostname to set. Defaults to `xiNAS-HWKEY`.

## Example
```yaml
- hosts: storage_nodes
  roles:
    - role: common
```
