export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/$/, '') || '/';

      // Routes where asset filename matches clean URL — env.ASSETS works fine
      const cleanRoutes = {
        '/':        '/browse',
        '/browse':  '/browse',
        '/library': '/library',
        '/packs':   '/packs',
        '/admin':   '/admin',
        '/pricing': '/pricing',
      };

      if (cleanRoutes[path]) {
        url.pathname = cleanRoutes[path];
        return env.ASSETS.fetch(url.toString());
      }

      if (path.startsWith('/browse/')) {
        url.pathname = '/browse';
        return env.ASSETS.fetch(url.toString());
      }

      // Routes where filename differs from URL — use redirect (avoids ASSETS binding issue)
      if (path === '/packs/all') {
        return Response.redirect(new URL('/allpacks.html', request.url).toString(), 302);
      }
      if (path === '/packs/templates') {
        return Response.redirect(new URL('/templates.html', request.url).toString(), 302);
      }

      // /pack/Axion → /pack.html?pack=Axion (pack.html already handles ?pack= + replaceState)
      if (path.startsWith('/pack/')) {
        const slug = path.slice(6);
        const dest = new URL('/pack.html', request.url);
        dest.searchParams.set('pack', decodeURIComponent(slug));
        return Response.redirect(dest.toString(), 302);
      }

      return env.ASSETS.fetch(request);
    } catch (err) {
      return new Response('Worker error: ' + err.message, { status: 500 });
    }
  },
};
