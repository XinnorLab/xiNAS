# Role: net_controllers

Configures static IPv4 addresses for network controllers using netplan.

By default, the template sets interface `ib0` with address `100.100.100.1/24`.
A startup script can modify the template before running Ansible to configure
other interfaces and addresses. When executed it lists all available interfaces
along with their current IPv4 address and link speed so that you can select the
correct device.
