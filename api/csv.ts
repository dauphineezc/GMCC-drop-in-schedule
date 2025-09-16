export const config = { runtime: 'edge' };

export default async function handler(req: Request) {
  const src = new URL(req.url).searchParams.get('src');
  if (!src) return new Response('Missing src', { status: 400 });

  const upstream = await fetch(src, { cache: 'no-store' });
  if (!upstream.ok) return new Response('Upstream error', { status: upstream.status });

  const headers = new Headers(upstream.headers);
  // Make this consumable by browsers as text, not a download
  headers.set('content-type', 'text/csv; charset=utf-8');
  headers.delete('content-disposition');
  // Don’t cache
  headers.set('cache-control', 'no-store');
  // Let your site read it
  headers.set('access-control-allow-origin', '*');

  return new Response(upstream.body, { headers });
}