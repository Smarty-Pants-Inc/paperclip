import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { DurablePrpControlPlane, PrpWireConnection } from "../vendor/paperclip-runner/index.js";
import { connectRunnerPrpIngress } from "./runner-prp-outbound.js";

describe("provider ingress startup over real TLS and WebSockets", () => {
  let root: string;
  let certificate: string;
  let key: string;
  const originalCAs = getCACertificates("default");
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "runner-ingress-tls-"));
    await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem"), "-days", "1",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"]);
    certificate = await readFile(join(root, "cert.pem"), "utf8");
    key = await readFile(join(root, "key.pem"), "utf8");
    setDefaultCACertificates([...originalCAs, certificate]);
  });
  afterAll(async () => {
    setDefaultCACertificates(originalCAs);
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.each(["cold", "unreachable", "stalled upgrade", "untrusted TLS"] as const)("handles a %s preview without escaping its startup budget", async mode => {
    const server = createServer({ key, cert: certificate });
    const wss = new WebSocketServer({ noServer: true });
    const sockets = new Set<Duplex>();
    server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    const availableAt = Date.now() + 200;
    let upgrades = 0;
    server.on("upgrade", (request, socket, head) => {
      upgrades += 1;
      if (mode === "stalled upgrade") return;
      if (mode === "unreachable" || Date.now() < availableAt) {
        socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(request, socket, head, peer => {
        peer.on("message", data => {
          if (JSON.parse(data.toString()).kind === "run.prepare") {
            peer.send(JSON.stringify({ kind: "run.prepared", result: "work can proceed" }));
          }
        });
        peer.send(JSON.stringify({ kind: "runner.ready" }));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    let activeWire: PrpWireConnection | undefined;
    let prepared!: (value: unknown) => void;
    const result = new Promise<unknown>(resolve => { prepared = resolve; });
    const endpoint = { kind: "authenticated_websocket" as const,
      websocketUrl: `wss://127.0.0.1:${port}/api/runner/v1/connect/run-fresh`,
      secretHeaders: [], generation: "tls-fixture", refresh: async () => endpoint, close: async () => {} };
    const startedAt = Date.now();
    if (mode === "untrusted TLS") setDefaultCACertificates(originalCAs);
    const handle = connectRunnerPrpIngress({ endpoint, startupDeadlineMs: 750, random: () => 0.5,
      authority: { attachWireConnection: (wire: PrpWireConnection) => {
        activeWire = wire;
        let authenticated = false;
        wire.onJson(value => {
          const message = value as { kind: string };
          if (message.kind === "runner.ready") authenticated = true;
          else if (message.kind === "run.prepared") prepared(value);
        });
        return { isAuthenticated: () => authenticated };
      } } as unknown as DurablePrpControlPlane,
    });
    try {
      if (mode === "cold") {
        await handle.ready;
        expect(upgrades).toBeGreaterThanOrEqual(2);
        activeWire!.sendJson({ kind: "run.prepare" });
        await expect(result).resolves.toEqual({ kind: "run.prepared", result: "work can proceed" });
      } else {
        await expect(handle.ready).rejects.toMatchObject({ code: "runner_ingress_unavailable" });
        await expect(handle.failure).rejects.toMatchObject({ code: "runner_ingress_unavailable" });
        expect(activeWire).toBeUndefined();
        if (mode === "untrusted TLS") expect(upgrades).toBe(0);
        expect(Date.now() - startedAt).toBeLessThan(2_000);
      }
    } finally {
      setDefaultCACertificates([...originalCAs, certificate]);
      await handle.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => wss.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 5_000);
});
