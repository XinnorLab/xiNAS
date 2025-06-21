# Role **xiraid_exporter**
Installs the [xiraid_exporter](https://github.com/ithilbor/xiraid_exporter) binary and runs it as a systemd service. The exporter exposes xiRAID metrics for Prometheus.

## Variables
* `xiraid_exporter_version` – exporter release version (default `2.0.0`).
* `xiraid_exporter_flags` – list of command line flags passed to the service.

## Example
```yaml
- hosts: storage_nodes
  roles:
    - role: xiraid_exporter
```
