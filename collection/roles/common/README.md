# Role: common

Baseline configuration for all storage nodes. Installs essential packages, configures timezone, NTP, basic kernel tuning and security updates.

## Variables
* **`common_timezone`** – system timezone (default `Europe/Amsterdam`).
* **`common_packages`** – list of baseline packages to install.
* **`common_sysctl`** – dictionary of sysctl parameters.
* **`chrony_service_name`** – name of the chrony service to manage (default `chrony`).

## Example
```yaml
- hosts: storage_nodes
  roles:
    - role: common
```
