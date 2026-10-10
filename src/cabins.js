// Cabin assignment manifest — admin-only CRM (source of truth, replaces the
// Google Doc). List/save/delete plus a bulk paste-import.

import { requireAdmin } from './auth.js';
import { ensureSchema, insertCabin, listCabins, listCabinNumbers, updateCabin, updateCabinsByNumber, deleteCabin, setStatusForUnnamed } from './db.js';
import { json } from './util.js';

function clip(s, n) {
  return String(s == null ? '' : s).trim().slice(0, n);
}

function normDrifter(v) {
  const s = String(v || '').toLowerCase();
  if (s.startsWith('new')) return 'New';
  if (s.startsWith('current')) return 'Current';
  return clip(v, 20);
}

// 'available' = open inventory we can sell; anything else is 'booked'.
function normStatus(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s.startsWith('avail') || s === 'open' ? 'available' : 'booked';
}

function truthy(v) {
  if (v === true || v === 1) return 1;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === '1' || s === 'x' || s === 'y' || s === 'yes' || s === 'true' || s === 'tc' ? 1 : 0;
}

// Defaults for a brand-new cabin row.
const CABIN_DEFAULTS = { name: '', res_number: '', cabin_type: '', cabin_number: '', drifter: '', notes: '', tc: 0, status: 'booked' };

// partial=true: only fields present in the body are returned, so an update
// that sends {id, status} leaves name/notes/etc. alone instead of blanking them.
function cabinFromBody(b, partial = false) {
  const has = (k) => !partial || b[k] !== undefined;
  const f = {};
  if (has('name')) f.name = clip(b.name, 200);
  if (has('res_number')) f.res_number = clip(b.res_number, 40);
  if (has('cabin_type')) f.cabin_type = clip(b.cabin_type, 60);
  if (has('cabin_number')) f.cabin_number = clip(b.cabin_number, 20);
  if (has('drifter')) f.drifter = normDrifter(b.drifter);
  if (has('notes')) f.notes = clip(b.notes, 2000);
  if (has('tc')) f.tc = truthy(b.tc);
  // Status only when the caller sent one (never reset it by accident).
  if (b.status !== undefined) f.status = normStatus(b.status);
  return f;
}

export async function handleListCabins(request, env, url) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'unauthorized' }, 401);
  await ensureSchema(env.DB);
  const q = url.searchParams;
  const cabins = await listCabins(env.DB, {
    drifter: q.get('drifter') || undefined,
    cabin_type: q.get('cabin_type') || undefined,
    status: q.get('status') || undefined,
    q: q.get('q') ? clip(q.get('q'), 80) : undefined,
  });
  if (q.get('format') === 'csv') {
    const cols = ['cabin_number', 'cabin_type', 'status', 'name', 'res_number', 'drifter', 'notes'];
    const esc = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [cols.join(',')];
    for (const c of cabins) lines.push(cols.map((k) => esc(c[k])).join(','));
    return new Response(lines.join('\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="cabins.csv"',
        'Cache-Control': 'no-store',
      },
    });
  }
  return json({ cabins });
}

export async function handleSaveCabin(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'unauthorized' }, 401);
  await ensureSchema(env.DB);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  const id = clip(body.id, 60);
  if (id) {
    await updateCabin(env.DB, id, cabinFromBody(body, true));
    return json({ ok: true, id });
  }
  const newId = crypto.randomUUID();
  await insertCabin(
    env.DB,
    Object.assign({ id: newId, created_at: Date.now() }, CABIN_DEFAULTS, cabinFromBody(body))
  );
  return json({ ok: true, id: newId });
}

export async function handleDeleteCabin(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'unauthorized' }, 401);
  await ensureSchema(env.DB);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  const id = clip(body.id, 60);
  if (!id) return json({ error: 'missing_id' }, 400);
  await deleteCabin(env.DB, id);
  return json({ ok: true });
}

// Bulk repair: { status: 'available'|'booked', only: 'unnamed' }
// Marks every cabin with no guests (blank name). Booked cabins with names are
// never touched, so this is safe to run after an import done with the wrong status.
export async function handleBulkCabinStatus(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'unauthorized' }, 401);
  await ensureSchema(env.DB);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  if (body.only !== 'unnamed') return json({ error: 'bad_scope' }, 400);
  const updated = await setStatusForUnnamed(env.DB, normStatus(body.status));
  return json({ ok: true, updated });
}

// Bulk update by cabin number:
//   { cabin_numbers: ['7368', ...], cabin_type?, status?, notes?, drifter? }
// Only the fields sent are changed. Names, reservation numbers, cabin numbers
// and the TC flag are deliberately not editable here.
export async function handleBulkUpdateCabins(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'unauthorized' }, 401);
  await ensureSchema(env.DB);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  const nums = Array.isArray(body.cabin_numbers)
    ? [...new Set(body.cabin_numbers.map((n) => clip(n, 20)).filter(Boolean))]
    : [];
  if (!nums.length) return json({ error: 'no_numbers' }, 400);
  if (nums.length > 500) return json({ error: 'too_many' }, 400);
  const f = cabinFromBody(body, true);
  delete f.name;
  delete f.res_number;
  delete f.cabin_number;
  delete f.tc;
  if (!Object.keys(f).length) return json({ error: 'no_fields' }, 400);
  const r = await updateCabinsByNumber(env.DB, nums, f);
  return json({ ok: true, updated: r.updated, not_found: r.notFound });
}

export async function handleClearCabins(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'unauthorized' }, 401);
  await ensureSchema(env.DB);
  await env.DB.prepare('DELETE FROM cabins').run();
  return json({ ok: true });
}

// Bulk import: { rows: [{name,res_number,cabin_type,cabin_number,drifter,notes}],
//   replace?: bool          wipe the list first
//   status?: 'booked'|'available'   applied to every imported row (default booked)
//   skipExisting?: bool     skip rows whose cabin # is already on the list, so
//                           loading open inventory never overwrites a booking
export async function handleImportCabins(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'unauthorized' }, 401);
  await ensureSchema(env.DB);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return json({ error: 'no_rows' }, 400);
  if (rows.length > 500) return json({ error: 'too_many' }, 400);
  if (body.replace) {
    await env.DB.prepare('DELETE FROM cabins').run();
  }
  const status = normStatus(body.status);
  const existing = new Set(body.skipExisting && !body.replace ? await listCabinNumbers(env.DB) : []);
  let added = 0;
  let skipped = 0;
  for (const r of rows) {
    const f = cabinFromBody(r);
    if (!f.name && !f.cabin_number && !f.res_number) continue; // skip blank rows
    if (f.cabin_number && existing.has(f.cabin_number)) {
      skipped++;
      continue;
    }
    f.status = status;
    await insertCabin(env.DB, Object.assign({ id: crypto.randomUUID(), created_at: Date.now() }, CABIN_DEFAULTS, f));
    if (f.cabin_number) existing.add(f.cabin_number);
    added++;
  }
  return json({ ok: true, added, skipped });
}
