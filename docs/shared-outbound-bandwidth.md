# Shared outbound bandwidth

Each node can have one shared upload pool. Instances that join it use the lowest
priority queue on the configured uplink. Other traffic on that interface uses the
normal queue, which is always served first. A busy normal queue can starve shared
uploads. Existing per-instance upload and download limits continue to apply.

For a node with a usable uplink set to 95 Mbps and a shared limit of 80 Mbps:

| Normal traffic | Maximum combined shared traffic |
| -------------- | ------------------------------- |
| 0 Mbps         | 80 Mbps                         |
| 40 Mbps        | About 55 Mbps                   |
| 95 Mbps        | About 0 Mbps                    |

The shared limit is a combined cap, not a guaranteed rate or an equal share for
each instance. Packet bursts and protocol overhead affect measured throughput.

## Setup

1. Open the node settings and select **Shared outbound bandwidth**.
2. Enable the pool and enter the outbound interface, such as `eth0`.
3. Set the usable uplink speed to about 90–95% of its measured sustained capacity.
   All outbound traffic on this interface is capped at this rate while the pool
   has members. This moves the bottleneck into the local scheduler, where normal
   traffic can be prioritized.
4. Set the combined shared upload limit at or below the usable uplink speed.
5. Enable **Use shared outbound bandwidth** in each participating instance's
   resource limits. Set **Shared upload limit for this instance** in Mbps, then
   restart those instances. Each instance can have a different limit; 0 adds no
   per-instance ceiling, while the node pool's combined cap still applies.

For example, set the node's shared limit to 20 Mbps, instance A to 10 Mbps, and
instance B to 20 Mbps. A can upload at up to 10 Mbps and B at up to 20 Mbps, but
their combined upload cannot exceed 20 Mbps. These are ceilings, not reserved
rates or a promise of a fixed split when both instances are busy. Normal traffic
still has priority over both instances.

The instance setting uses the existing container upload limit. The shared-mode
editor displays Mbps and stores the equivalent KB/s value (10 Mbps = 1250 KB/s;
20 Mbps = 2500 KB/s). Switching shared mode preserves the configured rate. This
per-instance ceiling also applies to uploads to local services; the node's shared
scheduler controls only outbound traffic on the selected uplink.

Changing the pool speeds applies to active members. Stop all participating
instances before disabling the pool or changing the interface. The node pool is
disabled by default, and existing instances do not join automatically. Portable
templates do not carry this node-specific membership setting.

## Supported environment

- Linux with local rootful Docker, with exactly one bridge network per instance.
- The Daemon must see the Docker host's network interfaces and container PIDs,
  and have network administration permission. For a containerized Daemon, use
  the host network and PID namespaces with appropriate capabilities.
- `tc` and `ip` from iproute2, with TBF, PRIO, fq_codel, matchall, fw and skbedit
  support. Existing IFB upload shaping remains compatible.
- An uplink without custom traffic control. The service refuses to overwrite
  another QoS tree and removes only its own rules when the last member exits.
- Packet mark bit `0x40000000` is reserved for shared uploads. Conflicting
  policy-routing rules are rejected. Firewall rules must preserve this bit
  between the container interface and uplink. The scheduler clears the bit as it
  classifies a packet; other mark bits are preserved.

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
They verify combined IPv4/IPv6 limits, different per-instance ceilings, normal
traffic priority, live rate changes, restart recovery, IFB compatibility, routing
conflicts and cleanup.

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
