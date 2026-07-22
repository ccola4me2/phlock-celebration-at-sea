// Sticky header shadow on scroll
const header = document.getElementById('siteHeader');
if (header) {
  const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
}

// Mobile nav toggle
const navToggle = document.getElementById('navToggle');
const navLinks = document.getElementById('navLinks');
if (navToggle && navLinks) {
  navToggle.addEventListener('click', () => {
    const isOpen = navLinks.classList.toggle('is-open');
    navToggle.setAttribute('aria-expanded', String(isOpen));
  });
  navLinks.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => {
      navLinks.classList.remove('is-open');
      navToggle.setAttribute('aria-expanded', 'false');
    });
  });
}

// FAQ accordion
document.querySelectorAll('.faq-item').forEach((item) => {
  const question = item.querySelector('.faq-question');
  if (!question) return;
  question.addEventListener('click', () => {
    const isOpen = item.classList.contains('is-open');
    document.querySelectorAll('.faq-item.is-open').forEach((open) => {
      if (open !== item) {
        open.classList.remove('is-open');
        open.querySelector('.faq-question').setAttribute('aria-expanded', 'false');
      }
    });
    item.classList.toggle('is-open', !isOpen);
    question.setAttribute('aria-expanded', String(!isOpen));
  });
});

// Photo lightbox — click any gallery photo to enlarge
// (only photo-cards that actually contain an image; placeholder cards are skipped)
const photoCards = Array.from(document.querySelectorAll('.photo-card')).filter((c) => c.querySelector('img'));
if (photoCards.length) {
  const lightbox = document.createElement('div');
  lightbox.className = 'lightbox';
  lightbox.setAttribute('role', 'dialog');
  lightbox.setAttribute('aria-label', 'Enlarged photo');
  lightbox.innerHTML =
    '<button class="lightbox-btn lightbox-close" aria-label="Close">&times;</button>' +
    '<button class="lightbox-btn lightbox-prev" aria-label="Previous photo">&#8249;</button>' +
    '<button class="lightbox-btn lightbox-next" aria-label="Next photo">&#8250;</button>' +
    '<img alt="">' +
    '<div class="lightbox-caption"><strong></strong><span></span></div>';
  document.body.appendChild(lightbox);

  const lbImg = lightbox.querySelector('img');
  const lbTitle = lightbox.querySelector('.lightbox-caption strong');
  const lbSub = lightbox.querySelector('.lightbox-caption span');

  let group = [];
  let index = 0;

  const show = (i) => {
    index = (i + group.length) % group.length;
    const card = group[index];
    const img = card.querySelector('img');
    lbImg.src = img.src;
    lbImg.alt = img.alt;
    const title = card.querySelector('figcaption strong');
    const sub = card.querySelector('figcaption span');
    lbTitle.textContent = title ? title.textContent : '';
    lbSub.textContent = sub ? sub.textContent : '';
  };

  const open = (card) => {
    const grid = card.closest('.grid');
    group = grid ? Array.from(grid.querySelectorAll('.photo-card')).filter((c) => c.querySelector('img')) : [card];
    show(group.indexOf(card));
    lightbox.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  };

  const close = () => {
    lightbox.classList.remove('is-open');
    document.body.style.overflow = '';
  };

  photoCards.forEach((card) => card.addEventListener('click', () => open(card)));
  lightbox.querySelector('.lightbox-close').addEventListener('click', close);
  lightbox.querySelector('.lightbox-prev').addEventListener('click', (e) => { e.stopPropagation(); show(index - 1); });
  lightbox.querySelector('.lightbox-next').addEventListener('click', (e) => { e.stopPropagation(); show(index + 1); });
  lightbox.addEventListener('click', (e) => { if (e.target === lightbox || e.target === lbImg) close(); });
  document.addEventListener('keydown', (e) => {
    if (!lightbox.classList.contains('is-open')) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') show(index - 1);
    if (e.key === 'ArrowRight') show(index + 1);
  });
}

// Contact form is an embedded GoHighLevel form (see contact.html).
// Pass the first-touch attribution cookie (set by the Cloudflare Worker when
// a visitor arrives via an alias domain) into the form as utm_source so
// every lead records which domain it originally came from.
const ghlFrame = document.querySelector('iframe[data-form-id]');
if (ghlFrame) {
  const match = document.cookie.match(/(?:^|;\s*)original_domain=([^;]+)/);
  if (match) {
    try {
      const frameUrl = new URL(ghlFrame.src);
      if (!frameUrl.searchParams.has('utm_source')) {
        frameUrl.searchParams.set('utm_source', decodeURIComponent(match[1]));
        frameUrl.searchParams.set('utm_medium', 'domain-redirect');
        ghlFrame.src = frameUrl.toString();
      }
    } catch (e) { /* leave the form as-is */ }
  }
}
