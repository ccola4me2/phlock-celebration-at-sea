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
    `CREATE TABLE IF NOT EXISTS short_links (
      code TEXT PRIMARY KEY,
      target TEXT NOT NULL,
      page TEXT,
      advisor TEXT,
      source TEXT,
      medium TEXT,
      campaign TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      clicks INTEGER NOT NULL DEFAULT 0,
      last_click_at INTEGER
    )`,
    // Drifters Lounge: private content for booked guests (see lounge.js).
    `CREATE TABLE IF NOT EXISTS lounge_posts (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      title TEXT NOT NULL,
      body TEXT,
      post_date TEXT,
      published INTEGER NOT NULL DEFAULT 1
    )`,
    `CREATE TABLE IF NOT EXISTS lounge_events (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      day TEXT NOT NULL,
      start_time TEXT,
      title TEXT NOT NULL,
      detail TEXT,
      day_label TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS lounge_dates (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      due_date TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS lounge_links (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      title TEXT NOT NULL,
      note TEXT,
      url TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS lounge_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS lounge_subscribers (
      id TEXT PRIMARY KEY,
      cabin_id TEXT NOT NULL,
      email TEXT NOT NULL,
      token TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_lounge_subs_cabin_email ON lounge_subscribers(cabin_id, email)`,
    `CREATE INDEX IF NOT EXISTS idx_lounge_subs_token ON lounge_subscribers(token)`,
    `CREATE TABLE IF NOT EXISTS lounge_pirates (
      id TEXT PRIMARY KEY,
      cabin_id TEXT NOT NULL,
      first_name TEXT NOT NULL,
      first_lower TEXT NOT NULL,
      pirate_name TEXT NOT NULL,
      duty TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_lounge_pirates_cabin_name ON lounge_pirates(cabin_id, first_lower)`,
    `CREATE TABLE IF NOT EXISTS lounge_signins (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      name_entered TEXT,
      res_entered TEXT,
      ua TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS drifter_sessions (
      id TEXT PRIMARY KEY,
      cabin_id TEXT NOT NULL,
      guest_name TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
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
    // Dive Bar posts remember when they were emailed to subscribers.
    'ALTER TABLE lounge_posts ADD COLUMN emailed_at INTEGER',
    'ALTER TABLE lounge_posts ADD COLUMN image_url TEXT',
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
    .prepare(`SELECT leads.*,
        (SELECT COALESCE(c.cabin_number || ' · ', '') || COALESCE(c.name, '') FROM cabins c WHERE leads.campaign = 'ref-' || c.id) AS referred_by
      FROM leads ${clause} ORDER BY created_at DESC LIMIT ${limit}`)
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

// Apply the same field changes to every cabin whose number is in `numbers`.
// Returns how many rows changed and which numbers matched nothing.
export async function updateCabinsByNumber(db, numbers, fields) {
  const cols = [];
  const args = [];
  for (const k of CABIN_FIELDS) {
    if (fields[k] !== undefined) { cols.push(`${k} = ?`); args.push(fields[k]); }
  }
  if (!cols.length) return { updated: 0, notFound: numbers };
  cols.push('updated_at = ?');
  args.push(Date.now());
  const stmt = db.prepare(`UPDATE cabins SET ${cols.join(', ')} WHERE TRIM(cabin_number) = ?`);
  let updated = 0;
  const notFound = [];
  for (const n of numbers) {
    const r = await stmt.bind(...args, n).run();
    const changed = (r.meta && r.meta.changes) || 0;
    if (changed) updated += changed;
    else notFound.push(n);
  }
  return { updated, notFound };
}

// Rename a cabin type across the whole manifest. Returns rows changed.
export async function renameCabinType(db, from, to) {
  const r = await db
    .prepare('UPDATE cabins SET cabin_type = ?, updated_at = ? WHERE cabin_type = ?')
    .bind(to, Date.now(), from)
    .run();
  return (r.meta && r.meta.changes) || 0;
}

// Flip every cabin that has no guests (blank name) to the given status.
// Returns how many rows changed. Cabins with a name are never touched.
export async function setStatusForUnnamed(db, status) {
  const r = await db
    .prepare(
      `UPDATE cabins SET status = ?, updated_at = ?
       WHERE (name IS NULL OR TRIM(name) = '') AND status <> ?`
    )
    .bind(status, Date.now(), status)
    .run();
  return (r.meta && r.meta.changes) || 0;
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

// ---- short links (parrotheadscruise.com/go/<code>) ----
export function getShortLink(db, code) {
  return db.prepare('SELECT * FROM short_links WHERE code = ?').bind(code).first();
}

export function insertShortLink(db, l) {
  return db
    .prepare(
      `INSERT INTO short_links (code, target, page, advisor, source, medium, campaign, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .bind(l.code, l.target, l.page, l.advisor, l.source, l.medium, l.campaign, l.created_by, l.created_at)
    .run();
}

