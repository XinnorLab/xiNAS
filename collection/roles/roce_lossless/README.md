# roce_lossless

Configure lossless Ethernet (DCB/PFC/ETS) for RoCE on Mellanox/NVIDIA NICs.

## Overview

This role enables lossless transport for RoCEv2 over UDP/IP on NVIDIA/Mellanox NICs by configuring:

- **PFC** (Priority Flow Control) - Prevents packet loss by pausing traffic on congested priorities
- **ETS** (Enhanced Transmission Selection) - Guarantees bandwidth allocation for RoCE traffic
- **DSCP/PCP mapping** - Ensures RoCE traffic is marked and mapped to the correct priority
- **ECN** (Explicit Congestion Notification) - Enables proactive congestion signaling

## Requirements

- DOCA-OFED must be installed (run `doca_ofed` role first)
- Mellanox/NVIDIA NICs with mlx5_core driver
- `mlnx_qos` tool (included with DOCA-OFED)

## Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `roce_lossless_enabled` | `true` | Enable/disable the role |
| `roce_interfaces` | `[]` | Interfaces to configure (auto-detect if empty) |
| `roce_driver_filter` | `mlx5_core` | Driver to filter during auto-detection |
| `roce_pfc_priority` | `3` | PFC priority for RoCE traffic (0-7) |
| `roce_pfc_enabled` | `true` | Enable PFC |
| `roce_ets_tc_bw` | `10,10,10,50,10,0,10,0` | ETS bandwidth allocation (TC0-TC7, must sum to 100) |
| `roce_traffic_class` | `3` | Traffic class for RoCE |
| `roce_dscp` | `26` | RoCEv2 DSCP value (26=AF31) |
| `roce_pcp` | `3` | PCP (802.1p) value for VLAN-tagged traffic |
| `roce_trust_mode` | `dscp` | Trust mode: dscp, pcp, or both |
| `roce_version` | `2` | RoCE version (1 or 2) |
| `roce_cma_tos` | `106` | RDMA CM ToS value (-1 to skip) |
| `roce_ecn_enabled` | `true` | Enable ECN |
| `roce_validate` | `true` | Run validation checks |
| `roce_fail_on_validation_error` | `false` | Fail playbook if validation fails |
| `roce_persist` | `true` | Create systemd service for boot persistence |
| `roce_persist_script` | `/usr/local/sbin/roce-lossless-config.sh` | Path for persistence script |

## DSCP/ToS Values

Common DSCP values for RoCE:
- **26 (AF31)** - Standard RoCE traffic (default)
- **46 (EF)** - High-priority/expedited forwarding

ToS = DSCP << 2. For DSCP 26: ToS = 104 (or 106 with ECN bits).

## Example Playbook

```yaml
- hosts: storage_nodes
  roles:
    - role: doca_ofed
    - role: roce_lossless
      vars:
        roce_pfc_priority: 3
        roce_dscp: 26
        roce_ets_tc_bw: "10,10,10,50,10,0,10,0"
```

## Dependencies

- `doca_ofed` - Must run before this role to install OFED stack

## Network Switch Configuration

For true lossless behavior, the network switch must also be configured for DCB/PFC/ETS. Example for NVIDIA/Mellanox switches:

```
interface ethernet 1/1
  dcb priority-flow-control mode on force
  dcb priority-flow-control priority 3 enable
  dcb ets tc 3 bandwidth 50 strict
```

## Validation

The role validates:
1. PFC is active via `mlnx_qos -i <iface>`
2. RDMA devices are visible via `rdma link show`
3. `ibv_devinfo` shows HCA devices
4. `cma_roce_tos` sysctl matches configured value

## Persistence

When `roce_persist: true`, the role creates:
- `/usr/local/sbin/roce-lossless-config.sh` - Configuration script
- `/etc/systemd/system/roce-lossless.service` - Systemd service that runs after `openibd.service`

## Tags

- `roce_lossless` - All tasks
- `detection` - NIC detection only
- `dcb` - DCB/PFC/ETS configuration
- `pfc` - PFC configuration only
- `ets` - ETS configuration only
- `dscp` - DSCP/PCP mapping
- `roce` - RoCE mode and ToS
- `ecn` - ECN configuration
- `persist` - Persistence mechanism
- `validation` - Validation checks
