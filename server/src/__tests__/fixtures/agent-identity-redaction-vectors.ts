import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";

/** Disposable test identity, never an account credential. Shared with export tests. */
export function agentIdentityRedactionVectors() {
  const privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 1024 })
    .privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const body = privateKeyPem.split(/\r?\n/).filter(line => line && !line.startsWith("-----")).join("").replace(/=+$/, "");
  const transform = (command: string, args: string[]) => execFileSync(command, args, {
    input: privateKeyPem, encoding: "utf8",
  });
  const split = privateKeyPem.indexOf("\n") + 1 + 17;
  return {
    privateKeyPem,
    body,
    // Check every window, not just the original PEM's line boundaries.
    windows: Array.from({ length: body.length - 31 }, (_, index) => body.slice(index, index + 32)),
    vectors: [
      { name: "cut -d= -f1", chunks: [transform("cut", ["-d=", "-f1"])] },
      { name: "awk '{print $1}'", chunks: [transform("awk", ["{print $1}"])] },
      { name: "tr -d '\\n'", chunks: [transform("tr", ["-d", "\n"])] },
      { name: "fold -w 60", chunks: [transform("fold", ["-w", "60"])] },
      { name: "JSON-escaped newlines", chunks: [JSON.stringify(privateKeyPem)] },
      { name: "two output chunks", chunks: [privateKeyPem.slice(0, split), privateKeyPem.slice(split)] },
      { name: "body only, padding stripped and joined", chunks: [body] },
      { name: "truncated body, rewrapped at 60", chunks: [body.slice(11, -7).match(/.{1,60}/g)!.join("\n")] },
    ],
    precision: [
      createHash("sha256").update("unrelated sha256 diagnostic").digest("base64"),
      Buffer.from("an unrelated 33-byte binary value").toString("base64"),
    ],
  };
}
