// Native lead capture + in-house CRM endpoints (replaces the GHL form).
// Public: POST /api/lead (save + attribute + email alert).
// Admin: GET /api/admin/leads (list/CSV), POST /api/admin/leads/update.

import { requireAdmin } from './auth.js';
import { ensureSchema, insertLead, listLeads, updateLead, deleteLead, insertConversion } from './db.js';
import { json, parseCookies } from './util.js';

const ATTR_COOKIE = 'phc_attr';
const VALID_STATUS = ['new', 'contacted', 'quoted', 'booked', 'lost'];

function clip(s, n) {
  return String(s == null ? '' : s).trim().slice(0, n);
}

function readAttr(request) {
  try {
    return JSON.parse(parseCookies(request)[ATTR_COOKIE] || '{}');
  } catch {
    return {};
  }
}

// ---- public: capture a lead ----
export async function handleCreateLead(request, env, ctx) {
  if (!env.DB) return json({ error: 'unavailable' }, 503);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }

  // Honeypot: bots fill hidden fields. Pretend success, save nothing.
  if (clip(body.company, 100) || clip(body.website, 100)) return json({ ok: true });

  const email = clip(body.email, 160);
  const phone = clip(body.phone, 40);
  const first = clip(body.first_name, 80);
  if (!first || (!email && !phone)) {
    return json({ error: 'missing_fields' }, 400);
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: 'bad_email' }, 400);
  }

  await ensureSchema(env.DB);
  const attr = readAttr(request);
  const id = crypto.randomUUID();
  const now = Date.now();
  const lead = {
    id,
    created_at: now,
    first_name: first,
    last_name: clip(body.last_name, 80),
    email,
    phone,
    state: clip(body.state, 60),
    cabin: clip(body.cabin, 120),
    heard: clip(body.heard, 160),
    message: clip(body.message, 4000),
    advisor: clip(attr.advisor, 60),
    source: clip(attr.source, 60),
    medium: clip(attr.medium, 60),
    campaign: clip(attr.campaign, 60),
    referrer: clip(attr.referrer, 120),
    landing: clip(attr.landing, 120),
    status: 'new',
  };

  try {
    await insertLead(env.DB, lead);
    // The lead IS the conversion — record it for reporting.
    await insertConversion(env.DB, {
      id: crypto.randomUUID(),
      advisor: lead.advisor,
      source: lead.source,
      medium: lead.medium,
      campaign: lead.campaign,
      content: lead.advisor,
      landing: lead.landing,
      created_at: now,
    });
  } catch {
    return json({ error: 'save_failed' }, 500);
  }

  // Fire the email alert without blocking the response.
  if (ctx && ctx.waitUntil) ctx.waitUntil(sendLeadEmail(env, lead).catch(() => {}));

  // Clear the attribution cookie so a later separate inquiry isn't mis-attributed.
  return json({ ok: true }, 200, {
    'Set-Cookie': `${ATTR_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly`,
  });
}

