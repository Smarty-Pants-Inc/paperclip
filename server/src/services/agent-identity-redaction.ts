import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { redactRegisteredSecretValues } from "./run-secret-redaction.js";

const MATERIAL_WINDOW = 32;
const PEM_RUN_MIN = 40;
const PRIVATE_KEY_MARKERS = ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "DSA PRIVATE KEY",
  "OPENSSH PRIVATE KEY", "ENCRYPTED PRIVATE KEY"].flatMap(label =>
  ["BEGIN", "END"].map(edge => `-----${edge} ${label}-----`));
// `fold -w N` and `cut -c` split or truncate markers ("-----END PRIVATE KEY\n-----").
// A marker may carry one line break between any two characters and may lose its
// trailing dashes. Built only from the constant labels above, never from private
// data; each optional break is a fixed choice, so matching stays linear.
const LINE_BREAK = "(?:\\r?\\n)?";
const markerPattern = new RegExp(PRIVATE_KEY_MARKERS.map(marker => {
  const head = marker.slice(0, -5);
  return [...head].join(LINE_BREAK) + `(?:${LINE_BREAK}-){0,5}`;
}).join("|"), "g");
const markerPrefixes = new Set(PRIVATE_KEY_MARKERS.flatMap(marker =>
  Array.from({ length: marker.length - 1 }, (_, index) => marker.slice(0, index + 1))));
const maxMarkerLength = Math.max(...PRIVATE_KEY_MARKERS.map(marker => marker.length));
// A held marker prefix may contain up to one CRLF per character.
const maxMarkerSpan = (maxMarkerLength - 1) * 3;
// Base64 pieces separated by at most this much whitespace (fold, wrapped output)
// are matched as one candidate against the known key-body windows.
const MAX_JOIN_WHITESPACE = 2;
const isBase64Start = (text: string) => /^[A-Za-z0-9+/=]/.test(text);
const trailingWhitespace = (text: string) => text.length - text.replace(/[ \t\r\n]+$/, "").length;
/** Longest tail that could still become a (possibly line-broken) marker. */
const heldMarkerLength = (tail: string) => {
  for (let index = Math.max(0, tail.length - maxMarkerSpan); index < tail.length; index++) {
    if (tail[index] === "-" && markerPrefixes.has(tail.slice(index).replace(/[\r\n]/g, ""))) return tail.length - index;
  }
  return 0;
};

type MaterialStream = { context: boolean; token: string; suppressed: boolean; marker: string };
const newMaterialStream = (): MaterialStream => ({ context: false, token: "", suppressed: false, marker: "" });

/**
 * Add a run's secret values to a redactor's exact values and key-body window
 * index. Live preparation and native log recovery both use this, so the two
 * paths cannot drift on how a run secret is matched.
 */
export function addRunSecretMaterial(redactor: { values: string[] }, secrets: Iterable<string>) {
  const known = new Set(redactor.values);
  for (const secret of new Set(secrets)) {
    // Keep the whole secret; drop derived lines too short to mean anything
    // (a JSON secret's "{" line would otherwise mask every brace).
    for (const value of createAgentIdentityRedactor(secret).values) {
      if (known.has(value) || (value !== secret && value.length < 8)) continue;
      known.add(value);
      redactor.values.push(value);
    }
  }
  redactor.values.sort((left, right) => right.length - left.length);
}

