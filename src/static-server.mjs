import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

import { isConfinedSvgPath } from './icon-candidate.mjs';
import { createApprovedIconProxy } from './icon-proxy.mjs';

const CONTENT_TYPES = {
  '.bin': 'application/octet-stream',
  '.gz': 'application/gzip',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.onnx': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

// SVG export fetches the same approved icon bytes that img-src already renders, so the one
// pinned CDN host is allowed to connect as well.
const CONTENT_SECURITY_POLICY = "default-src 'self'; img-src 'self' https://cdn.jsdelivr.net data:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://cdn.jsdelivr.net; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const DOCUMENT_ROUTES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
]);

// The icon index is hundreds of generated shards, so routes match generated names
// instead of exposing the directory to arbitrary traversal.
const ASSET_ROUTES = [
  { prefix: '/src/', name: /^[a-z0-9-]+\.mjs$/ },
  { prefix: '/vendor/', name: /^ort[a-z0-9.-]*\.(?:mjs|wasm)$/ },
  { prefix: '/models/', name: /^(?:quickdraw-mvp|sketch-embedder)\/[a-z0-9-]+\.(?:json|onnx)$/ },
  { prefix: '/data/icon-embeddings/', name: /^(?:index\.json|shard-\d{1,4}\.(?:bin|meta\.json\.gz))$/ },
  { prefix: '/data/', name: /^quickdraw-candidates\.json$/ },
];

const SVGDEPOT_PREFIX = '/svgdepot/';
const SVGDEPOT_CACHE = ['.cache', 'svgdepot'];

function pathError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function responseHeaders(contentType) {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
  };
}

function isInside(rootPath, filePath) {
  return filePath === rootPath || filePath.startsWith(`${rootPath}${sep}`);
}

function decodedPathname(requestPathname) {
  try {
    return decodeURIComponent(requestPathname);
  } catch {
    throw pathError('Not found', 404);
  }
}

export function svgDepotPath(pathname) {
  if (!pathname.startsWith(SVGDEPOT_PREFIX)) return null;
  const relativePath = pathname.slice(SVGDEPOT_PREFIX.length);
  if (!isConfinedSvgPath(relativePath)) throw pathError('Not found', 404);
  return relativePath;
}

function assetPath(pathname) {
  for (const route of ASSET_ROUTES) {
    if (!pathname.startsWith(route.prefix)) continue;
    const name = pathname.slice(route.prefix.length);
    if (!route.name.test(name)) throw pathError('Not found', 404);
    return `${route.prefix.slice(1)}${name}`;
  }
  return null;
}

export async function resolveServedFile(projectRoot, requestPathname) {
  const pathname = decodedPathname(requestPathname);

  const localSvgPath = svgDepotPath(pathname);
  const relativePath = localSvgPath
    ?? DOCUMENT_ROUTES.get(pathname)
    ?? assetPath(pathname);
  if (!relativePath) throw pathError('Not found', 404);

  const rootRealPath = await realpath(projectRoot);
  const allowedRootPath = localSvgPath
    ? await realpath(resolve(projectRoot, ...SVGDEPOT_CACHE))
    : rootRealPath;
  if (!isInside(rootRealPath, allowedRootPath)) throw pathError('Forbidden', 403);

  const fileRealPath = await realpath(resolve(allowedRootPath, relativePath));
  if (!isInside(allowedRootPath, fileRealPath)) throw pathError('Forbidden', 403);
  return fileRealPath;
}

export function createAppHandler(projectRoot, { fetchImpl = globalThis.fetch } = {}) {
  let proxyPromise;

  // Icons live in a commit-pinned upstream repository; the manifest supplies that pin so the
  // proxy can only ever reach approved jsDelivr URLs.
  async function approvedIconFallback(requestPathname) {
    const localSvgPath = svgDepotPath(decodedPathname(requestPathname));
    if (!localSvgPath) return null;
    proxyPromise ??= readFile(
      resolve(projectRoot, 'data', 'quickdraw-candidates.json'),
      'utf8',
    ).then(JSON.parse).then(manifest => createApprovedIconProxy({ manifest, fetchImpl }));
    return (await proxyPromise).icon(localSvgPath);
  }

  return async function handleRequest(request, response) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, {
        ...responseHeaders('text/plain; charset=utf-8'),
        Allow: 'GET, HEAD',
      });
      response.end('Method not allowed');
      return;
    }

    const { pathname } = new URL(request.url, 'http://localhost');
    try {
      const filePath = await resolveServedFile(projectRoot, pathname);
      const fileStats = await stat(filePath);
      if (!fileStats.isFile()) throw pathError('Not found', 404);
      const body = await readFile(filePath);
      const contentType = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
      response.writeHead(200, responseHeaders(contentType));
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      if (!error.statusCode) {
        try {
          const fallback = await approvedIconFallback(pathname);
          if (fallback) {
            response.writeHead(200, responseHeaders('image/svg+xml'));
            response.end(request.method === 'HEAD' ? undefined : fallback.body);
            return;
          }
        } catch {}
      }
      const statusCode = error.statusCode ?? 404;
      response.writeHead(statusCode, responseHeaders('text/plain; charset=utf-8'));
      response.end(request.method === 'HEAD' ? undefined : statusCode === 403 ? 'Forbidden' : 'Not found');
    }
  };
}
