// Drip campaign: automated follow-up emails to Contacted/Quoted leads that
// haven't booked yet. Runs from the Worker's daily cron (wrangler.jsonc
// "triggers") and sends through Resend, the same way the lead alerts do.
//
// Sequence: 4 emails at days 2, 6, 12 and 20 after enrollment. A lead leaves
// the sequence when it is marked Booked/Lost, when it unsubscribes, or after
// the last email. Nothing sends unless DRIP_ENABLED is "true".

import { requireAdmin } from './auth.js';
import {
  ensureSchema,
  getLead,
  getLeadByUnsubToken,
  listDripEnrollable,
  listDripDue,
  updateDrip,
} from './db.js';
import { json, randomToken } from './util.js';

const SITE = 'https://parrotheadscruise.com';
const ENROLL_STATUSES = ['contacted', 'quoted'];
// Days to wait before each email: 2, then 4, 6, 8 more (days 2, 6, 12, 20).
const GAP_DAYS = [2, 4, 6, 8];
const DAY = 86400000;
const MAX_PER_RUN = 50;

function clip(s, n) {
  return String(s == null ? '' : s).trim().slice(0, n);
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function splitList(s) {
  return String(s || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}
function firstName(lead) {
  return clip(lead.first_name, 40) || 'there';
}
// "Breezy Balcony - from $1,091.40 pp" -> "Breezy Balcony"
function cabinName(lead) {
  return clip(lead.cabin, 120).split(' - ')[0].trim();
}

export function dripEnabled(env) {
  return String(env.DRIP_ENABLED || '').toLowerCase() === 'true';
}

// ---- enrollment / state ----
export async function enrollLead(db, lead, now = Date.now()) {
  if (!lead || !lead.email) return false;
  if (lead.drip_status === 'unsubscribed') return false;
  const fields = {
    drip_status: 'active',
    drip_stage: 0,
    drip_started_at: now,
    drip_next_at: now + GAP_DAYS[0] * DAY,
  };
  if (!lead.unsub_token) fields.unsub_token = randomToken(24);
  await updateDrip(db, lead.id, fields);
  return true;
}

export async function stopDrip(db, id, status = 'stopped') {
  await updateDrip(db, id, { drip_status: status, drip_next_at: null });
}

// Called when an admin changes a lead's status. Contacted/Quoted enrolls a
// lead that has never been in the sequence; anything else stops an active one.
export async function syncDripForStatus(db, lead, newStatus) {
  if (!lead) return;
  if (ENROLL_STATUSES.includes(newStatus)) {
    if (!lead.drip_status) await enrollLead(db, lead);
  } else if (lead.drip_status === 'active') {
    await stopDrip(db, lead.id, 'stopped');
  }
}

// ---- email content ----
const PHONES = [
  { name: 'Lori', tel: '(813) 230-7879', href: 'tel:+18132307879' },
  { name: 'Dawn', tel: '(813) 453-4905', href: 'tel:+18134534905' },
  { name: 'Brent', tel: '(561) 777-9911', href: 'tel:+15617779911' },
];

const RATES = [
  ['Cozy Interior', '$844.40'],
  ['Picturesque Oceanview', '$1,005.90'],
  ['Breezy Balcony', '$1,091.40'],
  ['Wake View Balcony', '$1,129.40'],
  ['Junior Corner Suite', '$1,813.40'],
  ['Grand Terrace Suite', '$1,918.85'],
];

export const EMAILS = [
  {
    subject: (l) => `Still thinking about the Parrothead Day Cruise, ${firstName(l)}?`,
    heading: 'The PHlock is saving you a spot',
    paras: (l) => [
      `It was great connecting with you about the International Parrothead Day Cruise 2027. Picking a vacation is a big decision, so here's the quick version of why this one is different.`,
      `Seven nights round-trip from Miami, June 26 to July 3, 2027, aboard the Margaritaville at Sea Beachcomber, with a shipload of Parrotheads and exclusive events planned just for our group: private parties, live music, and a few surprises we can't put in writing.`,
      cabinName(l)
        ? `You mentioned the ${cabinName(l)}. We'd be glad to check availability and hold one for you.`
        : `Cabins start at $844.40 per person (double occupancy), and a deposit holds your spot.`,
    ],
    cta: { label: 'Reserve My Cabin', path: '/contact' },
  },
  {
    subject: () => 'Why James and Chris booked 2027 before they got off the ship',
    heading: 'Straight from the PHlock',
    paras: () => [`Don't take our word for it. Here's what two of last sailing's guests had to say:`],
    quotes: [
      {
        text: 'We had so much fun on this cruise we booked the 2027 Parrothead cruise before we disembarked. We made a lot of super new friends.',
        who: 'James Dunn',
      },
      {
        text: "Margaritaville at Sea has quickly become my favorite cruise line, and it's all because of the Parrothead Day cruise. My bags are already packed for next year!",
        who: 'Chris Betancourt',
      },
    ],
    after: () => [
      `What they're talking about: a Parrothead-only dining area, a Q&A and private concert with Nadirah Shakoor, the Tiki party, the pre-cruise meet and greet, and a week of shenanigans with people who get it.`,
    ],
    cta: { label: "See What's Included", path: '/#experience' },
  },
  {
    subject: (l) => `Cabins are filling up, ${firstName(l)}`,
    heading: 'Lock in your rate while the group block lasts',
    paras: () => [
      `Our group cabins are limited and assigned first come, first served. Once the block is gone, the ship's public rates apply, and those only go up.`,
      `Current group rates, per person, double occupancy:`,
    ],
    rates: RATES,
    after: () => [
      `And here's the part we're proudest of: every sailing supports Singing for Change, the foundation Jimmy Buffett started. Last time, the PHlock raised $5,050 for children's music programs. Party with purpose.`,
    ],
    cta: { label: 'Lock In My Rate', path: '/pricing' },
  },
  {
    subject: (l) => `Should we save you a seat on deck, ${firstName(l)}?`,
    heading: 'Last call (for now)',
    paras: () => [
      `This is the last automatic note from us, we promise. If the timing isn't right this year, no hard feelings, and we'd still love to see you on a future sailing.`,
      `If you're ready, it takes one reply to this email or a quick call. Lori, Dawn, and Brent all see your reply and will get you booked:`,
    ],
    phones: PHONES,
    after: () => [`Fins up, and we hope to see you on deck.`],
    cta: { label: "Yes, Let's Book", path: '/contact' },
  },
];

function ctaUrl(path, stage) {
  const [p, hash] = path.split('#');
  const u = new URL(p || '/', SITE);
  u.searchParams.set('utm_source', 'drip');
  u.searchParams.set('utm_medium', 'email');
  u.searchParams.set('utm_campaign', `drip-${stage}`);
  return u.toString() + (hash ? `#${hash}` : '');
}

function unsubUrl(lead) {
  return `${SITE}/unsubscribe?t=${encodeURIComponent(lead.unsub_token || 'preview')}`;
}

function renderHtml(env, lead, stage) {
  const e = EMAILS[stage - 1];
  const url = ctaUrl(e.cta.path, stage);
  const unsub = unsubUrl(lead);
  const postal = clip(env.DRIP_POSTAL_ADDRESS, 200);
  const p = (t) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#22303d;">${esc(t)}</p>`;
  let body = e.paras(lead).map(p).join('');
  if (e.quotes) {
    body += e.quotes
      .map(
        (q) =>
          `<blockquote style="margin:0 0 16px;padding:12px 16px;border-left:3px solid #c9a545;background:#faf6ea;font-size:16px;line-height:1.6;color:#22303d;font-style:italic;">&ldquo;${esc(q.text)}&rdquo;<br><span style="font-style:normal;font-size:13px;color:#8a6d1f;font-weight:bold;">${esc(q.who)}</span></blockquote>`
      )
      .join('');
  }
  if (e.rates) {
    body += `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;font-size:15px;color:#22303d;">${e.rates
      .map(
        ([n, r]) =>
          `<tr><td style="padding:4px 16px 4px 0;">${esc(n)}</td><td style="padding:4px 0;font-weight:bold;">${esc(r)}</td></tr>`
      )
      .join('')}</table>`;
  }
  if (e.phones) {
    body += `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;font-size:16px;color:#22303d;">${e.phones
      .map(
        (ph) =>
          `<tr><td style="padding:4px 16px 4px 0;font-weight:bold;">${esc(ph.name)}</td><td style="padding:4px 0;"><a href="${ph.href}" style="color:#123152;">${esc(ph.tel)}</a></td></tr>`
      )
      .join('')}</table>`;
  }
  if (e.after) body += e.after(lead).map(p).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(e.heading)}</title></head>
<body style="margin:0;padding:0;background:#f5efe2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5efe2;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
  <tr><td style="background:#081627;padding:26px 32px;text-align:center;">
    <div style="font-size:11px;letter-spacing:3px;color:#e3c878;text-transform:uppercase;">International</div>
    <div style="font-size:24px;font-weight:bold;color:#ffffff;letter-spacing:1px;">Parrothead Day Cruise 2027</div>
    <div style="font-size:12px;color:#c9a545;margin-top:4px;">June 26 &ndash; July 3, 2027 &middot; Margaritaville at Sea Beachcomber</div>
  </td></tr>
  <tr><td style="padding:32px 32px 8px;">
    <h1 style="margin:0 0 18px;font-size:22px;line-height:1.3;color:#081627;">${esc(e.heading)}</h1>
    ${p(`Hi ${firstName(lead)},`)}
    ${body}
  </td></tr>
  <tr><td style="padding:4px 32px 32px;" align="center">
    <a href="${url}" style="display:inline-block;background:#c9a545;color:#081627;text-decoration:none;font-weight:bold;font-size:16px;padding:14px 28px;border-radius:8px;">${esc(e.cta.label)}</a>
    <p style="margin:18px 0 0;font-size:14px;color:#55606c;">Or just reply to this email. Lori, Dawn, and Brent all see it.</p>
  </td></tr>
  <tr><td style="background:#f5efe2;padding:18px 32px;font-size:12px;line-height:1.6;color:#55606c;text-align:center;">
    You're receiving this because you asked about the International Parrothead Day Cruise 2027 at parrotheadscruise.com.
    Don't want these reminders? <a href="${unsub}" style="color:#123152;">Unsubscribe</a> and we'll stop right away.<br>
    Prestige Travel Vacations LLC &amp; Turner Travel${postal ? ' &middot; ' + esc(postal) : ''}
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function renderText(env, lead, stage) {
  const e = EMAILS[stage - 1];
  const lines = [`Hi ${firstName(lead)},`, '', e.heading, ''];
  for (const t of e.paras(lead)) lines.push(t, '');
  if (e.quotes) for (const q of e.quotes) lines.push(`"${q.text}"`, `  ${q.who}`, '');
  if (e.rates) {
    for (const [n, r] of e.rates) lines.push(`  ${n}: ${r}`);
    lines.push('');
  }
  if (e.phones) {
    for (const ph of e.phones) lines.push(`  ${ph.name}: ${ph.tel}`);
    lines.push('');
  }
  if (e.after) for (const t of e.after(lead)) lines.push(t, '');
  lines.push(`${e.cta.label}: ${ctaUrl(e.cta.path, stage)}`, '');
  lines.push('Or just reply to this email. Lori, Dawn, and Brent all see it.', '');
  lines.push(
    `You're receiving this because you asked about the International Parrothead Day Cruise 2027 at parrotheadscruise.com.`,
    `Unsubscribe: ${unsubUrl(lead)}`
  );
  const postal = clip(env.DRIP_POSTAL_ADDRESS, 200);
  lines.push(`Prestige Travel Vacations LLC & Turner Travel${postal ? ' | ' + postal : ''}`);
  return lines.join('\n');
}

export function buildDripMessage(env, lead, stage) {
  const e = EMAILS[stage - 1];
  const from = env.DRIP_FROM || 'International Parrothead Day Cruise <sales@parrotheadscruise.com>';
  const replyTo = splitList(env.DRIP_REPLY_TO || env.LEAD_NOTIFY_EMAILS);
  const unsub = unsubUrl(lead);
  const msg = {
    from,
    to: [lead.email],
    subject: e.subject(lead),
    html: renderHtml(env, lead, stage),
    text: renderText(env, lead, stage),
    headers: {
      'List-Unsubscribe': `<${unsub}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    tags: [{ name: 'campaign', value: 'drip' }, { name: 'stage', value: String(stage) }],
  };
  if (replyTo.length) msg.reply_to = replyTo;
  return msg;
}

async function sendResend(env, payload) {
  const key = env.RESEND_API_KEY;
  if (!key) throw new Error('no_resend_key');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`resend_${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ---- the daily job ----
export async function runDrip(env) {
  const summary = { enabled: dripEnabled(env), enrolled: 0, sent: 0, stopped: 0, errors: 0, skipped: false };
  if (!env.DB) {
    summary.skipped = true;
    return summary;
  }
  await ensureSchema(env.DB);
  const now = Date.now();

  // Pick up Contacted/Quoted leads that have never been in the sequence
  // (covers leads that were already contacted before the drip existed).
  for (const l of await listDripEnrollable(env.DB)) {
    if (await enrollLead(env.DB, l, now)) summary.enrolled++;
  }

  if (!summary.enabled) {
    summary.skipped = true;
    return summary;
  }

  for (const l of await listDripDue(env.DB, now, MAX_PER_RUN)) {
    // Re-check at send time: status may have changed since enrollment.
    if (!ENROLL_STATUSES.includes(l.status) || !l.email) {
      await stopDrip(env.DB, l.id, 'stopped');
      summary.stopped++;
      continue;
    }
    const stage = (l.drip_stage || 0) + 1;
    try {
      await sendResend(env, buildDripMessage(env, l, stage));
      const last = stage >= EMAILS.length;
      await updateDrip(env.DB, l.id, {
        drip_stage: stage,
        drip_status: last ? 'done' : 'active',
        drip_next_at: last ? null : now + GAP_DAYS[stage] * DAY,
        drip_last_sent_at: now,
      });
      summary.sent++;
    } catch (e) {
      // Leave drip_next_at alone so it retries on the next run.
      summary.errors++;
    }
  }
  return summary;
}

// ---- public: unsubscribe (GET from the footer link, POST for one-click) ----
function unsubPage(ok) {
  const title = ok ? "You're unsubscribed" : 'That link has expired';
  const msg = ok
    ? "You won't receive any more reminder emails about the International Parrothead Day Cruise 2027. If you ever change your mind, just reach out to Lori, Dawn, or Brent and we'll save you a spot on deck."
    : "We couldn't match that unsubscribe link. If you'd like to stop receiving reminders, reply to any of our emails with \"unsubscribe\" and we'll take care of it.";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} | Parrothead Day Cruise 2027</title>
<meta name="robots" content="noindex"></head>
<body style="margin:0;background:#081627;font-family:Arial,Helvetica,sans-serif;color:#fff;">
<div style="max-width:560px;margin:0 auto;padding:64px 24px;text-align:center;">
  <div style="font-size:11px;letter-spacing:3px;color:#e3c878;text-transform:uppercase;">International</div>
  <div style="font-size:26px;font-weight:bold;letter-spacing:1px;margin-bottom:28px;">Parrothead Day Cruise 2027</div>
  <h1 style="font-size:24px;margin:0 0 14px;color:#e3c878;">${esc(title)}</h1>
  <p style="font-size:16px;line-height:1.6;color:rgba(255,255,255,0.85);margin:0 0 28px;">${esc(msg)}</p>
  <a href="${SITE}/" style="display:inline-block;background:#c9a545;color:#081627;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:8px;">Back to parrotheadscruise.com</a>
</div></body></html>`;
}

export async function handleUnsubscribe(request, env, url) {
  const token = clip(url.searchParams.get('t'), 80);
  let ok = false;
  if (token && env.DB) {
    await ensureSchema(env.DB);
    const lead = await getLeadByUnsubToken(env.DB, token);
    if (lead) {
      await updateDrip(env.DB, lead.id, {
        drip_status: 'unsubscribed',
        drip_next_at: null,
        unsubscribed_at: Date.now(),
      });
      ok = true;
    }
  }
  if (request.method === 'POST') return new Response(ok ? 'OK' : 'Not found', { status: ok ? 200 : 404 });
  return new Response(unsubPage(ok), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// ---- admin: preview / test-send / run now / start-stop per lead ----
function sampleLead() {
  return {
    id: 'preview',
    first_name: 'Sandy',
    last_name: 'Parrothead',
    email: 'sample@example.com',
    cabin: 'Breezy Balcony - from $1,091.40 pp',
    status: 'contacted',
    unsub_token: 'preview',
  };
}

function stageParam(v) {
  const n = parseInt(v || '1', 10) || 1;
  return Math.min(Math.max(n, 1), EMAILS.length);
}

export async function handleDripAdmin(request, env, url) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'unauthorized' }, 401);
  await ensureSchema(env.DB);
  const path = url.pathname;

  if (path === '/api/admin/drip/preview' && request.method === 'GET') {
    const stage = stageParam(url.searchParams.get('stage'));
    const id = clip(url.searchParams.get('id'), 60);
    const lead = (id && (await getLead(env.DB, id))) || sampleLead();
    return new Response(buildDripMessage(env, lead, stage).html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  let body = {};
  if (request.method === 'POST') {
    try {
      body = await request.json();
    } catch {
      body = {};
    }
  }

  if (path === '/api/admin/drip/test' && request.method === 'POST') {
    // Send one email of the sequence to the signed-in admin (or another team
    // address) so the copy and deliverability can be checked before going live.
    const stage = stageParam(body.stage);
    const allowed = splitList(
      [env.ADMIN_EMAILS, env.LEAD_NOTIFY_EMAILS, env.DRIP_REPLY_TO].filter(Boolean).join(',')
    ).map((x) => x.toLowerCase());
    const wanted = clip(body.to, 160).toLowerCase();
    const to = wanted && allowed.includes(wanted) ? wanted : admin.email;
    const lead = Object.assign(sampleLead(), {
      first_name: (admin.name || '').split(' ')[0] || 'there',
      email: to,
    });
    const msg = buildDripMessage(env, lead, stage);
    msg.subject = `[TEST ${stage}/${EMAILS.length}] ${msg.subject}`;
    try {
      await sendResend(env, msg);
    } catch (e) {
      return json({ error: 'send_failed', detail: String(e.message || e) }, 502);
    }
    return json({ ok: true, to, stage });
  }

  if (path === '/api/admin/drip/run' && request.method === 'POST') {
    return json(await runDrip(env));
  }

  if (path === '/api/admin/leads/drip' && request.method === 'POST') {
    const id = clip(body.id, 60);
    const lead = id && (await getLead(env.DB, id));
    if (!lead) return json({ error: 'not_found' }, 404);
    if (body.action === 'stop') {
      await stopDrip(env.DB, lead.id, 'stopped');
      return json({ ok: true, drip_status: 'stopped' });
    }
    if (body.action === 'start') {
      if (lead.drip_status === 'unsubscribed') return json({ error: 'unsubscribed' }, 409);
      if (!lead.email) return json({ error: 'no_email' }, 400);
      await enrollLead(env.DB, lead);
      return json({ ok: true, drip_status: 'active' });
    }
    return json({ error: 'bad_action' }, 400);
  }

  return json({ error: 'not_found' }, 404);
}
