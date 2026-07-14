# Content To Fill In Before Launch

The site is built as the **2027 International Parrothead Day Cruise**:
June 26 – July 3, 2027 · 7 nights round-trip from Miami aboard the
Margaritaville at Sea Beachcomber · Key West → Grand Cayman → Ocho Rios.

Pricing is now sourced from the official rates document
(`International_ParrotHead_Day_Cruise_Rates_2027_with_Logo.docx`) and the
promo flyer: per-person rates from $844.40 (Cozy Interior, double occ.),
full rate chart with triple/quad breakdowns, gratuities ($22pp/night,
suites $25), and enhancements (drink $503.92, Wi-Fi $139.94, bundle $599,
soda $90.72, costs as of 6/24/26). Advisors: Lori Judd (Prestige), Dawn
Turner (Turner Travel), Brent Beasley (Cruise Planners, 561-777-9911).

Remaining items are marked with a dashed "✎ TBD" badge in the pages —
replace them with real values, then delete the `.tbd` wrapper span.

## Pricing details (pricing.html)
- [ ] Deposit amount and final payment due date
- [ ] Travel protection price (currently "Ask your advisor")
- [ ] Note: flyer shows Breezy Balcony double total as $2,181.80 but the
      rates docx and the math ($1,091.40 × 2) say $2,182.80 — the site uses
      $2,182.80. Confirm which is right.

## Past-cruise photos (index.html, Experience section)
- [x] Done — the 8 photos from the repo's `PH Cruise/` folder are optimized
      into `assets/img/past/` and wired into "The Flock In Action" with
      captions. Review the captions and photo order; to add more photos,
      copy the same `<figure class="photo-card">` markup.
- [ ] Confirm everyone pictured is OK appearing on the public site.

## Legal (privacy.html)
- [ ] "Last updated" date

## Other things to check before going live
- [ ] Verify the sail dates, itinerary port times, and cabin fares against
      the actual group contract before publishing — these were taken from a
      design mockup, not a confirmed booking document.
- [ ] Replace the Facebook `href="#"` links in the footer of every page with
      the real social URL.
- [ ] The contact form (contact.html) currently opens the visitor's email
      client via a `mailto:` link (see js/main.js) since there's no backend.
      For direct-to-inbox submissions, wire it to a form service (e.g.
      Formspree) or a Cloudflare Worker.
- [ ] Confirm rights/permission to use Margaritaville at Sea's ship and
      venue renderings (in `assets/img/`). An affiliation disclaimer is
      already in the footer and privacy page.
- [ ] Optional third advisor: the design mockup showed three advisor slots;
      the site currently lists the two known advisors (Lori Judd, Dawn
      Turner). Add a third if applicable.
- [ ] Spare unused image: `assets/img/mexican-cutie-cantina.jpg`.

## Standing agency info carried over from the live 2026 site
- Lori Judd & Dawn Turner contact info and bios
- FL Seller of Travel #ST15578
- Office hours (Mon–Fri 9am–5:30pm, Sat by appointment)

Confirm these are still accurate before launch.
