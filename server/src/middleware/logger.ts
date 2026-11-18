import pino from "pino";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";
import { HTTP_LOG_REDACT_PATHS, SENSITIVE_LOG_KEY_NAMES } from "./http-log-redaction.js";
import {
  isPrivateWebhookHttpRequest,
  isSecretSensitiveHttpRequest,
  isPrivateAgentCommentaryHttpRequest,
  isPrivateAgentObservabilityHttpRequest,
  isPrivateMuseHttpRequest,
  isPrivateDotPrincipalHttpRequest,
  shouldSilenceHttpSuccessLog,
} from "./http-log-policy.js";
import {
  redactSensitive,
  stripSecretBearingUrlParts,
} from "./redact-sensitive.js";
import { redactSensitiveText } from "../redaction.js";

/*
 * Credential masking in server logs: two layers, one scanner (redactSensitiveText).
 *
 * 1. The walker (redactLogValue) runs in the err, stderr, stdout and msg
 *    serializers. It gives the record its structure: it calls toJSON itself and
 *    masks the result, drops functions, masks keys, writes binary values as
 *    masked text, and fails closed (fixed markers) on depth, throwing getters,
 *    Proxy traps and toJSON.
 * 2. The backstop (maskSerializedLogLine, Pino hooks.streamWrite) runs on every
 *    finished line, after every serializer, for every child and destination. It
 *    masks the decoded text of every JSON string, key or value, in every field.
 *
 * Boundaries, named:
 * - A child logger that replaces serializers.msg (for example with identity)
 *   overrides the msg mask: that is Pino's intended serializer override. No app
 *   call site does it. The streamWrite backstop still masks that msg, since
 *   hooks are inherited and children cannot replace them.
 * - Bytes in a field no serializer visits reach the line as JSON numbers.
 *   The backstop decodes a Buffer ({"type":"Buffer","data":[...]}) and every
 *   typed array ({"0":n,...}: Uint8Array, Uint16Array, Int32Array,
 *   Float64Array, ...) from its underlying bytes. A DataView or ArrayBuffer
 *   there is written as {}: no byte of it reaches the line. In err, stderr,
 *   stdout and msg the walker decodes every ArrayBuffer view (DataView
 *   included) and ArrayBuffer.
 * - A credential split across two fields, or across two log lines, is in no
 *   single string either layer scans.
 * - Both layers also mask by key name: under a key in SENSITIVE_LOG_KEY_NAMES
 *   (http-log-redaction.ts; whole key, any case, "-" and "_" alike) a string
 *   or byte value (Buffer, typed array, ArrayBuffer) becomes
 *   "[masked: sensitive key]"; in an object or array there every string and
 *   byte leaf does, and the shape is kept. Booleans, numbers and null carry no
 *   credential and stay as written (`secret: false`). The walker does it at
 *   any depth of err, stderr, stdout, msg and errorContext; the backstop does
 *   it in every field of the line, so it also covers fields no serializer
 *   visits ({"ctx":{"x-api-key":"abc"}}), child bindings, and pino-http's req
 *   and res. A value a redact path already wrote as "[Redacted]" is left as
 *   it is.
 */
const MAX_LOG_REDACTION_DEPTH = 8;
const TRUNCATED_LOG_VALUE = `[masked: nested deeper than ${MAX_LOG_REDACTION_DEPTH}]`;
const UNREADABLE_LOG_VALUE = "[masked: unreadable value]";
const SENSITIVE_KEY_LOG_VALUE = "[masked: sensitive key]";

// The sensitive key names (http-log-redaction.ts, the one list), normalised:
// lower-case, "_" read as "-". A key matches only as a whole.
const normaliseLogKey = (key: string) => key.toLowerCase().replace(/_/g, "-");
const SENSITIVE_LOG_KEYS: ReadonlySet<string> = new Set(SENSITIVE_LOG_KEY_NAMES.map(normaliseLogKey));
function sensitiveLogKey(key: string): boolean {
  return SENSITIVE_LOG_KEYS.has(normaliseLogKey(key));
}
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

// Binary values (Buffer, Uint8Array and other typed arrays, DataView,
// ArrayBuffer) are written as their decoded, masked UTF-8 text, or as a fixed
// marker with their length when the bytes are not text. Never as raw bytes:
// JSON would write a Buffer's bytes as a number array no text scan can read.
function binaryLogBytes(value: object): Uint8Array | null {
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) return new Uint8Array(value);
  return null;
}

