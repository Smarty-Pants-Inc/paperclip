import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";

/** Disposable, unconfigured keys; never live identities or account credentials.
 * Reproduces all 18 transform rows per key type in shape3-pem-vectors.txt. */
export function secretShapePemVectors() {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  return ([
    ["pkcs8", rsa.export({ format: "pem", type: "pkcs8" }).toString()],
    ["pkcs1", rsa.export({ format: "pem", type: "pkcs1" }).toString()],
    ["ec", ec.export({ format: "pem", type: "sec1" }).toString()],
  ] as const).flatMap(([keyType, pem]) => {
    const body = pem.split(/\r?\n/).filter(line => line && !line.startsWith("-----")).join("").replace(/=+$/, "");
    const transform = (command: string, args: string[]) => execFileSync(command, args, { input: pem, encoding: "utf8" });
    const lines = pem.trim().split("\n");
    const wrap = (text: string, size: number) => text.match(new RegExp(`.{1,${size}}`, "g"))!.join("\n");
    const split = pem.indexOf("\n") + 1 + 17;
    const cases: Array<[string, string, boolean]> = [
      ["raw", pem, true],
      ["cut -d= -f1", transform("cut", ["-d=", "-f1"]), true],
      ["awk '{print $1}'", transform("awk", ["{print $1}"]), false],
      ["tr -d '\\n'", transform("tr", ["-d", "\n"]), true],
      ["fold -w 60", transform("fold", ["-w", "60"]), true],
      ["JSON.stringify", JSON.stringify(pem), true],
      ["JSON 2x", JSON.stringify(JSON.stringify(pem)), true],
      ["body-only joined", body, false],
      ["truncated rewrap60", wrap(body.slice(11, -7), 60), false],
      ["sed 1d;$d (no framing)", transform("sed", ["1d;$d"]), false],
      ["fold -w 36 full", transform("fold", ["-w", "36"]), true],
      ["begin-only fold 20 (head)", `${lines[0]}\n${wrap(body, 20)}`, false],
      ["end-only fold 20 (tail)", `${wrap(body, 20)}\n${lines.at(-1)}`, false],
      ["JSON with \\/ escapes", JSON.stringify(pem).replaceAll("/", "\\/"), true],
      ["base64 -w0 of PEM", transform("base64", ["-w0"]), false],
      ["2 chunks (17 into body), chunk1", pem.slice(0, split), true],
      ["2 chunks, chunk2", pem.slice(split), true],
      ["xxd -p", transform("xxd", ["-p"]), false],
    ];
    return cases.map(([name, text, supported]) => ({ keyType, name, text, body, supported }));
  });
}

/** Join wrapping for the window oracle, but never join across redaction marks. */
export function leakedPemWindows(text: string, body: string) {
  const unwrapped = text.replace(/\\{1,2}\//g, "/").replace(/\\{1,2}[rn]|\s/g, "");
  return Array.from({ length: body.length - 31 }, (_, i) => body.slice(i, i + 32))
    .filter(window => unwrapped.includes(window)).length;
}
