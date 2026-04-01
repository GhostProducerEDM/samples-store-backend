export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let path = url.pathname.replace(/\/$/, '') || '/';

    // Exact route → HTML file mapping
    const routes = {
      '/':                 '/browse.html',
      '/browse':           '/browse.html',
      '/library':          '/library.html',
      '/packs':            '/packs.html',
      '/packs/all':        '/allpacks.html',
      '/packs/templates':  '/templates.html',
      '/admin':            '/admin.html',
      '/pricing':          '/pricing.html',
    };

    if (routes[path]) {
      url.pathname = routes[path];
      return env.ASSETS.fetch(new Request(url.toString(), request));
    }

    // /pack/some-name → pack.html
    if (path.startsWith('/pack/')) {
      url.pathname = '/pack.html';
      return env.ASSETS.fetch(new Request(url.toString(), request));
    }

    // /browse/genre/house → browse.html
    if (path.startsWith('/browse/')) {
      url.pathname = '/browse.html';
      return env.ASSETS.fetch(new Request(url.toString(), request));
    }

    // All other static files (js, images, etc.)
    return env.ASSETS.fetch(request);
  },
};
