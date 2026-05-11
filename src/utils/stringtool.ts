// scramble.ts — hardened
import { createHash, pbkdf2Sync, randomBytes } from "crypto";

class HashStream {
  private counter = 0n;
  private buf: Buffer = Buffer.alloc(0);
  private offset = 0;
  constructor(private key: Buffer) {}

  private refill(): void {
    const h = createHash("sha256");
    h.update(this.key);
    const ctr = Buffer.alloc(8);
    ctr.writeBigUInt64BE(this.counter++);
    h.update(ctr);
    this.buf = h.digest();
    this.offset = 0;
  }
  nextByte(): number {
    if (this.offset >= this.buf.length) this.refill();
    return this.buf[this.offset++]!;
  }
  nextU32(): number {
    return (
      ((this.nextByte() << 24) |
        (this.nextByte() << 16) |
        (this.nextByte() << 8) |
        this.nextByte()) >>>
      0
    );
  }
}

function shuffle256(rng: HashStream): Uint8Array {
  const arr = new Uint8Array(256);
  for (let i = 0; i < 256; i++) arr[i] = i;
  for (let i = 255; i > 0; i--) {
    // Unbiased index in [0, i]
    const bound = 0xffffffff - (0xffffffff % (i + 1));
    let r: number;
    do {
      r = rng.nextU32();
    } while (r > bound);
    const j = r % (i + 1);
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

export class StringScrambler {
  private masterKey: Buffer;

  constructor(passphrase?: string) {
    // Derive a strong key. PBKDF2 with high iterations slows brute force.
    const pass = passphrase ?? randomBytes(32).toString("hex");
    this.masterKey = pbkdf2Sync(pass, "svksjrhjkcejg", 200_000, 32, "sha256");
  }

  encode(value: string): string {
    const pt = Buffer.from(value, "utf8");
    const nonce = randomBytes(12);
    // Per-message subkey so same plaintext -> different ciphertext
    const subkey = createHash("sha256")
      .update(this.masterKey)
      .update(nonce)
      .digest();

    const out = Buffer.alloc(pt.length);
    for (let i = 0; i < pt.length; i++) {
      // Position-dependent alphabet: re-seed per position -> polyalphabetic
      const posKey = createHash("sha256")
        .update(subkey)
        .update(Buffer.from(i.toString()))
        .digest();
      const table = shuffle256(new HashStream(posKey));
      out[i] = table[pt[i]!]!;
    }
    return Buffer.concat([nonce, out]).toString("base64");
  }

  decode(blob: string): string {
    const buf = Buffer.from(blob, "base64");
    const nonce = buf.subarray(0, 12);
    const ct = buf.subarray(12);
    const subkey = createHash("sha256")
      .update(this.masterKey)
      .update(nonce)
      .digest();

    const out = Buffer.alloc(ct.length);
    for (let i = 0; i < ct.length; i++) {
      const posKey = createHash("sha256")
        .update(subkey)
        .update(Buffer.from(i.toString()))
        .digest();
      const table = shuffle256(new HashStream(posKey));
      // Build inverse table
      const inv = new Uint8Array(256);
      for (let b = 0; b < 256; b++) inv[table[b]!] = b;
      out[i] = inv[ct[i]!]!;
    }
    return out.toString("utf8");
  }
}
