#!/bin/sh
# Test-only. Root mount namespace; no mount or install is visible on the host.
set -eu
root=$1
uid=$2
gid=$3
node=$4
helper=$5
systemctl=$6
mount --make-rprivate /
mount --bind "$root/local" /usr/local
mount --bind "$root/run" /run
mount --bind "$root/tmp" /tmp
mount -t tmpfs tmpfs /home
mkdir -p /home/user
mount --bind "$root/home" /home/user
# /bin is /usr/bin on this fixture host. All tools below are exact local copies.
mount --bind "$root/bin" /usr/bin
exec /usr/bin/setpriv --reuid "$uid" --regid "$gid" --init-groups /usr/bin/node "$helper"
