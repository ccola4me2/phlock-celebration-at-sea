# Content To Fill In Before Launch

The site is fully built and styled. These are the only things marked with a
dashed "TBD" badge in the pages — replace them with real 2028 details once
known, then delete the `.tbd` wrapper span around the text.

## Cruise details (index.html, pricing.html)
- [ ] Ship name
- [ ] Departure port
- [ ] Sail dates (and cruise length in nights)
- [ ] Itinerary port stops (index.html itinerary section)

## Pricing (index.html, pricing.html)
- [ ] Interior cabin price (pp, double occupancy)
- [ ] Oceanview cabin price
- [ ] Balcony cabin price
- [ ] Gratuities rate (pp/day)
- [ ] Beverage package price
- [ ] Travel protection price (pp)
- [ ] Deposit amount and final payment due date
- [ ] Cancellation deadline

## Legal (privacy.html)
- [ ] "Last updated" date

## Other things to check before going live
- [ ] Replace the Facebook `href="#"` links in the footer (index.html,
      pricing.html, team.html, faq.html, contact.html, privacy.html) with the
      real social URL.
- [ ] The contact form (contact.html) currently opens the visitor's email
      client via a `mailto:` link (see js/main.js) since there's no backend.
      If you want submissions to go directly into an inbox without opening
      the visitor's mail app, wire it to a form service (e.g. Formspree,
      Cloudflare Pages Forms via a Worker) or a simple Cloudflare Worker
      that emails/stores submissions.
- [ ] Ship renderings are now in `assets/img/` (hero, Life Onboard gallery,
      cabin/suite cards). The stateroom rendering files were named
      "Beachcomber" — if the 2028 ship is the Margaritaville at Sea
      Beachcomber, fill that into the "Ship" fact on the homepage.
      One spare image is unused: `assets/img/mexican-cutie-cantina.jpg`.
      Confirm rights/permission to use the cruise line's renderings before
      launch.
- [ ] Update the favicon/brand mark if you want a custom logo instead of the
      generated wave mark in assets/favicon.svg.

## Carried over from the live 2026 site (parrothead-cruise.com)
These were kept as-is since they're standing agency info, not cruise-specific:
- Lori Judd & Dawn Turner contact info and bios
- FL Seller of Travel #ST15578
- Office hours (Mon–Fri 9am–5:30pm, Sat by appointment)

Confirm these are still accurate for 2028 before launch.
