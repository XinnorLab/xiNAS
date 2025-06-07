# Role **xiraid_classic**
Installs Xinnor xiRAID Classic {{ xiraid_version }} on Ubuntu LTS with DKMS-built
kernel module.

## Variables
* `xiraid_version` – set to 4.2.0, 4.1.0 ...
* `xiraid_repo_url` – auto-derived; override for offline mirror.
* `xiraid_packages` – list of debs (`xiraid-core`, `xicli`, etc.).
* `xiraid_auto_reboot` – reboot after install.

## Example play snippet
```yaml
- hosts: storage_nodes
  roles:
    - xiraid_classic
```

### References
* Xinnor xiRAID 4.2.0 Installation Guide (Ubuntu)
* xiRAID Classic 4.1.0 PDF – package names and repo workflow
