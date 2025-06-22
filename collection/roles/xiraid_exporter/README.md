# Role **xiraid_exporter**
Installs the [xiraid_exporter](https://github.com/ithilbor/xiraid_exporter) binary and runs it as a systemd service. The exporter exposes xiRAID metrics for Prometheus.

The role now also generates self-signed TLS certificates for xiRAID in
`/etc/xraid/crt` and restarts the `xiraid.target` unit so the exporter can
connect securely without manual steps.

## Variables
* `xiraid_exporter_version` – exporter release version (default `2.0.0`).
* `xiraid_exporter_flags` – list of command line flags passed to the service.
* Generates certificates for `localhost` and connects to the xiRAID server on `localhost`.

## Example
```yaml
- hosts: storage_nodes
  roles:
    - role: xiraid_exporter
```
