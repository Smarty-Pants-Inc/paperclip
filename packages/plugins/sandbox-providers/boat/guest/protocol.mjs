// Dependency-free guest protocol. Errors deliberately contain no caller data.
export const MAX_FRAME_BYTES = 16 * 1024;
export const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_U64 = (1n << 64n) - 1n;
const IDENTITY = ['runnerInstanceId', 'environmentLeaseId', 'runId', 'normalizedSessionId', 'turnId', 'itemId'];
const CUT = ['identity', 'lastControllerCommandSeq', 'ackedSourceSeq'];
const SEQUENCES = new Set(['lastControllerCommandSeq', 'ackedSourceSeq']);

export class SupervisorError extends Error {
  constructor(code) { super(code); this.name = 'SupervisorError'; this.code = code; }
}
export const fail = (code) => { throw new SupervisorError(code); };
export function closed(value, required, optional = []) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
export const validString = (value) => typeof value === 'string' && value.isWellFormed();
export const validId = (value) => validString(value) && Buffer.byteLength(value) > 0
  && Buffer.byteLength(value) <= 128 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const u64 = (value) => (typeof value === 'bigint' && value >= 0n && value <= MAX_U64)
  || (Number.isSafeInteger(value) && value >= 0);
const identityValid = (value) => closed(value, IDENTITY) && IDENTITY.every((key) => validString(value[key]));

export function encodeJson(value) {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? JSON.rawJSON(item.toString()) : item);
}

// JSON.parse alone would silently erase duplicate keys and round Rust u64 cuts.
// Parse grammar with the platform parser, then reject duplicate object keys using
// its already-valid token stream. Never expose a native parser error to callers.
export function decodeJson(input, code = 'INVALID_REQUEST') {
  try {
    const text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input);
    const value = JSON.parse(text, (key, item, context) => {
      if (typeof item === 'number' && SEQUENCES.has(key)) {
        if (!/^(0|[1-9][0-9]*)$/.test(context.source)) fail(code);
        if (!Number.isSafeInteger(item)) return BigInt(context.source);
      }
      return item;
    });
    const stack = [];
    const tokens = /"(?:[^"\\]|\\.)*"|[{}[\]]/g;
    for (const token of text.matchAll(tokens)) {
      const word = token[0];
      if (word === '{') stack.push(new Set());
      else if (word === '[') stack.push(null);
      else if (word === '}' || word === ']') stack.pop();
      else if (/^\s*:/.test(text.slice(token.index + word.length))) {
        const key = JSON.parse(word);
        const seen = stack.at(-1);
        if (!seen || seen.has(key)) fail(code);
        seen.add(key);
      }
    }
    return value;
  } catch { fail(code); }
}

export function validateHostFrame(input) {
  try {
    let frame = input;
    if (typeof input === 'string' || Buffer.isBuffer(input)) {
      if (Buffer.byteLength(input) > MAX_FRAME_BYTES) fail('INVALID_FRAME');
      frame = decodeJson(input, 'INVALID_FRAME');
    }
    if (!frame || !validId(frame.id)) fail('INVALID_FRAME');
    switch (frame.op) {
      case 'park':
        if (!closed(frame, ['op', 'id', ...CUT]) || !identityValid(frame.identity)
          || !u64(frame.lastControllerCommandSeq) || !u64(frame.ackedSourceSeq)) fail('INVALID_FRAME');
        break;
      case 'claim':
        if (!closed(frame, ['op', 'id', 'parkId', 'bootstrapTicket']) || !validId(frame.parkId)
          || !validString(frame.bootstrapTicket) || /^\p{White_Space}*$/u.test(frame.bootstrapTicket)
          || Buffer.byteLength(frame.bootstrapTicket) > 8192) fail('INVALID_FRAME');
        break;
      case 'retire':
        if (!closed(frame, ['op', 'id', 'parkId'], ['claimId', ...CUT]) || !validId(frame.parkId)
          || (frame.claimId != null && !validId(frame.claimId))
          || (frame.identity != null && !identityValid(frame.identity))
          || (frame.lastControllerCommandSeq != null && !u64(frame.lastControllerCommandSeq))
          || (frame.ackedSourceSeq != null && !u64(frame.ackedSourceSeq))) fail('INVALID_FRAME');
        break;
      default: fail('INVALID_FRAME');
    }
    // Stable field ordering makes retries independent of a carrier's key order.
    const normalized = { op: frame.op, id: frame.id };
    if (frame.op !== 'park') normalized.parkId = frame.parkId;
    if (frame.op === 'claim') normalized.bootstrapTicket = frame.bootstrapTicket;
    if (frame.op === 'retire') normalized.claimId = frame.claimId ?? null;
    if (frame.op !== 'claim') {
      normalized.identity = frame.identity == null ? null : Object.fromEntries(IDENTITY.map((key) => [key, frame.identity[key]]));
      normalized.lastControllerCommandSeq = frame.lastControllerCommandSeq ?? null;
      normalized.ackedSourceSeq = frame.ackedSourceSeq ?? null;
      // Keep absent optional retire fields absent on the wire; normalize them only
      // when hashing a request (Rust treats absent and null options identically).
      if (frame.op === 'retire') for (const key of ['claimId', ...CUT]) if (!Object.hasOwn(frame, key)) delete normalized[key];
    }
    const wire = encodeJson(normalized) + '\n';
    if (Buffer.byteLength(wire) > MAX_FRAME_BYTES) fail('INVALID_FRAME');
    return wire;
  } catch { fail('INVALID_FRAME'); }
}

export function frameFingerprintInput(wire) {
  const frame = decodeJson(wire, 'INVALID_FRAME');
  if (frame.op === 'retire') return encodeJson({
    op: frame.op, id: frame.id, parkId: frame.parkId,
    claimId: frame.claimId ?? null, identity: frame.identity ?? null,
    lastControllerCommandSeq: frame.lastControllerCommandSeq ?? null,
    ackedSourceSeq: frame.ackedSourceSeq ?? null,
  });
  return encodeJson(frame);
}

export function validateReply(input) {
  const reply = decodeJson(input, 'CHANNEL_FAILED');
  if (!closed(reply, ['id', 'status']) || !validId(reply.id)
    || !['parked', 'claimed', 'retired', 'conflict'].includes(reply.status)) fail('CHANNEL_FAILED');
  return reply;
}
