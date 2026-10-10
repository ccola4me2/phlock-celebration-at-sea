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
    `CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      first_name TEXT,
      last_name TEXT,
      email TEXT,
      phone TEXT,
      state TEXT,
      cabin TEXT,
      heard TEXT,
      message TEXT,
      advisor TEXT,
      source TEXT,
      medium TEXT,
      campaign TEXT,
      referrer TEXT,
      landing TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      assigned_to TEXT,
      notes TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status)`,
    `CREATE TABLE IF NOT EXISTS cabins (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      name TEXT,
      res_number TEXT,
      cabin_type TEXT,
      cabin_number TEXT,
      drifter TEXT,
      notes TEXT,
      tc INTEGER NOT NULL DEFAULT 0
    )`,
  ];
  for (const sql of statements) await db.prepare(sql).run();
  // Additive migrations for tables that may already exist (ADD COLUMN fails
  // harmlessly if the column is already there).
  const migrations = [
    'ALTER TABLE cabins ADD COLUMN tc INTEGER NOT NULL DEFAULT 0',
    // Drip campaign state on leads (see drip.js).
    'ALTER TABLE leads ADD COLUMN drip_status TEXT',
    'ALTER TABLE leads ADD COLUMN drip_stage INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE leads ADD COLUMN drip_next_at INTEGER',
    'ALTER TABLE leads ADD COLUMN drip_started_at INTEGER',
    'ALTER TABLE leads ADD COLUMN drip_last_sent_at INTEGER',
    'ALTER TABLE leads ADD COLUMN unsub_token TEXT',
    'ALTER TABLE leads ADD COLUMN unsubscribed_at INTEGER',
    // Indexes on columns added above must run after the ALTERs.
    'CREATE INDEX IF NOT EXISTS idx_leads_drip ON leads(drip_status, drip_next_at)',
    'CREATE INDEX IF NOT EXISTS idx_leads_unsub ON leads(unsub_token)',
    // Cabin availability: 'booked' (has guests) or 'available' (open to sell).
    "ALTER TABLE cabins ADD COLUMN status TEXT NOT NULL DEFAULT 'booked'",
  ];
  for (const sql of migrations) {
    try {
      await db.prepare(sql).run();
    } catch (e) {
      /* column already exists */
    }
  }
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

