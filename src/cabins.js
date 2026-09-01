// Cabin assignment manifest — admin-only CRM (source of truth, replaces the
// Google Doc). List/save/delete plus a bulk paste-import.

import { requireAdmin } from './auth.js';
import { ensureSchema, insertCabin, listCabins, updateCabin, deleteCabin } from './db.js';
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

function cabinFromBody(b) {
  return {
    name: clip(b.name, 200),
    res_number: clip(b.res_number, 40),
    cabin_type: clip(b.cabin_type, 60),
    cabin_number: clip(b.cabin_number, 20),
    drifter: normDrifter(b.drifter),
    notes: clip(b.notes, 2000),
  };
}

export async function handleListCabins(request, env, url) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'unauthorized' }, 401);
  await ensureSchema(env.DB);
  const q = url.searchParams;
  const cabins = await listCabins(env.DB, {
    drifter: q.get('drifter') || undefined,
    cabin_type: q.get('cabin_type') || undefined,
    q: q.get('q') ? clip(q.get('q'), 80) : undefined,
  });
  if (q.get('format') === 'csv') {
    const cols = ['cabin_number', 'cabin_type', 'name', 'res_number', 'drifter', 'notes'];
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
  const fields = cabinFromBody(body);
  const id = clip(body.id, 60);
  if (id) {
    await updateCabin(env.DB, id, fields);
    return json({ ok: true, id });
  }
  const newId = crypto.randomUUID();
  await insertCabin(env.DB, Object.assign({ id: newId, created_at: Date.now() }, fields));
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

// Bulk import: { rows: [{name,res_number,cabin_type,cabin_number,drifter,notes}], replace?:bool }
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
  let added = 0;
  for (const r of rows) {
    const f = cabinFromBody(r);
    if (!f.name && !f.cabin_number && !f.res_number) continue; // skip blank rows
    await insertCabin(env.DB, Object.assign({ id: crypto.randomUUID(), created_at: Date.now() }, f));
    added++;
  }
  return json({ ok: true, added });
}
