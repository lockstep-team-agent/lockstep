import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { env } from "../env.js";

// Encryption key derived from the signing secret. (Self-host: set a strong TOKEN_SIGNING_SECRET.)
const key = scryptSync(env.TOKEN_SIGNING_SECRET, "lockstep-enc-v1", 32);

/** AES-256-GCM. Used to encrypt stored GitHub user tokens at rest. */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(".");
}

export function decrypt(blob: string): string {
  const parts = blob.split(".");
  if (parts.length !== 3) throw new Error("bad ciphertext");
  const [ivb, tagb, encb] = parts as [string, string, string];
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivb, "base64"));
  decipher.setAuthTag(Buffer.from(tagb, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encb, "base64")), decipher.final()]).toString("utf8");
}
