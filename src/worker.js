const MAIN_HOST = 'parrotheadscruise.com';
const COOKIE_NAME = 'original_domain';

export default {
  async fetch(request, env) {
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