/** Keep private material in memory only; do not copy it into run snapshots. */
export function createAgentIdentityRedactor(privateKeyPem?: string) {
  const values = privateKeyPem ? [...new Set([
    privateKeyPem,
    privateKeyPem.trim(),
    JSON.stringify(privateKeyPem).slice(1, -1),
    ...privateKeyPem.split(/\r?\n/).filter(line => line && !line.startsWith("-----")),
  ])].sort((a, b) => b.length - a.length) : [];
  const pending = new Map<string, string>();
  const materialStreams = new Map<string, MaterialStream>();
  const indexedValues = new Set<string>();
  const completePemValues: string[] = [];
  const materialWindows = new Set<string>();
  const materialPrefixes = new Set<string>();
  // `values` is intentionally appendable: execution preparation and native log
  // recovery add identities/registered secrets after constructing the redactor.
  const indexMaterial = () => {
    for (const value of values) {
      if (indexedValues.has(value)) continue;
      indexedValues.add(value);
      if (value.includes("-----BEGIN ") && value.includes("-----END ")) completePemValues.push(value);
      const decoded = value.replace(/\\r\\n|\\n|\\r/g, "\n");
      const body = decoded.split(/\r?\n/).filter(line => line && !line.startsWith("-----")).join("").replace(/=+$/, "");
      if (!/^[A-Za-z0-9+/]+$/.test(body)) continue;
      for (let index = 0; index + MATERIAL_WINDOW <= body.length; index++) {
        const window = body.slice(index, index + MATERIAL_WINDOW);
        if (materialWindows.has(window)) continue;
        materialWindows.add(window);
        for (let size = 1; size < MATERIAL_WINDOW; size++) materialPrefixes.add(window.slice(0, size));
      }
    }
  };
  const flushToken = (state: MaterialStream, interrupted = false) => {
    const token = state.token;
    state.token = "";
    state.suppressed = false;
    return interrupted && token.length >= 8 ? REDACTED_EVENT_VALUE : token;
  };
  const scanMaterial = (input: string, state: MaterialStream, complete = false) => {
    indexMaterial();
    let output = "";
    const segment = (text: string) => {
      for (const match of text.matchAll(/[A-Za-z0-9+/=]+|[^A-Za-z0-9+/=]+/g)) {
        const run = match[0];
        if (!isBase64Start(run)) {
          // A short whitespace gap keeps held pieces one candidate: folded key
          // lines are shorter than a window. Any other separator ends it.
          if (state.token && !state.suppressed && /^[ \t\r\n]+$/.test(run) &&
            trailingWhitespace(state.token) + run.length <= MAX_JOIN_WHITESPACE) state.token += run;
          else output += flushToken(state) + run;
          continue;
        }
        if (state.suppressed) continue;
        const raw = state.token + run;
        // The held token is bounded (a window prefix plus a sub-threshold run,
        // with at most two whitespace characters per piece).
        const joined = state.token.replace(/[ \t\r\n]/g, "") + run;
        const contiguous = raw.length - raw.replace(/[A-Za-z0-9+/=]+$/, "").length;
        let known = -1;
        // Fixed-width Set lookups: linear in output size, never a regex made
        // from private data or a search over every window for every character.
        for (let index = 0; index + MATERIAL_WINDOW <= joined.length; index++) {
          if (materialWindows.has(joined.slice(index, index + MATERIAL_WINDOW))) { known = index; break; }
        }
        if (known >= 0 || (state.context && contiguous >= PEM_RUN_MIN)) {
          // Redact from the first known window, or for structural context only
          // the contiguous run; earlier held pieces are ordinary output.
          let start = raw.length - contiguous;
          if (known >= 0) {
            start = 0;
            for (let seen = 0; seen < known || !isBase64Start(raw[start]!); start++) if (isBase64Start(raw[start]!)) seen++;
          }
          output += raw.slice(0, start);
          output += REDACTED_EVENT_VALUE;
          state.context = true;
          state.token = "";
          state.suppressed = true;
          continue;
        }
        // Hold the longest joined suffix that can still begin a window and,
        // inside PEM context, the current run that may still reach PEM_RUN_MIN.
        let held = Math.min(MATERIAL_WINDOW - 1, joined.length);
        while (held && !materialPrefixes.has(joined.slice(-held))) held--;
        let rawHeld = 0;
        for (let seen = 0; seen < held; rawHeld++) if (isBase64Start(raw[raw.length - 1 - rawHeld]!)) seen++;
        rawHeld = Math.max(rawHeld, state.context ? contiguous : 0);
        output += raw.slice(0, raw.length - rawHeld);
        state.token = raw.slice(raw.length - rawHeld);
      }
    };
    // Exact whole PEMs historically produce one marker. Project each as one
    // closed block so safe native archive prefixes still verify byte-for-byte.
    // Do not erase individual body lines here: seeing them establishes context.
    let text = state.marker + input;
    for (const value of completePemValues) text = text.split(value).join("-----END PRIVATE KEY-----");
    state.marker = "";
    let cursor = 0;
    for (const match of text.matchAll(markerPattern)) {
      segment(text.slice(cursor, match.index));
      output += flushToken(state) + REDACTED_EVENT_VALUE;
      state.context = match[0].replace(/[\r\n]/g, "").startsWith("-----BEGIN");
      cursor = match.index + match[0].length;
    }
    const tail = text.slice(cursor);
    const held = heldMarkerLength(tail);
    segment(held ? tail.slice(0, -held) : tail);
    if (held) {
      output += flushToken(state);
      state.marker = tail.slice(-held);
    }
    if (complete) output += flushToken(state, true) +
      (state.marker.length >= 8 ? REDACTED_EVENT_VALUE : state.marker);
    return output;
  };
  const hasPending = (stream: string) => pending.has(stream) || materialStreams.has(stream);
  const redactMaterial = (value: unknown): unknown => {
    if (typeof value === "string") return scanMaterial(value, newMaterialStream(), true);
    if (value instanceof Date) return value;
    if (Array.isArray(value)) return value.map(redactMaterial);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, redactMaterial(child)]));
    return value;
  };
  const deltaStreams = new Map<string, {
    scope: string; itemId?: string; payload: Record<string, unknown>; paths: string[];
  }>();
  const redactor = {
    values,
    redact<T>(value: T): T { return redactRegisteredSecretValues(redactMaterial(value), values) as T; },
    // Hold only a suffix that could begin a secret. Separate buffers prevent
    // interleaved stdout/stderr from defeating matching across output chunks.
    chunk(stream: string, chunk: string): string {
      const text = (pending.get(stream) ?? "") + chunk;
      let held = 0;
      for (const value of values) {
        for (let size = Math.min(value.length - 1, text.length); size > held; size--) {
          if (text.endsWith(value.slice(0, size))) { held = size; break; }
        }
      }
      // A complete exact match must not be mistaken for its own suffix prefix.
      if (values.some(value => value.length >= held && text.endsWith(value))) held = 0;
      if (held) pending.set(stream, text.slice(-held));
      else pending.delete(stream);
      const state = materialStreams.get(stream) ?? newMaterialStream();
      let output = scanMaterial(held ? text.slice(0, -held) : text, state);
      // A held exact-value prefix still proves the preceding token ended.
      if (held && !/^[A-Za-z0-9+/=]/.test(text.slice(-held))) output += flushToken(state);
      if (state.context || state.token || state.marker || state.suppressed) materialStreams.set(stream, state);
      else materialStreams.delete(stream);
      return redactRegisteredSecretValues(output, values);
    },
    // An interrupted partial secret must not be flushed as plaintext.
    finish(stream: string): string {
      const held = pending.get(stream);
      pending.delete(stream);
      const state = materialStreams.get(stream);
      materialStreams.delete(stream);
      // Both buffers are bounded: at most an exact-value prefix, 39 body chars,
      // and a private-key marker prefix. Never flush interrupted key material.
      const tail = state ? scanMaterial("", state, true) : "";
      return tail + (held ? (held.length < 8 ? held : REDACTED_EVENT_VALUE) : "");
    },
    /** Delta payloads can repeat output under text and provider-specific fields. */
    delta<T>(stream: string, value: T, itemId?: string): T {
      const scope = stream;
      const paths: string[] = [];
      const payload = value as Record<string, unknown>;
      // Durable transports can share one envelope item ID across provider items.
      stream = JSON.stringify([stream, payload.itemId, payload.providerItemId, payload.channel, payload.stream]);
      const visit = (entry: unknown, path: string, field: string): unknown => {
        if (typeof entry === "string") {
          if (!/^(text|delta|output|patch)$/.test(field)) return redactor.redact(entry);
          const key = `${stream}:${path}`;
          const output = redactor.chunk(key, entry);
          if (hasPending(key)) paths.push(key);
          return output;
        }
        if (Array.isArray(entry)) return entry.map((child, index) => visit(child, `${path}.${index}`, field));
        if (entry && typeof entry === "object") return Object.fromEntries(
          Object.entries(entry).map(([key, child]) => [key, visit(child, `${path}.${key}`, key)]),
        );
        return entry;
      };
      const result = visit(value, "", "") as T;
      for (const previous of deltaStreams.get(stream)?.paths ?? []) {
        if (hasPending(previous) && !paths.includes(previous)) paths.push(previous);
      }
      if (paths.length) deltaStreams.set(stream, { scope, itemId, paths,
        payload: Object.fromEntries(["itemId", "providerItemId", "kind", "channel", "stream"]
          .filter(key => typeof payload[key] === "string").map(key => [key, redactor.redact(payload[key])])),
      });
      else deltaStreams.delete(stream);
      return result;
    },
    /** Settle output in the terminal event, preserving its source receipt identity. */
    settleDeltas(scope: string, payload: Record<string, unknown>, wholeTurn: boolean) {
      const tails: Array<{ itemId?: string; payload: Record<string, unknown> }> = [];
      for (const [stream, descriptor] of deltaStreams) {
        if (wholeTurn ? !descriptor.scope.startsWith(scope) : descriptor.scope !== scope) continue;
        if (!wholeTurn && payload.itemId && descriptor.payload.itemId && payload.itemId !== descriptor.payload.itemId) continue;
        const primary = descriptor.paths.find(path => path === `${stream}:.text`) ?? descriptor.paths[0];
        let text = "";
        for (const path of descriptor.paths) {
          const tail = redactor.finish(path);
          if (path === primary) text = tail;
        }
        deltaStreams.delete(stream);
        if (text) tails.push({ itemId: descriptor.itemId, payload: { ...descriptor.payload, text } });
      }
      return tails.length ? { ...payload, outputTails: [
        ...(Array.isArray(payload.outputTails) ? payload.outputTails : []), ...tails,
      ] } : payload;
    },
  };
  return redactor;
}
