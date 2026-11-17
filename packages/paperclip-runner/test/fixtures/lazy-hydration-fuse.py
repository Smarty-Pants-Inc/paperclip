#!/usr/bin/env python3
"""A tiny unprivileged FUSE file system (raw /dev/fuse protocol via fusermount3)
that models a box still hydrating from a snapshot: files present at mount time
live on the lazy backing store; files created afterwards are local. rename(2)
of a local file onto a not-yet-local file returns EXDEV, exactly as the kernel
reports it from the file system. Writing a lazy file in place makes it local.

Usage: lazy-hydration-fuse.py MOUNTPOINT NAME=SEEDFILE...
Prints "ready" when mounted; unmount with `fusermount3 -u MOUNTPOINT`.
"""
import array, errno, os, socket, stat, struct, subprocess, sys, time

mountpoint = sys.argv[1]
nodes = {1: {"name": None, "dir": True}}
names = {}
next_node = [2]
for spec in sys.argv[2:]:
    name, seed = spec.split("=", 1)
    with open(seed, "rb") as handle:
        data = bytearray(handle.read())
    node = next_node[0]; next_node[0] += 1
    nodes[node] = {"name": name, "dir": False, "data": data, "lazy": True, "mode": 0o600}
    names[name] = node

left, right = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
env = dict(os.environ, _FUSE_COMMFD=str(right.fileno()))
mount = subprocess.Popen(["fusermount3", "-o", "rw,nosuid,nodev,fsname=lazyhydration,subtype=lazyhydration", "--", mountpoint],
                         env=env, pass_fds=[right.fileno()])
# Only fusermount3 may hold the other end: if it fails (mount denied), recvmsg
# then sees EOF instead of blocking forever on our own copy.
right.close()
fds = array.array("i")
_, ancillary, _, _ = left.recvmsg(1, socket.CMSG_LEN(fds.itemsize))
for level, kind, payload in ancillary:
    if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
        fds.frombytes(payload[: fds.itemsize])
mount.wait()
if not fds:
    sys.exit(f"fusermount3 did not pass a /dev/fuse descriptor (exit {mount.returncode})")
fuse = fds[0]

uid, gid = os.getuid(), os.getgid()

