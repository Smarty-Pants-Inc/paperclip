#!/usr/bin/env bash
# Linux-only, disposable network/mount/PID namespace. No host /etc/hosts or
# /home/user changes. Run with normal user privileges; sudo is namespace-only.
set -euo pipefail
: "${TMPDIR:?Use a disposable scratch directory}"
: "${PAPERCLIP_HIRE_BOAT_PACKAGE:?Path to built Boat 0.1.17-spare.6}"
: "${PAPERCLIP_RUNNER_BINARY:?Path to built paperclip-runnerd}"
: "${PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH:?Path to built provider pack}"
work=${PAPERCLIP_HIRE_BOAT_GUEST_ROOT:-$(mktemp -d "$TMPDIR/hire-boat-namespace-XXXXXX")}
mkdir -p "$work/original-home" "$work/guest-home" "$work/guest-tmp"
cp /etc/hosts "$work/hosts"
printf '\n127.0.0.1 hire-row-43127.on.boat.dev\n' >> "$work/hosts"
# A preinstalled provider pack, like the real Boat snapshot. The runtime still
# verifies all bytes and stages its actual runner binary through Boat HTTP.
pack="$work/guest-home/paperclip-workspace/.paperclip-runtime/paperclip-runner/provider-pack"
if ! test -e "$pack"; then
  mkdir -p "$(dirname "$pack")"
  ln -s "$PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH" "$pack"
fi
printf 'HIRE_BOAT_NAMESPACE=%s\n' "$work"
exec sudo -n unshare --mount --net --pid --fork --mount-proc --propagation private bash -c '
  set -euo pipefail
  work=$1; uid=$2; gid=$3; home=$4; path=$5; tmp=$6; out=$7; boat=$8; runner=$9; shift 9; pack=$1; shift
  ip link set lo up
  sysctl -qw net.ipv4.ip_unprivileged_port_start=0
  mount --bind "$work/hosts" /etc/hosts
  mount --bind /home "$work/original-home"
  mount -t tmpfs -o mode=755 tmpfs /home
  mkdir -p "$home" /home/user
  case "$home" in /home/*) mount --bind "$work/original-home/${home#/home/}" "$home";; esac
  mount --bind "$work/guest-home" /home/user
  mount --bind "$work/guest-tmp" /tmp
  # A real guest has an init that reaps detached runnerd generations. Vitest
  # must not be PID 1: zombie runners would falsely keep physical retirement
  # pending (including the runner process group and its stderr copier).
  exec python3 "$1" setpriv --reuid="$uid" --regid="$gid" --init-groups env HOME="$home" PATH="$path" TMPDIR="$tmp" TASK_OUT="$out" PAPERCLIP_HIRE_BOAT_NAMESPACE=1 PAPERCLIP_HIRE_BOAT_PACKAGE="$boat" PAPERCLIP_RUNNER_BINARY="$runner" PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH="$pack" "${@:2}"
' namespace "$work" "$(id -u)" "$(id -g)" "$HOME" "$PATH" "$TMPDIR" "${TASK_OUT:-}" "$PAPERCLIP_HIRE_BOAT_PACKAGE" "$PAPERCLIP_RUNNER_BINARY" "$PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH" "$(cd -- "$(dirname -- "$0")" && pwd)/hire-boat-init.py" "$@"
