/**
 * P5 #51 — Public status page CF Pages Functions handler.
 * Routes: GET /<team-slug> → fetch from api.uxinspect.com, render HTML.
 */

import { renderStatusPage, render404, renderError } from './render.js';

interface Env {
  API_BASE: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const slug = url.pathname.replace(/^\/+|\/+$/g, '');

  if (!slug || slug === 'favicon.ico' || slug === 'style.css') {
    return context.next();
  }

  if (slug === '' || slug === '/') {
    return Response.redirect('https://uxinspect.com', 302);
  }

  const apiBase = context.env.API_BASE || 'https://api.uxinspect.com';

  try {
    const res = await fetch(`${apiBase}/v1/status/${encodeURIComponent(slug)}`, {
      headers: { 'Accept': 'application/json' },
    });

    if (res.status === 404) {
      return new Response(render404(slug), {
        status: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (!res.ok) {
      return new Response(renderError(), {
        status: 502,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    const data = await res.json() as any;
    const html = renderStatusPage(data);

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
      },
    });
  } catch {
    return new Response(renderError(), {
      status: 502,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
};
