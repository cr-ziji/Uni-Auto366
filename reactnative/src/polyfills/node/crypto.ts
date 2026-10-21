/**
 * Node `crypto` polyfill for React Native.
 *
 * The primitives the ported business modules rely on are implemented:
 *
 *   - MD5 (rule identifiers + injection package checksums),
 *   - SHA-256 (resource checksums + injection signatures),
 *   - AES-128-CBC (the `u3enc` answer format) on top of `aes-js`,
 *   - a pseudo random source.
 *
 * `aes-js` implements the raw block cipher, therefore the PKCS#7 padding is
 * handled by this polyfill: the cipher encrypts the data as it is (the caller
 * pads it, exactly like the desktop sources do) and the decipher removes a
 * single PKCS#7 block unless the automatic padding is disabled.
 */
import {Buffer} from 'buffer';
import {ModeOfOperation} from 'aes-js';

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6,
  10, 15, 21,
];

const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
}

function rotateLeft(value: number, shift: number): number {
  return (value << shift) | (value >>> (32 - shift));
}

function utf8Bytes(input: string | Uint8Array | number): Uint8Array {
  if (typeof input !== 'string') {
    if (typeof input === 'number') {
      return utf8Bytes(String(input));
    }
    return input;
  }
  const out: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
      i++;
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return Uint8Array.from(out);
}

