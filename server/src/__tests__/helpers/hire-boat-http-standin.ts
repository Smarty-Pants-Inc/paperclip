import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";

/** External Boat API simulator only. Guest commands run for real inside the
 * caller's disposable mount namespace, not through a substituted Core service.
 * It never calls a lifecycle worker or writes Paperclip's database. */
export async function startHireBoatHttpStandin() {
  type Box = { id: string; state: string; stoppedAt: string | null; stop?: { id: string; status: string }; team: { id: string }; labels: Record<string, string>; createdAt: string };
  const boxes = new Map<string, Box>();
  const calls: Array<{ method: string; path: string; boxId: string | null; atNs: string; command?: string; status?: number }> = [];
  let faultBox: string | null = null;
  let inject = false;
  let closedGate = false;
  let faulted = false;
  let inspectState: "stopped" | "active" = "stopped";
  let previewPort = 0;
  let releaseStop: (() => void) | undefined;
  let releaseManifest: (() => void) | undefined;
  const transfers = new Map<string, string>();
  const guestPids = new Map<string, number>();
  function terminateGuest(id: string) {
    const pid = guestPids.get(id); if (!pid) return;
    try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    guestPids.delete(id);
  }
  const send = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value));
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = url.pathname.replace(/^\/api\/v1/, "");
    const boxId = /^\/sandboxes\/([^/]+)/.exec(route)?.[1] ?? null;
    const call: typeof calls[number] = { method: req.method ?? "GET", path: route, boxId, atNs: process.hrtime.bigint().toString() }; calls.push(call);
    console.info("BOAT_HTTP", JSON.stringify(call));
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const body = bytes.length ? JSON.parse(bytes.toString()) : {};
      if (route === "/orgs") return send(res, 200, { ok: true, organizations: [{ id: "org_hire_row" }] });
      if (route === "/sandboxes" && req.method === "GET") return send(res, 200, { sandboxes: [], pageInfo: { hasMore: false } });
      if (route === "/sandboxes" && req.method === "POST") {
        const id = `bx_${String(boxes.size + 2).padStart(8, "2")}`;
        const box: Box = { id, state: "ready", stoppedAt: null, team: { id: "org_hire_row" }, labels: body.labels ?? {}, createdAt: new Date().toISOString() };
        boxes.set(id, box); faultBox ??= id;
        return send(res, 200, { sandbox: box });
      }
      const box = boxId ? boxes.get(boxId) : undefined;
      if (!box) return send(res, 404, { ok: false, error: { code: "not_found" } });
      if (route === `/sandboxes/${boxId}` && req.method === "GET") {
        const observed = faulted && boxId === faultBox
          ? { ...box, state: inspectState === "active" ? "ready" : "archived", stoppedAt: inspectState === "active" ? null : new Date().toISOString() }
          : box;
        return send(res, 200, { sandbox: observed });
      }
      if (route.endsWith("/host")) {
        if (inject && !closedGate && boxId === faultBox) {
          faulted = true; call.status = 503;
          if (inspectState === "stopped") terminateGuest(boxId!);
          return send(res, 503, { ok: false, error: { code: "unavailable", message: "Boat sandbox lease is no longer active." } });
        }
        return send(res, 200, { url: "https://hire-row-43127.on.boat.dev/?_token=local-only", port: 43127, access: "private", isProtected: true });
      }
      if (route.endsWith("/stop")) {
        // The real terminal hook has already CLOSED admission before this
        // request. Hold only its HTTP response, leaving Core's lease active
        // until a concurrent same-account hire reaches the real plugin gate.
        if (closedGate && boxId === faultBox) await new Promise<void>(resolve => { releaseStop = resolve; });
        const refused = faulted && boxId === faultBox && inspectState === "active";
        box.state = refused ? "ready" : "archived"; box.stoppedAt = refused ? null : new Date().toISOString();
        // In the never-hide control Boat refuses the stop and keeps its box
        // active. Do not fabricate a successful stop/retirement receipt.
        box.stop = { id: `stop_${box.id}`, status: refused ? "failed" : "completed" };
        return send(res, 200, { sandbox: box, stop: box.stop });
      }
      if (route.includes("/stops/")) return send(res, 200, { stop: box.stop });
      if (route.endsWith("/resume")) { box.state = "ready"; box.stoppedAt = null; return send(res, 200, { sandbox: box }); }
      if (req.method === "PATCH") return send(res, 200, { sandbox: box });
      if (/\/files\/(?:upload|download)-url$/.test(route)) {
        const token = randomUUID(); transfers.set(token, body.path);
        return send(res, 200, { url: `https://127.0.0.1:${previewPort}/storage/${token}` });
      }
      if (route.endsWith("/files")) {
        const path = body.path ?? url.searchParams.get("path");
        if (typeof path !== "string" || !path.startsWith("/")) throw new Error("Expected absolute guest path");
        if (req.method === "PUT") { await mkdir(dirname(path), { recursive: true }); await writeFile(path, body.content ?? "", body.encoding === "base64" ? "base64" : "utf8"); return send(res, 200, { ok: true }); }
        if (req.method === "DELETE") { await rm(path, { force: true }); return send(res, 200, { ok: true }); }
        const content = await readFile(path);
        return send(res, 200, { content: content.toString("base64"), encoding: "base64" });
      }
      if (route.endsWith("/commands") && req.method === "POST") {
        call.command = body.command;
        // Hold the first real evidence command through the probe's ordinary
        // cleanup deadline. Only the observed REAL release RPC lets the test
        // answer it. Retirement cannot finish before release closes admission;
        // no timer, plugin state, callback or database row is manufactured.
        if (closedGate && !faulted && boxId === faultBox && String(body.command).includes("paperclip-probe-static-manifest")) {
          faulted = true;
          await new Promise<void>(resolve => { releaseManifest = resolve; });
          return send(res, 200, { exitCode: 1, timedOut: false, stdout: "", stderr: "evidence filesystem temporarily unavailable" });
        }
        // A provider outage ends guest access as well as ingress. The real
        // plugin's later release closes its admission gate; retained attempts
        // then fail at that gate, before sending another HTTP command.
        if (!closedGate && faulted && boxId === faultBox) { call.status = 503; return send(res, 503, { ok: false, error: { code: "unavailable" } }); }
        const result = await runChildProcess(`hire-boat-${randomUUID()}`, "/bin/sh", ["-c", body.command], {
          cwd: body.cwd ?? "/home/user", env: { HOME: "/home/user", PI_OFFLINE: "1", OTEL_SDK_DISABLED: "true" },
          timeoutSec: Math.min(body.timeoutSeconds ?? 60, 120), graceSec: 1, onLog: async () => {},
        });
        const launch = /^[^\n]+\n(\d+)\n\d{4}-\d\d-\d\dT/.exec(result.stdout);
        if (launch) guestPids.set(boxId!, Number(launch[1]));
        console.info("BOAT_COMMAND_RESULT", JSON.stringify({ boxId, command: String(body.command).slice(0, 180), exitCode: result.exitCode, stdout: result.stdout.slice(-1200), stderr: result.stderr.slice(-1200) }));
        return send(res, 200, result);
      }
      throw new Error(`Unhandled stand-in route ${req.method} ${route}`);
    } catch (error) { console.error("BOAT_STANDIN_ERROR", String(error)); call.status = 500; send(res, 500, { error: String(error) }); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing Boat listener");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`, boxes, calls,
    begin(state: "healthy" | "stopped" | "active", mechanism: "ingress-503" | "closed-gate" = "ingress-503") {
      closedGate = mechanism === "closed-gate";
      inject = state !== "healthy"; inspectState = state === "active" ? "active" : "stopped";
      faulted = false; faultBox = null; calls.length = 0; releaseStop = undefined; releaseManifest = undefined;
    },
    get manifestHeld() { return releaseManifest !== undefined; },
    failManifest() { const resolve = releaseManifest; releaseManifest = undefined; resolve?.(); },
    get stopHeld() { return releaseStop !== undefined; },
    finishStop() { const resolve = releaseStop; releaseStop = undefined; resolve?.(); },
    get faulted() { return faulted; }, get faultBox() { return faultBox; },
    setPreviewPort(port: number) { previewPort = port; },
    async serveStorage(req: IncomingMessage, res: ServerResponse) {
      const token = /^\/storage\/([^/?]+)/.exec(req.url ?? "")?.[1];
      const path = token && transfers.get(token);
      if (!path) { res.writeHead(404).end(); return; }
      if (req.headers.authorization) { res.writeHead(403).end(); return; }
      try {
        if (req.method === "PUT") {
          const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
          await mkdir(dirname(path), { recursive: true }); await writeFile(path, Buffer.concat(chunks));
          res.writeHead(200).end();
        } else { const content = await readFile(path); res.writeHead(200, { "content-type": "application/octet-stream" }).end(content); }
      } catch (error) { res.writeHead(500).end(String(error)); }
    },
    async close() { releaseManifest?.(); releaseStop?.(); for (const id of guestPids.keys()) terminateGuest(id); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