def attr(node):
    entry = nodes[node]
    now = int(time.time())
    if entry["dir"]:
        mode, size, nlink = stat.S_IFDIR | 0o700, 0, 2
    else:
        mode, size, nlink = stat.S_IFREG | entry["mode"], len(entry["data"]), 1
    return struct.pack("<QQQQQQIIIIIIIIII", node, size, (size + 511) // 512, now, now, now, 0, 0, 0, mode, nlink, uid, gid, 0, 4096, 0)

def entry_out(node):
    return struct.pack("<QQQQII", node, 0, 0, 0, 0, 0) + attr(node)

def reply(unique, error=0, data=b""):
    os.write(fuse, struct.pack("<IiQ", 16 + len(data), -error if error else 0, unique) + data)

def cstrings(body):
    return [part.decode() for part in body.split(b"\0")[:-1]]

print("ready", flush=True)
while True:
    try:
        request = os.read(fuse, 1 << 21)
    except OSError as error:
        if error.errno in (errno.ENODEV, errno.EBADF):
            break
        if error.errno == errno.EINTR:
            continue
        raise
    if not request:
        break
    length, opcode, unique, node = struct.unpack_from("<IIQQ", request)
    body = request[40:length]
    if opcode == 26:  # INIT
        major, minor, readahead, flags = struct.unpack_from("<IIII", body)
        reply(unique, 0, struct.pack("<IIIIHHIIHHI7I", 7, min(minor, 31), readahead, 0, 16, 12, 1 << 20, 1, 0, 0, 0, *([0] * 7)))
    elif opcode in (2, 42):  # FORGET, BATCH_FORGET: no reply
        continue
    elif opcode == 1:  # LOOKUP
        (name,) = cstrings(body)
        if name in names:
            reply(unique, 0, entry_out(names[name]))
        else:
            reply(unique, errno.ENOENT)
    elif opcode == 3:  # GETATTR
        reply(unique, 0, struct.pack("<QII", 0, 0, 0) + attr(node)) if node in nodes else reply(unique, errno.ENOENT)
    elif opcode == 4:  # SETATTR
        valid = struct.unpack_from("<I", body)[0]
        size = struct.unpack_from("<Q", body, 16)[0]
        mode = struct.unpack_from("<I", body, 76)[0]
        entry = nodes[node]
        if valid & 8 and not entry["dir"]:
            del entry["data"][size:]
            entry["data"].extend(b"\0" * (size - len(entry["data"])))
            entry["lazy"] = False
        if valid & 1:
            entry["mode"] = mode & 0o777
        reply(unique, 0, struct.pack("<QII", 0, 0, 0) + attr(node))
    elif opcode == 35:  # CREATE
        flags, mode, umask, _ = struct.unpack_from("<IIII", body)
        (name,) = cstrings(body[16:])
        if name in names and flags & os.O_EXCL:
            reply(unique, errno.EEXIST)
            continue
        if name not in names:
            created = next_node[0]; next_node[0] += 1
            nodes[created] = {"name": name, "dir": False, "data": bytearray(), "lazy": False, "mode": mode & 0o777 & ~umask}
            names[name] = created
        reply(unique, 0, entry_out(names[name]) + struct.pack("<QII", names[name], 0, 0))
    elif opcode in (14, 27):  # OPEN, OPENDIR
        reply(unique, 0, struct.pack("<QII", node, 0, 0))
    elif opcode == 15:  # READ
        _, offset, size = struct.unpack_from("<QQI", body)
        reply(unique, 0, bytes(nodes[node]["data"][offset:offset + size]))
    elif opcode == 16:  # WRITE
        _, offset, size = struct.unpack_from("<QQI", body)
        data = body[40:40 + size]
        target = nodes[node]["data"]
        if len(target) < offset:
            target.extend(b"\0" * (offset - len(target)))
        target[offset:offset + size] = data
        nodes[node]["lazy"] = False
        reply(unique, 0, struct.pack("<II", size, 0))
    elif opcode == 28:  # READDIR
        _, offset, size = struct.unpack_from("<QQI", body)
        out = b""
        for index, name in enumerate(sorted(names), start=1):
            if index <= offset:
                continue
            encoded = name.encode()
            dirent = struct.pack("<QQII", names[name], index, len(encoded), stat.S_IFREG >> 12) + encoded
            dirent += b"\0" * (-len(dirent) % 8)
            if len(out) + len(dirent) > size:
                break
            out += dirent
        reply(unique, 0, out)
    elif opcode in (18, 25, 20, 29, 30, 34, 38):  # RELEASE FLUSH FSYNC RELEASEDIR FSYNCDIR ACCESS DESTROY
        reply(unique)
    elif opcode == 10:  # UNLINK
        (name,) = cstrings(body)
        if name in names:
            del nodes[names.pop(name)]
            reply(unique)
        else:
            reply(unique, errno.ENOENT)
    elif opcode in (12, 45):  # RENAME, RENAME2
        old, new = cstrings(body[8 if opcode == 12 else 16:])
        if old not in names:
            reply(unique, errno.ENOENT)
        elif new in names and nodes[names[new]].get("lazy"):
            # The existing file is still on the lazy backing store.
            reply(unique, errno.EXDEV)
        else:
            if new in names:
                del nodes[names.pop(new)]
            moved = names.pop(old)
            nodes[moved]["name"] = new
            names[new] = moved
            reply(unique)
    elif opcode == 17:  # STATFS
        reply(unique, 0, struct.pack("<QQQQQIIII6I", 1 << 20, 1 << 19, 1 << 19, 1024, 512, 4096, 255, 4096, 0, *([0] * 6)))
    elif opcode == 36:  # INTERRUPT
        continue
    else:
        reply(unique, errno.ENOSYS)