function binaryLogText(bytes: Uint8Array): string {
  try {
    return redactSensitiveText(strictUtf8.decode(bytes));
  } catch {
    return `[masked: binary value, ${bytes.byteLength} bytes]`;
  }
}

function setLogField(target: Record<string, unknown>, key: string, value: unknown) {
  // defineProperty, so a "__proto__" key is written as data, not a prototype.
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

// Mask credential shapes in every string AND every key of a serialized log
// value, and leave nothing for JSON.stringify to run later: an enumerable
// toJSON is called here once (guarded) and its result masked; other functions
// are dropped, as JSON would drop them. Nested objects are copied, never
// mutated: they can be live application objects. A getter, Proxy trap or
// toJSON that throws becomes a fixed marker. Past the depth bound a subtree is
// replaced, never passed through unread. `ancestors` holds the current path
// only, so a true cycle is "[Circular]" and a shared reference is written twice.
// `sensitive`: the value is under a sensitive key name, at any depth. Then
// every string and byte value in it is the marker; booleans, numbers and null
// are kept, and so is the shape of an object or array.
function redactLogValue(value: unknown, depth = 0, ancestors = new Set<object>(), sensitive = false): unknown {
  if (typeof value === "string") return sensitive ? SENSITIVE_KEY_LOG_VALUE : redactSensitiveText(value);
  if (typeof value === "function") return undefined;
  if (!value || typeof value !== "object") return value;
  if (depth > MAX_LOG_REDACTION_DEPTH) return TRUNCATED_LOG_VALUE;
  if (ancestors.has(value)) return "[Circular]";
  ancestors.add(value);
  try {
    return redactLogObject(value, depth, ancestors, sensitive);
  } catch {
    return UNREADABLE_LOG_VALUE;
  } finally {
    ancestors.delete(value);
  }
}

function redactLogObject(value: object, depth: number, ancestors: Set<object>, sensitive: boolean): unknown {
  const bytes = binaryLogBytes(value);
  if (bytes) return sensitive ? SENSITIVE_KEY_LOG_VALUE : binaryLogText(bytes);
  // A URL's userinfo and query are credentials the text scan cannot know; the
  // request-URL policy drops both.
  if (value instanceof URL) {
    return sensitive ? SENSITIVE_KEY_LOG_VALUE : redactSensitiveText(stripSecretBearingUrlParts(value.href));
  }
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    // JSON.stringify would call this after masking; call it now, once, and
    // mask what it returns (a Date's ISO text, an HTTP client error's config).
    return redactLogValue(toJSON.call(value, ""), depth + 1, ancestors, sensitive);
  }
  if (Array.isArray(value)) return value.map((item) => redactLogValue(item, depth + 1, ancestors, sensitive));
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    let item: unknown;
    try {
      item = (value as Record<string, unknown>)[key];
    } catch {
      item = UNREADABLE_LOG_VALUE;
    }
    // Under a sensitive key name (an `x-api-key` header of 32 random
    // characters has no credential shape) a string or byte value is the
    // marker, whatever it holds; a boolean, number or null is kept.
    const masked = redactLogValue(item, depth + 1, ancestors, sensitive || sensitiveLogKey(key));
    if (masked !== undefined) setLogField(copy, redactSensitiveText(key), masked);
  }
  return copy;
}

// The final backstop (Pino hooks.streamWrite): runs on every finished JSON
// line, of every child logger (pino-http's included) and for every
// destination, after all serializers. It decodes each JSON string token, key
// or value (JSON.parse of the token), masks the decoded text with the same
// scanner and writes only a changed token back (JSON.stringify). Decoding
// first matters: in the encoded line a secret after an escape (\n, \t, \",
// \u0042) follows a letter and the scanner's word-boundary prefixes miss it.
// A line with nothing to mask is returned as the same string, byte for byte;
// on a masked line only the masked tokens change, so Pino's key order and
// duplicate keys are kept (a whole-line JSON.parse/stringify would reorder
// integer-like keys and collapse duplicates). Under a key token whose decoded
// name is in SENSITIVE_LOG_KEY_NAMES, whatever field it is in, a string token
// or a byte shape (a Buffer's {"type":"Buffer","data":[...]}, a typed array's
// {"0":n,...}) becomes "[masked: sensitive key]"; in an object or array there,
// every string token and byte shape does and the brackets stay. true, false,
// null and numbers stay as written. The scan is a loop, not a recursion: there
// is no depth limit to fall past.
export function maskSerializedLogLine(line: string): string {
  return maskSerializedLogStrings(maskSerializedLogBytes(line));
}

