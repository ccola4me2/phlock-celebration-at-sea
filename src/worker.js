import {
  handleLogin,
  handleLogout,
  handleMe,
  handleClaim,
  getCurrentUser,
  isAdmin,
} from './auth.js';
import { handleAdminApi, handleConversion } from './admin.js';
import { handleCreateLead, handleListLeads, handleUpdateLead, handleDeleteLead } from './leads.js';
import {
  handleListCabins,
  handleSaveCabin,
  handleDeleteCabin,
  handleImportCabins,
  handleClearCabins,
} from './cabins.js';
import { ensureSchema, insertVisit } from './db.js';
import { parseCookies } from './util.js';

const MAIN_HOST = 'parrotheadscruise.com';
const COOKIE_NAME = 'original_domain';
const ATTR_COOKIE = 'phc_attr';

// Admin pages that require a signed-in admin (everything under /admin except
// the login page).
function isAdminArea(path) {
  if (path === '/admin/login' || path === '/admin/login.html') return false;
  return path === '/admin' || path === '/admin.html' || path.startsWith('/admin/');
}

function clip(s, n) {
  return String(s || '').slice(0, n);
}

function referrerHost(request) {
  const ref = request.headers.get('Referer') || '';
  try {
    const h = new URL(ref).hostname.toLowerCase();
    if (h && h !== MAIN_HOST && h !== `www.${MAIN_HOST}`) return h;
  } catch {
    /* no/!bad referrer */
  }
  return '';
}

async function logVisit(env, attr) {
  try {
    await ensureSchema(env.DB);
    await insertVisit(env.DB, { id: crypto.randomUUID(), created_at: Date.now(), ...attr });
  } catch {
    /* tracking must never break page serving */
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const path = url.pathname;

    // Alias domains redirect to the main site, carrying their hostname as ?src=.
    if (host !== MAIN_HOST && host !== `www.${MAIN_HOST}` && !host.endsWith('.workers.dev')) {
      const dest = new URL(url.pathname + url.search, `https://${MAIN_HOST}`);
      if (!dest.searchParams.has('src')) dest.searchParams.set('src', host);
      return Response.redirect(dest.toString(), 302);
    }

    // Canonicalize www to the apex domain.
    if (host === `www.${MAIN_HOST}`) {
      return Response.redirect(`https://${MAIN_HOST}${url.pathname}${url.search}`, 301);
    }

    // Google Search Console verification (200, no redirect).
    if (path === '/google705e17e34b2526c5.html') {
      return new Response('google-site-verification: google705e17e34b2526c5.html', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // ---- Auth + admin API ----
    if (path === '/api/auth/login' && request.method === 'POST') return handleLogin(request, env);
    if (path === '/api/auth/logout' && request.method === 'POST') return handleLogout(request, env);
    if (path === '/api/auth/claim' && request.method === 'POST') return handleClaim(request, env);
    if (path === '/api/auth/me' && request.method === 'GET') return handleMe(request, env);
    if (path === '/api/track/conversion' && request.method === 'POST')
      return handleConversion(request, env);
    if (path === '/api/lead' && request.method === 'POST')
      return handleCreateLead(request, env, ctx);
    if (path === '/api/admin/leads' && request.method === 'GET')
      return handleListLeads(request, env, url);
    if (path === '/api/admin/leads/update' && request.method === 'POST')
      return handleUpdateLead(request, env);
    if (path === '/api/admin/leads/delete' && request.method === 'POST')
      return handleDeleteLead(request, env);
    if (path === '/api/admin/cabins' && request.method === 'GET')
      return handleListCabins(request, env, url);
    if (path === '/api/admin/cabins/save' && request.method === 'POST')
      return handleSaveCabin(request, env);
    if (path === '/api/admin/cabins/delete' && request.method === 'POST')
      return handleDeleteCabin(request, env);
    if (path === '/api/admin/cabins/import' && request.method === 'POST')
      return handleImportCabins(request, env);
    if (path === '/api/admin/cabins/clear' && request.method === 'POST')
      return handleClearCabins(request, env);
    if (path.startsWith('/api/admin/')) return handleAdminApi(request, env, url);

    // ---- Admin page gate ----
    if (isAdminArea(path)) {
      const user = await getCurrentUser(request, env);
      if (!isAdmin(user, env)) {
        return Response.redirect(
          `https://${MAIN_HOST}/admin/login?next=${encodeURIComponent(path)}`,
          302
        );
      }
    }

    // ---- Serve static asset ----
    const response = await env.ASSETS.fetch(request);
    const setCookies = [];

    // First-touch domain/source attribution cookie (used by the GHL form).
    const src = url.searchParams.get('src') || url.searchParams.get('utm_source');
    const hasOrig = (request.headers.get('Cookie') || '').includes(`${COOKIE_NAME}=`);
    if (src && !hasOrig && /^[\w.-]{1,100}$/.test(src)) {
      setCookies.push(
        `${COOKIE_NAME}=${encodeURIComponent(src)}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`
      );
    }

    // First-touch visit logging: one row per new visitor on an HTML pageview.
    const ct = response.headers.get('Content-Type') || '';
    const cookies = parseCookies(request);
    if (
      ct.includes('text/html') &&
      env.DB &&
      !cookies[ATTR_COOKIE] &&
      !path.startsWith('/admin')
    ) {
      const q = url.searchParams;
      const attr = {
        advisor: clip(q.get('utm_content') || q.get('adv'), 60),
        source: clip(q.get('utm_source') || q.get('src'), 60),
        medium: clip(q.get('utm_medium'), 60),
        campaign: clip(q.get('utm_campaign'), 60),
        content: clip(q.get('utm_content'), 60),
        landing: clip(path, 120),
        referrer: clip(referrerHost(request), 120),
      };
      // Store the attribution values (first-touch) so a later conversion on the
      // thank-you page can be attributed to the same advisor/source. HttpOnly:
      // only the Worker reads it.
      const cookieVal = encodeURIComponent(JSON.stringify(attr));
      setCookies.push(
        `${ATTR_COOKIE}=${cookieVal}; Path=/; Max-Age=7776000; SameSite=Lax; Secure; HttpOnly`
      );
      ctx.waitUntil(logVisit(env, attr));
    }

    if (setCookies.length) {
      const headers = new Headers(response.headers);
      for (const c of setCookies) headers.append('Set-Cookie', c);
      return new Response(response.body, { status: response.status, headers });
    }
    return response;
  },
};
