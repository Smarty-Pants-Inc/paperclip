// Deliberately fake, never configured as sensitive values. These model material
// generated/read by tools, rather than credentials admitted by the controller.
export const shapeTokens = [
  ...["p", "o", "u", "s", "r"].map(letter => ({ kind: "github", value: `gh${letter}_${"FakeShapeToken9".repeat(3)}` })),
  { kind: "github", value: `github_pat_${"Fake_Shape_Token9".repeat(3)}` },
  { kind: "openai", value: `sk-${"FakeShapeToken9_".repeat(3)}` },
  { kind: "anthropic", value: `sk-ant-${"FakeShapeToken9_".repeat(3)}` },
  { kind: "langfuse", value: "sk-lf-12345678-abcd-4000-8000-123456789abc" },
  { kind: "langfuse", value: "pk-lf-12345678-abcd-4000-8000-123456789abc" },
  ...["a", "b", "p", "r"].map(letter => ({ kind: "slack", value: `xox${letter}-1234567890-FakeShapeToken9` })),
  { kind: "aws", value: "AKIAFAKESHAPE0123456" },
  { kind: "jwt", value: "eyJhbGciOiJIUzI1NiJ9.eyJmYWtlIjoic2hhcGUifQ.FakeShapeSignature9" },
  { kind: "bearer", value: "Bearer FakeOpaqueCredential9_abcdefgh" },
];
export const shapeAssignments = [
  { kind: "assignment", value: "TOOL_KEY=shape-assignment-alpha", secret: "shape-assignment-alpha", retained: "TOOL_KEY=" },
  { kind: "assignment", value: '"accessToken": "shape-assignment-beta"', secret: "shape-assignment-beta", retained: '"accessToken": ' },
  { kind: "assignment", value: "DB_PASSWORD='shape assignment gamma'", secret: "shape assignment gamma", retained: "DB_PASSWORD=" },
  { kind: "assignment", value: '"privateMaterial": "shape-assignment-delta"', secret: "shape-assignment-delta", retained: '"privateMaterial": ' },
  { kind: "assignment", value: "CREDENTIAL=shape-assignment-epsilon", secret: "shape-assignment-epsilon", retained: "CREDENTIAL=" },
  { kind: "assignment", value: "MY_SECRET=shape-assignment-zeta", secret: "shape-assignment-zeta", retained: "MY_SECRET=" },
];
export const fakePemBody = Buffer.from("THIS IS FAKE PRIVATE KEY MATERIAL FOR SHAPE CONTRACT TESTS ONLY. ".repeat(8)).toString("base64");
const wrap = (width: number) => fakePemBody.match(new RegExp(`.{1,${width}}`, "g"))!;
export const shapePems = ["PRIVATE KEY", "OPENSSH PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "ENCRYPTED PRIVATE KEY"].flatMap(label => {
  const lines = [`-----BEGIN ${label}-----`, ...wrap(48), `-----END ${label}-----`];
  return [
    ["raw", lines.join("\n")], ["crlf", lines.join("\r\n")],
    ["escaped", lines.join("\\n")], ["double-escaped", lines.join("\\\\n")],
    ["escaped-crlf", lines.join("\\r\\n")], ["spaces", lines.join(" ")],
    ["wrap64", [lines[0], ...wrap(64), lines.at(-1)].join("\n")],
    ["wrap76", [lines[0], ...wrap(76), lines.at(-1)].join("\n")],
    ["begin-only", lines.slice(0, -1).join("\n")],
    ["end-only", lines.slice(1).join("\n")],
  ].map(([form, value]) => ({ label: `${label}/${form}`, value: value!, kind: "pem" }));
});
export const shapeNegatives = [
  "token is a word in ordinary prose; a key unlocks a door.",
  "12345678-abcd-4000-8000-123456789abc", "0123456789abcdef0123456789abcde", // 31 hex chars
  "6e90f3f00123456789abcdef0123456789abcdef", // 40-character git sha
  'function tokenize(source: string) { return source.split(" "); }',
  'const value = tokenCount + 1; readToken(value); config.apiKey;',
  "Authentication and tokens are discussed here.",
  "module.someIdentifier.otherIdentifier", "-----BEGIN PUBLIC KEY-----\npublic-example\n-----END PUBLIC KEY-----",
];