export async function listShortLinks(db) {
  const rows = await db.prepare('SELECT * FROM short_links ORDER BY created_at DESC LIMIT 500').all();
  return rows.results || [];
}

// ---- pirate names (Parrots & Pirates) ----
/** Save a christening; the same first name in the same cabin just refreshes its time. */
export function upsertPirate(db, p) {
  return db
    .prepare(
      `INSERT INTO lounge_pirates (id, cabin_id, first_name, first_lower, pirate_name, duty, created_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(cabin_id, first_lower) DO UPDATE SET pirate_name = excluded.pirate_name, duty = excluded.duty, created_at = excluded.created_at`
    )
    .bind(p.id, p.cabin_id, p.first_name, p.first_lower, p.pirate_name, p.duty || '', p.created_at)
    .run();
}

/** The most recently christened, with their cabin numbers. */
export async function listPirates(db, limit = 8) {
  const rows = await db
    .prepare(
      `SELECT p.pirate_name, p.duty, p.created_at, c.cabin_number
       FROM lounge_pirates p JOIN cabins c ON c.id = p.cabin_id
       ORDER BY p.created_at DESC LIMIT ?`
    )
    .bind(Math.max(1, Math.min(50, limit)))
    .all();
  return rows.results || [];
}

export async function countPirates(db) {
  // Only names whose cabin still exists, the same rows the Dive Bar shows.
  const r = await db.prepare('SELECT COUNT(*) AS n FROM lounge_pirates p JOIN cabins c ON c.id = p.cabin_id').first();
  return (r && r.n) || 0;
}

// ---- cabin referral links (Bring a friend) ----
// Every booked cabin gets one short link, parrotheadscruise.com/go/<lastname>-<cabin>, whose
// target tags the visit utm_source=drifters, utm_medium=referral, utm_campaign=ref-<cabin id>.
// A lead that arrives through it carries that campaign, which is how the board counts it.
export function referralCampaign(cabinId) {
  return 'ref-' + String(cabinId || '');
}

