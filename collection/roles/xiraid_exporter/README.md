# Role **xiraid_exporter**
Installs the [xiraid_exporter](https://github.com/ithilbor/xiraid_exporter) binary and runs it as a systemd service. The exporter exposes xiRAID metrics for Prometheus.

The role expects TLS certificates for xiRAID to already be present under
`/etc/xraid/crt`.  It will reload the `xiraid.target` unit so the exporter can
connect securely using those files.

## Variables
* `xiraid_exporter_version` – exporter release version (default `2.0.0`).
* `xiraid_exporter_flags` – list of command line flags passed to the service.
* Connects to the xiRAID server on `localhost` using the provided certificates.

## Example
```yaml
- hosts: storage_nodes
  roles:
    - role: xiraid_exporter
```
