import { createHash } from 'node:crypto';
import { decodeJson, fail, frameFingerprintInput, SupervisorError, validateReply } from './protocol.mjs';

// One channel belongs to one process generation. Only an active exchange owns a
// timer. After an ambiguous timeout retain hashes/counts, never the ticket body.
export class HostChannel {
  #socket;
  #timeout;
  #tail = Promise.resolve();
  #queued = 0;
  #pending = new Map();
  #uncertain;
  #waiter;
  #input = Buffer.alloc(0);
  #failed = false;

  constructor(socket, timeout) {
    this.#socket = socket;
    this.#timeout = timeout;
    socket.on('data', (bytes) => this.#receive(bytes));
    socket.on('error', () => this.close());
    socket.on('end', () => this.close());
    socket.on('close', () => this.close());
  }

  request(wire) {
    if (this.#failed) return Promise.reject(new SupervisorError('CHANNEL_FAILED'));
    if (this.#queued >= 16) return Promise.reject(new SupervisorError('BUSY'));
    this.#queued++;
    const deadline = performance.now() + this.#timeout;
    const result = this.#tail.then(() => this.#exchange(wire, deadline));
    this.#tail = result.catch(() => {}).finally(() => { this.#queued--; });
    return result;
  }

  async #exchange(wire, deadline) {
    if (this.#failed) fail('CHANNEL_FAILED');
    const remaining = deadline - performance.now();
    if (remaining <= 0) fail('QUEUE_TIMEOUT');
    const { id, op } = decodeJson(wire);
    const digest = createHash('sha256').update(frameFingerprintInput(wire)).digest('hex');
    if (this.#uncertain) {
      if (this.#uncertain.id !== id || this.#uncertain.digest !== digest) fail('UNCERTAIN');
      if (this.#uncertain.reply) {
        const reply = this.#uncertain.reply;
        this.#uncertain = undefined;
        return reply;
      }
    }
    const prior = this.#pending.get(id);
    if (prior && prior.digest !== digest) fail('UNCERTAIN');
    if ([...this.#pending.values()].reduce((count, item) => count + item.count, 0) >= 32) fail('RETRY_LIMIT');
    this.#pending.set(id, { digest, count: (prior?.count ?? 0) + 1, status: { park: 'parked', claim: 'claimed', retire: 'retired' }[op] });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiter = undefined;
        this.#uncertain = { id, digest };
        reject(new SupervisorError('REPLY_TIMEOUT'));
      }, remaining);
      this.#waiter = {
        id,
        finish: (error, reply) => {
          clearTimeout(timer);
          this.#waiter = undefined;
          if (error) reject(error);
          else { this.#uncertain = undefined; resolve(reply); }
        },
      };
      this.#socket.write(wire, (error) => { if (error) this.close(); });
    });
  }

  #receive(bytes) {
    if (this.#failed) return;
    // Each reply is at most 1024 bytes. Bound before concatenating untrusted data.
    // At most 32 replies can be outstanding, including exact retries.
    if (this.#input.length + bytes.length > 32 * 1024) { this.close(); return; }
    this.#input = Buffer.concat([this.#input, bytes]);
    try {
      let end;
      while ((end = this.#input.indexOf(10)) !== -1) {
        if (end + 1 > 1024) fail('CHANNEL_FAILED');
        const reply = validateReply(this.#input.subarray(0, end));
        this.#input = this.#input.subarray(end + 1);
        const pending = this.#pending.get(reply.id);
        if (!pending || ![pending.status, 'conflict'].includes(reply.status)) fail('CHANNEL_FAILED');
        if (--pending.count === 0) this.#pending.delete(reply.id);
        if (this.#waiter?.id === reply.id) this.#waiter.finish(null, reply);
        else if (this.#uncertain?.id === reply.id) this.#uncertain.reply = reply;
        // A delayed duplicate receipt for an already returned retry is consumed,
        // never mistaken for the next operation's reply.
      }
      if (this.#input.length >= 1024) fail('CHANNEL_FAILED');
    } catch { this.close(); }
  }

  close() {
    if (this.#failed) return;
    this.#failed = true;
    this.#input = Buffer.alloc(0);
    this.#pending.clear();
    this.#uncertain = undefined;
    this.#waiter?.finish(new SupervisorError('CHANNEL_FAILED'));
    this.#socket.destroy();
  }
}
