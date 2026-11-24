// Short-lived, signed links to a page scan, so a provider (Claude) can fetch
// the image itself instead of the Worker base64-encoding it into the request.
//
// A link is `${PUBLIC_API_URL}/scan/<fileId>?exp=<unix seconds>&sig=<hmac>`.
// The signature covers the file id and the expiry, so a link opens exactly one
// scan and stops working after `exp`. The signing key is derived from
// MASTER_KEY: no extra secret to manage, and rotating the master key revokes
// every outstanding link.

import { Buffer } from "node:buffer";

const KEY_LABEL = "scan-url-v1";

const encoder = new TextEncoder();

// Derived once per isolate: a review batch signs a link for every page.
const signingKeys = new Map<string, Promise<CryptoKey>>();

function signingKey(masterKey: string): Promise<CryptoKey> {
  let key = signingKeys.get(masterKey);
  if (!key) {
    key = deriveSigningKey(masterKey);
    signingKeys.set(masterKey, key);
  }
  return key;
}

async function deriveSigningKey(masterKey: string): Promise<CryptoKey> {
  const master = await crypto.subtle.importKey(
    "raw",
    encoder.encode(masterKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign(
    "HMAC",
    master,
    encoder.encode(KEY_LABEL),
  );
  return crypto.subtle.importKey(
    "raw",
    derived,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

const toBase64Url = (bytes: ArrayBuffer): string =>
  Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const fromBase64Url = (value: string): Uint8Array =>
  new Uint8Array(
    Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
  );

const payload = (fileId: string, expiresAt: number): Uint8Array =>
  encoder.encode(`${fileId}.${expiresAt}`);

export async function signScanUrl({
  baseUrl,
  masterKey,
  fileId,
  expiresAt,
}: {
  baseUrl: string;
  masterKey: string;
  fileId: string;
  // Unix seconds.
  expiresAt: number;
}): Promise<string> {
  const key = await signingKey(masterKey);
  const sig = await crypto.subtle.sign("HMAC", key, payload(fileId, expiresAt));
  const url = new URL(
    `/scan/${encodeURIComponent(fileId)}`,
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  );
  url.searchParams.set("exp", String(expiresAt));
  url.searchParams.set("sig", toBase64Url(sig));
  return url.toString();
}

export async function verifyScanSignature({
  masterKey,
  fileId,
  exp,
  sig,
  nowSeconds,
}: {
  masterKey: string;
  fileId: string;
  exp: string | undefined;
  sig: string | undefined;
  nowSeconds: number;
}): Promise<boolean> {
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  const expiresAt = Number(exp);
  if (expiresAt < nowSeconds) return false;
  const key = await signingKey(masterKey);
  // crypto.subtle.verify compares in constant time.
  return crypto.subtle.verify(
    "HMAC",
    key,
    fromBase64Url(sig),
    payload(fileId, expiresAt),
  );
}
