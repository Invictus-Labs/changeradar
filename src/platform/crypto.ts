import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>;

export const sha256Hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Encrypts stored secrets (connector credential values) at rest with an operator-supplied 32-byte key
 * that never lives in the database. AES-256-GCM, fresh random nonce, versioned envelope.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("CHANGERADAR_ENCRYPTION_KEY must decode to exactly 32 bytes");
    this.key = key;
  }

  static fromBase64(value: string | undefined): SecretBox {
    if (!value) throw new Error("CHANGERADAR_ENCRYPTION_KEY is required (base64 of 32 random bytes; see .env.example)");
    return new SecretBox(Buffer.from(value, "base64"));
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
  }

  decrypt(sealed: string): string {
    const [version, iv, tag, ct] = sealed.split(":");
    // An empty plaintext seals to an empty ciphertext segment, so only a missing segment is malformed.
    if (version !== "v1" || !iv || !tag || ct === undefined) throw new Error("unsupported secret format");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
  }

  /** Keyed MAC for values derived from secrets (CSRF tokens, rate limit keys). */
  mac(purpose: string, value: string): string {
    // The purpose is length prefixed so no (purpose, value) pair can be shifted into another.
    return createHmac("sha256", this.key).update(`${purpose.length}:${purpose}\n${value}`).digest("base64url");
  }
}

const SCRYPT_N = 16384;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64, { N: SCRYPT_N, r: 8, p: 1 });
  return `scrypt$${SCRYPT_N}$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** Hash used to spend equal time when the account does not exist, so timing does not reveal accounts. */
export const DUMMY_PASSWORD_HASH = `scrypt$${SCRYPT_N}$8$1$AAAAAAAAAAAAAAAAAAAAAA==$${Buffer.alloc(64).toString("base64")}`;

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
