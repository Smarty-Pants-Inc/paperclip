import { lstatSync, readFileSync, realpathSync, Stats } from "node:fs";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRUSTED_PI_EXECUTABLE_ARG, trustedPiLaunchBinding } from "./pi-proxy-command.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    lstatSync: vi.fn(original.lstatSync),
    readFileSync: vi.fn(original.readFileSync),
    realpathSync: vi.fn(original.realpathSync),
  };
});

// Keep reason: owner, inode shape, canonical path and sealed-byte checks are a trust boundary.
// Mock metadata as in the Pi runtime integrity tests: root ownership needs no privileged chown.
describe.skipIf(process.platform !== "linux")("Pi executable and proxy owner trust", () => {
  const runtimeUid = 1000;
  const executable = "/pack/pi";
  const proxy = "/pack/cli/pi-rpc-app-server-proxy.cjs";
  const executableFd = "/proc/self/fd/7";
  const proxyFd = "/proc/self/fd/8";
  const originalArgv = process.argv;
  const metadata = new Map<string, Stats>();
  const contents = new Map<string, Buffer>();
  const canonicalPaths = new Map<string, string>();
  const args = [TRUSTED_PI_EXECUTABLE_ARG, executableFd, "--paperclip-pi-executable-path", executable,
    "--paperclip-pi-proxy-path", proxy];

  beforeEach(() => {
    vi.spyOn(process, "getuid").mockReturnValue(runtimeUid);
    process.argv = [process.execPath, proxyFd];
    metadata.clear(); contents.clear(); canonicalPaths.clear();
    for (const [path, fd, bytes] of [[executable, executableFd, "verified Pi"], [proxy, proxyFd, "verified proxy"]]) {
      metadata.set(path!, Object.assign(new Stats(), { mode: 0o100755, uid: runtimeUid, nlink: 1 }));
      contents.set(path!, Buffer.from(bytes!)); contents.set(fd!, Buffer.from(bytes!));
      canonicalPaths.set(path!, path!);
    }
    vi.mocked(lstatSync).mockImplementation(((path) => {
      const result = metadata.get(String(path));
      if (!result) throw new Error("missing fixture metadata");
      return result;
    }) as typeof lstatSync);
    vi.mocked(readFileSync).mockImplementation(((path) => {
      const result = contents.get(String(path));
      if (!result) throw new Error("missing fixture bytes");
      return result;
    }) as typeof readFileSync);
    vi.mocked(realpathSync).mockImplementation(((path) => canonicalPaths.get(String(path))!) as typeof realpathSync);
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  const acceptedOwners = [
    { executableUid: runtimeUid, proxyUid: runtimeUid },
    { executableUid: 0, proxyUid: runtimeUid },
    { executableUid: runtimeUid, proxyUid: 0 },
    { executableUid: 0, proxyUid: 0 },
  ].flatMap(owners => [0o755, 0o644].map(mode => ({ ...owners, mode })));

  it.each(acceptedOwners)("accepts executable uid $executableUid and proxy uid $proxyUid with mode $mode", ({ executableUid, proxyUid, mode }) => {
    Object.assign(metadata.get(executable)!, { uid: executableUid, mode: 0o100000 | mode });
    Object.assign(metadata.get(proxy)!, { uid: proxyUid, mode: 0o100000 | mode });
    expect(trustedPiLaunchBinding(args)).toEqual({
      command: executable,
      trustedProxyEntrypointUrl: pathToFileURL(proxy).href,
    });
  });

  it.each([0o755, 0o644])("accepts a root-owned executable without a proxy binding with mode %i", mode => {
    Object.assign(metadata.get(executable)!, { uid: 0, mode: 0o100000 | mode });
    expect(trustedPiLaunchBinding(args.slice(0, 4))).toEqual({ command: executable });
  });

  describe.each(["executable", "proxy"] as const)("%s rejection guards", target => {
    it.each(["foreign owner", "group writable", "other writable", "symlink", "directory", "hardlink", "noncanonical", "different bytes"])(
      "rejects %s even when both paths otherwise have trusted root ownership", defect => {
        metadata.get(executable)!.uid = 0;
        metadata.get(proxy)!.uid = 0;
        const path = target === "executable" ? executable : proxy;
        const stat = metadata.get(path)!;
        if (defect === "foreign owner") stat.uid = runtimeUid + 1;
        if (defect === "group writable") stat.mode |= 0o020;
        if (defect === "other writable") stat.mode |= 0o002;
        if (defect === "symlink") stat.mode = 0o120755;
        if (defect === "directory") stat.mode = 0o040755;
        if (defect === "hardlink") stat.nlink = 2;
        if (defect === "noncanonical") canonicalPaths.set(path, `/elsewhere${path}`);
        if (defect === "different bytes") contents.set(path, Buffer.from("not the sealed descriptor bytes"));
        expect(() => trustedPiLaunchBinding(args)).toThrow(/binding is unavailable/);
      },
    );
  });

  it("requires a known runtime uid even for root-owned files", () => {
    metadata.get(executable)!.uid = 0;
    metadata.get(proxy)!.uid = 0;
    vi.mocked(process.getuid).mockReturnValue(undefined as unknown as number);
    expect(() => trustedPiLaunchBinding(args)).toThrow(/binding is unavailable/);
  });
});
