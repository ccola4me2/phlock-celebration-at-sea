// D1 access + lazy schema bootstrap.
// The schema is created on demand (CREATE TABLE IF NOT EXISTS) the first time
// the DB is touched in an isolate, so there is no separate migration step to
// run. Public/static requests never call this, so a DB hiccup can't take the
// marketing site down.

let schemaReady = false;

export async function ensureSchema(db) {
  if (schemaReady) return;
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      name TEXT,
      role TEXT NOT NULL DEFAULT 'admin',
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      last_login_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
    `CREATE TABLE IF NOT EXISTS visits (
      id TEXT PRIMARY KEY,
      advisor TEXT,
      source TEXT,
      medium TEXT,
      campaign TEXT,
      content TEXT,
      landing TEXT,
      referrer TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_visits_created ON visits(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_visits_advisor ON visits(advisor)`,
    `CREATE TABLE IF NOT EXISTS conversions (
      id TEXT PRIMARY KEY,
      advisor TEXT,
      source TEXT,
      medium TEXT,
      campaign TEXT,
      content TEXT,
      landing TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_conversions_created ON conversions(created_at)`,
  ];
  for (const sql of statements) await db.prepare(sql).run();
  schemaReady = true;
}

// ---- users ----
export function getUserByEmail(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
}

export function getUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
}

export function insertUser(db, u) {
  return db
    .prepare(
      'INSERT INTO users (id, email, password_hash, name, role, status, created_at) VALUES (?,?,?,?,?,?,?)'
    )
    .bind(u.id, u.email, u.password_hash, u.name, u.role || 'admin', u.status || 'active', u.created_at)
    .run();
}

export function setUserPassword(db, userId, hash) {
  return db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, userId).run();
}

export function setLastLogin(db, userId, ts) {
  return db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(ts, userId).run();
}

// ---- sessions ----
export function createSession(db, s) {
  return db
    .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .bind(s.id, s.user_id, s.created_at, s.expires_at)
    .run();
}

export function getSession(db, id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first();
}

export function deleteSession(db, id) {
  return db.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
}

export function deleteUserSessions(db, userId) {
  return db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
}

// ---- tracking ----
export function insertVisit(db, v) {
  return db
    .prepare(
      'INSERT INTO visits (id, advisor, source, medium, campaign, content, landing, referrer, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .bind(v.id, v.advisor, v.source, v.medium, v.campaign, v.content, v.landing, v.referrer, v.created_at)
    .run();
}

export function insertConversion(db, c) {
  return db
    .prepare(
      'INSERT INTO conversions (id, advisor, source, medium, campaign, content, landing, created_at) VALUES (?,?,?,?,?,?,?,?)'
    )
    .bind(c.id, c.advisor, c.source, c.medium, c.campaign, c.content, c.landing, c.created_at)
    .run();
}