// ---- leads ----
export function insertLead(db, l) {
  return db
    .prepare(
      `INSERT INTO leads
       (id, created_at, first_name, last_name, email, phone, state, cabin, heard, message,
        advisor, source, medium, campaign, referrer, landing, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      l.id, l.created_at, l.first_name, l.last_name, l.email, l.phone, l.state, l.cabin, l.heard,
      l.message, l.advisor, l.source, l.medium, l.campaign, l.referrer, l.landing, l.status || 'new'
    )
    .run();
}

export function getLead(db, id) {
  return db.prepare('SELECT * FROM leads WHERE id = ?').bind(id).first();
}

export async function listLeads(db, opts = {}) {
  const where = [];
  const args = [];
  if (opts.status) { where.push('status = ?'); args.push(opts.status); }
  if (opts.advisor) { where.push('advisor = ?'); args.push(opts.advisor); }
  if (opts.from != null) { where.push('created_at >= ?'); args.push(opts.from); }
  if (opts.to != null) { where.push('created_at <= ?'); args.push(opts.to); }
  if (opts.q) {
    where.push('(first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR phone LIKE ?)');
    const like = '%' + opts.q + '%';
    args.push(like, like, like, like);
  }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(opts.limit || 1000, 5000);
  const rows = await db
    .prepare(`SELECT * FROM leads ${clause} ORDER BY created_at DESC LIMIT ${limit}`)
    .bind(...args)
    .all();
  return rows.results || [];
}

export function deleteLead(db, id) {
  return db.prepare('DELETE FROM leads WHERE id = ?').bind(id).run();
}

// ---- leads: drip campaign state ----
const DRIP_FIELDS = [
  'drip_status',
  'drip_stage',
  'drip_next_at',
  'drip_started_at',
  'drip_last_sent_at',
  'unsub_token',
  'unsubscribed_at',
];

export function updateDrip(db, id, fields) {
  const cols = [];
  const args = [];
  for (const k of DRIP_FIELDS) {
    if (fields[k] !== undefined) { cols.push(`${k} = ?`); args.push(fields[k]); }
  }
  if (!cols.length) return null;
  args.push(id);
  return db.prepare(`UPDATE leads SET ${cols.join(', ')} WHERE id = ?`).bind(...args).run();
}

export function getLeadByUnsubToken(db, token) {
  return db.prepare('SELECT * FROM leads WHERE unsub_token = ?').bind(token).first();
}

// Contacted/Quoted leads with an email that have never entered the sequence.
export async function listDripEnrollable(db) {
  const rows = await db
    .prepare(
      `SELECT * FROM leads
       WHERE status IN ('contacted', 'quoted') AND drip_status IS NULL
         AND email IS NOT NULL AND email <> '' LIMIT 500`
    )
    .all();
  return rows.results || [];
}

export async function listDripDue(db, now, limit = 50) {
  const rows = await db
    .prepare(
      `SELECT * FROM leads
       WHERE drip_status = 'active' AND drip_next_at IS NOT NULL AND drip_next_at <= ?
       ORDER BY drip_next_at ASC LIMIT ?`
    )
    .bind(now, limit)
    .all();
  return rows.results || [];
}

// ---- cabins ----
const CABIN_FIELDS = ['name', 'res_number', 'cabin_type', 'cabin_number', 'drifter', 'notes', 'tc', 'status'];

export function insertCabin(db, c) {
  return db
    .prepare(
      `INSERT INTO cabins (id, created_at, name, res_number, cabin_type, cabin_number, drifter, notes, tc, status)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(c.id, c.created_at, c.name, c.res_number, c.cabin_type, c.cabin_number, c.drifter, c.notes, c.tc || 0, c.status || 'booked')
    .run();
}

export async function listCabins(db, opts = {}) {
  const where = [];
  const args = [];
  if (opts.drifter) { where.push('drifter = ?'); args.push(opts.drifter); }
  if (opts.cabin_type) { where.push('cabin_type = ?'); args.push(opts.cabin_type); }
  if (opts.status) { where.push('status = ?'); args.push(opts.status); }
  if (opts.q) {
    where.push('(name LIKE ? OR res_number LIKE ? OR cabin_number LIKE ? OR notes LIKE ?)');
    const like = '%' + opts.q + '%';
    args.push(like, like, like, like);
  }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = await db
    .prepare(
      `SELECT * FROM cabins ${clause}
       ORDER BY (cabin_number IS NULL OR cabin_number = '') ASC, cabin_number ASC LIMIT 2000`
    )
    .bind(...args)
    .all();
  return rows.results || [];
}

export function updateCabin(db, id, fields) {
  const cols = [];
  const args = [];
  for (const k of CABIN_FIELDS) {
    if (fields[k] !== undefined) { cols.push(`${k} = ?`); args.push(fields[k]); }
  }
  if (!cols.length) return null;
  cols.push('updated_at = ?');
  args.push(Date.now(), id);
  return db.prepare(`UPDATE cabins SET ${cols.join(', ')} WHERE id = ?`).bind(...args).run();
}

// Cabin numbers already on the manifest (used by import to skip duplicates).
export async function listCabinNumbers(db) {
  const rows = await db
    .prepare(`SELECT cabin_number FROM cabins WHERE cabin_number IS NOT NULL AND cabin_number <> ''`)
    .all();
  return (rows.results || []).map((r) => String(r.cabin_number).trim());
}

export function deleteCabin(db, id) {
  return db.prepare('DELETE FROM cabins WHERE id = ?').bind(id).run();
}

export function updateLead(db, id, fields) {
  const cols = [];
  const args = [];
  for (const k of ['status', 'assigned_to', 'notes']) {
    if (fields[k] !== undefined) { cols.push(`${k} = ?`); args.push(fields[k]); }
  }
  if (!cols.length) return null;
  cols.push('updated_at = ?');
  args.push(Date.now(), id);
  return db.prepare(`UPDATE leads SET ${cols.join(', ')} WHERE id = ?`).bind(...args).run();
}
