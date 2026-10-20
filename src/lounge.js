// The Drifters Dive Bar: a private page for booked guests at /drifters.
//
// Guests sign in with their last name and reservation number, matched against
// the admin's Cabins list (so the manifest stays the source of truth: if you are
// on it, you can get in). Content (news posts, the schedule, key dates, links,
// a pinned notice) is edited from the admin Dive Bar page and stored in D1.
//
//   GET  /drifters              the Dive Bar, or the sign-in gate
//   POST /drifters/login        last_name + res_number (form post)
//   POST /drifters/logout
//   GET  /drifters/post/<id>    one news post in full
//   /api/admin/lounge...        the editor's API (admin only)
//
// Signed-in admins see the Dive Bar without a guest session, for previewing.

import { getCurrentUser, isAdmin, requireAdmin } from './auth.js';
import {
  ensureSchema,
  LOUNGE_TYPES,
  listLounge,
  getLoungeRow,
  saveLounge,
  deleteLounge,
  getLoungeSettings,
  setLoungeSetting,
  createDrifterSession,
  getDrifterSession,
  deleteDrifterSession,
  findCabinForSignIn,
  insertLoungeSignin,
  listLoungeSignins,
} from './db.js';
import { json, parseCookies, randomToken, sha256Hex } from './util.js';

