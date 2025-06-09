# Role **xiraid_classic**
Installs Xinnor xiRAID Classic {{ xiraid_version }} on Ubuntu LTS with DKMS-built
kernel module. The role accepts the xiRAID EULA automatically using
`xicli settings eula modify -s accepted`.

## Variables
* `xiraid_version` – set to 4.2.0, 4.1.0 ...
* `xiraid_repo_version` – version of `xiraid-repo_*.deb` package.
* `xiraid_kernel` – kernel version used for the repo package (defaults to major.minor of the current kernel).
* `xiraid_repo_pkg_url` – full URL to download the repository package; override for offline mirror.
* `xiraid_packages` – list of deb packages (defaults to `xiraid-core`).
* `xiraid_auto_reboot` – reboot after install.
* `xiraid_accept_eula` – automatically accept the xiRAID EULA (default: `true`).

## Example play snippet
```yaml
- hosts: storage_nodes
  roles:
    - xiraid_classic
```

### References
* Xinnor xiRAID 4.2.0 Installation Guide (Ubuntu)
* xiRAID Classic 4.1.0 PDF – package names and repo workflow