function referralCodeFor(cabin) {
  const words = String(cabin.name || '').replace(/\(.*?\)/g, ' ').split(/[^A-Za-z]+/).filter((w) => w.length > 1 && !/^(and|tbd|cabin|nd|rd|th|st)$/i.test(w));
  const last = (words[words.length - 1] || 'drifter').toLowerCase();
  const no = String(cabin.cabin_number || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return (last + '-' + (no || String(cabin.id || '').slice(0, 4))).slice(0, 40);
}

export async function getReferralLink(db, cabinId) {
  return db.prepare("SELECT * FROM short_links WHERE medium = 'referral' AND campaign = ?").bind(referralCampaign(cabinId)).first();
}

/** The cabin's referral link, made on first sight. The code steps to -2, -3 if another cabin already holds it. */
export async function ensureReferralLink(db, cabin, now) {
  const found = await getReferralLink(db, cabin.id);
  if (found) return found;
  const campaign = referralCampaign(cabin.id);
  const target = '/?utm_source=drifters&utm_medium=referral&utm_campaign=' + encodeURIComponent(campaign);
  const base = referralCodeFor(cabin);
  for (let n = 1; n <= 9; n++) {
    const code = n === 1 ? base : `${base.slice(0, 37)}-${n}`;
    try {
      await insertShortLink(db, { code, target, page: '/', advisor: '', source: 'drifters', medium: 'referral', campaign, created_by: 'dive-bar', created_at: now || Date.now() });
      return getShortLink(db, code);
    } catch {
      /* code taken: try the next */
    }
  }
  return null;
}

/** Every cabin with a referral link, with its clicks and the leads that came through it. */
export async function listReferralBoard(db) {
  const rows = await db
    .prepare(
      `SELECT c.id AS cabin_id, c.name, c.cabin_number, s.code, s.clicks, s.created_at,
              (SELECT COUNT(*) FROM leads l WHERE l.campaign = s.campaign) AS signups,
              (SELECT COUNT(*) FROM leads l WHERE l.campaign = s.campaign AND l.status = 'booked') AS booked
       FROM short_links s JOIN cabins c ON s.campaign = 'ref-' || c.id
       WHERE s.medium = 'referral'
       ORDER BY booked DESC, signups DESC, s.clicks DESC, c.name ASC
       LIMIT 500`
    )
    .all();
  return rows.results || [];
}

export function deleteShortLink(db, code) {
  return db.prepare('DELETE FROM short_links WHERE code = ?').bind(code).run();
}

export function bumpShortLink(db, code, ts) {
  return db
    .prepare('UPDATE short_links SET clicks = clicks + 1, last_click_at = ? WHERE code = ?')
    .bind(ts, code)
    .run();
}

// ---- Drifters Lounge content (one generic CRUD over four small tables) ----
export const LOUNGE_TYPES = {
  posts: { table: 'lounge_posts', cols: ['title', 'body', 'post_date', 'published', 'image_url'], order: 'post_date DESC, created_at DESC' },
  events: { table: 'lounge_events', cols: ['day', 'start_time', 'title', 'detail', 'day_label'], order: 'day ASC, start_time ASC, created_at ASC' },
  dates: { table: 'lounge_dates', cols: ['due_date', 'title', 'detail'], order: 'due_date ASC, created_at ASC' },
  links: { table: 'lounge_links', cols: ['title', 'note', 'url', 'sort_order'], order: 'sort_order ASC, created_at ASC' },
};

export async function listLounge(db, type) {
  const t = LOUNGE_TYPES[type];
  const rows = await db.prepare(`SELECT * FROM ${t.table} ORDER BY ${t.order} LIMIT 500`).all();
  return rows.results || [];
}

export function getLoungeRow(db, type, id) {
  const t = LOUNGE_TYPES[type];
  return db.prepare(`SELECT * FROM ${t.table} WHERE id = ?`).bind(id).first();
}

// row.id present = update (only the columns sent); absent = insert.
export async function saveLounge(db, type, row) {
  const t = LOUNGE_TYPES[type];
  const now = Date.now();
  if (row.id) {
    const cols = [];
    const args = [];
    for (const k of t.cols) {
      if (row[k] !== undefined) { cols.push(`${k} = ?`); args.push(row[k]); }
    }
    if (!cols.length) return row.id;
    cols.push('updated_at = ?');
    args.push(now, row.id);
    await db.prepare(`UPDATE ${t.table} SET ${cols.join(', ')} WHERE id = ?`).bind(...args).run();
    return row.id;
  }
  const id = crypto.randomUUID();
  const cols = ['id', 'created_at'].concat(t.cols.filter((k) => row[k] !== undefined));
  const vals = [id, now].concat(t.cols.filter((k) => row[k] !== undefined).map((k) => row[k]));
  await db
    .prepare(`INSERT INTO ${t.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`)
    .bind(...vals)
    .run();
  return id;
}

export function deleteLounge(db, type, id) {
  const t = LOUNGE_TYPES[type];
  return db.prepare(`DELETE FROM ${t.table} WHERE id = ?`).bind(id).run();
}

export async function getLoungeSettings(db) {
  const rows = await db.prepare('SELECT key, value FROM lounge_settings').all();
  const out = {};
  for (const r of rows.results || []) out[r.key] = r.value;
  return out;
}

export function setLoungeSetting(db, key, value) {
  return db.prepare('INSERT OR REPLACE INTO lounge_settings (key, value) VALUES (?, ?)').bind(key, value).run();
}

// ---- Drifter (guest) sessions ----
export function createDrifterSession(db, s) {
  return db
    .prepare('INSERT INTO drifter_sessions (id, cabin_id, guest_name, created_at, expires_at) VALUES (?,?,?,?,?)')
    .bind(s.id, s.cabin_id, s.guest_name, s.created_at, s.expires_at)
    .run();
}

export function getDrifterSession(db, id) {
  return db.prepare('SELECT * FROM drifter_sessions WHERE id = ?').bind(id).first();
}

export function deleteDrifterSession(db, id) {
  return db.prepare('DELETE FROM drifter_sessions WHERE id = ?').bind(id).run();
}

// A booked cabin whose reservation number matches and whose name contains the
// last name (case-insensitive). Available (unsold) cabins never match.
export function findCabinForSignIn(db, resNumber, lastNameLower) {
  return db
    .prepare(
      `SELECT * FROM cabins
       WHERE TRIM(res_number) = ? AND status <> 'available'
         AND lower(name) LIKE '%' || ? || '%' LIMIT 1`
    )
    .bind(resNumber, lastNameLower)
    .first();
}

// ---- Dive Bar sign-in attempts (for diagnosing "it won't let me in") ----
export function insertLoungeSignin(db, s) {
  return db
    .prepare('INSERT INTO lounge_signins (id, created_at, outcome, name_entered, res_entered, ua) VALUES (?,?,?,?,?,?)')
    .bind(s.id, s.created_at, s.outcome, s.name_entered, s.res_entered, s.ua)
    .run();
}

export async function listLoungeSignins(db, limit = 100) {
  const rows = await db.prepare('SELECT * FROM lounge_signins ORDER BY created_at DESC LIMIT ?').bind(limit).all();
  return rows.results || [];
}

export function getCabin(db, id) {
  return db.prepare('SELECT * FROM cabins WHERE id = ?').bind(id).first();
}

// ---- Dive Bar email subscribers (opt-in, per cabin) ----
export function insertSubscriber(db, s) {
  return db
    .prepare('INSERT OR IGNORE INTO lounge_subscribers (id, cabin_id, email, token, created_at) VALUES (?,?,?,?,?)')
    .bind(s.id, s.cabin_id, s.email, s.token, s.created_at)
    .run();
}

export async function listSubscribersForCabin(db, cabinId) {
  const rows = await db.prepare('SELECT * FROM lounge_subscribers WHERE cabin_id = ? ORDER BY created_at ASC').bind(cabinId).all();
  return rows.results || [];
}

export async function listSubscribers(db) {
  const rows = await db
    .prepare(
      `SELECT s.*, c.name AS cabin_name, c.cabin_number
       FROM lounge_subscribers s LEFT JOIN cabins c ON c.id = s.cabin_id
       ORDER BY s.created_at DESC LIMIT 2000`
    )
    .all();
  return rows.results || [];
}

export function deleteSubscriberByToken(db, token) {
  return db.prepare('DELETE FROM lounge_subscribers WHERE token = ?').bind(token).run();
}

export function setPostEmailed(db, id, ts) {
  return db.prepare('UPDATE lounge_posts SET emailed_at = ? WHERE id = ?').bind(ts, id).run();
}