const SITE = 'https://parrotheadscruise.com';
const COOKIE = 'phc_drifter';
const SESSION_DAYS = 90;
// June 26, 2027, 4:00 PM Eastern.
const SAIL_AT = Date.UTC(2027, 5, 26, 20, 0, 0);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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
function redirect(to, extraHeaders) {
  return new Response(null, { status: 303, headers: Object.assign({ Location: to }, extraHeaders || {}) });
}
function html(body, status = 200, extraHeaders) {
  return new Response(body, {
    status,
    headers: Object.assign(
      { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, private', 'X-Robots-Tag': 'noindex' },
      extraHeaders || {}
    ),
  });
}

// ---- dates ----
function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null;
}
function fmtDay(s) {
  const p = parseYmd(s);
  if (!p) return esc(s);
  const dt = new Date(Date.UTC(p.y, p.mo - 1, p.d));
  return `${DOW[dt.getUTCDay()]}, ${MONTHS[p.mo - 1]} ${p.d}`;
}
function fmtDate(s) {
  const p = parseYmd(s);
  return p ? `${MONTHS[p.mo - 1].slice(0, 3)} ${p.d}, ${p.y}` : esc(s);
}
function fmtTime(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return esc(s);
  let h = +m[1];
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ampm}`;
}
function daysToSail(now = Date.now()) {
  return Math.max(0, Math.ceil((SAIL_AT - now) / 86400000));
}

// Plain text -> paragraphs, with links made clickable.
function richText(text) {
  const paras = String(text || '').replace(/\r\n/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return paras
    .map((p) => {
      let s = esc(p).replace(/\n/g, '<br>');
      s = s.replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
      return `<p>${s}</p>`;
    })
    .join('');
}
function excerpt(text, n = 170) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s;
}

// ---- guest sessions ----
async function currentGuest(request, env) {
  const token = parseCookies(request)[COOKIE];
  if (!token || !env.DB) return null;
  const sess = await getDrifterSession(env.DB, await sha256Hex(token));
  if (!sess || sess.expires_at < Date.now()) return null;
  return { cabin_id: sess.cabin_id, name: sess.guest_name || 'Drifter', sid: sess.id };
}

async function viewer(request, env) {
  const guest = await currentGuest(request, env);
  if (guest) return guest;
  // Admins can preview without a guest session.
  const user = await getCurrentUser(request, env);
  if (isAdmin(user, env)) return { cabin_id: null, name: (user.name || user.email) + ' (admin preview)', admin: true };
  return null;
}

// ---- shared page chrome ----
const CSS = `
  .lg-hero { background: linear-gradient(100deg, rgba(6,15,28,.95) 0%, rgba(6,15,28,.84) 48%, rgba(6,15,28,.58) 100%), url("/assets/img/ship-exterior.jpg") center 62%/cover no-repeat; color:#fff; padding: 4rem 0 3.5rem; }
  .lg-hero .container { display:grid; grid-template-columns: 1.3fr 1fr; gap:2rem; align-items:center; }
  .lg-hero h1 { margin:.2rem 0 .6rem; color:#fff; }
  .lg-hero .hero-lede { color:rgba(255,255,255,.86); }
  .lg-meta { display:flex; flex-wrap:wrap; align-items:center; gap:.6rem 1.1rem; margin-top:1.5rem; padding-top:1.1rem; border-top:1px solid rgba(201,165,69,.35); font-size:.76rem; letter-spacing:.1em; text-transform:uppercase; color:rgba(255,255,255,.72); }
  .lg-meta b { color:var(--gold-light); font-weight:700; letter-spacing:.04em; font-size:1rem; }
  .lg-meta .sep { width:4px; height:4px; border-radius:50%; background:var(--gold); opacity:.8; }
  .lg-pinned { background:var(--cream); color:var(--ink); border-radius:12px; padding:1.3rem 1.4rem; border-left:5px solid var(--gold); box-shadow:var(--shadow-md); }
  .lg-pinned .tag { font-size:.7rem; letter-spacing:.12em; text-transform:uppercase; font-weight:700; color:#8a6d1f; }
  .lg-pinned h3 { margin:.3rem 0 .4rem; font-family:var(--font-display); font-size:1.05rem; color:var(--navy-900); }
  .lg-pinned p { margin:0 0 .5em; font-size:.95rem; color:var(--ink-soft); } .lg-pinned p:last-child { margin-bottom:0; }
  .lg-post { display:flex; flex-direction:column; }
  .lg-post .date { font-size:.74rem; letter-spacing:.1em; text-transform:uppercase; color:var(--gold); font-weight:700; }
  .lg-post h3 { margin:.35rem 0 .4rem; font-size:1.1rem; }
  .lg-post p { color:var(--ink-soft); font-size:.95rem; margin:0 0 .9rem; }
  .lg-post a { margin-top:auto; font-weight:600; color:var(--navy-700); }
  .lg-day { display:grid; grid-template-columns:180px 1fr; gap:1.2rem; padding:1.1rem 0; border-bottom:1px solid rgba(255,255,255,.12); }
  .lg-day:last-child { border-bottom:none; }
  .lg-day .when { font-family:var(--font-display); color:var(--gold-light); font-size:.95rem; line-height:1.3; }
  .lg-day .when small { display:block; font-family:var(--font-body); color:rgba(255,255,255,.6); font-size:.74rem; letter-spacing:.08em; text-transform:uppercase; margin-top:.2rem; }
  .lg-ev { display:flex; gap:1rem; padding:.45rem 0; }
  .lg-ev time { flex:none; width:84px; color:#fff; font-weight:600; font-size:.9rem; }
  .lg-ev div { color:rgba(255,255,255,.85); font-size:.95rem; }
  .lg-ev div span { display:block; color:rgba(255,255,255,.55); font-size:.82rem; }
  .lg-dates { list-style:none; margin:0; padding:0; }
  .lg-dates li { display:flex; gap:1rem; align-items:center; padding:.8rem 0; border-bottom:1px solid var(--cream-dark); }
  .lg-dates .d { flex:none; width:64px; text-align:center; background:var(--navy-900); color:#fff; border-radius:10px; padding:.4rem 0; line-height:1.1; }
  .lg-dates .d b { display:block; font-size:1.2rem; color:var(--gold-light); }
  .lg-dates .d small { font-size:.68rem; letter-spacing:.08em; text-transform:uppercase; }
  .lg-dates .t { font-weight:600; color:var(--navy-900); }
  .lg-dates .t span { display:block; font-weight:400; color:var(--ink-soft); font-size:.88rem; }
  .lg-doc { display:flex; align-items:center; gap:.9rem; padding:.9rem 1rem; background:#fff; border:1px solid var(--cream-dark); border-radius:10px; text-decoration:none; }
  .lg-doc .ic { width:38px; height:38px; border-radius:9px; background:var(--navy-900); color:var(--gold); display:flex; align-items:center; justify-content:center; flex:none; }
  .lg-doc b { display:block; color:var(--navy-900); } .lg-doc small { color:var(--ink-soft); }
  .lg-empty { color:var(--ink-soft); text-align:center; padding:1rem 0; }
  .bg-navy .lg-empty { color:rgba(255,255,255,.6); }
  .lg-gate { min-height:70vh; display:flex; align-items:center; justify-content:center; padding:3rem 1rem; background:linear-gradient(180deg, rgba(6,15,28,.82), rgba(6,15,28,.90)), url("/assets/img/ship-exterior.jpg") center 60%/cover no-repeat; }
  .lg-card { background:var(--cream); color:var(--ink); border-radius:14px; padding:2.2rem 2rem; max-width:460px; width:100%; box-shadow:0 30px 70px rgba(0,0,0,.45); text-align:center; }
  .lg-card .lock { width:54px; height:54px; border-radius:50%; background:var(--navy-900); color:var(--gold); display:inline-flex; align-items:center; justify-content:center; font-size:1.4rem; margin-bottom:.6rem; }
  .lg-card h1 { font-family:var(--font-display); font-size:1.5rem; margin:.2rem 0 .3rem; color:var(--navy-900); }
  .lg-card .script { font-family:var(--font-script); font-size:1.9rem; color:var(--gold); display:block; line-height:1; }
  .lg-card p { color:var(--ink-soft); margin:.4rem 0 1.2rem; }
  .lg-card label { display:block; text-align:left; font-size:.72rem; letter-spacing:.1em; text-transform:uppercase; font-weight:700; color:var(--ink-soft); margin:.6rem 0 .3rem; }
  .lg-card input { width:100%; padding:.85em 1em; font:inherit; font-size:1.05rem; border:1px solid var(--cream-dark); border-radius:10px; background:#fff; }
  .lg-card .btn { width:100%; margin-top:1rem; border:none; cursor:pointer; font:inherit; }
  .lg-card .help { font-size:.82rem; color:var(--ink-soft); margin:1rem 0 0; }
  .lg-card .err { background:#fdecec; color:#8a2a2a; border-radius:8px; padding:.7em .9em; font-size:.9rem; margin:0 0 .6rem; text-align:left; }
  .lg-card .note { background:#eaf2f8; color:#1f3d5c; border-radius:8px; padding:.7em .9em; font-size:.88rem; margin:0 0 .6rem; text-align:left; }
  .lg-article { max-width:760px; margin:0 auto; }
  .lg-article .date { font-size:.78rem; letter-spacing:.1em; text-transform:uppercase; color:var(--gold); font-weight:700; }
  .lg-article .body p { font-family:var(--font-serif); font-size:1.18rem; line-height:1.72; color:var(--ink); margin:0 0 1em; }
  .lg-foot { display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap; }
  .lg-foot form { margin:0; } .lg-foot button { background:none; border:none; color:inherit; font:inherit; text-decoration:underline; cursor:pointer; padding:0; }
  @media (max-width: 760px) { .lg-hero .container { grid-template-columns:1fr; } .lg-day { grid-template-columns:1fr; gap:.4rem; } }
`;

function head(title) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} | International Parrothead Day Cruise 2027</title>
<meta name="robots" content="noindex, nofollow">
<link rel="icon" type="image/png" href="/assets/img/favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=Great+Vibes&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/styles.css"><style>${CSS}</style></head><body>
<header class="site-header" id="siteHeader"><nav class="nav container">
  <a href="/" class="brand"><img class="brand-mark" src="/assets/img/logo-drifters.jpg" alt="Parrot Head Drifters logo"><span class="brand-text"><span class="brand-top">International</span><span class="brand-main">Parrothead Day</span><span class="brand-sub">Cruise 2027</span></span></a>
  <button class="nav-toggle" id="navToggle" aria-label="Toggle navigation" aria-expanded="false" aria-controls="navLinks"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg></button>
  <div class="nav-links" id="navLinks"><div class="nav-item has-menu"><button class="nav-menu-btn" type="button" aria-haspopup="true" aria-expanded="false">The Cruise<svg class="caret" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button><div class="nav-menu"><a href="/#experience">Experience</a><a href="/#itinerary">Itinerary</a><a href="/#ship">The Ship</a></div></div><a href="/pricing">Cabins &amp; Pricing</a><a href="/charity">Cruising for Change</a><a href="/faq">FAQ</a><div class="nav-item has-menu"><button class="nav-menu-btn" type="button" aria-haspopup="true" aria-expanded="false">Contact<svg class="caret" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button><div class="nav-menu"><a href="/contact">Contact Us</a><a href="/team">Travel Advisors</a></div></div><a href="/drifters" class="nav-lounge" aria-current="page">Drifters Dive Bar</a><a href="/contact" class="btn btn-gold">Reserve Your Cabin</a></div>
</nav></header>
<main>`;
}

function foot(who) {
  return `</main>
<footer class="site-footer"><div class="container"><div class="footer-bottom lg-foot">
  <span>&copy; 2026&ndash;2027 Prestige Travel Vacations LLC &amp; Turner Travel. The Drifters Dive Bar is private to booked guests.</span>
  ${who ? `<span>Signed in as ${esc(who)} &middot; <form method="post" action="/drifters/logout" style="display:inline"><button type="submit">Sign out</button></form></span>` : ''}
</div></div></footer>
<script src="/js/main.js"></script></body></html>`;
}

// ---- pages ----
function gatePage(err, closed, inApp) {
  const tip = inApp && err !== 'cookies'
    ? '<div class="note">Opening this from the Facebook app? Sign-in works best in your regular browser: tap the <b>&#8942;</b> or <b>&#8230;</b> menu at the top and choose <b>Open in Safari</b> (or Chrome).</div>'
    : '';
  const notice = closed
    ? '<div class="err">The Dive Bar isn\'t open yet. Check back soon, or ask Lori, Dawn or Brent.</div>'
    : err === 'cookies'
      ? '<div class="err">Your sign-in worked, but this browser didn\'t keep you signed in. That happens inside the Facebook app. Tap the <b>&#8942;</b> or <b>&#8230;</b> menu at the top, choose <b>Open in Safari</b> (or Chrome), and sign in again there.</div>'
    : err === 'nomatch'
      ? '<div class="err">We couldn\'t find that reservation. Check the reservation number on your confirmation and try just your last name. Still stuck? Text Lori, Dawn or Brent.</div>'
      : err === 'missing'
        ? '<div class="err">Please enter both your last name and your reservation number.</div>'
        : '';
  return head('Drifters Dive Bar') + `
<div class="lg-gate"><div class="lg-card">
  <div class="lock">&#128274;</div>
  <span class="script">Drifters only</span>
  <h1>The Drifters Dive Bar</h1>
  <p>Dive in with your last name and reservation number for all the details: schedule, events, news and deadlines.</p>
  ${tip}${notice}
  <form method="post" action="/drifters/login" ${closed ? 'hidden' : ''}>
    <label for="ln">Last name</label><input id="ln" name="last_name" autocomplete="family-name" autocapitalize="words" autocorrect="off" spellcheck="false" enterkeyhint="next" required>
    <label for="rn">Reservation number</label><input id="rn" name="res_number" inputmode="numeric" pattern="[0-9 ]*" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" required>
    <button class="btn btn-gold" type="submit">Dive In</button>
  </form>
  <p class="help">Any last name on the booking works. Your reservation number is on your booking confirmation. Can't find it? Text Lori (813) 230-7879, Dawn (813) 453-4905 or Brent (561) 777-9911.</p>
</div></div>` + foot('');
}

function crewCards() {
  return `<section><div class="container">
  <div class="section-head"><span class="eyebrow">Questions?</span><h2>Your Drifters crew</h2></div>
  <div class="grid grid-3">
    <div class="card" style="text-align:center;"><h3>Lori Judd</h3><p style="color:var(--ink-soft);margin:.2rem 0 .6rem;">Prestige Travel Vacations</p><a href="tel:+18132307879">(813) 230-7879</a></div>
    <div class="card" style="text-align:center;"><h3>Dawn Turner</h3><p style="color:var(--ink-soft);margin:.2rem 0 .6rem;">Turner Travel</p><a href="tel:+18134534905">(813) 453-4905</a></div>
    <div class="card" style="text-align:center;"><h3>Brent Beasley</h3><p style="color:var(--ink-soft);margin:.2rem 0 .6rem;">Cruises Tours &amp; Travel</p><a href="tel:+15617779911">(561) 777-9911</a></div>
  </div>
</div></section>`;
}

function loungePage(who, settings, posts, events, dates, links) {
  const pinned = settings.pinned_title
    ? `<div class="lg-pinned"><span class="tag">Pinned</span><h3>${esc(settings.pinned_title)}</h3>${richText(settings.pinned_body)}</div>`
    : `<div class="lg-pinned"><span class="tag">Welcome</span><h3>You're in.</h3><p>News, the schedule and every deadline for our sailing live here. Check back often.</p></div>`;

  const postCards = posts.length
    ? posts.map((p) => `<div class="card lg-post"><span class="date">${fmtDate(p.post_date)}</span><h3>${esc(p.title)}</h3><p>${esc(excerpt(p.body))}</p><a href="/drifters/post/${esc(p.id)}">Read more &rarr;</a></div>`).join('')
    : '<p class="lg-empty">No news yet. Watch this space.</p>';

  const byDay = new Map();
  for (const e of events) {
    if (!byDay.has(e.day)) byDay.set(e.day, { label: e.day_label || '', items: [] });
    const d = byDay.get(e.day);
    if (!d.label && e.day_label) d.label = e.day_label;
    d.items.push(e);
  }
  const schedule = byDay.size
    ? [...byDay.entries()].map(([day, d]) => `<div class="lg-day"><div class="when">${fmtDay(day)}${d.label ? `<small>${esc(d.label)}</small>` : ''}</div><div>${d.items.map((e) => `<div class="lg-ev"><time>${e.start_time ? fmtTime(e.start_time) : ''}</time><div>${esc(e.title)}${e.detail ? `<span>${esc(e.detail)}</span>` : ''}</div></div>`).join('')}</div></div>`).join('')
    : '<p class="lg-empty">The Drifters schedule will be posted here as events are confirmed.</p>';

  const dateList = dates.length
    ? `<ul class="lg-dates">${dates.map((d) => { const p = parseYmd(d.due_date); return `<li><div class="d"><small>${p ? MONTHS[p.mo - 1].slice(0, 3) : ''}</small><b>${p ? p.d : ''}</b></div><div class="t">${esc(d.title)}${d.detail ? `<span>${esc(d.detail)}</span>` : ''}</div></li>`; }).join('')}</ul>`
    : '<p class="lg-empty">No deadlines posted yet.</p>';

  const linkList = links.length
    ? `<div style="display:grid;gap:.7rem;">${links.map((l) => `<a class="lg-doc" href="${esc(l.url)}" target="_blank" rel="noopener"><div class="ic">&#128279;</div><div><b>${esc(l.title)}</b>${l.note ? `<small>${esc(l.note)}</small>` : ''}</div></a>`).join('')}</div>`
    : '<p class="lg-empty">Documents and links will appear here.</p>';

  return head('Drifters Dive Bar') + `
<section class="lg-hero"><div class="container">
  <div>
    <span class="hero-script">Welcome aboard, Drifters</span>
    <h1>The Drifters Dive Bar</h1>
    <p class="hero-lede" style="margin:0;">Everything for our booked PHlock in one place: the schedule, the latest news, the deadlines and the people to call. Private to the 2027 sailing.</p>
    <div class="lg-meta"><span><b>${daysToSail()}</b> days to sail</span><span class="sep"></span><span>June 26 to July 3, 2027</span><span class="sep"></span><span>Margaritaville at Sea Beachcomber</span></div>
  </div>
  ${pinned}
</div></section>

<section><div class="container">
  <div class="section-head"><span class="eyebrow">Latest from the PHlock</span><h2>News &amp; Newsletters</h2></div>
  <div class="grid grid-3">${postCards}</div>
</div></section>

<section class="bg-navy"><div class="container">
  <div class="section-head"><span class="eyebrow">What's happening</span><h2 style="color:var(--gold-light);">Drifters Schedule</h2><p class="tagline">Private events for our group. Times are local and may shift a little; this page always has the latest.</p></div>
  ${schedule}
</div></section>

<section class="bg-cream-dark"><div class="container">
  <div class="grid grid-2" style="gap:var(--space-5);align-items:flex-start;">
    <div><div class="section-head" style="text-align:left;margin:0 0 1.2rem;"><span class="eyebrow">Don't miss</span><h2>Key dates &amp; deadlines</h2></div>${dateList}</div>
    <div><div class="section-head" style="text-align:left;margin:0 0 1.2rem;"><span class="eyebrow">Handy</span><h2>Documents &amp; links</h2></div>${linkList}</div>
  </div>
</div></section>
${crewCards()}` + foot(who);
}

function postPage(who, post) {
  return head(post.title) + `
<section><div class="container lg-article">
  <p><a href="/drifters">&larr; Back to the Dive Bar</a></p>
  <span class="date">${fmtDate(post.post_date)}</span>
  <h1 style="margin:.3rem 0 1.2rem;">${esc(post.title)}</h1>
  <div class="body">${richText(post.body) || '<p class="lg-empty">This post has no text yet.</p>'}</div>
</div></section>` + foot(who);
}

// ---- public handler ----
export async function handleLounge(request, env, url) {
  if (!env.DB) return html('<p>The Dive Bar is temporarily unavailable.</p>', 503);
  await ensureSchema(env.DB);
  const path = url.pathname.replace(/\/+$/, '') || '/drifters';
  const method = request.method.toUpperCase();

  if (path === '/drifters/logout' && method === 'POST') {
    const guest = await currentGuest(request, env);
    if (guest) await deleteDrifterSession(env.DB, guest.sid);
    return redirect('/drifters', { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly` });
  }

  if (path === '/drifters/login' && method === 'POST') {
    const settings = await getLoungeSettings(env.DB);
    if (settings.enabled === '0') return redirect('/drifters');
    let form;
    try {
      form = await request.formData();
    } catch {
      return redirect('/drifters?err=missing');
    }
    const nameIn = clip(form.get('last_name'), 80);
    const resIn = clip(form.get('res_number'), 40);
    const raw = nameIn.toLowerCase().replace(/[^a-z' \-]/g, ' ').replace(/\s+/g, ' ').trim();
    const res = resIn.replace(/[^0-9a-z]/gi, '');
    // Keep a short log of attempts so a "my phone won't let me in" can be read
    // back exactly as the phone sent it.
    const log = async (outcome) => {
      try {
        await insertLoungeSignin(env.DB, {
          id: crypto.randomUUID(),
          created_at: Date.now(),
          outcome,
          name_entered: nameIn.slice(0, 80),
          res_entered: resIn.slice(0, 40),
          ua: clip(request.headers.get('User-Agent'), 200),
        });
      } catch {
        /* logging never blocks sign-in */
      }
    };
    if (!raw || !res) {
      await log('missing');
      return redirect('/drifters?err=missing');
    }
    // People type "Jim Dunn" or "Dunn, James" in a box labelled last name. Try
    // the whole entry first, then each word (last word first), so any name on
    // the booking gets them in.
    const words = raw.split(' ').filter((w) => w.length >= 2);
    const candidates = [...new Set([raw, ...words.slice().reverse()])];
    let cabin = null;
    for (const c of candidates) {
      cabin = await findCabinForSignIn(env.DB, res, c);
      if (cabin) break;
    }
    if (!cabin) {
      await log('nomatch');
      return redirect('/drifters?err=nomatch');
    }
    await log('ok');
    const token = randomToken(32);
    const now = Date.now();
    await createDrifterSession(env.DB, {
      id: await sha256Hex(token),
      cabin_id: cabin.id,
      guest_name: clip(cabin.name, 120),
      created_at: now,
      expires_at: now + SESSION_DAYS * 86400000,
    });
    // ?welcome=1 lets the next request tell "cookie did not stick" apart from a cold visit.
    return redirect('/drifters?welcome=1', {
      'Set-Cookie': `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; SameSite=Lax; Secure; HttpOnly`,
    });
  }

  if (method !== 'GET' && method !== 'HEAD') return new Response('Method not allowed', { status: 405 });

  const who = await viewer(request, env);
  const settings = await getLoungeSettings(env.DB);
  const closed = settings.enabled === '0' && !(who && who.admin);

  const postMatch = /^\/drifters\/post\/([A-Za-z0-9-]{1,60})$/.exec(path);
  if (postMatch) {
    if (!who || closed) return redirect('/drifters');
    const post = await getLoungeRow(env.DB, 'posts', postMatch[1]);
    if (!post || (!post.published && !who.admin)) return html(head('Not found') + '<section><div class="container"><p>That post isn\'t available. <a href="/drifters">Back to the Dive Bar</a></p></div></section>' + foot(who.name), 404);
    return html(postPage(who.name, post));
  }

  if (path !== '/drifters') return redirect('/drifters');
  if (!who || closed) {
    const inApp = /FBAN|FBAV|FB_IAB|Instagram|Messenger/i.test(request.headers.get('User-Agent') || '');
    // Arrived straight from a successful sign-in with no session: the browser dropped the cookie.
    const err = !closed && url.searchParams.get('welcome') === '1' ? 'cookies' : url.searchParams.get('err') || '';
    return html(gatePage(err, closed, inApp));
  }

  const [posts, events, dates, links] = await Promise.all([
    listLounge(env.DB, 'posts'),
    listLounge(env.DB, 'events'),
    listLounge(env.DB, 'dates'),
    listLounge(env.DB, 'links'),
  ]);
  return html(loungePage(who.name, settings, posts.filter((p) => p.published || who.admin), events, dates, links));
}

// ---- admin API ----
function cleanRow(type, b) {
  const row = {};
  if (b.id) row.id = clip(b.id, 60);
  if (type === 'posts') {
    if (b.title !== undefined) row.title = clip(b.title, 200);
    if (b.body !== undefined) row.body = clip(b.body, 20000);
    if (b.post_date !== undefined) row.post_date = parseYmd(b.post_date) ? clip(b.post_date, 10) : '';
    if (b.published !== undefined) row.published = b.published ? 1 : 0;
  } else if (type === 'events') {
    if (b.day !== undefined) row.day = parseYmd(b.day) ? clip(b.day, 10) : '';
    if (b.start_time !== undefined) row.start_time = /^\d{1,2}:\d{2}$/.test(String(b.start_time || '').trim()) ? clip(b.start_time, 5).padStart(5, '0') : '';
    if (b.title !== undefined) row.title = clip(b.title, 200);
    if (b.detail !== undefined) row.detail = clip(b.detail, 500);
    if (b.day_label !== undefined) row.day_label = clip(b.day_label, 40);
  } else if (type === 'dates') {
    if (b.due_date !== undefined) row.due_date = parseYmd(b.due_date) ? clip(b.due_date, 10) : '';
    if (b.title !== undefined) row.title = clip(b.title, 200);
    if (b.detail !== undefined) row.detail = clip(b.detail, 500);
  } else if (type === 'links') {
    if (b.title !== undefined) row.title = clip(b.title, 200);
    if (b.note !== undefined) row.note = clip(b.note, 200);
    if (b.url !== undefined) row.url = /^https?:\/\//i.test(String(b.url || '').trim()) ? clip(b.url, 1000) : '';
    if (b.sort_order !== undefined) row.sort_order = parseInt(b.sort_order, 10) || 0;
  }
  return row;
}

function missing(type, row, isNew) {
  const need = { posts: ['title'], events: ['day', 'title'], dates: ['due_date', 'title'], links: ['title', 'url'] }[type];
  for (const k of need) {
    if (isNew ? !row[k] : row[k] !== undefined && !row[k]) return k;
  }
  return null;
}

export async function handleLoungeAdmin(request, env, url) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'unauthorized' }, 401);
  await ensureSchema(env.DB);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === '/api/admin/lounge/signins' && method === 'GET') {
    return json({ signins: await listLoungeSignins(env.DB, 100) });
  }

  if (path === '/api/admin/lounge' && method === 'GET') {
    const [settings, posts, events, dates, links] = await Promise.all([
      getLoungeSettings(env.DB),
      listLounge(env.DB, 'posts'),
      listLounge(env.DB, 'events'),
      listLounge(env.DB, 'dates'),
      listLounge(env.DB, 'links'),
    ]);
    return json({ settings, posts, events, dates, links });
  }

  if (method !== 'POST') return json({ error: 'not_found' }, 404);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }

  if (path === '/api/admin/lounge/settings') {
    if (body.enabled !== undefined) await setLoungeSetting(env.DB, 'enabled', body.enabled ? '1' : '0');
    if (body.pinned_title !== undefined) await setLoungeSetting(env.DB, 'pinned_title', clip(body.pinned_title, 160));
    if (body.pinned_body !== undefined) await setLoungeSetting(env.DB, 'pinned_body', clip(body.pinned_body, 2000));
    return json({ ok: true, settings: await getLoungeSettings(env.DB) });
  }

  const m = /^\/api\/admin\/lounge\/(posts|events|dates|links)(?:\/(delete))?$/.exec(path);
  if (!m || !LOUNGE_TYPES[m[1]]) return json({ error: 'not_found' }, 404);
  const type = m[1];

  if (m[2] === 'delete') {
    const id = clip(body.id, 60);
    if (!id) return json({ error: 'missing_id' }, 400);
    await deleteLounge(env.DB, type, id);
    return json({ ok: true });
  }

  const row = cleanRow(type, body);
  const lacks = missing(type, row, !row.id);
  if (lacks) return json({ error: 'missing_' + lacks }, 400);
  const id = await saveLounge(env.DB, type, row);
  return json({ ok: true, id });
}
