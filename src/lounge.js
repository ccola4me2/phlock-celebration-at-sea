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
//   GET  /drifters/post/<id>    one news post in full (with a sign-up form when the post has a button)
//   POST /drifters/signup       a signed-in cabin signs up for, changes or cancels an event post
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
  getCabin,
  insertSubscriber,
  listSubscribersForCabin,
  listSubscribers,
  unsubscribeByToken,
  removeOptOut,
  pendingCabinEmails,
  setPostEmailed,
  ensureReferralLink,
  listReferralBoard,
  listPirates,
  countPirates,
  getSignup,
  saveSignup,
  deleteSignup,
  listSignups,
  signupTotals,
  cabinSignups,
} from './db.js';
import { christenPirate, previewPirate } from './pirates.js';
import { json, parseCookies, randomToken, sha256Hex, testAddress } from './util.js';

const SITE = 'https://parrotheadscruise.com';
// A sign-in can send the guest back to the one post they came for (a shared sign-up link).
const POST_PATH = /^\/drifters\/post\/[A-Za-z0-9-]{1,60}$/;
const COOKIE = 'phc_drifter';
const SESSION_DAYS = 90;
// A second, short-lived pass rides on the link after sign-in, for browsers that drop the cookie.
const LINK_HOURS = 24;
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
      { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, private', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'strict-origin-when-cross-origin' },
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
async function sessionFor(env, token) {
  if (!token || !env.DB) return null;
  const sess = await getDrifterSession(env.DB, await sha256Hex(token));
  if (!sess || sess.expires_at < Date.now()) return null;
  return sess;
}

// The cookie first; failing that, the pass carried on the link (?s=) for
// browsers that refuse to keep cookies (Facebook's in-app browser, some phones).
async function currentGuest(request, env, url) {
  const byCookie = await sessionFor(env, parseCookies(request)[COOKIE]);
  if (byCookie) return { cabin_id: byCookie.cabin_id, name: byCookie.guest_name || 'Drifter', sid: byCookie.id, via: 'cookie' };
  const t = url ? clip(url.searchParams.get('s'), 80) : '';
  const byLink = await sessionFor(env, t);
  if (byLink) return { cabin_id: byLink.cabin_id, name: byLink.guest_name || 'Drifter', sid: byLink.id, via: 'link', token: t };
  return null;
}

async function viewer(request, env, url) {
  const guest = await currentGuest(request, env, url);
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
  .lg-post .pic { display:block; width:100%; height:150px; object-fit:contain; object-position:center; margin:0 0 .8rem; border-radius:10px; background:#fff; padding:.5rem; box-sizing:border-box; }
  .lg-post .pic.poster { height:240px; object-position:center; }
  .lg-post .btn-signup { display:block; margin-top:auto; text-align:center; background:var(--gold); color:var(--navy-900); font-weight:700; padding:.7rem 1rem; border-radius:10px; text-decoration:none; }
  .lg-post .btn-signup:hover { filter:brightness(1.06); }
  .lg-post .btn-signup + a { margin-top:.6rem; text-align:center; }
  .lg-signup { margin:2rem 0 0; border-left:5px solid var(--gold); }
  .lg-signup .tag { font-size:.7rem; letter-spacing:.12em; text-transform:uppercase; font-weight:700; color:#8a6d1f; }
  .lg-signup h2 { margin:.3rem 0 .3rem; font-size:1.3rem; }
  .lg-signup .cab { margin:0 0 1rem; color:var(--ink-soft); font-size:.95rem; }
  .lg-signup label { display:block; font-weight:600; font-size:.9rem; margin:.8rem 0 .3rem; }
  .lg-signup select, .lg-signup input[type=text], .lg-signup textarea { width:100%; box-sizing:border-box; padding:.7rem .8rem; font:inherit; border:1px solid #cdbf93; border-radius:8px; background:#fff; }
  .lg-signup .row { display:flex; flex-wrap:wrap; gap:.7rem; align-items:center; margin-top:1rem; }
  .lg-signup .btn-cancel { background:none; border:none; color:#8a3b2b; text-decoration:underline; cursor:pointer; font:inherit; padding:.4rem; }
  .lg-signup .in { background:#e9f6ec; border:1px solid #a9d6b5; color:#1d5d33; border-radius:8px; padding:.7rem .9rem; margin:0 0 .8rem; font-weight:600; }
  .lg-signup .msg { margin-top:.7rem; font-size:.92rem; } .lg-signup .msg.err { color:#a02a1c; }
  .lg-release { max-height:260px; overflow:auto; border:1px solid #cdbf93; border-radius:10px; background:#fffdf6; padding:.8rem 1rem; margin-top:1.2rem; font-size:.88rem; line-height:1.5; color:var(--ink-soft); }
  .lg-release b.h { display:block; color:var(--navy-900); margin-bottom:.5rem; font-size:.95rem; }
  .lg-release p { margin:0 0 .65rem; } .lg-release p:last-child { margin-bottom:0; }
  .lg-signup label.lg-agree { display:flex; gap:.6rem; align-items:flex-start; font-weight:600; margin:.8rem 0 0; cursor:pointer; }
  .lg-agree input { width:1.15rem; height:1.15rem; margin-top:.15rem; flex:none; accent-color:#8a6d1f; }
  .lg-opts { display:grid; gap:.7rem; margin:.5rem 0 .2rem; }
  .lg-opt { display:flex; gap:.8rem; align-items:center; border:1px solid #cdbf93; border-radius:10px; background:#fff; padding:.5rem; }
  .lg-opt img { width:104px; height:70px; object-fit:cover; border-radius:8px; flex:none; background:#eee; }
  .lg-opt .t { flex:1; min-width:0; display:flex; flex-direction:column; gap:.15rem; }
  .lg-opt .t b { font-size:.95rem; line-height:1.25; color:var(--navy-900); }
  .lg-opt .t .p { font-weight:700; color:#1a3d6d; font-size:.95rem; }
  .lg-opt .t .n { font-size:.82rem; color:var(--ink-soft); line-height:1.35; }
  .lg-opt .qty { flex:none; display:flex; flex-direction:column; align-items:center; gap:.2rem; font-size:.7rem; letter-spacing:.08em; text-transform:uppercase; color:#8a6d1f; font-weight:700; }
  .lg-signup .lg-opt select { width:68px; padding:.55rem .4rem; text-align:center; }
  @media (max-width:520px) { .lg-opt { flex-wrap:wrap; gap:.5rem .7rem; } .lg-opt img { width:72px; height:52px; } .lg-opt .t { flex:1 1 0; min-width:0; } .lg-opt .qty { flex:1 1 100%; flex-direction:row; justify-content:space-between; align-items:center; border-top:1px solid #eee3c3; padding-top:.5rem; font-size:.75rem; } .lg-signup .lg-opt select { width:84px; } }
  .lg-article .hero-pic { display:block; max-width:420px; width:100%; height:auto; margin:0 0 1.4rem; }
  .lg-article .hero-pic.poster { max-width:600px; margin:0 auto 1.8rem; border-radius:14px; box-shadow:0 10px 30px rgba(6,15,28,.22); }
  .lg-day { display:grid; grid-template-columns:180px 1fr; gap:1.2rem; padding:1.1rem 0; border-bottom:1px solid rgba(255,255,255,.12); }
  .lg-day:last-child { border-bottom:none; }
  .lg-day .when { font-family:var(--font-display); color:var(--gold-light); font-size:.95rem; line-height:1.3; }
  .lg-day .when small { display:block; font-family:var(--font-body); color:rgba(255,255,255,.6); font-size:.74rem; letter-spacing:.08em; text-transform:uppercase; margin-top:.2rem; }
  .lg-ev { display:flex; gap:1rem; padding:.45rem 0; }
  .lg-ev time { flex:none; width:84px; color:#fff; font-weight:600; font-size:.9rem; }
  .lg-ev div { color:rgba(255,255,255,.85); font-size:.95rem; }
  .lg-ev div span { display:block; color:rgba(255,255,255,.55); font-size:.82rem; }
  .lg-ev .btn-ev { display:inline-block; margin-top:.35rem; background:var(--gold); color:var(--navy-900); font-weight:700; font-size:.7rem; line-height:1.2; letter-spacing:.02em; padding:.2rem .55rem; border-radius:5px; text-decoration:none; }
  .lg-ev .btn-ev:hover { filter:brightness(1.06); }
  @media (max-width: 640px) { .lg-ev .btn-ev { display:block; width:100%; box-sizing:border-box; text-align:center; margin-top:.7rem; font-size:.95rem; line-height:1.2; padding:.8rem 1rem; border-radius:10px; } }
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
  .lg-you { display:grid; grid-template-columns:1fr 1fr; gap:1.4rem; margin-top:-1.6rem; position:relative; z-index:2; }
  .lg-ref { margin-top:1.4rem; }
  .lg-you > .card { min-width:0; }
  .lg-ref .lg-link { display:flex; gap:.5rem; align-items:center; margin:.7rem 0 .4rem; }
  .lg-ref .lg-link input { flex:1 1 160px; width:100%; min-width:0; padding:.7em .8em; font:inherit; font-size:.95rem; border:1px solid var(--cream-dark); border-radius:10px; background:#fff; color:var(--navy-900); }
  .lg-ref .lg-link .btn { border:none; cursor:pointer; font:inherit; white-space:nowrap; }
  .lg-share { display:flex; gap:.5rem; flex-wrap:wrap; margin-top:.5rem; }
  .lg-share a { display:inline-flex; align-items:center; gap:.35rem; padding:.5em .9em; border-radius:999px; border:1px solid var(--navy-900); color:var(--navy-900); text-decoration:none; font-size:.85rem; font-weight:600; }
  .lg-share a:hover { background:var(--navy-900); color:#fff; }
  .lg-board { list-style:none; margin:.6rem 0 0; padding:0; }
  .lg-board li { display:flex; align-items:center; gap:.8rem; padding:.55rem 0; border-top:1px solid var(--cream-dark); font-size:.95rem; }
  .lg-board li:first-child { border-top:none; }
  .lg-board .rk { flex:none; width:30px; height:30px; border-radius:50%; background:var(--navy-900); color:var(--gold-light); font-weight:700; display:flex; align-items:center; justify-content:center; font-size:.85rem; }
  .lg-board li:first-child .rk { background:var(--gold); color:var(--navy-900); }
  .lg-board .who { flex:1; min-width:0; color:var(--navy-900); font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .lg-board .who small { display:block; font-weight:400; color:var(--ink-soft); font-size:.8rem; }
  .lg-board .n { flex:none; text-align:right; color:var(--ink-soft); font-size:.82rem; line-height:1.2; }
  .lg-board .n b { display:block; color:var(--navy-900); font-size:1.05rem; }
  .lg-board .me { background:#fbf6e6; margin:0 -.6rem; padding-left:.6rem; padding-right:.6rem; border-radius:8px; }
  @media (max-width: 760px) {
    .lg-board li { flex-wrap:wrap; row-gap:.15rem; }
    .lg-board .who { flex:1 1 calc(100% - 42px); white-space:normal; }
    .lg-board .n { margin-left:42px; text-align:left; display:flex; gap:.3rem; align-items:baseline; }
    .lg-board .n ~ .n { margin-left:0; }
    .lg-board .n ~ .n::before { content:"\\00b7"; margin-right:.3rem; }
    .lg-board .n b { display:inline; font-size:1rem; }
  }
  .lg-pirate .row { display:flex; gap:.6rem; flex-wrap:wrap; margin-top:.7rem; }
  .lg-pirate input { flex:1 1 180px; min-width:0; padding:.75em .9em; font:inherit; border:1px solid var(--cream-dark); border-radius:10px; background:#fff; }
  .lg-pirate .btn { border:none; cursor:pointer; font:inherit; }
  .lg-pirate .result { margin-top:1rem; padding:1.1rem 1.2rem; background:var(--navy-900); color:#fff; border-radius:14px; position:relative; overflow:hidden; }
  .lg-pirate .result::after { content:"\\2620"; position:absolute; right:-6px; bottom:-26px; font-size:7rem; opacity:.08; }
  .lg-pirate .result small { display:block; font-size:.72rem; letter-spacing:.14em; text-transform:uppercase; color:var(--gold-light); margin-bottom:.3rem; }
  .lg-pirate .result b { font-family:var(--font-display); font-size:1.6rem; line-height:1.15; display:block; color:#fff; }
  .lg-pirate .result p { margin:.5rem 0 0; color:rgba(255,255,255,.8); font-size:.92rem; position:relative; }
  .lg-pirate .share { display:flex; gap:.5rem; flex-wrap:wrap; margin-top:.8rem; position:relative; }
  .lg-pirate .share a, .lg-pirate .share button { display:inline-flex; align-items:center; gap:.35rem; padding:.5em .9em; border-radius:999px; border:1px solid var(--gold); color:var(--gold-light); background:transparent; text-decoration:none; font:inherit; font-size:.85rem; font-weight:600; cursor:pointer; }
  .lg-pirate .share a:hover, .lg-pirate .share button:hover { background:var(--gold); color:var(--navy-900); }
  .lg-pirate .again { margin:.6rem 0 0; font-size:.85rem; color:var(--ink-soft); }
  .lg-pirate .again a { color:var(--navy-900); }
  .lg-crew .who { white-space:normal; }
  .lg-crew .who small { color:var(--ink-soft); }
  .lg-prize { margin:.6rem 0 0; padding:.6em .9em; background:#fbf6e6; border-left:3px solid var(--gold); border-radius:6px; font-size:.9rem; color:var(--ink); }
  .lg-you .card { padding:1.4rem 1.5rem; }
  .lg-you .eyebrow { display:block; margin-bottom:.4rem; }
  .lg-cabin-no { font-family:var(--font-display); font-size:2.6rem; line-height:1; color:var(--navy-900); margin:.1rem 0 .3rem; }
  .lg-cabin-no small { font-family:var(--font-body); font-size:.8rem; color:var(--ink-soft); letter-spacing:.08em; text-transform:uppercase; margin-left:.5rem; }
  .lg-kv { margin:0; padding:0; list-style:none; font-size:.95rem; color:var(--ink); }
  .lg-kv li { display:flex; gap:.6rem; padding:.3rem 0; border-top:1px solid var(--cream-dark); }
  .lg-kv li:first-child { border-top:none; }
  .lg-kv li > span:first-child { flex:none; width:110px; color:var(--ink-soft); font-size:.78rem; letter-spacing:.08em; text-transform:uppercase; padding-top:.15em; }
  .lg-badge { display:inline-block; white-space:nowrap; background:var(--navy-900); color:var(--gold-light); font-size:.7rem; font-weight:700; letter-spacing:.08em; text-transform:uppercase; padding:.25em .7em; border-radius:999px; }
  .lg-sub form { display:flex; gap:.6rem; flex-wrap:wrap; margin-top:.6rem; }
  .lg-sub input[type=email] { flex:1 1 200px; padding:.75em .9em; font:inherit; border:1px solid var(--cream-dark); border-radius:10px; background:#fff; }
  .lg-sub .btn { border:none; cursor:pointer; font:inherit; }
  .lg-sub .ok { background:#e6f4ea; color:#1e6b3a; border-radius:8px; padding:.6em .9em; font-size:.9rem; margin:.5rem 0 0; }
  .lg-sub .err { background:#fdecec; color:#8a2a2a; border-radius:8px; padding:.6em .9em; font-size:.9rem; margin:.5rem 0 0; }
  .lg-sub .list { margin:.6rem 0 0; padding:0; list-style:none; font-size:.9rem; color:var(--ink-soft); }
  @media (max-width: 760px) { .lg-you { grid-template-columns:1fr; margin-top:1rem; } }
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

function foot(who, pass) {
  const hidden = pass ? `<input type="hidden" name="s" value="${esc(pass)}">` : '';
  return `</main>
<footer class="site-footer"><div class="container"><div class="footer-bottom lg-foot">
  <span>&copy; 2026&ndash;2027 Prestige Travel Vacations LLC, Turner Travel, &amp; Cruises Tours &amp; Travel. The Drifters Dive Bar is private to booked guests.</span>
  ${who ? `<span>Signed in as ${esc(who)} &middot; <form method="post" action="/drifters/logout" style="display:inline">${hidden}<button type="submit">Sign out</button></form></span>` : ''}
</div></div></footer>
<script src="/js/main.js"></script></body></html>`;
}

// ---- pages ----
function gatePage(err, closed, inApp, next) {
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
    ${next && POST_PATH.test(next) ? `<input type="hidden" name="next" value="${esc(next)}">` : ''}
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

function yourCabinCard(cabin, extra) {
  if (!cabin) {
    return `<div class="card"><span class="eyebrow">Your cabin</span><p class="lg-empty" style="text-align:left;padding:.3rem 0 0;">${extra && extra.admin ? 'Admin preview: each guest sees their own cabin here.' : 'We couldn\'t load your cabin. Text your advisor and we\'ll sort it.'}</p></div>`;
  }
  const drifter = String(cabin.drifter || '').toLowerCase();
  const badge = drifter === 'current' ? 'Returning Drifter' : drifter === 'new' ? 'New Drifter' : '';
  return `<div class="card">
    <span class="eyebrow">Your cabin</span>
    <div class="lg-cabin-no">${cabin.cabin_number ? esc(cabin.cabin_number) : 'TBA'}${cabin.cabin_number ? '' : '<small>Assigned closer to sailing</small>'}</div>
    <ul class="lg-kv">
      ${cabin.cabin_type ? `<li><span>Type</span><span>${esc(cabin.cabin_type)}</span></li>` : ''}
      <li><span>Sailing as</span><span>${esc(cabin.name)}</span></li>
      <li><span>Reservation</span><span>${esc(cabin.res_number)}</span></li>
      ${badge ? `<li><span>Status</span><span><span class="lg-badge">${badge}</span></span></li>` : ''}
    </ul>
    <p class="lg-empty" style="text-align:left;padding:.7rem 0 0;font-size:.85rem;">Something look off? Text Lori, Dawn or Brent and we'll fix it.</p>
  </div>`;
}

const SHARE_TEXT = "I'm sailing on the International Parrothead Day Cruise, June 26 to July 3, 2027, on the brand new Margaritaville at Sea Beachcomber. Come with us! Here's everything about it: ";

// Bring a friend: the cabin's own link, the ways to share it, and the board.
function referralSection(link, board, cabin, settings, extra) {
  if (settings.referral_on === '0') return '';
  const mine = cabin ? cabin.id : '';
  const prize = settings.referral_prize
    ? `<p class="lg-prize">&#127942; ${esc(settings.referral_prize)}</p>`
    : '<p class="lg-prize">&#127942; Prize to be announced. Bragging rights are already on the table.</p>';
  let linkCard;
  if (link) {
    const url = `${SITE}/go/${link.code}`;
    const text = encodeURIComponent(SHARE_TEXT + url);
    linkCard = `<div class="card">
    <span class="eyebrow">Bring a friend</span>
    <h3 style="margin:0 0 .3rem;">Your cabin's link</h3>
    <p style="margin:0;color:var(--ink-soft);font-size:.95rem;">Every friend who asks about the cruise through this link counts for your cabin. Post it, email it, share it. When they book, you climb the board.</p>
    <div class="lg-link"><input type="text" value="${esc(url)}" readonly onclick="this.select()" id="refUrl"><button class="btn btn-gold" type="button" id="refCopy">Copy</button></div>
    <div class="lg-share">
      <a href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}" target="_blank" rel="noopener">&#128216; Facebook</a>
      <a href="mailto:?subject=${encodeURIComponent('Come cruise with us, June 2027')}&amp;body=${text}">&#9993;&#65039; Email</a>
      <a href="#" id="refShare" hidden>&#128228; Share</a>
    </div>
    ${prize}
  </div>`;
  } else {
    linkCard = `<div class="card"><span class="eyebrow">Bring a friend</span><p class="lg-empty" style="text-align:left;padding:.3rem 0 0;">${extra && extra.admin ? 'Admin preview: each cabin sees its own share link here.' : 'Your share link is on its way. Check back in a moment.'}</p>${prize}</div>`;
  }
  const active = board.filter((b) => b.signups > 0 || b.clicks > 0);
  const rows = active.slice(0, 10).map((b, i) => `<li${b.cabin_id === mine ? ' class="me"' : ''}><span class="rk">${i + 1}</span><span class="who">${esc(b.name || 'A Drifter cabin')}<small>${b.cabin_number ? 'Cabin ' + esc(b.cabin_number) : ''}${b.cabin_id === mine ? (b.cabin_number ? ' · ' : '') + 'That\'s you' : ''}</small></span><span class="n"><b>${b.signups}</b>${b.signups === 1 ? 'friend asked' : 'friends asked'}</span><span class="n"><b>${b.booked}</b>booked</span><span class="n"><b>${b.clicks}</b>clicks</span></li>`).join('');
  const boardCard = `<div class="card">
    <span class="eyebrow">The board</span>
    <h3 style="margin:0 0 .3rem;">Who's bringing the PHlock</h3>
    ${rows ? `<ul class="lg-board">${rows}</ul>` : '<p class="lg-empty" style="text-align:left;padding:.3rem 0 0;">Nobody has shared a link yet. First click goes on the board.</p>'}
    <p style="margin:.8rem 0 0;color:var(--ink-soft);font-size:.82rem;">A friend counts when they send us their details through your link. A booking counts when their cabin is confirmed.</p>
  </div>`;
  return `<section id="friends" style="padding-top:0;"><div class="container"><div class="lg-you lg-ref">${linkCard}${boardCard}</div></div></section>
<script>(function(){var c=document.getElementById('refCopy'),u=document.getElementById('refUrl');if(c&&u){c.onclick=function(){u.select();var done=function(){c.textContent='Copied';setTimeout(function(){c.textContent='Copy';},1600);};if(navigator.clipboard){navigator.clipboard.writeText(u.value).then(done,function(){document.execCommand('copy');done();});}else{document.execCommand('copy');done();}};}var s=document.getElementById('refShare');if(s&&u&&navigator.share){s.hidden=false;s.onclick=function(e){e.preventDefault();navigator.share({title:'International Parrothead Day Cruise 2027',text:${JSON.stringify(SHARE_TEXT)},url:u.value}).catch(function(){});};}})();</script>`;
}

// ---- Parrots & Pirates: the name generator ----
// The names themselves are made in pirates.js, on the server, so that no two Drifters are handed
// the same nickname, title, duty or weapon. The page only asks and shows the answer.
function pirateSection(crew, settings, extra, pass) {
  if (settings.pirate_on === '0') return '';
  const rows = (crew || []).map((c) => `<li><span class="rk">&#9760;</span><span class="who">${esc(c.pirate_name)}<small>${c.cabin_number ? 'Cabin ' + esc(c.cabin_number) : ''}${c.duty ? (c.cabin_number ? ' · ' : '') + esc(String(c.duty).replace(/^Duty aboard: /, '').replace(/\. Weapon.*$/, '')) : ''}</small></span></li>`).join('');
  return `<section id="pirates" style="padding-top:0;"><div class="container"><div class="lg-you lg-ref">
  <div class="card lg-pirate">
    <span class="eyebrow">Parrots &amp; Pirates</span>
    <h3 style="margin:0 0 .3rem;">What's your pirate name?</h3>
    <p style="margin:0;color:var(--ink-soft);font-size:.95rem;">Every Drifter needs one before Pirate Night. Type your first name and the Dive Bar will christen you. No two Drifters get the same name, and once you're christened it's yours for the voyage, so there's no weaseling out of it.</p>
    <div class="row"><input type="text" id="pn" placeholder="Your first name" autocomplete="given-name" autocapitalize="words" maxlength="40"><button class="btn btn-gold" type="button" id="pnGo">Christen me</button></div>
    <p class="again" id="pnErr" hidden></p>
    <div class="result" id="pnRes" hidden>
      <small>Hear ye, hear ye</small>
      <b id="pnOut"></b>
      <p id="pnDuty"></p>
      <div class="share">
        <button type="button" id="pnCopy">&#128203; Copy</button>
        <a id="pnFb" href="#" target="_blank" rel="noopener">&#128216; Facebook</a>
        <a id="pnShare" href="#" hidden>&#128228; Share</a>
      </div>
    </div>
    <p class="again" id="pnAgain" hidden>Now do your cabin mate and see who outranks whom.</p>
    <p class="again" id="pnNote" hidden>Admin preview: this name is not saved, so a guest may be given it. Guests keep the name they get.</p>
  </div>
  <div class="card lg-crew">
    <span class="eyebrow">The crew so far</span>
    <h3 style="margin:0 0 .3rem;">Recently christened</h3>
    <ul class="lg-board" id="pnCrew">${rows}</ul>
    <p class="lg-empty" id="pnEmpty" style="text-align:left;padding:.3rem 0 0;"${rows ? ' hidden' : ''}>Nobody has been christened yet. The first name on this list gets bragging rights for life.</p>
    <p style="margin:.8rem 0 0;color:var(--ink-soft);font-size:.82rem;">Pirate Night is one night of the sailing, date to be announced. Full regalia expected: hat, patch, beads and attitude.</p>
  </div>
</div></div></section>
<script>(function(){
var PASS=${JSON.stringify(pass || '')};
var $=function(i){return document.getElementById(i);};
function esc(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML;}
function renderCrew(list){var ul=$('pnCrew');ul.innerHTML=list.map(function(c){var d=(c.duty||'').replace(/^Duty aboard: /,'').replace(/\\. Weapon.*$/,'');return '<li><span class="rk">&#9760;</span><span class="who">'+esc(c.pirate_name)+'<small>'+(c.cabin_number?'Cabin '+esc(c.cabin_number):'')+(d?(c.cabin_number?' · ':'')+esc(d):'')+'</small></span></li>';}).join('');$('pnEmpty').hidden=list.length>0;}
function show(p,preview){$('pnOut').textContent=p.name;$('pnDuty').textContent=p.duty;$('pnRes').hidden=false;$('pnAgain').hidden=false;$('pnNote').hidden=!preview;
var msg='My pirate name for the International Parrothead Day Cruise is '+p.name+'. Get yours in the Drifters Dive Bar: https://parrotheadscruise.com/drifters';
$('pnFb').href='https://www.facebook.com/sharer/sharer.php?u='+encodeURIComponent('https://parrotheadscruise.com/drifters')+'&quote='+encodeURIComponent(msg);
var sh=$('pnShare');if(navigator.share){sh.hidden=false;sh.onclick=function(e){e.preventDefault();navigator.share({text:msg}).catch(function(){});};}
$('pnCopy').onclick=function(){var done=function(){$('pnCopy').textContent='Copied';setTimeout(function(){$('pnCopy').innerHTML='&#128203; Copy';},1500);};if(navigator.clipboard){navigator.clipboard.writeText(msg).then(done,done);}else{done();}};}
function fail(code){var e=$('pnErr');e.textContent=code==='missing_name'?'Type a first name, letters only.':code==='unauthorized'?'Your sign-in has timed out. Reload the page and sign in again.':"The ship's log is busy. Try again in a moment.";e.hidden=false;}
var busy=false;
function run(){var n=$('pn').value.trim();if(!n){$('pn').focus();return;}if(busy)return;busy=true;$('pnErr').hidden=true;var b=$('pnGo');b.disabled=true;b.textContent="Consulting the ship's log";
fetch('/drifters/pirate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,s:PASS})}).then(function(r){return r.json().then(function(d){return {ok:r.ok,d:d};});}).then(function(x){if(!x.ok||!x.d.pirate){fail(x.d&&x.d.error);}else{show(x.d.pirate,x.d.preview);if(x.d.crew)renderCrew(x.d.crew);}}).catch(function(){fail('');}).then(function(){busy=false;b.disabled=false;b.textContent='Christen me';});}
$('pnGo').onclick=run;$('pn').addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();run();}});
})();</script>`;
}

function emailCard(subs, extra, sfx, pass) {
  const state = extra ? extra.sub : '';
  const msg = state === 'ok'
    ? '<p class="ok">You\'re on the list. We\'ll email you when there\'s news.</p>'
    : state === 'dup'
      ? '<p class="ok">That email is already on the list for your cabin.</p>'
      : state === 'bad'
        ? '<p class="err">That email address doesn\'t look right. Try again?</p>'
        : '';
  const list = subs && subs.length
    ? `<ul class="list">${subs.map((s) => `<li>&#10003; ${esc(s.email)}</li>`).join('')}</ul>`
    : '';
  return `<div class="card lg-sub">
    <span class="eyebrow">Stay in the loop</span>
    <h3 style="margin:0 0 .3rem;">Get Dive Bar updates by email</h3>
    <p style="margin:0;color:var(--ink-soft);font-size:.95rem;">New posts, schedule changes and deadline reminders, straight to your inbox. One email per cabin is plenty; add two if you like.</p>
    ${msg}${list}
    <form method="post" action="/drifters/email${sfx}">
      ${pass ? `<input type="hidden" name="s" value="${esc(pass)}">` : ''}
      <input type="email" name="email" placeholder="you@example.com" autocomplete="email" autocapitalize="off" required>
      <button class="btn btn-gold" type="submit">${subs && subs.length ? 'Add another' : 'Keep me posted'}</button>
    </form>
  </div>`;
}

// A button on a schedule entry may point inside the Dive Bar; carry the 24-hour sign-in pass with it
// (before any #fragment) so a browser that drops cookies stays signed in.
function withPass(url, sfx) {
  if (!sfx || !/^\/drifters(\/|$|\?|#)/.test(url)) return url;
  const [path, frag] = url.split('#');
  return path + (path.includes('?') ? '&' + sfx.slice(1) : sfx) + (frag !== undefined ? '#' + frag : '');
}

function loungePage(who, settings, posts, events, dates, links, pass, extra) {
  const sfx = pass ? `?s=${encodeURIComponent(pass)}` : '';
  const youSection = `<section id="updates" style="padding-bottom:0;"><div class="container"><div class="lg-you">${yourCabinCard(extra && extra.cabin, extra)}${emailCard(extra && extra.subs, extra, sfx, pass)}</div></div></section>`;
  const linkNote = pass
    ? `<section style="padding:0;"><div class="container"><div class="lg-pinned" style="margin-top:1.2rem;border-left-color:#1a8fa3;"><span class="tag" style="color:#136f80;">Heads up</span><p>This browser isn't keeping you signed in, so the links on this page carry your sign-in for the next 24 hours. For the smoothest visit, open the Dive Bar in Safari or Chrome and sign in there.</p></div></div></section>`
    : '';
  const pinned = settings.pinned_title
    ? `<div class="lg-pinned"><span class="tag">Pinned</span><h3>${esc(settings.pinned_title)}</h3>${richText(settings.pinned_body)}</div>`
    : `<div class="lg-pinned"><span class="tag">Welcome</span><h3>You're in.</h3><p>News, the schedule and every deadline for our sailing live here. Check back often.</p></div>`;

  const postCards = posts.length
    ? posts.map((p) => `<div class="card lg-post">${p.image_url ? `<img class="pic${p.signup_label ? ' poster' : ''}" src="${esc(p.image_url)}" alt="" loading="lazy">` : ''}<span class="date">${fmtDate(p.post_date)}</span><h3>${esc(p.title)}</h3><p>${esc(excerpt(p.body))}</p>${p.signup_label ? `<a class="btn-signup" href="/drifters/post/${esc(p.id)}${sfx}#signup">${esc(p.signup_label)}${extra && extra.signed && extra.signed[p.id] ? ' &#10003;' : ''}</a>` : ''}<a href="/drifters/post/${esc(p.id)}${sfx}">Read more &rarr;</a></div>`).join('')
    : '<p class="lg-empty">No news yet. Watch this space.</p>';

  const byDay = new Map();
  for (const e of events) {
    if (!byDay.has(e.day)) byDay.set(e.day, { label: e.day_label || '', items: [] });
    const d = byDay.get(e.day);
    if (!d.label && e.day_label) d.label = e.day_label;
    d.items.push(e);
  }
  const schedule = byDay.size
    ? [...byDay.entries()].map(([day, d]) => `<div class="lg-day"><div class="when">${fmtDay(day)}${d.label ? `<small>${esc(d.label)}</small>` : ''}</div><div>${d.items.map((e) => `<div class="lg-ev"><time>${e.start_time ? fmtTime(e.start_time) : ''}</time><div>${esc(e.title)}${e.detail ? `<span>${esc(e.detail)}</span>` : ''}${e.link_label && e.link_url ? `<a class="btn-ev" href="${esc(withPass(e.link_url, sfx))}">${esc(e.link_label)}</a>` : ''}</div></div>`).join('')}</div></div>`).join('')
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
${linkNote}
${youSection}
${referralSection(extra && extra.refLink, (extra && extra.board) || [], extra && extra.cabin, settings, extra)}
${pirateSection((extra && extra.crew) || [], settings, extra, pass)}
<section><div class="container">
  <div class="section-head"><span class="eyebrow">Latest from the PHlock</span><h2>News &amp; Newsletters</h2></div>
  <div class="grid grid-3">${postCards}</div>
</div></section>

<section class="bg-navy"><div class="container">
  <div class="section-head"><span class="eyebrow">What's happening</span><h2 style="color:var(--gold-light);">Drifters Schedule</h2><p class="tagline">Private events for our group. Times are local and may shift a little; this page always has the latest.</p></div>
  ${schedule}
</div></section>

${dates.length || links.length ? `<section class="bg-cream-dark"><div class="container">
  <div class="grid${dates.length ? ' grid-2' : ''}" style="gap:var(--space-5);align-items:flex-start;">
    ${dates.length ? `<div><div class="section-head" style="text-align:left;margin:0 0 1.2rem;"><span class="eyebrow">Don't miss</span><h2>Key dates &amp; deadlines</h2></div>${dateList}</div>` : ''}
    <div><div class="section-head" style="text-align:left;margin:0 0 1.2rem;"><span class="eyebrow">Handy</span><h2>Documents &amp; links</h2></div>${linkList}</div>
  </div>
</div></section>` : ''}
${crewCards()}` + foot(who, pass);
}

// The sign-up form under a post that has a button. A guest signs up their own cabin (the one
// they signed in with), so every sign-up is tied to a reservation; an admin previewing sees the
// running count instead. `signup` is this cabin's saved row, if any.
// A sign-up post can offer choices: one per line, "Label | Price | Detail | Picture". The guest picks a
// quantity of each, so one form takes drinks, excursions, spa and so on for their own cabin.
function parseOptions(text) {
  const seen = new Set();
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const p = line.split('|').map((s) => s.trim());
    const label = (p[0] || '').slice(0, 80);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push({ label, price: (p[1] || '').slice(0, 80), note: (p[2] || '').slice(0, 200), image: /^(\/[^\s]*|https:\/\/[^\s]+)$/.test(p[3] || '') ? p[3] : '' });
    if (out.length >= 20) break;
  }
  return out;
}

function optionRows(opts, saved, live) {
  return opts.map((o, i) => `<div class="lg-opt">${o.image ? `<img src="${esc(o.image)}" alt="" loading="lazy">` : ''}<div class="t"><b>${esc(o.label)}</b>${o.price ? `<span class="p">${esc(o.price)}</span>` : ''}${o.note ? `<span class="n">${esc(o.note)}</span>` : ''}</div>${live ? `<label class="qty">Qty<select class="oq" data-i="${i}" aria-label="Quantity: ${esc(o.label)}">${[0, 1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}"${(saved[o.label] || 0) === n ? ' selected' : ''}>${n}</option>`).join('')}</select></label>` : ''}</div>`).join('');
}

// The release or terms text an admin pasted: blank lines separate paragraphs, nothing else is interpreted.
function releaseHtml(text) {
  return String(text || '').trim().split(/\n\s*\n/).map((p) => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');
}

function optionsBlock(post, opts, e, pass) {
  const rel = String(post.signup_release || '').trim();
  const relBox = rel ? `<div class="lg-release"><b class="h">Please read before you send</b>${releaseHtml(rel)}</div>` : '';
  if (e.admin && !e.cabin) {
    const t = e.totals || { cabins: 0, guests: 0 };
    return `<section id="signup" class="card lg-signup"><span class="tag">Request</span><h2>${esc(post.signup_label)}</h2><p class="cab">Admin preview. Guests see these choices, each with a quantity box, and the request is saved to their own cabin. So far: <b>${t.cabins || 0}</b> cabin${t.cabins === 1 ? '' : 's'}, <b>${t.guests || 0}</b> item${t.guests === 1 ? '' : 's'}. The full list is on the admin Dive Bar page.</p><div class="lg-opts">${optionRows(opts, {}, false)}</div>${relBox}${rel ? '<p class="cab" style="margin-top:.8rem;">Guests must tick a box to agree to this before their request will send.</p>' : ''}</section>`;
  }
  if (!e.cabin) return '';
  const su = e.signup;
  const saved = {};
  try { for (const x of JSON.parse((su && su.choices) || '[]')) if (x && x.label) saved[x.label] = x.qty; } catch { /* no saved choices */ }
  const who = `${e.cabin.cabin_number ? 'Cabin ' + esc(e.cabin.cabin_number) + ' &middot; ' : ''}${esc(e.cabin.name || '')}${e.cabin.res_number ? ' &middot; Res ' + esc(e.cabin.res_number) : ''}`;
  const labels = JSON.stringify(opts.map((o) => o.label)).replace(/</g, '\\u003c');
  return `<section id="signup" class="card lg-signup">
  <span class="tag">Request</span>
  <h2>${esc(post.signup_label)}</h2>
  <p class="cab">Adding to ${who}</p>
  <div class="in" id="su-in"${su ? '' : ' hidden'}>Your request is in: <span id="su-n">${su ? su.guests : ''}</span> item<span id="su-s">${su && su.guests === 1 ? '' : 's'}</span> from your cabin. Change it below any time.</div>
  <label>What would you like to add? Pick a quantity for each.</label>
  <div class="lg-opts">${optionRows(opts, saved, true)}</div>
  <label for="su-note">${rel ? 'Anything we should know? Medical conditions, mobility needs, ages of children, or any questions (optional). Share only what the tour operator needs to plan.' : 'Anything we should know? (optional)'}</label>
  <textarea id="su-note" rows="3" maxlength="500" placeholder="${rel ? 'Medical or mobility needs, ages, questions' : 'Names, ages, days, questions'}">${esc(su ? su.note : '')}</textarea>
  ${relBox}${rel ? '<label class="lg-agree" for="su-ok"><input type="checkbox" id="su-ok"><span>I have read the above and agree to it for myself and everyone I am signing up.</span></label>' : ''}
  <div class="row"><button class="btn btn-gold" id="su-go" type="button">${su ? 'Update my request' : 'Send my request'}</button><button class="btn-cancel" id="su-no" type="button"${su ? '' : ' hidden'}>Cancel my request</button></div>
  <div class="msg" id="su-msg" role="status" hidden></div>
</section>
<script>(function(){var PASS=${JSON.stringify(pass || '')},POST=${JSON.stringify(post.id)},LABELS=${labels},REL=${rel ? 'true' : 'false'};
var $=function(i){return document.getElementById(i);},busy=false,saved=${su ? 'true' : 'false'};
function msg(t,bad){var m=$('su-msg');m.textContent=t;m.className='msg'+(bad?' err':'');m.hidden=false;}
function pick(){var o={},t=0,q=document.querySelectorAll('.oq');for(var i=0;i<q.length;i++){var n=parseInt(q[i].value,10)||0;o[LABELS[+q[i].getAttribute('data-i')]]=n;t+=n;}return {o:o,t:t};}
function send(o){if(busy)return;busy=true;$('su-go').disabled=true;
fetch('/drifters/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({post:POST,choices:o,note:$('su-note').value,agree:REL?$('su-ok').checked:undefined,s:PASS})})
.then(function(r){return r.json().then(function(d){return {ok:r.ok,d:d};});})
.then(function(x){if(!x.ok){msg(x.d&&x.d.error==='off'?'Requests are closed for this offer.':x.d&&x.d.error==='agree'?'Please tick the box to agree first.':'Sorry, that did not save. Please try again, or text Lori, Dawn or Brent.',true);return;}
var n=x.d.guests||0;saved=n>0;$('su-in').hidden=!n;$('su-n').textContent=n;$('su-s').textContent=n===1?'':'s';$('su-no').hidden=!n;$('su-go').textContent=n?'Update my request':'Send my request';
msg(n?'Got it. We will price this with the sale and confirm with you.':'Your request was cancelled.',false);})
.catch(function(){msg('Sorry, that did not save. Please try again.',true);})
.then(function(){busy=false;$('su-go').disabled=false;});}
$('su-go').onclick=function(){var p=pick();if(!p.t){if(saved){if(confirm('Cancel the request for this cabin?'))send(p.o);}else msg('Choose at least one item first.',true);return;}
if(REL&&!$('su-ok').checked){msg('Please read the release above and tick the box to agree before you send.',true);$('su-ok').focus();return;}send(p.o);};
$('su-no').onclick=function(){if(confirm('Cancel the request for this cabin?')){var q=document.querySelectorAll('.oq');for(var i=0;i<q.length;i++)q[i].value='0';send(pick().o);}};
})();</script>`;
}

function signupBlock(post, extra, pass) {
  if (!post.signup_label) return '';
  const e = extra || {};
  const optList = parseOptions(post.signup_options);
  if (optList.length) return optionsBlock(post, optList, e, pass);
  if (e.admin && !e.cabin) {
    const t = e.totals || { cabins: 0, guests: 0 };
    return `<section id="signup" class="card lg-signup"><span class="tag">Sign-up</span><h2>${esc(post.signup_label)}</h2><p class="cab">Admin preview. Guests see a form here that signs up their own cabin. So far: <b>${t.cabins || 0}</b> cabin${t.cabins === 1 ? '' : 's'}, <b>${t.guests || 0}</b> guest${t.guests === 1 ? '' : 's'}. The full list is on the admin Dive Bar page.</p></section>`;
  }
  if (!e.cabin) return '';
  const su = e.signup;
  const opts = [1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}"${su && su.guests === n ? ' selected' : ''}>${n}</option>`).join('');
  const who = `${e.cabin.cabin_number ? 'Cabin ' + esc(e.cabin.cabin_number) + ' &middot; ' : ''}${esc(e.cabin.name || '')}`;
  return `<section id="signup" class="card lg-signup">
  <span class="tag">Sign-up</span>
  <h2>${esc(post.signup_label)}</h2>
  <p class="cab">Signing up for ${who}</p>
  <div class="in" id="su-in"${su ? '' : ' hidden'}>You're signed up: <span id="su-n">${su ? su.guests : ''}</span> guest<span id="su-s">${su && su.guests === 1 ? '' : 's'}</span> from your cabin. Change it below any time.</div>
  <label for="su-g">How many from your cabin are coming?</label>
  <select id="su-g">${opts}</select>
  <label for="su-note">Anything we should know? (optional)</label>
  <input type="text" id="su-note" maxlength="200" value="${esc(su ? su.note : '')}" placeholder="Names, allergies, questions">
  <div class="row"><button class="btn btn-gold" id="su-go" type="button">${su ? 'Update my sign-up' : 'Count our cabin in'}</button><button class="btn-cancel" id="su-no" type="button"${su ? '' : ' hidden'}>Cancel our sign-up</button></div>
  <div class="msg" id="su-msg" role="status" hidden></div>
</section>
<script>(function(){var PASS=${JSON.stringify(pass || '')},POST=${JSON.stringify(post.id)};
var $=function(i){return document.getElementById(i);},busy=false;
function msg(t,bad){var m=$('su-msg');m.textContent=t;m.className='msg'+(bad?' err':'');m.hidden=false;}
function send(g){if(busy)return;busy=true;$('su-go').disabled=true;
fetch('/drifters/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({post:POST,guests:g,note:$('su-note').value,s:PASS})})
.then(function(r){return r.json().then(function(d){return {ok:r.ok,d:d};});})
.then(function(x){if(!x.ok){msg(x.d&&x.d.error==='off'?'Sign-up is closed for this event.':'Sorry, that did not save. Please try again, or text Lori, Dawn or Brent.',true);return;}
var n=x.d.guests||0;$('su-in').hidden=!n;$('su-n').textContent=n;$('su-s').textContent=n===1?'':'s';$('su-no').hidden=!n;$('su-go').textContent=n?'Update my sign-up':'Count our cabin in';
msg(n?'Saved. See you there!':'Your sign-up was cancelled.',false);})
.catch(function(){msg('Sorry, that did not save. Please try again.',true);})
.then(function(){busy=false;$('su-go').disabled=false;});}
$('su-go').onclick=function(){send(parseInt($('su-g').value,10)||1);};
$('su-no').onclick=function(){if(confirm('Cancel the sign-up for this cabin?'))send(0);};
})();</script>`;
}

function postPage(who, post, pass, extra) {
  const sfx = pass ? `?s=${encodeURIComponent(pass)}` : '';
  return head(post.title) + `
<section><div class="container lg-article">
  <p><a href="/drifters${sfx}">&larr; Back to the Dive Bar</a></p>
  <span class="date">${fmtDate(post.post_date)}</span>
  <h1 style="margin:.3rem 0 1.2rem;">${esc(post.title)}</h1>
  ${post.image_url ? `<img class="hero-pic${post.signup_label ? ' poster' : ''}" src="${esc(post.image_url)}" alt="">` : ''}
  <div class="body">${richText(post.body) || '<p class="lg-empty">This post has no text yet.</p>'}</div>
  ${signupBlock(post, extra, pass)}
</div></section>` + foot(who, pass);
}

// ---- public handler ----
export async function handleLounge(request, env, url) {
  if (!env.DB) return html('<p>The Dive Bar is temporarily unavailable.</p>', 503);
  await ensureSchema(env.DB);
  const path = url.pathname.replace(/\/+$/, '') || '/drifters';
  const method = request.method.toUpperCase();

  if (path === '/drifters/logout' && method === 'POST') {
    let passed = '';
    try {
      passed = clip((await request.formData()).get('s'), 80);
    } catch {
      /* no body */
    }
    const byCookie = await sessionFor(env, parseCookies(request)[COOKIE]);
    if (byCookie) await deleteDrifterSession(env.DB, byCookie.id);
    const byLink = await sessionFor(env, passed);
    if (byLink) await deleteDrifterSession(env.DB, byLink.id);
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
    const nextIn = clip(form.get('next'), 90);
    const home = POST_PATH.test(nextIn) ? nextIn : '/drifters';
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
      return redirect(`${home}?err=missing`);
    }
    // People type "Jim Dunn" or "Dunn, James" in a box labelled last name. Try
    // the whole entry first, then each word (last word first), so any name on
    // the booking gets them in.
    // Compared letters-only on both sides (see findCabinForSignIn), so "O' Neill" in the manifest
    // matches "oneill", and "Sullivan-Dunn" matches a booking that says "Dunn".
    const letters = (w) => w.replace(/[^a-z]/g, '');
    const words = raw.split(/[\s\-']+/).map(letters).filter((w) => w.length >= 2);
    const candidates = [...new Set([letters(raw), ...words.slice().reverse()])].filter(Boolean);
    let cabin = null;
    for (const c of candidates) {
      cabin = await findCabinForSignIn(env.DB, res, c);
      if (cabin) break;
    }
    if (!cabin) {
      await log('nomatch');
      return redirect(`${home}?err=nomatch`);
    }
    await log('ok');
    const token = randomToken(32);
    const pass = randomToken(24);
    const now = Date.now();
    await createDrifterSession(env.DB, {
      id: await sha256Hex(token),
      cabin_id: cabin.id,
      guest_name: clip(cabin.name, 120),
      created_at: now,
      expires_at: now + SESSION_DAYS * 86400000,
    });
    await createDrifterSession(env.DB, {
      id: await sha256Hex(pass),
      cabin_id: cabin.id,
      guest_name: clip(cabin.name, 120),
      created_at: now,
      expires_at: now + LINK_HOURS * 3600000,
    });
    // The pass on the link gets a cookie-blocking browser in; a browser that kept
    // the cookie is sent straight to the clean address on arrival.
    return redirect(`${home}?welcome=1&s=${pass}${home === '/drifters' ? '' : '#signup'}`, {
      'Set-Cookie': `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; SameSite=Lax; Secure; HttpOnly`,
    });
  }

  // Event sign-up: the signed-in cabin says how many are coming (0 cancels). One row per cabin and
  // post, tied to the reservation. Admins previewing have no cabin and cannot sign anyone up.
  if (path === '/drifters/signup' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400); }
    const passed = clip(body.s, 80) || clip(url.searchParams.get('s'), 80);
    const who = await viewer(request, env, new URL(`/drifters?s=${encodeURIComponent(passed)}`, SITE));
    if (!who || !who.cabin_id) return json({ error: 'unauthorized' }, 401);
    const post = await getLoungeRow(env.DB, 'posts', clip(body.post, 60));
    if (!post || !post.published || !post.signup_label) return json({ error: 'off' }, 404);
    const cabin = await getCabin(env.DB, who.cabin_id);
    if (!cabin) return json({ error: 'unauthorized' }, 401);
    // A post with choices takes a quantity of each ({ label: qty }); all zeros cancels. Anything that is
    // not a listed label or a whole number 0 to 6 is a bad request, never a cancel.
    const optList = parseOptions(post.signup_options);
    if (optList.length) {
      const ch = body.choices;
      if (!ch || typeof ch !== 'object' || Array.isArray(ch)) return json({ error: 'bad_request' }, 400);
      const known = new Set(optList.map((o) => o.label));
      if (Object.keys(ch).some((k) => !known.has(k))) return json({ error: 'bad_request' }, 400);
      const picked = [];
      let total = 0;
      for (const o of optList) {
        const raw = ch[o.label];
        if (raw === undefined) continue;
        const q = typeof raw === 'number' || (typeof raw === 'string' && /^\d{1,2}$/.test(raw.trim())) ? Math.floor(Number(raw)) : NaN;
        if (!(q >= 0 && q <= 6)) return json({ error: 'bad_request' }, 400);
        if (q > 0) { picked.push({ label: o.label, price: o.price, qty: q }); total += q; }
      }
      const before = await getSignup(env.DB, post.id, cabin.id);
      if (total === 0) {
        await deleteSignup(env.DB, post.id, cabin.id);
        if (before) { await notifyRequest(env, post, cabin, [], '', 'cancelled'); await confirmToGuest(env, post, cabin, [], '', 'cancelled'); }
        return json({ ok: true, guests: 0 });
      }
      const note = clip(body.note, 500);
      // A post with a release takes no request unless the guest ticked the box; the time they agreed is kept.
      const needsRelease = !!String(post.signup_release || '').trim();
      if (needsRelease && body.agree !== true) return json({ error: 'agree' }, 400);
      await saveSignup(env.DB, { id: crypto.randomUUID(), post_id: post.id, cabin_id: cabin.id, guests: total, note, choices: JSON.stringify(picked), agreed_at: needsRelease ? Date.now() : null, now: Date.now() });
      await notifyRequest(env, post, cabin, picked, note, before ? 'changed' : 'new');
      await confirmToGuest(env, post, cabin, picked, note, before ? 'changed' : 'new', { agreedAt: Date.now() });
      return json({ ok: true, guests: total });
    }
    // Only a real number cancels (0). Blank, null or text is a bad request, never a cancel.
    const rawGuests = body.guests;
    const guests = typeof rawGuests === 'number' || (typeof rawGuests === 'string' && /^\d{1,2}$/.test(rawGuests.trim())) ? Math.floor(Number(rawGuests)) : NaN;
    if (!(guests >= 0 && guests <= 6)) return json({ error: 'bad_request' }, 400);
    const hadSignup = await getSignup(env.DB, post.id, cabin.id);
    if (guests === 0) {
      await deleteSignup(env.DB, post.id, cabin.id);
      if (hadSignup) await confirmToGuest(env, post, cabin, [], '', 'cancelled');
      return json({ ok: true, guests: 0 });
    }
    const hcNote = clip(body.note, 200);
    await saveSignup(env.DB, { id: crypto.randomUUID(), post_id: post.id, cabin_id: cabin.id, guests, note: hcNote, now: Date.now() });
    await confirmToGuest(env, post, cabin, [], hcNote, hadSignup ? 'changed' : 'new', { guests });
    return json({ ok: true, guests });
  }

  if (path === '/drifters/email' && method === 'POST') {
    let form;
    try {
      form = await request.formData();
    } catch {
      return redirect('/drifters');
    }
    // The link pass may arrive in the form (cookie-blocking browsers) or the query.
    const passed = clip(form.get('s'), 80) || clip(url.searchParams.get('s'), 80);
    const guest = await currentGuest(request, env, new URL(`/drifters?s=${encodeURIComponent(passed)}`, SITE));
    if (!guest || !guest.cabin_id) return redirect('/drifters');
    const back = `/drifters${guest.via === 'link' ? `?s=${encodeURIComponent(guest.token)}&` : '?'}sub=`;
    const email = clip(form.get('email'), 160).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return redirect(back + 'bad#updates');
    const existing = await listSubscribersForCabin(env.DB, guest.cabin_id);
    if (existing.some((s) => s.email === email)) return redirect(back + 'dup#updates');
    await insertSubscriber(env.DB, { id: crypto.randomUUID(), cabin_id: guest.cabin_id, email, token: randomToken(24), created_at: Date.now() });
    await removeOptOut(env.DB, email);
    return redirect(back + 'ok#updates');
  }

  // Parrots & Pirates: give this first name its pirate name. A guest's is saved against the cabin
  // and never changes; an admin previewing the page is shown one and nothing is kept.
  if (path === '/drifters/pirate' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400); }
    const passed = clip(body.s, 80) || clip(url.searchParams.get('s'), 80);
    const who = await viewer(request, env, new URL(`/drifters?s=${encodeURIComponent(passed)}`, SITE));
    if (!who) return json({ error: 'unauthorized' }, 401);
    const settings = await getLoungeSettings(env.DB);
    if (settings.pirate_on === '0') return json({ error: 'off' }, 404);
    let p = null;
    let preview = false;
    if (who.cabin_id) {
      const cabin = await getCabin(env.DB, who.cabin_id);
      if (!cabin) return json({ error: 'unauthorized' }, 401);
      p = await christenPirate(env.DB, cabin, body.name, Date.now());
    } else {
      preview = true;
      p = await previewPirate(env.DB, body.name);
    }
    if (!p) return json({ error: 'missing_name' }, 400);
    return json({ ok: true, pirate: p, preview, crew: await listPirates(env.DB, 8) });
  }

  if (path === '/drifters/email/unsubscribe' && (method === 'GET' || method === 'POST')) {
    const t = clip(url.searchParams.get('t'), 80);
    if (t) await unsubscribeByToken(env.DB, t);
    if (method === 'POST') return new Response('OK');
    return html(head('Unsubscribed') + '<section><div class="container lg-article"><h1>You\'re unsubscribed</h1><p>No more Dive Bar emails to this address. The page itself is still yours: <a href="/drifters">parrotheadscruise.com/drifters</a>.</p></div></section>' + foot(''));
  }

  if (method !== 'GET' && method !== 'HEAD') return new Response('Method not allowed', { status: 405 });

  const who = await viewer(request, env, url);
  const settings = await getLoungeSettings(env.DB);
  const closed = settings.enabled === '0' && !(who && who.admin);
  // Cookie worked: keep the pass out of the address bar and history.
  if (who && who.via !== 'link' && url.searchParams.has('s')) return redirect(path);
  const pass = who && who.via === 'link' ? who.token : '';
  const sfx = pass ? `?s=${encodeURIComponent(pass)}` : '';

  const postMatch = /^\/drifters\/post\/([A-Za-z0-9-]{1,60})$/.exec(path);
  if (postMatch) {
    if (!who || closed) {
      // Someone arriving from a shared sign-up link: show the sign-in, then bring them back here.
      if (closed) return redirect('/drifters');
      const inApp = /FBAN|FBAV|FB_IAB|Instagram|Messenger/i.test(request.headers.get('User-Agent') || '');
      const err = url.searchParams.get('welcome') === '1' ? 'cookies' : url.searchParams.get('err') || '';
      return html(gatePage(err, false, inApp, path));
    }
    const post = await getLoungeRow(env.DB, 'posts', postMatch[1]);
    if (!post || (!post.published && !who.admin)) return html(head('Not found') + `<section><div class="container"><p>That post isn't available. <a href="/drifters${sfx}">Back to the Dive Bar</a></p></div></section>` + foot(who.name, pass), 404);
    let extra = null;
    if (post.signup_label) {
      const cabin = who.cabin_id ? await getCabin(env.DB, who.cabin_id) : null;
      const totals = who.admin && !cabin ? (await signupTotals(env.DB))[post.id] : null;
      extra = { admin: !!who.admin, cabin, totals, signup: cabin ? await getSignup(env.DB, post.id, cabin.id) : null };
    }
    return html(postPage(who.name, post, pass, extra));
  }

  if (path !== '/drifters') return redirect('/drifters');
  if (!who || closed) {
    const inApp = /FBAN|FBAV|FB_IAB|Instagram|Messenger/i.test(request.headers.get('User-Agent') || '');
    // Arrived straight from a successful sign-in with no session: the browser dropped the cookie.
    const err = !closed && url.searchParams.get('welcome') === '1' ? 'cookies' : url.searchParams.get('err') || '';
    return html(gatePage(err, closed, inApp));
  }

  const [posts, events, dates, links, cabin, subs] = await Promise.all([
    listLounge(env.DB, 'posts'),
    listLounge(env.DB, 'events'),
    listLounge(env.DB, 'dates'),
    listLounge(env.DB, 'links'),
    who.cabin_id ? getCabin(env.DB, who.cabin_id) : null,
    who.cabin_id ? listSubscribersForCabin(env.DB, who.cabin_id) : [],
  ]);
  let refLink = null;
  let board = [];
  if (settings.referral_on !== '0') {
    try {
      refLink = cabin ? await ensureReferralLink(env.DB, cabin, Date.now()) : null;
      board = await listReferralBoard(env.DB);
    } catch { /* the page still renders without the board */ }
  }
  let crew = [];
  if (settings.pirate_on !== '0') {
    try { crew = await listPirates(env.DB, 8); } catch { /* the card still renders */ }
  }
  let signed = {};
  if (cabin) {
    try { signed = await cabinSignups(env.DB, cabin.id); } catch { /* the card still renders */ }
  }
  const extra = { cabin, subs, admin: !!who.admin, sub: clip(url.searchParams.get('sub'), 8), refLink, board, crew, signed };
  return html(loungePage(who.name, settings, posts.filter((p) => p.published || who.admin), events, dates, links, pass, extra));
}

// ---- emailing a post to subscribers (Resend, batches of 100) ----
function postEmailHtml(env, post, unsub) {
  const postal = clip(env.DRIP_POSTAL_ADDRESS, 200);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(post.title)}</title></head>
<body style="margin:0;padding:0;background:#f5efe2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5efe2;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
  <tr><td style="background:#081627;padding:24px 32px;text-align:center;">
    <div style="font-size:11px;letter-spacing:3px;color:#e3c878;text-transform:uppercase;">Drifters Dive Bar</div>
    <div style="font-size:22px;font-weight:bold;color:#ffffff;letter-spacing:1px;">Parrothead Day Cruise 2027</div>
  </td></tr>
  <tr><td style="padding:30px 32px 8px;">
    <div style="font-size:12px;letter-spacing:2px;color:#c9a545;text-transform:uppercase;font-weight:bold;">${esc(fmtDate(post.post_date))}</div>
    <h1 style="margin:6px 0 16px;font-size:22px;line-height:1.3;color:#081627;">${esc(post.title)}</h1>
    ${post.image_url ? `<img src="${esc(/^https?:/.test(post.image_url) ? post.image_url : SITE + post.image_url)}" alt="" style="${post.signup_label ? 'display:block;max-width:100%;width:100%;height:auto;margin:0 auto 18px;border-radius:10px;' : 'display:block;max-width:360px;width:100%;height:auto;margin:0 0 16px;'}">` : ''}
    <div style="font-size:16px;line-height:1.6;color:#22303d;">${richText(post.body).replace(/<p>/g, '<p style="margin:0 0 14px;">')}</div>
  </td></tr>
  <tr><td style="padding:4px 32px 30px;" align="center">
    <a href="${post.signup_label ? `${SITE}/drifters/post/${esc(post.id)}#signup` : `${SITE}/drifters`}" style="display:inline-block;background:#c9a545;color:#081627;text-decoration:none;font-weight:bold;font-size:16px;padding:13px 26px;border-radius:8px;">${post.signup_label ? esc(post.signup_label) : 'Open the Dive Bar'}</a>
  </td></tr>
  <tr><td style="background:#f5efe2;padding:16px 32px;font-size:12px;line-height:1.6;color:#55606c;text-align:center;">
    You asked for Dive Bar updates on parrotheadscruise.com. <a href="${unsub}" style="color:#123152;">Unsubscribe</a> any time.<br>
    Prestige Travel Vacations LLC, Turner Travel, &amp; Cruises Tours &amp; Travel${postal ? ' &middot; ' + esc(postal) : ''}
  </td></tr>
</table></td></tr></table></body></html>`;
}

// One send path for every Dive Bar email: Resend batches of 100, each message with its own
// unsubscribe link. `make(sub, unsub)` returns { subject, html, text }.
// Tell the people who run the sale that a cabin sent, changed or cancelled a choices request. It goes to
// the same list as the website's new-inquiry alerts and leads with the reservation number, which is what
// the cruise line's system is keyed on. Never throws: a mail hiccup must not lose the guest's request.
async function notifyRequest(env, post, cabin, picked, note, kind, opts) {
  try {
    const o = opts || {};
    // Test cabins used to check the form (reservation numbers starting 999) never alert the team.
    if (!o.test && /^999/.test(String(cabin.res_number || '').trim())) return false;
    const key = env.RESEND_API_KEY;
    if (!key) return false;
    const to = o.to || String(env.LEAD_NOTIFY_EMAILS || env.ADMIN_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!to.length) return false;
    const from = env.MAIL_FROM || 'Parrothead Day Cruise <noreply@parrotheadscruise.com>';
    const verb = kind === 'cancelled' ? 'Cancelled' : kind === 'changed' ? 'Changed' : 'New';
    const res = String(cabin.res_number || '').trim() || 'not on file';
    const names = String(cabin.name || '').trim() || '(no name)';
    const guestEmail = String(cabin.email || '').trim();
    const agreed = kind !== 'cancelled' && !!String(post.signup_release || '').trim();
    const subject = `${o.test ? '[Test] ' : ''}${verb} request: Res ${res}, ${names}`;
    const items = (picked || []).map((x) => `${x.qty} x ${x.label}${x.price ? ' (' + x.price + ')' : ''}`);
    const e = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const intro = kind === 'cancelled' ? 'They cancelled their earlier request.' : kind === 'changed' ? 'They changed their request. This is the full list now:' : 'Here is what they asked for:';
    const html = `<div style="font-family:Arial,sans-serif;max-width:560px;color:#1b2430;">
  <p style="margin:0 0 4px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#8a6d1f;">${e(verb)} request${o.test ? ' (test)' : ''} &middot; ${e(post.title)}</p>
  <h2 style="margin:0 0 4px;color:#081627;">Reservation ${e(res)}</h2>
  <p style="margin:0 0 ${guestEmail ? '2' : '14'}px;font-size:16px;">${e(names)}</p>
  ${guestEmail ? `<p style="margin:0 0 14px;font-size:14px;color:#445;">${e(guestEmail)}</p>` : ''}
  <p style="margin:0 0 6px;">${e(intro)}</p>
  ${items.length ? `<ul style="margin:0 0 12px;padding-left:20px;font-size:15px;line-height:1.6;">${items.map((i) => `<li>${e(i)}</li>`).join('')}</ul>` : ''}
  ${note ? `<p style="margin:0 0 12px;"><b>Their note:</b> ${e(note)}</p>` : ''}
  ${agreed ? '<p style="margin:0 0 12px;"><b>Agreed to the release:</b> yes</p>' : ''}
  <p style="margin:16px 0;"><a href="${SITE}/admin/lounge" style="background:#c9a545;color:#081627;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:bold;">Open the list in Admin</a></p>
  <p style="font-size:12px;color:#667;">Sent automatically when a guest uses the form on the Dive Bar. Sale prices are the cruise line's; confirm the booking with the guest.</p>
</div>`;
    const text = `${verb} request${o.test ? ' (test)' : ''}: ${post.title}\nReservation ${res}\n${names}${guestEmail ? '\n' + guestEmail : ''}\n\n${intro}\n${items.map((i) => '- ' + i).join('\n')}${note ? '\nTheir note: ' + note : ''}${agreed ? '\nAgreed to the release: yes' : ''}\n\n${SITE}/admin/lounge`;
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ from, to, subject, html, text }, guestEmail && !o.test ? { reply_to: guestEmail.split(/\s*,\s*/) } : {})) });
    return r.ok;
  } catch {
    return false;
  }
}

// Put every booked cabin's email address on the Dive Bar list (with its own unsubscribe link) unless that
// address has opted out. Runs just before a real send, so a new address on the Cabins page is picked up.
async function syncCabinSubscribers(db) {
  const add = await pendingCabinEmails(db);
  for (const a of add) await insertSubscriber(db, { id: crypto.randomUUID(), cabin_id: a.cabin_id, email: a.email, token: randomToken(24), created_at: Date.now() });
  return add.length;
}

// Confirm a request to the guest who made it: what they asked for, their note, and (when the post has a
// release) a copy of what they agreed to and when. Goes to the email address(es) on their cabin; nobody
// without one gets anything. Never throws. kind is 'new', 'changed' or 'cancelled'; o.guests is the headcount
// for a plain sign-up (no choices).
async function confirmToGuest(env, post, cabin, picked, note, kind, o) {
  try {
    o = o || {};
    if (!o.test && /^999/.test(String(cabin.res_number || '').trim())) return false;
    const key = env.RESEND_API_KEY;
    if (!key) return false;
    const to = o.to || String(cabin.email || '').split(/[\s,;]+/).map((s) => s.trim()).filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)).slice(0, 4);
    if (!to.length) return false;
    const from = env.MAIL_FROM || 'Parrothead Day Cruise <noreply@parrotheadscruise.com>';
    const replyTo = String(env.DRIP_REPLY_TO || env.LEAD_NOTIFY_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const e = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const names = String(cabin.name || '').trim() || 'there';
    const res = String(cabin.res_number || '').trim();
    const plain = !!(o.guests && !(picked || []).length);
    const cancelled = kind === 'cancelled';
    const subject = `${o.test ? '[Test] ' : ''}${cancelled ? 'Cancelled' : plain ? "You're signed up" : 'We have your request'}: ${post.title}`;
    const items = (picked || []).map((x) => `${x.qty} x ${x.label}${x.price ? ' (' + x.price + ')' : ''}`);
    const lead = cancelled ? 'Your request has been cancelled. Nothing further is needed.' : plain ? `You're signed up with ${o.guests} guest${o.guests === 1 ? '' : 's'} from your cabin.` : kind === 'changed' ? 'We updated your request. This is the full list now:' : 'Thank you. Here is what you asked for:';
    const rel = String(post.signup_release || '').trim();
    const showRel = rel && !cancelled && !plain;
    const when = new Date(o.agreedAt || Date.now()).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'long', timeStyle: 'short' });
    const link = `${SITE}/drifters/post/${post.id}#signup`;
    const relHtml = showRel ? `<p style="margin:18px 0 6px;"><b>What you agreed to</b> (${e(when)} Eastern):</p><div style="border:1px solid #d9cfae;background:#fffdf6;border-radius:8px;padding:10px 14px;font-size:13px;line-height:1.5;color:#445;">${releaseHtml(rel)}</div>` : '';
    const html = `<div style="font-family:Arial,sans-serif;max-width:560px;color:#1b2430;">
  <p style="margin:0 0 4px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#8a6d1f;">${e(post.title)}</p>
  <h2 style="margin:0 0 10px;color:#081627;">Hi ${e(names)},</h2>
  <p style="margin:0 0 8px;">${e(lead)}</p>
  ${items.length ? `<ul style="margin:0 0 12px;padding-left:20px;font-size:15px;line-height:1.6;">${items.map((i) => `<li>${e(i)}</li>`).join('')}</ul>` : ''}
  ${res ? `<p style="margin:0 0 8px;color:#445;">Reservation ${e(res)}</p>` : ''}
  ${note && !cancelled ? `<p style="margin:0 0 12px;"><b>Your note:</b> ${e(note)}</p>` : ''}
  ${cancelled ? '' : '<p style="margin:0 0 8px;">We will follow up to confirm. If anything looks wrong, just reply to this email.</p>'}
  ${relHtml}
  <p style="margin:18px 0;"><a href="${link}" style="background:#c9a545;color:#081627;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:bold;">${cancelled ? 'Open the Dive Bar' : 'Change your request'}</a></p>
  <p style="font-size:12px;color:#667;">You are getting this because a request was sent from your cabin on the Drifters Dive Bar.</p>
</div>`;
    const text = `${post.title}\n\nHi ${names},\n${lead}\n${items.map((i) => '- ' + i).join('\n')}${res ? '\nReservation ' + res : ''}${note && !cancelled ? '\nYour note: ' + note : ''}${cancelled ? '' : '\n\nWe will follow up to confirm. If anything looks wrong, just reply to this email.'}${showRel ? '\n\nWhat you agreed to (' + when + ' Eastern):\n' + rel : ''}\n\n${link}`;
    const msg = { from, to, subject, html, text };
    if (replyTo.length && !o.test) msg.reply_to = replyTo;
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(msg) });
    return r.ok;
  } catch {
    return false;
  }
}

async function sendToSubscribers(env, subs, make) {
  // One email per address, even when the same address is on more than one cabin.
  const seenEmail = new Set();
  subs = subs.filter((s) => { const k = String((s && s.email) || '').trim().toLowerCase(); if (!k || seenEmail.has(k)) return false; seenEmail.add(k); return true; });
  const key = env.RESEND_API_KEY;
  if (!key) return { sent: 0, failed: subs.length, error: 'no_resend_key' };
  const from = env.MAIL_FROM || 'Parrothead Day Cruise <noreply@parrotheadscruise.com>';
  const replyTo = String(env.DRIP_REPLY_TO || env.LEAD_NOTIFY_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean);
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < subs.length; i += 100) {
    const batch = subs.slice(i, i + 100).map((s) => {
      const unsub = `${SITE}/drifters/email/unsubscribe?t=${encodeURIComponent(s.token)}`;
      const m = make(s, unsub);
      const msg = { from, to: [s.email], subject: m.subject, html: m.html, text: `${m.text}\nUnsubscribe: ${unsub}`, headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
      if (replyTo.length) msg.reply_to = replyTo;
      return msg;
    });
    try {
      const res = await fetch('https://api.resend.com/emails/batch', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(batch) });
      if (res.ok) sent += batch.length;
      else failed += batch.length;
    } catch {
      failed += batch.length;
    }
  }
  return { sent, failed };
}

async function emailPost(env, post, subs, test) {
  const text = `${post.title}\n\n${String(post.body || '')}\n\n${post.signup_label ? post.signup_label + ': ' + SITE + '/drifters/post/' + post.id + '#signup' : 'Open the Dive Bar: ' + SITE + '/drifters'}`;
  return sendToSubscribers(env, subs, (s, unsub) => ({ subject: `${test ? '[Test] ' : ''}Drifters Dive Bar: ${post.title}`, html: postEmailHtml(env, post, unsub), text }));
}

// A schedule entry, key date or document added to the Dive Bar: a short update email, one item,
// with a button to the Dive Bar (or to the entry's own button link, e.g. a sign-up).
function absUrl(u) {
  return /^https?:/i.test(u) ? u : SITE + (String(u).startsWith('/') ? u : '/' + u);
}

function updateFor(type, row) {
  if (type === 'events') {
    const when = [fmtDate(row.day), row.day_label].filter(Boolean).join(' \u00b7 ') + (row.start_time ? ' \u00b7 ' + fmtTime(row.start_time) : '');
    return { kicker: 'Schedule update', when, title: row.title, detail: row.detail || '', buttonLabel: row.link_label && row.link_url ? row.link_label : 'Open the Dive Bar', buttonUrl: row.link_label && row.link_url ? absUrl(row.link_url) : `${SITE}/drifters` };
  }
  if (type === 'dates') {
    return { kicker: 'New key date', when: fmtDate(row.due_date), title: row.title, detail: row.detail || '', buttonLabel: 'Open the Dive Bar', buttonUrl: `${SITE}/drifters` };
  }
  return { kicker: 'New on the Dive Bar', when: 'Document or link', title: row.title, detail: row.note || '', buttonLabel: 'Open it', buttonUrl: row.url };
}

function updateEmailHtml(env, u, unsub) {
  const postal = clip(env.DRIP_POSTAL_ADDRESS, 200);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(u.title)}</title></head>
<body style="margin:0;padding:0;background:#f5efe2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5efe2;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
  <tr><td style="background:#081627;padding:24px 32px;text-align:center;">
    <div style="font-size:11px;letter-spacing:3px;color:#e3c878;text-transform:uppercase;">Drifters Dive Bar</div>
    <div style="font-size:22px;font-weight:bold;color:#ffffff;letter-spacing:1px;">Parrothead Day Cruise 2027</div>
  </td></tr>
  <tr><td style="padding:30px 32px 8px;">
    <div style="font-size:12px;letter-spacing:2px;color:#c9a545;text-transform:uppercase;font-weight:bold;">${esc(u.kicker)}</div>
    <div style="font-size:13px;color:#55606c;margin:6px 0 0;">${esc(u.when)}</div>
    <h1 style="margin:8px 0 14px;font-size:22px;line-height:1.3;color:#081627;">${esc(u.title)}</h1>
    ${u.detail ? `<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#22303d;">${esc(u.detail)}</p>` : ''}
  </td></tr>
  <tr><td style="padding:4px 32px 30px;" align="center">
    <a href="${esc(u.buttonUrl)}" style="display:inline-block;background:#c9a545;color:#081627;text-decoration:none;font-weight:bold;font-size:16px;padding:13px 26px;border-radius:8px;">${esc(u.buttonLabel)}</a>
  </td></tr>
  <tr><td style="background:#f5efe2;padding:16px 32px;font-size:12px;line-height:1.6;color:#55606c;text-align:center;">
    You asked for Dive Bar updates on parrotheadscruise.com. <a href="${unsub}" style="color:#123152;">Unsubscribe</a> any time.<br>
    Prestige Travel Vacations LLC, Turner Travel, &amp; Cruises Tours &amp; Travel${postal ? ' &middot; ' + esc(postal) : ''}
  </td></tr>
</table></td></tr></table></body></html>`;
}

async function emailUpdate(env, type, row, subs, test) {
  const u = updateFor(type, row);
  const text = `${u.kicker}: ${u.title}\n${u.when}\n${u.detail ? '\n' + u.detail + '\n' : ''}\n${u.buttonLabel}: ${u.buttonUrl}`;
  return sendToSubscribers(env, subs, (s, unsub) => ({ subject: `${test ? '[Test] ' : ''}Drifters Dive Bar: ${u.title}`, html: updateEmailHtml(env, u, unsub), text }));
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
    if (b.signup_label !== undefined) row.signup_label = clip(b.signup_label, 80);
    if (b.signup_options !== undefined) row.signup_options = clip(b.signup_options, 4000);
    if (b.signup_release !== undefined) row.signup_release = clip(b.signup_release, 8000);
    if (b.signup_min !== undefined) { const n = parseInt(b.signup_min, 10); row.signup_min = n >= 1 && n <= 99 ? n : null; }
    if (b.image_url !== undefined) {
      const u = clip(b.image_url, 500);
      row.image_url = /^(\/[^\s]*|https:\/\/[^\s]+)$/.test(u) ? u : '';
    }
  } else if (type === 'events') {
    if (b.day !== undefined) row.day = parseYmd(b.day) ? clip(b.day, 10) : '';
    if (b.start_time !== undefined) row.start_time = /^\d{1,2}:\d{2}$/.test(String(b.start_time || '').trim()) ? clip(b.start_time, 5).padStart(5, '0') : '';
    if (b.title !== undefined) row.title = clip(b.title, 200);
    if (b.detail !== undefined) row.detail = clip(b.detail, 500);
    if (b.day_label !== undefined) row.day_label = clip(b.day_label, 40);
    if (b.link_label !== undefined) row.link_label = clip(b.link_label, 60);
    if (b.link_url !== undefined) {
      const u = clip(b.link_url, 300);
      row.link_url = /^(\/[^\s]*|https:\/\/[^\s]+)$/.test(u) ? u : '';
    }
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

  if (path === '/api/admin/lounge/subscribers' && method === 'GET') {
    const subs = await listSubscribers(env.DB);
    if (url.searchParams.get('format') === 'csv') {
      const escCsv = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      const lines = ['email,cabin,name,subscribed_at'].concat(subs.map((s) => [s.email, s.cabin_number, s.cabin_name, new Date(s.created_at).toISOString()].map(escCsv).join(',')));
      return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="dive-bar-subscribers.csv"', 'Cache-Control': 'no-store' } });
    }
    return json({ subscribers: subs, pending: (await pendingCabinEmails(env.DB)).length });
  }

  if (path === '/api/admin/lounge/signups' && method === 'GET') {
    const id = clip(url.searchParams.get('post'), 60);
    const post = id && (await getLoungeRow(env.DB, 'posts', id));
    if (!post) return json({ error: 'not_found' }, 404);
    const rows = await listSignups(env.DB, id);
    if (url.searchParams.get('format') === 'csv') {
      // A guest types the note, so a cell that starts like a spreadsheet formula is defused for Excel.
      const escCsv = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      const choiceText = (raw) => { try { return JSON.parse(raw || '[]').map((x) => x.qty + ' x ' + x.label).join('; '); } catch { return ''; } };
      const lines = ['cabin,reservation,name,guests,choices,note,signed_up,agreed_to_release'].concat(rows.map((r) => [r.cabin_number, r.res_number, r.name, r.guests, choiceText(r.choices), r.note, new Date(r.created_at).toISOString(), r.agreed_at ? new Date(r.agreed_at).toISOString() : ''].map(escCsv).join(',')));
      return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="dive-bar-signups.csv"', 'Cache-Control': 'no-store' } });
    }
    return json({ post: { id: post.id, title: post.title }, signups: rows });
  }

  if (path === '/api/admin/lounge' && method === 'GET') {
    const [settings, posts, events, dates, links, referrals, pirateCount, signups] = await Promise.all([
      getLoungeSettings(env.DB),
      listLounge(env.DB, 'posts'),
      listLounge(env.DB, 'events'),
      listLounge(env.DB, 'dates'),
      listLounge(env.DB, 'links'),
      listReferralBoard(env.DB).catch(() => []),
      countPirates(env.DB).catch(() => 0),
      signupTotals(env.DB).catch(() => ({})),
    ]);
    return json({ settings, posts, events, dates, links, referrals, pirates: pirateCount, signups });
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
    if (body.referral_on !== undefined) await setLoungeSetting(env.DB, 'referral_on', body.referral_on ? '1' : '0');
    if (body.referral_prize !== undefined) await setLoungeSetting(env.DB, 'referral_prize', clip(body.referral_prize, 300));
    if (body.pirate_on !== undefined) await setLoungeSetting(env.DB, 'pirate_on', body.pirate_on ? '1' : '0');
    return json({ ok: true, settings: await getLoungeSettings(env.DB) });
  }

  // Sends a sample "new request" alert to the signed-in admin only, so the wording can be checked.
  if (path === '/api/admin/lounge/requests/test') {
    const id = clip(body.id, 60);
    const post = id && (await getLoungeRow(env.DB, 'posts', id));
    if (!post) return json({ error: 'not_found' }, 404);
    const opts = parseOptions(post.signup_options);
    if (!opts.length) return json({ error: 'no_choices' }, 400);
    const picked = [{ label: opts[0].label, price: opts[0].price, qty: 2 }, { label: opts[opts.length - 1].label, price: opts[opts.length - 1].price, qty: 1 }];
    const ok = await notifyRequest(env, post, { res_number: '54385181', name: 'Brent & Lauren Beasley' }, picked, 'Sample note from a guest', 'new', { to: [testAddress(env, admin)], test: true });
    const okGuest = await confirmToGuest(env, post, { res_number: '54385181', name: 'Brent & Lauren Beasley' }, picked, 'Sample note from a guest', 'new', { to: [testAddress(env, admin)], test: true, agreedAt: Date.now() });
    return json({ ok, okGuest, to: testAddress(env, admin) });
  }

  if (path === '/api/admin/lounge/posts/send') {
    const id = clip(body.id, 60);
    const post = id && (await getLoungeRow(env.DB, 'posts', id));
    if (!post) return json({ error: 'not_found' }, 404);
    if (!post.published) return json({ error: 'unpublished' }, 400);
    // A test goes only to the signed-in admin's own address and never marks the post as emailed.
    const test = !!body.test;
    if (!test) await syncCabinSubscribers(env.DB);
    const subs = test ? [{ email: testAddress(env, admin), token: 'test' }] : await listSubscribers(env.DB);
    if (!subs.length) return json({ ok: true, sent: 0, failed: 0 });
    const r = await emailPost(env, post, subs, test);
    if (r.sent && !test) await setPostEmailed(env.DB, post.id, Date.now());
    return json(Object.assign({ ok: true }, r));
  }

  // Email subscribers about one schedule entry, key date or document ("Email" in the admin lists, or
  // the prompt after adding one). Posts have their own send above.
  if (path === '/api/admin/lounge/announce') {
    const type = clip(body.type, 10);
    const id = clip(body.id, 60);
    if (!['events', 'dates', 'links'].includes(type)) return json({ error: 'bad_request' }, 400);
    const row = id && (await getLoungeRow(env.DB, type, id));
    if (!row) return json({ error: 'not_found' }, 404);
    const test = !!body.test;
    if (!test) await syncCabinSubscribers(env.DB);
    const subs = test ? [{ email: testAddress(env, admin), token: 'test' }] : await listSubscribers(env.DB);
    if (!subs.length) return json({ ok: true, sent: 0, failed: 0 });
    return json(Object.assign({ ok: true, to: test ? testAddress(env, admin) : undefined }, await emailUpdate(env, type, row, subs, test)));
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
