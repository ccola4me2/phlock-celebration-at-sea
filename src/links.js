// Short links: parrotheadscruise.com/go/<code> forwards to the full UTM-tagged
// URL the Link Builder produced, so a Facebook post shows a tidy link while
// Reports attribution works exactly as before (the landing request still
// carries the utm_* params).

import { requireAdmin } from './auth.js';
import {
  ensureSchema,
  getShortLink,
  insertShortLink,
  listShortLinks,
  deleteShortLink,
  bumpShortLink,
} from './db.js';
import { json } from './util.js';

const SITE = 'https://parrotheadscruise.com';
const PREFIX = '/go/';
const CODE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PAGES = ['/', '/pricing', '/faq', '/charity', '/team', '/contact', '/fb', '/fb/balcony', '/fb/keywest', '/fb/charity', '/fb/drifters'];
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'];

function clip(s, n) {
  return String(s == null ? '' : s).trim().slice(0, n);
}
function slug(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
export function normalizeCode(raw) {
  return slug(raw).slice(0, 40);
}

// Same rules as the Link Builder's client-side build(): only known pages,
// slugged UTM values, blanks dropped.
function buildTarget(page, utm) {
  const u = new URL(PAGES.includes(page) ? page : '/', SITE);
  for (const k of UTM_KEYS) {
    const v = slug(utm[k]);
    if (v) u.searchParams.set(k, v);
  }
  return u.pathname + u.search;
}

// ---- public: GET /go/<code> ----
export async function handleShortLink(request, env, ctx, url) {
  const code = normalizeCode(url.pathname.slice(PREFIX.length));
  let target = '/';
  if (code && env.DB) {
    try {
      await ensureSchema(env.DB);
      const link = await getShortLink(env.DB, code);
      if (link) {
        target = link.target;
        ctx.waitUntil(bumpShortLink(env.DB, code, Date.now()).catch(() => {}));
      }
    } catch {
      /* unknown or DB hiccup: still land the visitor on the site */
    }
  }
  return Response.redirect(SITE + target, 302);
}

// ---- admin: list / create / delete ----
export async function handleLinksApi(request, env, url) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'unauthorized' }, 401);
  await ensureSchema(env.DB);
  const path = url.pathname;

  if (path === '/api/admin/links' && request.method === 'GET') {
    const links = await listShortLinks(env.DB);
    return json({ links: links.map((l) => Object.assign({ url: SITE + PREFIX + l.code }, l)) });
  }

  let body = {};
  if (request.method === 'POST') {
    try {
      body = await request.json();
    } catch {
      return json({ error: 'bad_request' }, 400);
    }
  }

  if (path === '/api/admin/links' && request.method === 'POST') {
    const code = normalizeCode(body.code);
    if (!code || !CODE_RE.test(code)) return json({ error: 'bad_code' }, 400);
    const page = clip(body.page, 60) || '/';
    const utm = {};
    for (const k of UTM_KEYS) utm[k] = clip(body[k], 80);
    const target = buildTarget(page, utm);
    const existing = await getShortLink(env.DB, code);
    if (existing) {
      // Same destination: hand back the link that already exists.
      if (existing.target === target) return json({ ok: true, code, url: SITE + PREFIX + code, target, existing: true });
      return json({ error: 'taken', target: existing.target }, 409);
    }
    await insertShortLink(env.DB, {
      code,
      target,
      page,
      advisor: slug(utm.utm_content),
      source: slug(utm.utm_source),
      medium: slug(utm.utm_medium),
      campaign: slug(utm.utm_campaign),
      created_by: admin.email,
      created_at: Date.now(),
    });
    return json({ ok: true, code, url: SITE + PREFIX + code, target });
  }

  if (path === '/api/admin/links/delete' && request.method === 'POST') {
    const code = normalizeCode(body.code);
    if (!code) return json({ error: 'missing_code' }, 400);
    await deleteShortLink(env.DB, code);
    return json({ ok: true });
  }

  return json({ error: 'not_found' }, 404);
}
