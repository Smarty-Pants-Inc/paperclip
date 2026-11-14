import { Writable } from "node:stream";

type GuardianLogLine = Record<string, unknown>;

const originalStdout = process.stdout;
const originalStdoutDescriptor = Object.getOwnPropertyDescriptor(process, "stdout")!;
const originalNodeEnv = process.env.NODE_ENV;
const retainedLines: string[] = [];
const MAX_CAPTURE_LINES = 32;
const MAX_CAPTURE_BYTES = 32 * 1024;
const MAX_LINE_BYTES = 16 * 1024;
const TARGET_MESSAGE = "[plugin] Conversation guardian reconciliation failed.";
let retainedBytes = 0;
let pending = "";
let discardOversizedLine = false;

function retainLine(line: string) {
  if (line.length > MAX_LINE_BYTES) return;
  try {
    const record = JSON.parse(line) as GuardianLogLine;
    if (record.msg !== TARGET_MESSAGE) return;
    if (retainedLines.length >= MAX_CAPTURE_LINES || retainedBytes + line.length > MAX_CAPTURE_BYTES) return;
    retainedLines.push(line);
    retainedBytes += line.length;
  } catch {
    // Only complete JSON lines with the exact plugin warning are evidence.
  }
}

const captureStream = new Writable({
  write(chunk, _encoding, callback) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    // Keep the host's ordinary stdout behavior while retaining only bounded target records.
    originalStdout.write(text);
    let cursor = 0;
    while (cursor < text.length) {
      const newline = text.indexOf("\n", cursor);
      if (newline < 0) {
        const tail = text.slice(cursor);
        if (!discardOversizedLine) {
          if (pending.length + tail.length <= MAX_LINE_BYTES) pending += tail;
          else {
            pending = "";
            discardOversizedLine = true;
          }
        }
        break;
      }
      if (discardOversizedLine) {
        discardOversizedLine = false;
        pending = "";
      } else {
        retainLine(pending + text.slice(cursor, newline));
        pending = "";
      }
      cursor = newline + 1;
    }
    callback();
  },
});

// Pino's documented stdout-tampering path checks for an own write function.
// Bind this real Writable's implementation so it remains the actual destination.
captureStream.write = captureStream.write.bind(captureStream);

try {
  process.env.NODE_ENV = "production";
  Object.defineProperty(process, "stdout", { configurable: true, enumerable: true, value: captureStream });
  // Pino's default destination uses process.stdout when it is replaced before initialization.
  await import("../../middleware/logger.js");
} finally {
  Object.defineProperty(process, "stdout", originalStdoutDescriptor);
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
}

export function resetGuardianLogCapture(): void {
  retainedLines.length = 0;
  retainedBytes = 0;
  pending = "";
  discardOversizedLine = false;
}

export function readGuardianLogCapture(): GuardianLogLine[] {
  return retainedLines.map(line => JSON.parse(line) as GuardianLogLine);
}
