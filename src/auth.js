// Admin authentication for Lori, Dawn, and Brent.
//
// Accounts are gated by an ADMIN_EMAILS allowlist (dashboard var). Each person
// sets their OWN password via the "claim" flow (email + shared SETUP_CODE), so
// no plaintext password is ever created or handled on the server side beyond
// hashing what the user typed. Sessions are opaque random tokens; the DB stores
// only their SHA-256.

import {
  hashPassword,
  verifyPassword,
  randomToken,
  sha256Hex,
  json,
  parseCookies,
  cookieHeader,
} from './util.js';
import {
  ensureSchema,
  getUserByEmail,
  getUserById,
  insertUser,
  setUserPassword,
  setLastLogin,
  createSession,
  getSession,
  deleteSession,
} from './db.js';

const SESSION_COOKIE = 'phc_session';
// A fixed hash to verify against when the account is missing, so login timing
// does not reveal whether an email exists.
const DUMMY_HASH =
  'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

function allowlist(env) {
  return String(env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowlisted(email, env) {
  return allowlist(env).includes(String(email || '').trim().toLowerCase());
}

function ttlSeconds(env) {
  const days = parseInt(env.SESSION_TTL_DAYS || '30', 10);
  return days * 24 * 60 * 60;
}

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, status: u.status };
}

export async function getCurrentUser(request, env) {
  if (!env.DB) return null;
  const raw = parseCookies(request)[SESSION_COOKIE];
  if (!raw) return null;
  await ensureSchema(env.DB);
  const id = await sha256Hex(raw);
  const session = await getSession(env.DB, id);
  if (!session) return null;
  if (session.expires_at < Date.now()) {
    await deleteSession(env.DB, id);
    return null;
  }
  const user = await getUserById(env.DB, session.user_id);
  if (!user || user.status !== 'active') return null;
  return publicUser(user);
}

export function isAdmin(user, env) {
  return !!user && user.role === 'admin' && isAllowlisted(user.email, env);
}

async function startSession(env, userId) {
  const raw = randomToken(32);
  const id = await sha256Hex(raw);
  const now = Date.now();
  await createSession(env.DB, {
    id,
    user_id: userId,
    created_at: now,
    expires_at: now + ttlSeconds(env) * 1000,
  });
  return raw;
}

export async function handleLogin(request, env) {
  await ensureSchema(env.DB);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const user = await getUserByEmail(env.DB, email);
  // Always run a verify to flatten timing whether or not the user exists.
  const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !user.password_hash || !ok) {
    return json({ error: 'invalid_credentials' }, 401);
  }
  if (user.status !== 'active' || !isAllowlisted(user.email, env)) {
    return json({ error: 'account_disabled' }, 403);
  }
  const raw = await startSession(env, user.id);
  await setLastLogin(env.DB, user.id, Date.now());
  return json({ user: publicUser(user) }, 200, {
    'Set-Cookie': cookieHeader(SESSION_COOKIE, raw, ttlSeconds(env)),
  });
}

export async function handleLogout(request, env) {
  const raw = parseCookies(request)[SESSION_COOKIE];
  if (raw && env.DB) {
    await ensureSchema(env.DB);
    await deleteSession(env.DB, await sha256Hex(raw));
  }
  return json({ ok: true }, 200, {
    'Set-Cookie': cookieHeader(SESSION_COOKIE, '', 0),
  });
}

export async function handleMe(request, env) {
  const user = await getCurrentUser(request, env);
  return json({ user: user && isAdmin(user, env) ? user : null });
}

// First-time password set (and setup-code-gated reset). Email must be on the
// ADMIN_EMAILS allowlist. If SETUP_CODE is configured it is always required
// (and lets an admin reset their own password); if it is not configured, claim
// works only once per account (first-claim-wins).
export async function handleClaim(request, env) {
  await ensureSchema(env.DB);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '');
  const password = String(body.password || '');
  const name = String(body.name || '').trim();

  if (!isAllowlisted(email, env)) return json({ error: 'not_authorized' }, 403);
  if (password.length < 8) return json({ error: 'weak_password' }, 400);

  const setupCode = env.SETUP_CODE ? String(env.SETUP_CODE) : '';
  const existing = await getUserByEmail(env.DB, email);

  if (setupCode) {
    if (code !== setupCode) return json({ error: 'bad_setup_code' }, 403);
  } else if (existing && existing.password_hash) {
    return json({ error: 'already_claimed' }, 409);
  }

  const hash = await hashPassword(password);
  let userId;
  if (existing) {
    userId = existing.id;
    await setUserPassword(env.DB, userId, hash);
    if (name && !existing.name) {
      await env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(name, userId).run();
    }
  } else {
    userId = crypto.randomUUID();
    await insertUser(env.DB, {
      id: userId,
      email,
      password_hash: hash,
      name: name || email.split('@')[0],
      role: 'admin',
      status: 'active',
      created_at: Date.now(),
    });
  }
  const raw = await startSession(env, userId);
  await setLastLogin(env.DB, userId, Date.now());
  const user = await getUserById(env.DB, userId);
  return json({ user: publicUser(user) }, 200, {
    'Set-Cookie': cookieHeader(SESSION_COOKIE, raw, ttlSeconds(env)),
  });
}

// Guard for /api/admin/* endpoints.
export async function requireAdmin(request, env) {
  const user = await getCurrentUser(request, env);
  if (!isAdmin(user, env)) return null;
  return user;
}
