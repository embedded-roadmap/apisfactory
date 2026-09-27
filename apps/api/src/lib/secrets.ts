import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "./errors";

/**
 * Bağlayıcı erişim bilgileri (entegratör kullanıcı/parola, API anahtarı) için simetrik şifreleme.
 * AES-256-GCM; anahtar CONNECTOR_SECRET_KEY ortam değişkeninden (32 bayt, base64 veya 64 hane hex).
 * Saklama biçimi: "v1:" + base64(iv[12] | tag[16] | şifreli metin). Anahtar tanımlı değilse sunucu açılır,
 * yalnız erişim bilgisi kaydetme/kullanma istekleri açık bir hatayla reddedilir.
 */

function key(): Buffer {
  const raw = process.env.CONNECTOR_SECRET_KEY;
  if (!raw) throw new AppError(503, "secret_key_missing", "CONNECTOR_SECRET_KEY tanımlı değil; bağlayıcı erişim bilgisi saklanamaz");
  const k = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (k.length !== 32) throw new AppError(503, "secret_key_invalid", "CONNECTOR_SECRET_KEY 32 bayt olmalı (base64 veya 64 hane hex)");
  return k;
}

export function encryptSecret(plain: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(JSON.stringify(plain), "utf8"), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), body]).toString("base64")}`;
}

export function decryptSecret<T = unknown>(stored: string): T {
  if (!stored.startsWith("v1:")) throw new Error("Tanınmayan şifreli erişim bilgisi biçimi");
  const buf = Buffer.from(stored.slice(3), "base64");
  const d = createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8")) as T;
}
