import { createHash } from "node:crypto";

/** Fixed-memory, fail-closed history. False positives can suppress projection;
 * false negatives (and therefore rebinding an old identity) are impossible.
 * Never use a positive match to grant authority or select a turn. */
export class PiIdentityTombstones {
  readonly #bits = new Uint8Array(1024 * 1024);

  get byteLength(): number { return this.#bits.byteLength; }

  #positions(key: string): number[] {
    const hash = createHash("sha256").update(key).digest();
    return [0, 4, 8, 12].map(offset => hash.readUInt32LE(offset) % (this.#bits.length * 8));
  }

  has(key: string): boolean {
    return this.#positions(key).every(bit => (this.#bits[bit >>> 3]! & (1 << (bit & 7))) !== 0);
  }

  add(key: string): void {
    for (const bit of this.#positions(key)) this.#bits[bit >>> 3]! |= 1 << (bit & 7);
  }
}
