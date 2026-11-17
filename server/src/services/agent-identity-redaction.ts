import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { isDigitValue, redactRegisteredSecretValues } from "./run-secret-redaction.js";

export const MIN_SECRET_OUTPUT_VALUE_LENGTH = 8;
const MIN_RESUMED_SUFFIX_LENGTH = 4;

const PROTOCOL_KEY = /^(?:id|ids|ref|refs|schema|type|kind|status|state|outcome|phase|stream|channel|role|level|color|transport|operation|namespace|provider|model|biller|disposition|priority|mode|method)$|(?:Id|Ids|Ref|Refs|Type|Kind|State|Status|Code|Disposition|Revision|Version|Mode|Schema|Digest|Sha256|At)$|_(?:id|ids|type|kind|state|status|code)$/;

export function secretEnvironmentValues(env: unknown, secretKeys: Iterable<string>): string[] {
  if (!env || typeof env !== "object" || Array.isArray(env)) return [];
  const record = env as Record<string, unknown>;
  return [...new Set([...secretKeys].map(key => record[key]).filter((value): value is string => typeof value === "string" && value.length > 0))];
}

export function secretOutputForms(secrets: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const value of secrets) {
    const lines = /[\r\n]/.test(value) ? value.split(/\r?\n|\r/).map(line => line.trim()).filter(line => !line.startsWith("-----")) : [];
    for (const form of [value, value.trim(), ...lines]) {
      if (form.trim().length < MIN_SECRET_OUTPUT_VALUE_LENGTH) continue;
      forms.add(form);
      forms.add(JSON.stringify(form).slice(1, -1));
    }
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

function replaceValues(text: string, values: readonly string[]): string {
  return values.reduce((result, value) => result.split(value).join(REDACTED_EVENT_VALUE), text);
}

function resumedSuffixLength(text: string, candidates: readonly string[]): number {
  let longest = 0;
  for (const value of candidates) {
    for (let size = value.length - 1; size >= MIN_RESUMED_SUFFIX_LENGTH && size > longest; size--) {
      const suffix = value.slice(-size);
      if (text.startsWith(suffix)) { longest = size; break; }
      if (text.length >= MIN_RESUMED_SUFFIX_LENGTH && text.length > longest && suffix.startsWith(text)) { longest = text.length; break; }
    }
  }
  return longest;
}

function redactOutputSecretValues<T>(input: T, values: readonly string[], key?: string): T {
  if (values.length === 0 || (key !== undefined && PROTOCOL_KEY.test(key))) return input;
  if (typeof input === "string") return replaceValues(input, values) as T;
  if (Array.isArray(input)) return input.map((entry) => redactOutputSecretValues(entry, values, key)) as T;
  if (!input || typeof input !== "object" || input instanceof Date) return input;
  return Object.fromEntries(Object.entries(input).map(([entryKey, entry]) =>
    [entryKey, redactOutputSecretValues(entry, values, entryKey)])) as T;
}

/** Keep private material in memory only; do not copy it into run snapshots. */
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
 * The shortest run-secret value matched in text, whole or derived: the floor
 * the derived-line rule already used. A shorter value ("1", "v1") cannot be told
 * apart from ordinary output, so indexing it only corrupts logs and events.
 */
export const MIN_RUN_SECRET_LENGTH = 8;

/**
 * A value is skipped only when it EQUALS one of the run's own ids (run, agent,
 * company, issue, environment, connection ids passed as `identifiers`). A
 * value merely shaped like an id (a UUID, a host name, a region) is NOT
 * skipped: many API keys are bare UUIDs, and a guard must never let a real
 * credential print unmasked. Masking is applied to content only (payload,
 * debug, log text), so an indexed value cannot rewrite protocol metadata.
 */
export function isRunSecretIdentifier(value: string, identifiers: ReadonlySet<string> = new Set()) {
  return identifiers.has(value) || identifiers.has(value.trim());
}

/**
 * Add a run's secret values to a redactor's exact values and key-body window
 * index. Live preparation, observability values, the native control-plane port
 * and native log recovery all use this, so the paths cannot drift on how a run
 * secret is matched. `identifiers` are the run's own ids: a value equal to one
 * is never indexed. An all-digit value is indexed but masks only where it stands
 * as a whole number (see redactRegisteredSecretValues), so ordinary numbers stay.
 */
export function addRunSecretMaterial(redactor: { values: string[]; runIdentifiers?: Set<string> }, secrets: Iterable<string>, identifiers: Iterable<string | null | undefined> = []) {
  const known = new Set(redactor.values);
  const ids = new Set([...identifiers].filter((id): id is string => typeof id === "string" && id.length > 0));
  // The output-secret stage (#21341) applies the same id exemption to its values.
  for (const id of ids) redactor.runIdentifiers?.add(id);
  for (const secret of new Set(secrets)) {
    if (typeof secret !== "string" || secret.length < MIN_RUN_SECRET_LENGTH || isRunSecretIdentifier(secret, ids)) continue;
    // Keep the whole secret; drop derived lines too short to mean anything
    // (a JSON secret's "{" line would otherwise mask every brace) or that are
    // identifiers themselves.
    for (const value of createAgentIdentityRedactor(secret).values) {
      if (known.has(value) || value.length < MIN_RUN_SECRET_LENGTH || isRunSecretIdentifier(value, ids)) continue;
      known.add(value);
      redactor.values.push(value);
    }
  }
  redactor.values.sort((left, right) => right.length - left.length);
}

/** Keep private material in memory only; do not copy it into run snapshots. */
export function createAgentIdentityRedactor(privateKeyPem?: string, secrets: readonly string[] = [],
  options: { maskResumedSuffixes?: boolean } = {}) {
  const values = privateKeyPem ? [...new Set([
    privateKeyPem,
    privateKeyPem.trim(),
    JSON.stringify(privateKeyPem).slice(1, -1),
    ...privateKeyPem.split(/\r?\n/).filter(line => line && !line.startsWith("-----")),
  ])].sort((a, b) => b.length - a.length) : [];
  const pending = new Map<string, string>();
  // Upstream #21341 output secrets: a second stage after the fork's exact-value
  // and key-material stage, with its own stream buffers. All-digit values and
  // values equal to one of the run's own ids stay with the fork stage's rules
  // (whole numbers only; never an id), so this stage skips them.
  const secretSources: string[] = [];
  const secretValues: string[] = [];
  const runIdentifiers = new Set<string>();
  const outputPending = new Map<string, string>();
  const seenStreams = new Set<string>();
  const maskedPending = new Map<string, number>();
  const outputSecretValues = () => secretValues.filter(value => !isDigitValue(value.trim()) && !isRunSecretIdentifier(value, runIdentifiers));
  const materialStreams = new Map<string, MaterialStream>();
  const indexedValues = new Set<string>();
  const completePemValues: string[] = [];
  const materialWindows = new Set<string>();
  // Windows of key material (a value with a BEGIN marker). Only these, or a
  // BEGIN marker, open key-block context; a plain secret masks only itself.
  const keyBlockWindows = new Set<string>();
  const materialPrefixes = new Set<string>();
  // Values with at least one key-body window: the material scan masks these
  // from their first window. Every other value is matched whole only.
  const windowedValues = new Set<string>();
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
      const keyBlock = decoded.includes("-----BEGIN ");
      if (body.length >= MATERIAL_WINDOW) windowedValues.add(value);
      for (let index = 0; index + MATERIAL_WINDOW <= body.length; index++) {
        const window = body.slice(index, index + MATERIAL_WINDOW);
        if (keyBlock) keyBlockWindows.add(window);
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
        let knownKeyBlock = false;
        // Fixed-width Set lookups: linear in output size, never a regex made
        // from private data or a search over every window for every character.
        for (let index = 0; index + MATERIAL_WINDOW <= joined.length; index++) {
          const window = joined.slice(index, index + MATERIAL_WINDOW);
          if (materialWindows.has(window)) { known = index; knownKeyBlock = keyBlockWindows.has(window); break; }
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
          // A plain secret (no marker, no END to close context) must not leave
          // context open: later ordinary base64 or hashes would be masked.
          if (knownKeyBlock) state.context = true;
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
  const hasPending = (stream: string) => pending.has(stream) || materialStreams.has(stream) || outputPending.has(stream) || maskedPending.has(stream);
  const outputChunk = (stream: string, chunk: string): string => {
      const text = (outputPending.get(stream) ?? "") + chunk;
      const candidates = outputSecretValues();
      const resumes = options.maskResumedSuffixes === true && !seenStreams.has(stream);
      const resumed = Math.max(resumes ? resumedSuffixLength(text, candidates) : 0, maskedPending.get(stream) ?? 0);
      if (resumes && resumed === 0 && text.length > 0 && text.length < MIN_RESUMED_SUFFIX_LENGTH
        && candidates.some((value) => value.indexOf(text, 1) !== -1)) {
        outputPending.set(stream, text);
        return "";
      }
      const masked: Array<[number, number]> = resumed > 0 ? [[0, resumed]] : [];
      let end = text.length;
      for (let index = 0; index < text.length;) {
        let matched = 0;
        let partial = false;
        for (const value of candidates) {
          if (value.charCodeAt(0) !== text.charCodeAt(index)) continue;
          if (text.startsWith(value, index)) { matched = value.length; break; }
          if (text.length - index < value.length && value.startsWith(text.slice(index))) { partial = true; break; }
        }
        if (partial) { end = index; break; }
        if (matched) {
          masked.push([index, index + matched]);
          index += matched;
        } else index++;
      }
      if (end < text.length) outputPending.set(stream, text.slice(end));
      else outputPending.delete(stream);
      if (end < Math.min(resumed, text.length)) maskedPending.set(stream, Math.min(resumed, text.length) - end);
      else maskedPending.delete(stream);
      if (resumes && end > resumed) seenStreams.add(stream);
      const merged: Array<[number, number]> = [];
      for (const [from, to] of masked.sort((left, right) => left[0] - right[0])) {
        const last = merged.at(-1);
        if (last && from < last[1]) last[1] = Math.max(last[1], to);
        else merged.push([from, to]);
      }
      let output = "";
      let cursor = 0;
      for (const [from, to] of merged) {
        if (from >= end) break;
        output += text.slice(cursor, from) + REDACTED_EVENT_VALUE;
        cursor = Math.min(to, end);
      }
      return output + text.slice(cursor, end);
    };
  const outputFinish = (stream: string): string => {
    const held = outputPending.get(stream);
    const heldMasked = maskedPending.has(stream);
    outputPending.delete(stream);
    maskedPending.delete(stream);
    if (held && heldMasked) return REDACTED_EVENT_VALUE;
    return held ? (held.length < 8 ? held : REDACTED_EVENT_VALUE) : "";
  };
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
    secretSources,
    secretValues,
    runIdentifiers,
    addSecretValues(secrets: readonly string[]) {
      secretSources.splice(0, secretSources.length, ...new Set([...secretSources, ...secrets.filter(Boolean)]));
      secretValues.splice(0, secretValues.length, ...secretOutputForms(secretSources));
    },
    redact<T>(value: T, key?: string): T {
      return redactOutputSecretValues(redactRegisteredSecretValues(redactMaterial(value), values) as T, outputSecretValues(), key);
    },
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
      if (values.some(value => !isDigitValue(value) && value.length >= held && text.endsWith(value))) held = 0;
      // An all-digit value masks only as a whole number: hold a complete one at
      // the end until the next character shows whether the number continues.
      else for (const value of values) if (isDigitValue(value) && text.endsWith(value)) held = Math.max(held, value.length);
      // Never cut through a value: hold from the start of any value the cut
      // would split (one ending inside the held prefix of another value).
      let cut = text.length - held;
      for (let moved = held > 0; moved;) {
        moved = false;
        for (const value of values) {
          const start = value ? text.indexOf(value, Math.max(0, cut - value.length + 1)) : -1;
          if (start >= 0 && start < cut) { cut = start; moved = true; }
        }
      }
      held = text.length - cut;
      if (held) pending.set(stream, text.slice(-held));
      else pending.delete(stream);
      const state = materialStreams.get(stream) ?? newMaterialStream();
      // Match whole values before the material scan: its hold can keep a
      // value's last characters (a base64 suffix that may begin a key window)
      // for the next chunk, and the whole-value replace below would then see
      // only a part. Windowed values stay with the scan, which masks them from
      // their first window and keeps whole PEM projection and key context.
      indexMaterial();
      const scanned = redactRegisteredSecretValues(held ? text.slice(0, -held) : text,
        values.filter(value => !windowedValues.has(value)));
      let output = scanMaterial(scanned, state);
      // A held exact-value prefix still proves the preceding token ended.
      if (held && !/^[A-Za-z0-9+/=]/.test(text.slice(-held))) output += flushToken(state);
      if (state.context || state.token || state.marker || state.suppressed) materialStreams.set(stream, state);
      else materialStreams.delete(stream);
      return outputChunk(stream, redactRegisteredSecretValues(output, values));
    },
    /** True while `chunk` still holds text of this stream for its next piece. */
    holds(stream: string): boolean { return hasPending(stream); },
    // An interrupted partial secret must not be flushed as plaintext.
    finish(stream: string): string {
      const held = pending.get(stream);
      pending.delete(stream);
      const state = materialStreams.get(stream);
      materialStreams.delete(stream);
      // Both buffers are bounded: at most an exact-value prefix, 39 body chars,
      // and a private-key marker prefix. Never flush interrupted key material.
      const tail = state ? scanMaterial("", state, true) : "";
      const settled = tail + (held ? (held.length < 8 ? held : REDACTED_EVENT_VALUE) : "");
      return (settled ? outputChunk(stream, settled) : "") + outputFinish(stream);
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
          if (!/^(text|delta|output|patch)$/.test(field)) return redactor.redact(entry, field || undefined);
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
          .filter(key => typeof payload[key] === "string").map(key => [key, redactor.redact(payload[key], key)])),
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
  redactor.addSecretValues(secrets);
  return redactor;
}
