const MAIN_HOST = 'parrotheadscruise.com';
const COOKIE_NAME = 'original_domain';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();

    // Any alias domain attached to this Worker (e.g. parrotheadscruising.com)
    // redirects to the main site, carrying its hostname as ?src= so the main
    // domain can set a first-party attribution cookie on arrival.
    if (host !== MAIN_HOST && host !== `www.${MAIN_HOST}` && !host.endsWith('.workers.dev')) {
      const dest = new URL(url.pathname + url.search, `https://${MAIN_HOST}`);
      if (!dest.searchParams.has('src')) dest.searchParams.set('src', host);
      return Response.redirect(dest.toString(), 302);
    }

    // Canonicalize www to the apex domain.
    if (host === `www.${MAIN_HOST}`) {
      return Response.redirect(`https://${MAIN_HOST}${url.pathname}${url.search}`, 301);
    }

    // Server-side Widgety proxy: keeps the App ID + Token secret (Worker
    // secrets, never in the repo) and returns a normalized ship dataset for
    // the Cruise Comp page.
    if (url.pathname === '/api/ships') {
      return handleShipsApi(request, env, ctx);
    }

    const response = await env.ASSETS.fetch(request);

    // First-touch attribution: remember where the visitor originally came
    // from, but never overwrite an existing cookie.
    const src = url.searchParams.get('src') || url.searchParams.get('utm_source');
    const hasCookie = (request.headers.get('Cookie') || '').includes(`${COOKIE_NAME}=`);
    if (src && !hasCookie && /^[\w.-]{1,100}$/.test(src)) {
      const headers = new Headers(response.headers);
      headers.append(
        'Set-Cookie',
        `${COOKIE_NAME}=${encodeURIComponent(src)}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`
      );
      return new Response(response.body, { status: response.status, headers });
    }

    return response;
  },
};

// ---------------------------------------------------------------------------
// Widgety Ships API proxy
// ---------------------------------------------------------------------------
const WIDGETY_BASE = 'https://www.widgety.co.uk/api';
const WIDGETY_ACCEPT = 'application/json;api_version=2';

function jsonResponse(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8' },
      extraHeaders || {}
    ),
  });
}

function stripHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeShip(s) {
  const op = s.operator || {};
  const f = s.ship_facts || {};
  return {
    id: s.id,
    title: (s.title || '').trim(),
    line: (op.name || '').trim(),
    image: s.cover_image_href || s.profile_image_href || null,
    logo: s.profile_image_href || null,
    ship_class: (s.ship_class || '').trim(),
    size: (s.size || '').trim(),
    style: (s.style || '').trim(),
    launch_year: f.launch_year ? String(f.launch_year).trim() : null,
    refit_year: f.refit_year ? String(f.refit_year).trim() : null,
    gross_tonnage: toNumber(f.gross_tonnage),
    length: toNumber(f.length),
    width: toNumber(f.width),
    teaser: stripHtml(s.teaser).slice(0, 200),
    url: s.html_href || null,
    cruise_count: Array.isArray(s.cruises) ? s.cruises.length : 0,
  };
}

async function handleShipsApi(request, env, ctx) {
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
  }

  const appId = env.WIDGETY_APP_ID;
  const token = env.WIDGETY_TOKEN;
  if (!appId || !token) {
    return jsonResponse(
      {
        error: 'not_configured',
        message:
          'Widgety credentials are not set. Add WIDGETY_APP_ID and WIDGETY_TOKEN as Worker secrets.',
      },
      503,
      { 'Cache-Control': 'no-store' }
    );
  }

  // Serve from the edge cache when available (dataset changes rarely).
  const cache = caches.default;
  const cacheKey = new Request(`https://${MAIN_HOST}/api/ships`, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const auth = `app_id=${encodeURIComponent(appId)}&token=${encodeURIComponent(token)}`;
  const perPage = 25;
  const ships = [];
  try {
    for (let page = 1; page <= 8; page++) {
      const upstream = await fetch(
        `${WIDGETY_BASE}/ships.json?${auth}&per_page=${perPage}&page=${page}`,
        { headers: { Accept: WIDGETY_ACCEPT }, cf: { cacheTtl: 3600, cacheEverything: true } }
      );
      if (!upstream.ok) {
        if (page === 1) {
          return jsonResponse(
            { error: 'upstream_error', status: upstream.status },
            502,
            { 'Cache-Control': 'no-store' }
          );
        }
        break; // partial data from earlier pages is still usable
      }
      const data = await upstream.json();
      const batch = Array.isArray(data.ships) ? data.ships : [];
      ships.push(...batch);
      if (batch.length < perPage) break; // last page reached
    }
  } catch (err) {
    return jsonResponse({ error: 'fetch_failed' }, 502, { 'Cache-Control': 'no-store' });
  }

  const normalized = ships
    .map(normalizeShip)
    .filter((s) => s.title)
    .sort((a, b) =>
      a.line === b.line ? a.title.localeCompare(b.title) : a.line.localeCompare(b.line)
    );

  const lines = [...new Set(normalized.map((s) => s.line).filter(Boolean))].sort();

  const body = {
    ships: normalized,
    count: normalized.length,
    lines,
    source: 'Widgety',
  };

  const response = jsonResponse(body, 200, {
    'Cache-Control': 'public, max-age=3600, s-maxage=21600',
  });
  // Store a clone in the edge cache for subsequent requests.
  if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
