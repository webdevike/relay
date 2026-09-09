/**
 * HMAC-SHA256 over an injected SHA-256 so the same code runs on Node (webcrypto) and in the
 * phone app (expo-crypto `digest`). RFC 2104, block size 64.
 */
export type Sha256 = (data: Uint8Array) => Promise<ArrayBuffer>;

const BLOCK = 64;

export async function hmacSha256(key: Uint8Array, message: Uint8Array, sha256: Sha256): Promise<Uint8Array> {
  const k = key.length > BLOCK ? new Uint8Array(await sha256(key)) : key;
  const padded = new Uint8Array(BLOCK);
  padded.set(k);
  const inner = new Uint8Array(BLOCK + message.length);
  const outer = new Uint8Array(BLOCK + 32);
  for (let i = 0; i < BLOCK; i++) {
    const b = padded[i] ?? 0;
    inner[i] = b ^ 0x36;
    outer[i] = b ^ 0x5c;
  }
  inner.set(message, BLOCK);
  outer.set(new Uint8Array(await sha256(inner)), BLOCK);
  return new Uint8Array(await sha256(outer));
}

/** proof = hex(HMAC-SHA256(secretBytes, utf8(nonce))) with hex secret as stored after pairing. */
export async function authProof(secretHex: string, nonce: string, sha256: Sha256): Promise<string> {
  return toHex(await hmacSha256(fromHex(secretHex), new TextEncoder().encode(nonce), sha256));
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