export function md5(input: string | Uint8Array): Uint8Array {
  const message = utf8Bytes(input);
  const originalLength = message.length;
  const bitLength = originalLength * 8;
  const paddedLength = (((originalLength + 8) >> 6) + 1) << 6;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(message);
  buffer[originalLength] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const M = new Uint32Array(16);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      M[i] = view.getUint32(offset + i * 4, true);
    }
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotateLeft(F, S[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const digest = new Uint8Array(16);
  const digestView = new DataView(digest.buffer);
  digestView.setUint32(0, a0, true);
  digestView.setUint32(4, b0, true);
  digestView.setUint32(8, c0, true);
  digestView.setUint32(12, d0, true);
  return digest;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

/** SHA-256 digest of the given input. */
export function sha256(input: string | Uint8Array): Uint8Array {
  const message = utf8Bytes(input);
  const originalLength = message.length;
  const bitLength = originalLength * 8;
  const paddedLength = (((originalLength + 8) >> 6) + 1) << 6;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(message);
  buffer[originalLength] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 4294967296));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const W = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      W[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let a = H[0];
    let b = H[1];
    let c = H[2];
    let d = H[3];
    let e = H[4];
    let f = H[5];
    let g = H[6];
    let h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + W[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  for (let i = 0; i < 8; i++) {
    digestView.setUint32(i * 4, H[i]);
  }
  return digest;
}

export class Hash {
  private readonly chunks: Uint8Array[] = [];

  constructor(private readonly algorithm: string) {}

  update(data: string | Uint8Array | Buffer): this {
    this.chunks.push(utf8Bytes(data as any));
    return this;
  }

  digest(encoding?: 'hex' | 'base64' | 'buffer'): string | Buffer {
    const algorithm = this.algorithm;
    if (algorithm !== 'md5' && algorithm !== 'sha256') {
      throw new Error(`[e2rn] crypto.createHash('${algorithm}') is not implemented on React Native`);
    }
    let total = 0;
    for (const chunk of this.chunks) {
      total += chunk.length;
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    const digest = Buffer.from(algorithm === 'md5' ? md5(joined) : sha256(joined));
    if (encoding === 'hex') {
      return digest.toString('hex');
    }
    if (encoding === 'base64') {
      return digest.toString('base64');
    }
    return digest;
  }
}

export function createHash(algorithm: string): Hash {
  return new Hash(algorithm.toLowerCase());
}

let randomCounter = 0;

function randomBytesImpl(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    randomCounter = (randomCounter + 1) % 0xffffffff;
    bytes[i] = (Math.floor(Math.random() * 256) ^ (randomCounter & 0xff)) & 0xff;
  }
  return bytes;
}

export function randomBytes(size: number): Buffer {
  return randomBytesImpl(size);
}

export function randomUUID(): string {
  const bytes = randomBytesImpl(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* -------------------------------------------------------------------------- */
/* Symmetric encryption                                                       */
/* -------------------------------------------------------------------------- */

const BLOCK_SIZE = 16;

function toBuffer(data: string | Uint8Array | Buffer): Buffer {
  if (typeof data === 'string') {
    return Buffer.from(data, 'utf8');
  }
  return Buffer.from(data as any);
}

function normalizeAlgorithm(algorithm: string): string {
  const value = String(algorithm ?? '').toLowerCase();
  if (value === 'aes-128-cbc' || value === 'aes-192-cbc' || value === 'aes-256-cbc') {
    return value;
  }
  throw new Error(`[e2rn] crypto: the algorithm "${algorithm}" is not supported on React Native`);
}

function validateKey(algorithm: string, key: Uint8Array): void {
  const expected = algorithm === 'aes-128-cbc' ? 16 : algorithm === 'aes-192-cbc' ? 24 : 32;
  if (key.length !== expected) {
    throw new Error(`[e2rn] crypto: invalid key length (${key.length} bytes, expected ${expected})`);
  }
}

function validateIv(iv: Uint8Array): void {
  if (!iv || iv.length !== BLOCK_SIZE) {
    throw new Error('[e2rn] crypto: invalid initialization vector');
  }
}

/** Shared behaviour of {@link Cipher} and {@link Decipher}. */
abstract class CipherBase {
  protected readonly mode: any;
  protected pending: Buffer = Buffer.alloc(0);
  protected autoPadding: boolean;

  constructor(algorithm: string, key: Uint8Array, iv: Uint8Array, decipher: boolean, autoPadding: boolean) {
    const normalized = normalizeAlgorithm(algorithm);
    validateKey(normalized, key);
    validateIv(iv);
    this.mode = new (ModeOfOperation as any).cbc(key, iv);
    this.autoPadding = autoPadding;
    void decipher;
  }

  /** Enables or disables the automatic PKCS#7 padding. */
  setAutoPadding(autoPadding: boolean = true): this {
    this.autoPadding = autoPadding;
    return this;
  }

  /** Whether the automatic PKCS#7 padding is enabled. */
  getAutoPadding(): boolean {
    return this.autoPadding;
  }

  abstract update(data: string | Uint8Array | Buffer): Buffer;
  abstract final(): Buffer;
}

/** Encrypts data with AES-CBC. */
export class Cipher extends CipherBase {
  constructor(algorithm: string, key: Uint8Array, iv: Uint8Array) {
    super(algorithm, key, iv, false, false);
  }

  update(data: string | Uint8Array | Buffer): Buffer {
    const input = toBuffer(data);
    this.pending = Buffer.concat([this.pending, input]);
    const blocks = Math.floor(this.pending.length / BLOCK_SIZE) * BLOCK_SIZE;
    if (blocks === 0) {
      return Buffer.alloc(0);
    }
    const chunk = this.pending.subarray(0, blocks);
    this.pending = Buffer.from(this.pending.subarray(blocks));
    return Buffer.from(this.mode.encrypt(chunk) as Uint8Array);
  }

  final(): Buffer {
    if (this.pending.length === 0) {
      return Buffer.alloc(0);
    }
    if (!this.autoPadding) {
      throw new Error('[e2rn] crypto: wrong final block length (the data has to be padded by the caller)');
    }
    const padding = BLOCK_SIZE - (this.pending.length % BLOCK_SIZE);
    const padded = Buffer.concat([this.pending, Buffer.alloc(padding, padding)]);
    this.pending = Buffer.alloc(0);
    return Buffer.from(this.mode.encrypt(padded) as Uint8Array);
  }
}

/** Decrypts data with AES-CBC. */
export class Decipher extends CipherBase {
  private pendingPlain: Buffer = Buffer.alloc(0);

  constructor(algorithm: string, key: Uint8Array, iv: Uint8Array) {
    super(algorithm, key, iv, true, true);
  }

  update(data: string | Uint8Array | Buffer): Buffer {
    const input = toBuffer(data);
    this.pending = Buffer.concat([this.pending, input]);
    const blocks = Math.floor(this.pending.length / BLOCK_SIZE) * BLOCK_SIZE;
    if (blocks === 0) {
      return Buffer.alloc(0);
    }
    const chunk = this.pending.subarray(0, blocks);
    this.pending = Buffer.from(this.pending.subarray(blocks));
    const plain = Buffer.from(this.mode.decrypt(chunk) as Uint8Array);
    if (!this.autoPadding) {
      return plain;
    }
    // The last block carries the padding, therefore it is only released by
    // `final()`.
    const combined = Buffer.concat([this.pendingPlain, plain]);
    if (combined.length <= BLOCK_SIZE) {
      this.pendingPlain = combined;
      return Buffer.alloc(0);
    }
    this.pendingPlain = Buffer.from(combined.subarray(combined.length - BLOCK_SIZE));
    return Buffer.from(combined.subarray(0, combined.length - BLOCK_SIZE));
  }

  final(): Buffer {
    if (this.pending.length > 0) {
      throw new Error('[e2rn] crypto: wrong final block length');
    }
    if (!this.autoPadding) {
      return Buffer.alloc(0);
    }
    const block = this.pendingPlain;
    this.pendingPlain = Buffer.alloc(0);
    if (block.length === 0) {
      return Buffer.alloc(0);
    }
    const padding = block[block.length - 1];
    if (padding < 1 || padding > BLOCK_SIZE || padding > block.length) {
      throw new Error('[e2rn] crypto: bad decrypt');
    }
    for (let index = block.length - padding; index < block.length; index++) {
      if (block[index] !== padding) {
        throw new Error('[e2rn] crypto: bad decrypt');
      }
    }
    return Buffer.from(block.subarray(0, block.length - padding));
  }
}

/** Creates an AES-CBC cipher. */
export function createCipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array): Cipher {
  return new Cipher(algorithm, key, iv);
}

/** Creates an AES-CBC decipher. */
export function createDecipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array): Decipher {
  return new Decipher(algorithm, key, iv);
}

export default {
  Cipher,
  Decipher,
  createCipheriv,
  createDecipheriv,
  createHash,
  md5,
  randomBytes,
  randomUUID,
  sha256,
};
