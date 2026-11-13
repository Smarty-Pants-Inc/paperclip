import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";

function field(value: string | Buffer): Buffer {
  const body = typeof value === "string" ? Buffer.from(value) : value;
  const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}
export type AgentIdentity = { dir: string; socket: string; publicKey: string; publicFile: string; pid: number; workerId: string };

/** A private OpenSSH agent, not the operator's ambient agent. Private material is
 * sent only in SSH_AGENTC_ADD_IDENTITY over its Unix socket and then zeroed. */
export class OwnedSshAgent {
  readonly workerId = randomUUID();
  // Disabled workers do not generate keys or start an agent. Generate only on
  // the first admitted SSH preparation, not when the plugin module is loaded.
  private keypair: { privateKey: KeyObject; publicKey: KeyObject } | undefined;
  private child?: ChildProcessWithoutNullStreams;
  private directory?: string;
  private starting?: Promise<AgentIdentity>;
  private closed = false;
  start(): Promise<AgentIdentity> {
    if (this.closed) return Promise.reject(new Error("BOAT_SSH_AGENT_CLOSED"));
    return this.starting ??= this.create();
  }
  private async create(): Promise<AgentIdentity> {
    this.keypair = generateKeyPairSync("ed25519");
    const dir = this.directory = await mkdtemp(join(tmpdir(), "bssh-"));
    const socket = join(dir, "agent.sock");
    if (Buffer.byteLength(socket) > 100) throw new Error("BOAT_SSH_SOCKET_PATH_TOO_LONG");
    const child = this.child = spawn("ssh-agent", ["-D", "-a", socket], {
      env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: "pipe",
    });
    // ssh-agent emits its non-secret socket address only after bind/listen.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => done(new Error("BOAT_SSH_AGENT_START_FAILED")), 5000);
      const done = (error?: Error) => { clearTimeout(timeout); child.stdout.off("data", ready); child.off("error", failed); child.off("exit", exited); error ? reject(error) : resolve(); };
      const ready = () => done();
      const failed = () => done(new Error("BOAT_SSH_AGENT_START_FAILED"));
      const exited = () => failed();
      child.stdout.once("data", ready); child.once("error", failed); child.once("exit", exited);
    });
    child.stdout.resume(); child.stderr.resume();
    if (!this.keypair) throw new Error("BOAT_SSH_AGENT_CLOSED");
    const { privateKey, publicKey } = this.keypair;
    const priv = privateKey.export({ format: "jwk" });
    const pub = publicKey.export({ format: "jwk" });
    const seed = Buffer.from(priv.d!, "base64url"), rawPublic = Buffer.from(pub.x!, "base64url");
    const rawPrivate = Buffer.concat([seed, rawPublic]);
    const publicLine = `ssh-ed25519 ${Buffer.concat([field("ssh-ed25519"), field(rawPublic)]).toString("base64")}`;
    const message = Buffer.concat([Buffer.from([17]), field("ssh-ed25519"), field(rawPublic), field(rawPrivate), field(`paperclip-boat-carrier:${this.workerId}`)]);
    try { await addIdentity(socket, message); }
    finally { seed.fill(0); rawPrivate.fill(0); message.fill(0); delete priv.d; this.keypair = undefined; }
    const publicFile = join(dir, "identity.pub");
    await writeFile(publicFile, publicLine + "\n", { mode: 0o600, flag: "wx" });
    return { dir, socket, publicKey: publicLine, publicFile, pid: child.pid!, workerId: this.workerId };
  }
  async close(removeDirectory = true): Promise<void> {
    this.closed = true;
    await this.starting?.catch(() => {});
    this.keypair = undefined;
    if (this.child) await stopLocalProcess(this.child);
    if (removeDirectory && this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}
function addIdentity(path: string, message: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let bytes = Buffer.alloc(0), settled = false;
    const packet = field(message);
    const done = (ok: boolean) => { if (settled) return; settled = true; packet.fill(0); socket.destroy(); ok ? resolve() : reject(new Error("BOAT_SSH_AGENT_ADD_FAILED")); };
    socket.setTimeout(5000, () => done(false));
    socket.once("error", () => done(false));
    socket.once("close", () => done(false));
    socket.once("connect", () => socket.write(packet));
    socket.on("data", part => {
      bytes = Buffer.concat([bytes, part]);
      if (bytes.length > 5 || (bytes.length >= 4 && bytes.readUInt32BE(0) !== 1)) done(false);
      else if (bytes.length === 5) done(bytes[4] === 6);
    });
  });
}
export async function stopLocalProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
    const deadline = setTimeout(() => { cleanup(); reject(new Error("BOAT_SSH_PROCESS_CLOSE_UNCONFIRMED")); }, 3000);
    const cleanup = () => { clearTimeout(kill); clearTimeout(deadline); child.off("close", closed); };
    const closed = () => { cleanup(); resolve(); };
    child.once("close", closed); child.kill("SIGTERM");
  });
}