// JSON writes the bytes of a view in a field no serializer visits as numbers:
// a Buffer as {"type":"Buffer","data":[...]}, and every other ArrayBuffer view
// with elements (Uint8Array, Uint16Array, Int32Array, Float64Array, ...) as an
// index object {"0":n,"1":n,...} of its ELEMENTS, not its bytes. Those
// structural shapes (never inside a string: there the quotes are escaped) are
// decoded the walker's way, as UTF-8 from the underlying bytes: the line does
// not say which view wrote the elements, so the bytes are rebuilt under each
// element type whose values the elements fit exactly, and one whose UTF-8 text
// holds a credential is replaced with the masked text. Bytes that are not
// text, or hold none, are left as written. A DataView or ArrayBuffer is written
// as {}: none of its bytes reach the line.
const SERIALIZED_BUFFER_RE = /\{"type":"Buffer","data":\[([0-9,]*)\]\}/g;
const JSON_NUMBER = String.raw`-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`;
const SERIALIZED_INDEX_OBJECT_RE = new RegExp(String.raw`\{"0":${JSON_NUMBER}(?:,"\d+":${JSON_NUMBER})*\}`, "g");
// Same-endian as the process that wrote the line (the line is written here).
const SERIALIZED_VIEW_TYPES = [
  Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array,
] as const;

function decodedLogText(bytes: Uint8Array): string | null {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}