async function sendLeadEmail(env, lead) {
  const key = env.RESEND_API_KEY;
  if (!key) return;
  const to = String(env.LEAD_NOTIFY_EMAILS || env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!to.length) return;
  const from = env.MAIL_FROM || 'Parrothead Cruise <onboarding@resend.dev>';
  const name = `${lead.first_name} ${lead.last_name}`.trim() || '(no name)';
  const origin = lead.advisor
    ? `Advisor tag: ${lead.advisor}`
    : lead.source
      ? `Source: ${lead.source}`
      : lead.referrer
        ? `Referrer: ${lead.referrer}`
        : 'Direct';
  const esc = (s) => String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const row = (k, v) => (v ? `<tr><td style="padding:4px 10px;color:#667;">${k}</td><td style="padding:4px 10px;"><b>${esc(v)}</b></td></tr>` : '');
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;">
      <h2 style="color:#0c2038;">New cruise inquiry</h2>
      <table style="border-collapse:collapse;font-size:14px;">
        ${row('Name', name)}
        ${row('Email', lead.email)}
        ${row('Phone', lead.phone)}
        ${row('State', lead.state)}
        ${row('Cabin interest', lead.cabin)}
        ${row('Heard about us', lead.heard)}
        ${row('Message', lead.message)}
        ${row('Came from', origin)}
        ${row('Campaign', lead.campaign)}
      </table>
      <p style="margin-top:16px;"><a href="https://parrotheadscruise.com/admin/leads" style="background:#c9a545;color:#081627;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:bold;">Open in Admin</a></p>
    </div>`;
  const payload = { from, to, subject: `New cruise inquiry: ${name}`, html };
  if (lead.email) payload.reply_to = lead.email;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// ---- admin: list + update ----
export async function handleListLeads(request, env, url) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'unauthorized' }, 401);
  await ensureSchema(env.DB);
  const q = url.searchParams;
  const opts = {
    status: VALID_STATUS.includes(q.get('status')) ? q.get('status') : undefined,
    advisor: q.get('advisor') || undefined,
    q: q.get('q') ? clip(q.get('q'), 80) : undefined,
  };
  const leads = await listLeads(env.DB, opts);
  if (q.get('format') === 'csv') {
    const cols = ['created_at', 'first_name', 'last_name', 'email', 'phone', 'state', 'cabin', 'heard', 'advisor', 'source', 'campaign', 'status', 'assigned_to', 'message', 'notes'];
    const escCsv = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [cols.join(',')];
    for (const l of leads) {
      lines.push(cols.map((c) => (c === 'created_at' ? new Date(l[c]).toISOString() : escCsv(l[c]))).join(','));
    }
    return new Response(lines.join('\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="leads.csv"',
        'Cache-Control': 'no-store',
      },
    });
  }
  return json({ leads });
}

export async function handleUpdateLead(request, env) {
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
  const fields = {};
  if (body.status !== undefined) {
    if (!VALID_STATUS.includes(body.status)) return json({ error: 'bad_status' }, 400);
    fields.status = body.status;
  }
  if (body.assigned_to !== undefined) fields.assigned_to = clip(body.assigned_to, 60);
  if (body.notes !== undefined) fields.notes = clip(body.notes, 8000);
  await updateLead(env.DB, id, fields);
  return json({ ok: true });
}

// Bulk import existing leads (e.g. from GoHighLevel). Admin-only; does NOT send
// email alerts (these are historical), and lets you set source/status per row.
export async function handleImportLeads(request, env) {
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
  if (rows.length > 1000) return json({ error: 'too_many' }, 400);
  const STATUS = ['new', 'contacted', 'quoted', 'booked', 'lost'];
  let added = 0;
  for (const r of rows) {
    const first = clip(r.first_name, 80);
    const email = clip(r.email, 160);
    const phone = clip(r.phone, 40);
    if (!first && !email && !phone) continue;
    let created = Date.now();
    if (r.created_at) {
      const t = Date.parse(r.created_at);
      if (!Number.isNaN(t)) created = t;
    }
    await insertLead(env.DB, {
      id: crypto.randomUUID(),
      created_at: created,
      first_name: first,
      last_name: clip(r.last_name, 80),
      email,
      phone,
      state: clip(r.state, 60),
      cabin: clip(r.cabin, 120),
      heard: clip(r.heard, 160),
      message: clip(r.message, 4000),
      advisor: clip(r.advisor, 60),
      source: clip(r.source, 60),
      medium: clip(r.medium, 60),
      campaign: clip(r.campaign, 60),
      referrer: '',
      landing: '',
      status: STATUS.includes(r.status) ? r.status : 'new',
    });
    added++;
  }
  return json({ ok: true, added });
}

export async function handleDeleteLead(request, env) {
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
  await deleteLead(env.DB, id);
  return json({ ok: true });
}
