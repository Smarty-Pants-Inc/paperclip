import { expect } from "vitest";

// Match Claude API/OAuth and OpenAI project token shapes, not arbitrary `sk-`
// substrings such as a `sl-task-` directory in an instructions path.
const TOKEN_VALUE_PATTERN = /sk-(?:ant-(?:oat01-)?|proj-)[A-Za-z0-9_-]{20,}/;

export function expectNoTokenLeak(body: unknown, seededValues: readonly string[]): void {
  const serialized = JSON.stringify(body);
  for (const value of seededValues) {
    expect(serialized).not.toContain(value);
  }
  expect(serialized).not.toMatch(TOKEN_VALUE_PATTERN);
}