function maskedSerializedBytes(match: string, values: number[]): string {
  for (const ViewType of SERIALIZED_VIEW_TYPES) {
    const view = ViewType.from(values);
    if (values.some((value, index) => view[index] !== value)) continue;
    const text = decodedLogText(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    if (text === null) continue;
    const masked = redactSensitiveText(text);
    if (masked !== text) return JSON.stringify(masked);
  }
  return match;
}

// A Buffer's data array is its bytes: decoded as bytes only.
function maskedSerializedBuffer(match: string, values: number[]): string {
  if (values.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return match;
  const text = decodedLogText(Uint8Array.from(values));
  if (text === null) return match;
  const masked = redactSensitiveText(text);
  return masked === text ? match : JSON.stringify(masked);
}

// The elements of a {"0":n,"1":n,...} match, or null when its keys are not
// the indexes 0, 1, 2, ... in order (then it is not a view's shape).
function serializedIndexElements(match: string): number[] | null {
  const entries = Object.entries(JSON.parse(match) as Record<string, number>);
  if (entries.some(([key], index) => key !== String(index))) return null;
  return entries.map(([, byte]) => byte);
}

function maskSerializedLogBytes(line: string): string {
  if (!line.includes('"data":[') && !line.includes('{"0":')) return line;
  return line
    .replace(SERIALIZED_BUFFER_RE, (match, data: string) =>
      data ? maskedSerializedBuffer(match, data.split(",").map(Number)) : match)
    .replace(SERIALIZED_INDEX_OBJECT_RE, (match) => {
      const elements = serializedIndexElements(match);
      return elements ? maskedSerializedBytes(match, elements) : match;
    });
}

const SENSITIVE_KEY_LOG_JSON = JSON.stringify(SENSITIVE_KEY_LOG_VALUE);
// Values already masked by name: ours, and Pino's redact-path censor.
const MASKED_KEY_LOG_JSON: ReadonlySet<string> = new Set([SENSITIVE_KEY_LOG_JSON, JSON.stringify("[Redacted]")]);

// The index of the closing quote of the JSON string opening at `start`, or -1.
function jsonStringEnd(line: string, start: number): number {
  let end = start + 1;
  while (end < line.length) {
    const code = line.charCodeAt(end);
    if (code === 0x5c) end += 2;
    else if (code === 0x22) return end;
    else end += 1;
  }
  return -1;
}

function jsonSpaceEnd(line: string, start: number): number {
  let index = start;
  while (index < line.length && " \t\r\n".includes(line[index])) index += 1;
  return index;
}

// One past the end of the JSON value starting at `start`, or -1: a string, a
// balanced object or array (brackets inside strings skipped), or a number or
// literal. A loop, not a recursion.
function jsonValueEnd(line: string, start: number): number {
  const first = line.charCodeAt(start);
  if (first === 0x22) {
    const end = jsonStringEnd(line, start);
    return end === -1 ? -1 : end + 1;
  }
  if (first === 0x7b || first === 0x5b) {
    let depth = 0;
    let index = start;
    while (index < line.length) {
      const code = line.charCodeAt(index);
      if (code === 0x22) {
        const end = jsonStringEnd(line, index);
        if (end === -1) return -1;
        index = end + 1;
        continue;
      }
      if (code === 0x7b || code === 0x5b) depth += 1;
      else if ((code === 0x7d || code === 0x5d) && --depth === 0) return index + 1;
      index += 1;
    }
    return -1;
  }
  let index = start;
  while (index < line.length && !",}] \t\r\n".includes(line[index])) index += 1;
  return index === start ? -1 : index;
}

function maskSerializedLogStrings(line: string): string {
  let parts: string[] | null = null;
  let copied = 0;
  let index = line.indexOf('"');
  while (index !== -1) {
    const end = jsonStringEnd(line, index);
    if (end === -1) return unparsableLogLine(line);
    let decoded: unknown;
    try {
      decoded = JSON.parse(line.slice(index, end + 1));
    } catch {
      return unparsableLogLine(line);
    }
    const text = decoded as string;
    const masked = redactSensitiveText(text);
    // A string followed by ":" is a key (JSON has no other place for one).
    const colon = jsonSpaceEnd(line, end + 1);
    if (line.charCodeAt(colon) === 0x3a && sensitiveLogKey(text)) {
      // A key with a sensitive name: the string and byte values in its value.
      const valueStart = jsonSpaceEnd(line, colon + 1);
      const valueEnd = jsonValueEnd(line, valueStart);
      if (valueEnd === -1) return unparsableLogLine(line);
      const value = line.slice(valueStart, valueEnd);
      const maskedValue = maskSensitiveKeyJson(value);
      if (maskedValue === null) return unparsableLogLine(line);
      if (maskedValue !== value) {
        parts ??= [];
        parts.push(line.slice(copied, valueStart), maskedValue);
        copied = valueEnd;
      }
      index = line.indexOf('"', valueEnd);
      continue;
    }
    if (masked !== text) {
      parts ??= [];
      parts.push(line.slice(copied, index), JSON.stringify(masked));
      copied = end + 1;
    }
    index = line.indexOf('"', end + 1);
  }
  if (!parts) return line;
  parts.push(line.slice(copied));
  return parts.join("");
}

// The JSON value under a sensitive key name, with every string token and byte
// shape in it replaced with the marker (a value already written as "[Redacted]"
// or as the marker is left as it is), and true, false, null, numbers, keys and
// brackets kept: `false` stays `false`, `{"hash":"x","n":1}` becomes
// `{"hash":"[masked: sensitive key]","n":1}`. null if a token does not parse.
function maskSensitiveKeyJson(value: string): string | null {
  const first = value.charCodeAt(0);
  if (first === 0x22) return MASKED_KEY_LOG_JSON.has(value) ? value : SENSITIVE_KEY_LOG_JSON;
  if (first !== 0x7b && first !== 0x5b) return value;
  // Byte shapes first (structural: never inside a string), each to the marker.
  const json = value
    .replace(SERIALIZED_BUFFER_RE, () => SENSITIVE_KEY_LOG_JSON)
    .replace(SERIALIZED_INDEX_OBJECT_RE, (match) => (serializedIndexElements(match) ? SENSITIVE_KEY_LOG_JSON : match));
  let parts: string[] | null = null;
  let copied = 0;
  let index = json.indexOf('"');
  while (index !== -1) {
    const end = jsonStringEnd(json, index);
    if (end === -1) return null;
    const token = json.slice(index, end + 1);
    let replacement: string | null = null;
    if (json.charCodeAt(jsonSpaceEnd(json, end + 1)) === 0x3a) {
      // A key: kept, its text masked by shape like every other key.
      let decoded: unknown;
      try {
        decoded = JSON.parse(token);
      } catch {
        return null;
      }
      const masked = redactSensitiveText(decoded as string);
      if (masked !== decoded) replacement = JSON.stringify(masked);
    } else if (!MASKED_KEY_LOG_JSON.has(token)) {
      replacement = SENSITIVE_KEY_LOG_JSON;
    }
    if (replacement !== null) {
      parts ??= [];
      parts.push(json.slice(copied, index), replacement);
      copied = end + 1;
    }
    index = json.indexOf('"', end + 1);
  }
  if (!parts) return json;
  parts.push(json.slice(copied));
  return parts.join("");
}

// Pino only writes JSON.stringify output, so this is not reached; if it ever
// is, write a fixed record rather than an unscanned line.
function unparsableLogLine(line: string): string {
  return `${JSON.stringify({ msg: "[masked: unparsable log line]", length: line.length })}\n`;
}

/**
 * Pino `err` serializer: Pino's standard error serializer (which folds the
 * `cause` chain into `message` and `stack`, and copies enumerable extras and
 * AggregateError children), then the shared credential mask on every string.
 */
export function redactedErrSerializer(err: unknown): unknown {
  // pino-http hands over an already standard-serialized error; serializing it
  // a second time would rename its type to "Object", so only mask its strings.
  if (!(err instanceof Error)) return redactLogValue(err);
  let serialized: unknown;
  try {
    serialized = pino.stdSerializers.err(err) as unknown;
  } catch {
    // A getter or Proxy trap on the error threw while it was read.
    return { type: "Error", message: UNREADABLE_LOG_VALUE };
  }
  if (!serialized || typeof serialized !== "object") return redactLogValue(serialized);
  const record = serialized as Record<string, unknown>;
  // The standard serializer copies enumerable inherited members, so an HTTP
  // client error's toJSON (config + headers) lands on the record, and
  // JSON.stringify would call it after masking. Call it here and mask its result.
  if (typeof record.toJSON === "function") return redactLogValue(record);
  // The standard serializer returns a fresh object whose prototype carries the
  // non-enumerable `raw` reference; redact its own fields in place.
  for (const key of Object.keys(record)) {
    record[key] = redactLogValue(record[key], 0, new Set<object>(), sensitiveLogKey(key));
  }
  return record;
}

const redactedTextSerializer = (value: unknown) => redactLogValue(value);

export const logSerializers = {
  err: redactedErrSerializer,
  stderr: redactedTextSerializer,
  stdout: redactedTextSerializer,
  // The one choke point for `msg`. Pino runs the message-key serializer on the
  // final message it emits (after %s/%o formatting, the msgPrefix, and the
  // message it infers from `err` when none is given), and on a `msg` property
  // of the merging object. Child loggers, including pino-http's, inherit it.
  msg: redactedTextSerializer,
};

export const baseLoggerOptions = {
  redact: [...HTTP_LOG_REDACT_PATHS],
  serializers: logSerializers,
  // Pino 10 hooks.streamWrite: "manipulating the stringified JSON log data
  // just before writing". It is the one place that sees every field of every
  // record, including ones no serializer visits, and it still applies when a
  // child replaces serializers.msg with identity (Pino's intended override,
  // which bypasses the msg serializer above). Children inherit hooks.
  hooks: { streamWrite: maskSerializedLogLine },
};

const sharedOpts = {
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

const isProduction = process.env.NODE_ENV === "production";
export const logger = isProduction
  ? pino({
      ...baseLoggerOptions,
      level: process.env.PAPERCLIP_LOG_LEVEL?.trim() || "info",
    })
  : pino(
      {
        ...baseLoggerOptions,
        level: process.env.PAPERCLIP_LOG_LEVEL?.trim() || "debug",
      },
      pino.transport({
        target: "pino-pretty",
        options: {
          ...sharedOpts,
          ignore: "pid,hostname,req,res,responseTime",
          colorize: true,
          destination: 1,
        },
      }),
    );

function requestClassificationUrl(req: {
  originalUrl?: unknown;
  url?: unknown;
}): string | undefined {
  return typeof req.originalUrl === "string"
    ? req.originalUrl
    : typeof req.url === "string"
      ? req.url
      : undefined;
}

function isPrivateWebhook(req: {
  method?: string;
  originalUrl?: unknown;
  url?: unknown;
}) {
  return isPrivateWebhookHttpRequest(
    req.method,
    requestClassificationUrl(req),
  );
}

function privateWebhookLogUrl(url: unknown) {
  return typeof url === "string" && /\/routine-triggers\/public(?:\/|$)/i.test(url)
    ? "/api/routine-triggers/public/:publicId/fire"
    : "/api/chat-webhooks/:publicId/:provider";
}

function requestLogUrl(req: {
  method?: string;
  originalUrl?: unknown;
  url?: unknown;
}) {
  if(isPrivateDotPrincipalHttpRequest(requestClassificationUrl(req)))return "/mcp/runner/oauth/cloud-principal";
  if(isPrivateMuseHttpRequest(requestClassificationUrl(req)))return "/api/muse/:protocol";
  if (isPrivateAgentObservabilityHttpRequest(requestClassificationUrl(req))) return "/api/companies/:companyId/observability";
  return isPrivateWebhook(req)
    ? privateWebhookLogUrl(requestClassificationUrl(req))
    : stripSecretBearingUrlParts(typeof req.url === "string" ? req.url : "");
}

function abortedRequestMessage(req: IncomingMessage, res: ServerResponse) {
  if (!req.readableAborted && res.writableFinished) return null;
  return `${req.method} ${requestLogUrl(req)} — request aborted${res.headersSent ? " during response" : " before response"}`;
}

export function createHttpLogger(baseLogger: Logger) {
  return pinoHttp({
    logger: baseLogger,
    serializers: {
      // pino-http installs its own standard err serializer on its child logger
      // unless one is given here, which would bypass the base logger's mask.
      err: redactedErrSerializer,
      req(req: Record<string, unknown> & { url?: unknown }) {
        if (isPrivateAgentObservabilityHttpRequest(typeof req.url === "string" ? req.url : undefined)) {
          return { id: req.id, method: req.method, url: "/api/companies/:companyId/observability" };
        }
        if(isPrivateDotPrincipalHttpRequest(typeof req.url === "string" ? req.url : undefined))return {id:req.id,method:req.method,url:"/mcp/runner/oauth/cloud-principal"};
        if(isPrivateMuseHttpRequest(typeof req.url === "string" ? req.url : undefined))return {id:req.id,method:req.method,url:"/api/muse/:protocol"};
        if (isPrivateAgentCommentaryHttpRequest(typeof req.url === "string" ? req.url : undefined)) {
          return { id: req.id, method: req.method, url: stripSecretBearingUrlParts(req.url as string) };
        }
        if (
          isPrivateWebhook({
            method: typeof req.method === "string" ? req.method : undefined,
            url: req.url,
          })
        ) {
          // pino's standard request serializer has already selected originalUrl.
          // A closed projection also excludes params, arbitrary headers and any
          // parser/SDK-added body copies, including Buffer numeric byte keys.
          return {
            id: req.id,
            method: req.method,
            url: privateWebhookLogUrl(req.url),
          };
        }
        const headers = req.headers as Record<string, unknown> | undefined;
        return {
          ...req,
          ...(headers ? { headers: {
            ...headers,
            ...Object.fromEntries(["referer", "referrer"].filter(key => typeof headers[key] === "string")
              .map(key => [key, stripSecretBearingUrlParts(headers[key] as string)])),
          } } : {}),
          url:
            typeof req.url === "string"
              ? stripSecretBearingUrlParts(req.url)
              : req.url,
          // The URL policy intentionally drops all query parameters. The default
          // serializer also exposes the parsed query separately, so omit that
          // duplicate path instead of letting credentials bypass the URL scrub.
          query: undefined,
        };
      },
      res(
        res: Record<string, unknown> & {
          raw?: {
            req?: { method?: string; originalUrl?: unknown; url?: unknown };
          };
        },
      ) {
        // A provider error may also be reflected in response headers. Keep the
        // same content-free contract on both sides of a webhook request.
        return res.raw?.req && (isPrivateWebhook(res.raw.req) || isPrivateMuseHttpRequest(requestClassificationUrl(res.raw.req)) || isPrivateDotPrincipalHttpRequest(requestClassificationUrl(res.raw.req)) || isPrivateAgentCommentaryHttpRequest(requestClassificationUrl(res.raw.req)) || isPrivateAgentObservabilityHttpRequest(requestClassificationUrl(res.raw.req)))
          ? { statusCode: res.statusCode }
          : res;
      },
    },
    customLogLevel(_req, res, err) {
      if (err || (res as ServerResponse & { err?: unknown }).err || res.statusCode >= 500) return "error";
      if (_req.readableAborted || !res.writableFinished) return "warn";
      if (shouldSilenceHttpSuccessLog(_req.method, _req.url, res.statusCode)) {
        return "silent";
      }
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    customSuccessMessage(req, res) {
      return abortedRequestMessage(req, res) ?? `${req.method} ${requestLogUrl(req)} ${res.statusCode}`;
    },
    customErrorMessage(req, res, err) {
      const abortedMessage = abortedRequestMessage(req, res);
      if (abortedMessage) return abortedMessage;
      if (
        isSecretSensitiveHttpRequest(req.method, requestClassificationUrl(req))
      ) {
        return `${req.method} ${requestLogUrl(req)} ${res.statusCode} — request failed`;
      }
      const ctx = (res as any).__errorContext;
      const errMsg =
        ctx?.error?.message ||
        err?.message ||
        (res as any).err?.message ||
        "unknown error";
      return `${req.method} ${stripSecretBearingUrlParts(req.url ?? "")} ${res.statusCode} — ${redactSensitiveText(String(errMsg))}`;
    },
    customErrorObject(req, _res, _err, value) {
      if (isPrivateAgentObservabilityHttpRequest(requestClassificationUrl(req))) {
        return { ...value, err: { type: "Error", message: "Agent observability request failed" } };
      }
      if(isPrivateDotPrincipalHttpRequest(requestClassificationUrl(req)))return {...value,err:{type:"Error",message:"Dot principal request failed"}};
      if (isPrivateMuseHttpRequest(requestClassificationUrl(req)))return {...value,err:{type:"Error",message:"External agent request failed"}};
      if (isPrivateAgentCommentaryHttpRequest(requestClassificationUrl(req))) {
        return { ...value, err: { type: "Error", message: "Feedback request failed" } };
      }
      // pino-http serializes res.err independently of customProps/errorContext.
      // Do not rely on a particular error handler having sanitized an SDK Error.
      return isPrivateWebhook(req)
        ? {
            ...value,
            err: { type: "Error", message: "Chat webhook request failed" },
          }
        : value;
    },
    customProps(req, res) {
      if (res.statusCode >= 400) {
        const ctx = (res as any).__errorContext;
        if (/^\/mcp\/(?:oauth|paperclip)(?:\/|$)/.test(requestClassificationUrl(req) ?? "")) {
          return { reqBody: "[REDACTED]", ...(ctx ? { errorContext: { name: "Error" } } : {}) };
        }
        if (isPrivateWebhook(req) || isPrivateMuseHttpRequest(requestClassificationUrl(req)) || isPrivateDotPrincipalHttpRequest(requestClassificationUrl(req)) || isPrivateAgentCommentaryHttpRequest(requestClassificationUrl(req)) || isPrivateAgentObservabilityHttpRequest(requestClassificationUrl(req))) {
          // Omit, rather than recursively redact, the entire provider payload.
          // This applies equally before/after parsing and with/without context.
          return {
            reqBody: "[REDACTED]",
            ...(ctx || (res as any).err
              ? { errorContext: { name: "Error" } }
              : {}),
          };
        }
        if (ctx) {
          const secretSensitiveRoute = isSecretSensitiveHttpRequest(
            req.method,
            requestClassificationUrl(req),
          );
          return {
            // Provider SDK and validation errors sometimes echo the supplied
            // credential in their prose. Keep only a non-sensitive type marker
            // for setup routes; the status, route, and redacted body remain.
            errorContext: secretSensitiveRoute
              ? { name: "Error" }
              : redactLogValue(redactSensitive(ctx.error)),
            reqBody: redactSensitive(ctx.reqBody),
            reqParams: redactSensitive(ctx.reqParams),
          };
        }
        const props: Record<string, unknown> = {};
        const { body, params } = req as any;
        if (body && typeof body === "object" && Object.keys(body).length > 0) {
          props.reqBody = redactSensitive(body);
        }
        if (
          params &&
          typeof params === "object" &&
          Object.keys(params).length > 0
        ) {
          props.reqParams = redactSensitive(params);
        }
        if ((req as any).route?.path) {
          props.routePath = (req as any).route.path;
        }
        return props;
      }
      return {};
    },
  });
}

export const httpLogger = createHttpLogger(logger);
