// Small crypto + HTTP helpers for the admin backend.
// Password hashing and session tokens mirror the CruiseShoppers scheme:
// PBKDF2-HMAC-SHA256 (100k iterations) for passwords; opaque random session
// tokens whose SHA-256 is the server-side session id.

const PBKDF2_ITERATIONS = 100000;

const enc = new TextEncoder();

function bytesToB64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function deriveBits(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      key,
      256
    )
  );
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToB64(salt)}$${bytesToB64(bits)}`;
}

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('pbkdf2$')) return false;
  const [, iterStr, saltB64, hashB64] = stored.split('$');
  const iterations = parseInt(iterStr, 10);
  const salt = b64ToBytes(saltB64);
  const bits = await deriveBits(password, salt, iterations);
  return timingSafeEqual(bytesToB64(bits), hashB64);
}

export function randomToken(bytes = 32) {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(str) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return bytesToHex(new Uint8Array(digest));
}

export function json(obj, status = 200, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      extraHeaders || {}
    ),
  });
}

export function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookieHeader(name, value, maxAgeSeconds) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ];
  if (typeof maxAgeSeconds === 'number') parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}
