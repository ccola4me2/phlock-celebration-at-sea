// Shared admin client: verify the session, populate the top bar, wire logout.
// The Worker already gates /admin/* server-side; this is belt-and-suspenders
// and also hands each page the current user (for prefill/display).
window.PHCAdmin = (async function () {
  let user = null;
  try {
    const res = await fetch('/api/auth/me');
    user = (await res.json()).user;
  } catch (e) {
    /* fall through to redirect */
  }
  if (!user) {
    location.href = '/admin/login?next=' + encodeURIComponent(location.pathname);
    return null;
  }
  const who = document.getElementById('aWho');
  if (who) {
    who.textContent = user.name || user.email;
    const btn = document.createElement('button');
    btn.textContent = 'Sign out';
    btn.onclick = async function () {
      try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) {}
      location.href = '/admin/login';
    };
    who.appendChild(btn);
  }
  // Mark the active nav item.
  document.querySelectorAll('.a-nav a').forEach(function (a) {
    if (a.getAttribute('href') === location.pathname) a.classList.add('active');
  });
  return user;
})();
