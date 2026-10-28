// Meta Pixel for the Facebook landing pages (/fb and its variants).
// Put the Pixel ID from Meta Events Manager in FB_PIXEL_ID and every landing
// page records PageView on load, ViewContent when the price section is seen,
// and Lead when the inquiry form is sent. With the ID blank, nothing loads and
// phcTrack() is a harmless no-op.
window.FB_PIXEL_ID = '';
(function () {
  window.phcTrack = function (ev, params) {
    if (!window.fbq) return;
    try { window.fbq('track', ev, params || {}); } catch (e) { /* never break the page */ }
  };
  var id = window.FB_PIXEL_ID;
  if (!id) return;
  !function (f, b, e, v, n, t, s) {
    if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
    if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
    t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
  }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
  window.fbq('init', id);
  window.fbq('track', 'PageView');
})();
