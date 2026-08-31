// Admin API: reporting over the visits/conversions tables, plus the public
// conversion tracker used by the thank-you page.

import { requireAdmin } from './auth.js';
import { ensureSchema, insertConversion } from './db.js';
import { json, parseCookies } from './util.js';

const ATTR_COOKIE = 'phc_attr';

// ---- public: conversion beacon (called from /thank-you) ----
export async function handleConversion(request, env) {
  if (!env.DB) return json({ ok: false }, 200);
  await ensureSchema(env.DB);
  let attr = {};
  try {
    attr = JSON.parse(parseCookies(request)[ATTR_COOKIE] || '{}');
  } catch {
    attr = {};
  }
  try {
    await insertConversion(env.DB, {
      id: crypto.randomUUID(),
      advisor: attr.advisor || '',
      source: attr.source || '',
      medium: attr.medium || '',
      campaign: attr.campaign || '',
      content: attr.content || '',
      landing: attr.landing || '',
      created_at: Date.now(),
    });
  } catch {
    /* never surface tracking errors */
  }
  // Clear the attribution cookie so repeated thank-you loads don't double count.
  return json({ ok: true }, 200, {
    'Set-Cookie': `${ATTR_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly`,
  });
}

// ---- admin: reporting ----
export async function handleAdminApi(request, env, url) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'unauthorized' }, 401);
  const path = url.pathname;
  if (path === '/api/admin/report' && request.method === 'GET') {
    return handleReport(request, env, url);
  }
  return json({ error: 'not_found' }, 404);
}

function parseDate(str, endOfDay = false) {
  if (!str) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (!m) return null;
  const d = Date.UTC(+m[1], +m[2] - 1, +m[3], endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
  return d;
}

async function groupBy(db, column, table, range) {
  const label = `COALESCE(NULLIF(${column}, ''), '(none)')`;
  const rows = await db
    .prepare(
      `SELECT ${label} AS label, COUNT(*) AS count FROM ${table}
       WHERE created_at BETWEEN ? AND ? GROUP BY label ORDER BY count DESC LIMIT 100`
    )
    .bind(range[0], range[1])
    .all();
  return rows.results || [];
}

async function handleReport(request, env, url) {
  await ensureSchema(env.DB);
  const db = env.DB;
  const q = url.searchParams;
  const from = parseDate(q.get('from')) ?? Date.now() - 90 * 24 * 60 * 60 * 1000;
  const to = parseDate(q.get('to'), true) ?? Date.now();
  const range = [from, to];

  const [visitsTotal, tagged, byAdvisor, bySource, byCampaign, byMedium, byLanding, convTotal, convByAdvisor] =
    await Promise.all([
      db.prepare('SELECT COUNT(*) n FROM visits WHERE created_at BETWEEN ? AND ?').bind(...range).first(),
      db
        .prepare("SELECT COUNT(*) n FROM visits WHERE created_at BETWEEN ? AND ? AND advisor <> ''")
        .bind(...range)
        .first(),
      groupBy(db, 'advisor', 'visits', range),
      groupBy(db, 'source', 'visits', range),
      groupBy(db, 'campaign', 'visits', range),
      groupBy(db, 'medium', 'visits', range),
      groupBy(db, 'landing', 'visits', range),
      db.prepare('SELECT COUNT(*) n FROM conversions WHERE created_at BETWEEN ? AND ?').bind(...range).first(),
      groupBy(db, 'advisor', 'conversions', range),
    ]);

  const byDay = (
    await db
      .prepare(
        `SELECT date(created_at/1000, 'unixepoch') AS d, COUNT(*) AS count
         FROM visits WHERE created_at BETWEEN ? AND ? GROUP BY d ORDER BY d`
      )
      .bind(...range)
      .all()
  ).results;

  return json({
    range: { from, to },
    visits: visitsTotal.n,
    tagged: tagged.n,
    conversions: convTotal.n,
    byAdvisor,
    bySource,
    byCampaign,
    byMedium,
    byLanding,
    byDay,
    conversionsByAdvisor: convByAdvisor,
  });
}
