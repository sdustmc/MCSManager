# Shared outbound bandwidth

Each node can have one shared upload pool. Enabling it on an instance preserves
the original upload limit as a normal-priority dedicated allowance and adds an
independent low-priority shared allowance. Both settings are displayed in Mbps
while shared bandwidth is enabled. Download limits remain independent.

For example, 10 Mbps dedicated plus 10 Mbps shared permits up to 20 Mbps when
capacity is available. The dedicated portion uses the same normal queue as host
services and nonshared instances; the extra shared portion uses the lowest
priority queue. These are local priority allowances, not reserved provider
capacity or a guarantee against congestion within the normal queue.

For a node with a usable uplink set to 95 Mbps and a shared limit of 80 Mbps:

| Normal traffic | Maximum combined shared traffic |
| -------------- | ------------------------------- |
| 0 Mbps         | 80 Mbps                         |
| 40 Mbps        | About 55 Mbps                   |
| 95 Mbps        | About 0 Mbps                    |

Normal traffic in this table includes the dedicated portions of mixed instances.
The shared limit caps only the combined low-priority portions, not the dedicated
allowances. It is not a guaranteed rate or an equal share for each instance.
Packet bursts and protocol overhead affect measured throughput.

## Setup

1. Open the node settings and select **Shared outbound bandwidth**.
2. Enable the pool and enter the outbound interface, such as `eth0`.
3. Set the usable uplink speed to about 90–95% of its measured sustained capacity.
   All outbound traffic on this interface is capped at this rate while the pool
   has members. This moves the bottleneck into the local scheduler, where normal
   traffic can be prioritized.
4. Set the combined shared upload limit at or below the usable uplink speed.
5. Enable **Use shared outbound bandwidth** in each participating instance's
   resource limits. The original upload rate remains the **Dedicated upload
   allowance**. Set **Additional shared upload limit** separately and save.
   Running instances apply bandwidth changes immediately without restarting.
   Toggling the switch preserves both configured values. Failed updates restore
   the previous configuration and bandwidth rules and report an error.
6. A dedicated allowance of 0 selects shared-only traffic. A shared allowance of
   0 adds no per-instance shared ceiling; the node pool's combined cap still applies.

For a 20 Mbps shared pool, configure A with 10 Mbps dedicated plus 10 Mbps shared,
and B with 0 Mbps dedicated plus 20 Mbps shared. A can upload at up to 20 Mbps,
and B at up to 20 Mbps. Their shared portions together cannot exceed 20 Mbps;
the combined instance traffic can reach 30 Mbps including A's dedicated portion.
Normal traffic always takes priority over their shared portions.

The existing `docker.uploadSpeedLimit` remains the dedicated limit, and
`docker.sharedUploadSpeedLimit` stores the independent extra shared limit. Both
use KB/s in the API (10 Mbps = 1250 KB/s). With a finite shared ceiling, their sum
also caps container uploads to local services; priority splitting applies only
on the selected uplink. Older shared-only configurations are migrated on load
to a zero dedicated allowance and their previous shared ceiling, preserving
their existing behavior. Existing nonshared configurations keep their upload rate.

Changing the pool speeds applies to active members. Stop all participating
instances before disabling the pool or changing the interface. The node pool is
disabled by default, and existing instances do not join automatically. Portable
templates do not carry this node-specific membership setting.

## Supported environment

- Linux with local rootful Docker, with exactly one bridge network per instance.
- The Daemon must see the Docker host's network interfaces and container PIDs,
  and have network administration permission. For a containerized Daemon, use
  the host network and PID namespaces with appropriate capabilities.
- `tc` and `ip` from iproute2, with TBF, PRIO, fq_codel, matchall, fw, skbedit and
  goto-chain support. Mixed allowances also need basic/meta matching and police
  actions. Existing IFB upload shaping remains compatible.
- An uplink without custom traffic control. The service refuses to overwrite
  another QoS tree and removes only its own rules when the last member exits.
- Packet mark bit `0x40000000` is reserved for shared uploads. Mixed allowances
  additionally reserve mask `0x7fff0000` for container identification across
  routing and source NAT. Conflicting policy-routing rules are rejected before
  adding a mixed member. Firewall rules must preserve the reserved bits between
  the container interface and uplink. The scheduler clears its private bits at
  the uplink; bits outside the reserved mask are preserved.

Host networking, rootless Docker, remote Docker hosts and multiple networks on
one container are rejected for shared instances. New instances fail to start if
the shared pool cannot be applied. Membership is restored when the Daemon takes
over running containers after a restart.

This controls **outbound traffic on the selected interface**. It cannot guarantee
latency or throughput across an upstream bottleneck, a changing provider rate,
another uplink, or congestion caused by downloads before packets reach the host.
Shared uploads also consume CPU and other host resources; network scheduling does
not reserve those resources for other services.

## Verification

The ordinary Daemon suite includes configuration validation and real Docker
lifecycle checks. The traffic tests additionally require root, `unshare`,
`nsenter`, `iperf3`, `iptables`, `modprobe`, and an IFB-capable kernel. They create an isolated
router, receiver and two bridge clients, with no connection to the host network.
They verify combined IPv4/IPv6 limits, independent dedicated/shared allowances,
TCP uploads, different per-instance ceilings, normal traffic priority, live rate
changes, restart recovery, IFB compatibility, routing conflicts and cleanup.

From `daemon/`, using the absolute path to Node if sudo has a different PATH:

```sh
task_node="$(command -v node)"
sudo env MCSM_SHARED_NETWORK_TEST=1 unshare --net --mount --fork \
  sh -c 'ip link set lo up && exec "$@"' -- "$task_node" \
  node_modules/vitest/vitest.mjs run \
  src/service/__test__/shared_bandwidth_service.network.test.ts --reporter=verbose
```

The tests refuse to run unless the namespace starts with only a loopback
interface. IFB is loaded with `numifbs=0`, so loading its driver does not create
default IFB devices in the host namespace. No host uplink, route or firewall rule
is changed.
