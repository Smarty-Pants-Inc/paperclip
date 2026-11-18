import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PiRpcTransport } from "./pi-rpc-transport.js";

function alive(pid: number): boolean {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[0] !== "Z"; }
  catch { return false; }
}
// Keep reason: bounded escalation/process-tree cleanup is a data-safety failure
// path. Real OS children, not mocked kill-call counts, catch inherited groups.
describe.skipIf(process.platform !== "linux")("Pi Stop process-group escalation", () => {
  it.each([false, true])("TERM/KILL reaches a stubborn tool child (native detached group=%s)", async detached => {
    const transport = new PiRpcTransport({ command: process.execPath, args: ["-e", `
      const { spawn } = require('node:child_process');
      process.on('SIGTERM', () => {});
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: ['ignore','pipe','inherit'], detached: ${detached} });
      const ready = new Promise(resolve => child.stdout.once('data', resolve));
      process.stdin.once('data', async data => { await ready; const req=JSON.parse(data); process.stdout.write(JSON.stringify({type:'response',id:req.id,success:true,data:{child:child.pid}})+'\\n'); });
      process.stdin.resume(); process.stdin.on('end',()=>{}); setInterval(()=>{},1000);
    `], cwd: process.cwd(), shutdownTimeoutMs: 50, killTimeoutMs: 100 });
    let child = 0;
    try {
      const reply = await transport.request("ready"); child = (reply.data as { child: number }).child;
      const stat = readFileSync(`/proc/${transport.pid}/stat`, "utf8").split(") ")[1]!.split(" ");
      expect(Number(stat[2]), "Pi's process-group leader is its own PID").toBe(transport.pid);
      expect(alive(child)).toBe(true);
      await transport.close();
      expect(transport.exitInfo?.signal).toBe("SIGKILL");
      expect(alive(child), "no tool child survives escalation").toBe(false);
    } finally {
      if (child && alive(child)) { try { process.kill(child, "SIGKILL"); } catch {} }
      await transport.close();
    }
  });
});
