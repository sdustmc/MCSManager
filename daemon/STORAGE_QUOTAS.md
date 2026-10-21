# XFS storage quotas

Storage limits use GiB (1024³ bytes). Existing instances retain the original
10% hard-limit buffer unless it is explicitly changed. A buffer of 0% produces
a strict hard limit. Disk checks stop running instances at their allocated
capacity; the buffer leaves extra space for saving data. File limits use inode
counts, including directories; a value of zero means unlimited.

## Requirements

The Daemon must run on Linux and have permission to manage XFS project quotas
and the project registration files. The host needs `findmnt` and `xfs_quota`.
Both project accounting and enforcement must be enabled. The environment check
reads `xfs_quota state -p`; a mount option alone is not sufficient.

Each instance needs a dedicated directory. Filesystem roots, symlinks, and
overlapping project trees are rejected. Containerized Daemons must have the
existing host workspace mapping configured and access to the host quota tools,
mount information, and registration files.

## Storage pools

Configure storage pools in the node's **Storage pools** tab. Each pool has a name,
an existing directory on a distinct XFS filesystem, and reserved free space in
GiB. Its report separates actual free space, assigned hard limits, and capacity
available for new allocations. These are allocation checks, not physical space
reservations; other host applications can still consume disk space.

Pool paths use the Daemon's local directory layout. Host workspace mapping is
applied before inspecting filesystems and checking allocations. Both the local
directory and the mapped host directory must be accessible to the Daemon.

Choose a pool when creating or editing an instance. New instance directories
are placed under the selected pool using the instance UUID. Changing the pool
of an existing instance requires it to be stopped and its current directory to
be empty. Migrate and verify existing files before changing the directory; the
panel does not silently move or delete them. Pools in use cannot be removed or
relocated.

Clearing a pool selection uses the default instance directory unless an explicit
directory outside the old pool is supplied. The instance must be stopped and
its old directory empty. An assignment cannot be cleared while its target
directory still overlaps the old pool, including when the pool is also the
default instance directory.

## Applying and recovering changes

Quota changes are asynchronous. The instance editor waits for a verified result
and displays applying, active, unknown, or failed state. Expanding a quota and
changing its thresholds can be applied while the instance runs. Disabling quota,
changing process type, or changing directories requires a stopped instance.
Shrinking below current block or inode usage is rejected.
Quota edits wait until startup, shutdown, or installation has finished. Startup
also rechecks pending quota work after creating a missing instance directory.

Operations are serialized to protect allocation checks. `/etc/projects` and
`/etc/projid` keep their existing atomic transaction protection. Instance quota
operations additionally persist a recovery record under
`data/StorageQuotaOperation/`. New records include the complete preceding
instance configuration and use owner-only file permissions (0600). Older
quota-only records remain readable. Interrupted operations restore the preceding
configuration and quota on restart, rebuild command dispatch when needed, and
reinitialize project inheritance before finishing recovery. Failed rollback
retains its record and blocks instance start, configuration edits, and deletion
until **Retry / recover quota** succeeds.
Do not remove a recovery record to bypass this check.

Recovery reinstates the preceding block and inode limits even if buffered writes
have exceeded the allocation or the pool has run out of allocatable capacity.
The usual allocation checks still apply to new changes. The panel records
asynchronous configuration audits after the Daemon reports completion, without
holding the editor's save request open. Failed completion requests are logged.

Usage comes from XFS numeric project reports, cached and shared per filesystem
for 30 seconds. Stopped instances retain their disk measurements. Read failures
show an unknown state and preserve the last measurement and timestamp. Warning
thresholds apply to both allocated bytes and the configured inode limit.

New hard-quota instances expose an applying state immediately. The creation
screen waits for verified completion before requesting upload credentials or
reporting success. Upload handshakes, chunk writes, and file mutations reject
pending or unapplied quotas; multipart prechecks run before receiving temporary
files. Read access and file deletion remain available after a failed operation
when no recovery record is pending.

Reinstallation and deleting the workspace contents preserve the root directory
inode. Preset downloads initialize the quota before writing files. Reusing an
existing project registration also checks the actual root with
`project -c -d 0` and repairs missing project flags instead of relying only on
the saved project identifier. Normal status banners are distinguished from
diagnostics, as emitted by the [upstream project command](https://kernel.googlesource.com/pub/scm/linux/kernel/git/djwong/xfsprogs-dev/+/refs/tags/health-monitoring_2025-09-05/quota/project.c).

Container takeover attaches existing processes independently of cold-start
checks, including while quota recovery is running. An attachment failure is
logged for that container, leaves its instance busy, and does not kill the
container or interrupt other takeovers. Expiry still applies after attachment.
Storage pool accounting ignores instances on other filesystems before checking
their quota suitability; limits and reserves on the pool itself remain enforced.

Reference: [xfs_quota manual](https://man7.org/linux/man-pages/man8/xfs_quota.8.html).

## Validation

Run `npm test` in `daemon`, `panel`, and `frontend`. Quota regression tests use
temporary project files and simulated XFS commands. They do not modify the host's
mounts, project files, or quota limits. Production verification additionally
requires a disposable XFS filesystem with project accounting and enforcement.
