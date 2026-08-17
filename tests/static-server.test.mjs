import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAppHandler, resolveServedFile } from '../src/static-server.mjs';

function createRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, 'data', 'icon-embeddings'), { recursive: true });
  mkdirSync(join(root, 'models', 'sketch-embedder'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'vendor'), { recursive: true });
  mkdirSync(join(root, '.cache', 'svgdepot', 'Animals', 'line'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html>');
  writeFileSync(join(root, 'data', 'quickdraw-candidates.json'), '{}');
  writeFileSync(join(root, 'data', 'icon-embeddings', 'index.json'), '{}');
  writeFileSync(join(root, 'data', 'icon-embeddings', 'shard-0.bin'), 'bin');
  writeFileSync(join(root, 'models', 'sketch-embedder', 'sketch-embedder.onnx'), 'model');
  writeFileSync(join(root, 'src', 'drawing-app.mjs'), '');
  writeFileSync(join(root, 'vendor', 'ort-wasm-simd-threaded.wasm'), 'wasm');
  writeFileSync(join(root, '.cache', 'svgdepot', 'Animals', 'line', 'cat.svg'), '<svg/>');
  return root;
}

test('the client server only resolves explicitly served paths', async () => {
  const root = createRoot('autodraw-client-paths-');

  try {
    assert.equal(await resolveServedFile(root, '/'), await realpath(join(root, 'index.html')));
    assert.equal(
      await resolveServedFile(root, '/index.html'),
      await realpath(join(root, 'index.html')),
    );
    assert.equal(
      await resolveServedFile(root, '/src/drawing-app.mjs'),
      await realpath(join(root, 'src', 'drawing-app.mjs')),
    );
    assert.equal(
      await resolveServedFile(root, '/models/sketch-embedder/sketch-embedder.onnx'),
      await realpath(join(root, 'models', 'sketch-embedder', 'sketch-embedder.onnx')),
    );
    assert.equal(
      await resolveServedFile(root, '/data/icon-embeddings/shard-0.bin'),
      await realpath(join(root, 'data', 'icon-embeddings', 'shard-0.bin')),
    );
    assert.equal(
      await resolveServedFile(root, '/data/quickdraw-candidates.json'),
      await realpath(join(root, 'data', 'quickdraw-candidates.json')),
    );
    assert.equal(
      await resolveServedFile(root, '/vendor/ort-wasm-simd-threaded.wasm'),
      await realpath(join(root, 'vendor', 'ort-wasm-simd-threaded.wasm')),
    );
    assert.equal(
      await resolveServedFile(root, '/svgdepot/Animals/line/cat.svg'),
      await realpath(join(root, '.cache', 'svgdepot', 'Animals', 'line', 'cat.svg')),
    );

    await assert.rejects(() => resolveServedFile(root, '/svgdepot/../.git/config.svg'), /Not found/);
    await assert.rejects(() => resolveServedFile(root, '/src/../index.html'), /Not found/);
    await assert.rejects(() => resolveServedFile(root, '/data/secrets.json'), /Not found/);
    await assert.rejects(() => resolveServedFile(root, '/.git/config'), /Not found/);
    await assert.rejects(() => resolveServedFile(root, '/package.json'), /Not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the client server rejects a served path that resolves outside the project root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'autodraw-client-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'autodraw-client-outside-'));
  mkdirSync(join(root, 'data'));
  mkdirSync(join(root, '.cache', 'svgdepot', 'Animals'), { recursive: true });
  writeFileSync(join(outside, 'secret.json'), '{"secret":true}');
  symlinkSync(join(outside, 'secret.json'), join(root, 'data', 'quickdraw-candidates.json'));
  symlinkSync(join(outside, 'secret.json'), join(root, '.cache', 'svgdepot', 'Animals', 'cat.svg'));

  try {
    await assert.rejects(
      () => resolveServedFile(root, '/data/quickdraw-candidates.json'),
      /Forbidden/,
    );
    await assert.rejects(() => resolveServedFile(root, '/svgdepot/Animals/cat.svg'), /Forbidden/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('the client server secures responses and types runtime binaries exactly', async () => {
  const root = createRoot('autodraw-client-http-');
  const server = createServer(createAppHandler(root, { fetchImpl: async () => new Response('', { status: 404 }) }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  try {
    const responses = await Promise.all([
      fetch(`http://127.0.0.1:${port}/`),
      fetch(`http://127.0.0.1:${port}/missing`),
      fetch(`http://127.0.0.1:${port}/`, { method: 'POST' }),
    ]);
    assert.deepEqual(responses.map(response => response.status), [200, 404, 405]);
    for (const response of responses) {
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
      assert.match(
        response.headers.get('content-security-policy'),
        /script-src 'self' 'wasm-unsafe-eval'/,
      );
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
    assert.equal(responses[2].headers.get('allow'), 'GET, HEAD');

    const binaries = await Promise.all([
      fetch(`http://127.0.0.1:${port}/models/sketch-embedder/sketch-embedder.onnx`),
      fetch(`http://127.0.0.1:${port}/vendor/ort-wasm-simd-threaded.wasm`),
      fetch(`http://127.0.0.1:${port}/src/drawing-app.mjs`),
    ]);
    assert.deepEqual(binaries.map(response => response.status), [200, 200, 200]);
    assert.deepEqual(
      binaries.map(response => response.headers.get('content-type')),
      ['application/octet-stream', 'application/wasm', 'text/javascript; charset=utf-8'],
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('missing local icons proxy their pinned manifest SVG', async () => {
  const root = mkdtempSync(join(tmpdir(), 'autodraw-client-icons-'));
  mkdirSync(join(root, 'data'));
  const approvedUrl = 'https://cdn.jsdelivr.net/gh/example/icons@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Animals/line/cat.svg';
  writeFileSync(join(root, 'data', 'quickdraw-candidates.json'), JSON.stringify({
    schemaVersion: 1,
    fingerprint: 'manifest',
    source: {
      repository: 'https://github.com/example/icons.git',
      commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    classes: [{
      name: 'cat',
      candidates: [{ path: 'Animals/line/cat.svg', url: approvedUrl }],
    }],
  }));

  const requests = [];
  const server = createServer(createAppHandler(root, {
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
        status: 200,
        headers: { 'Content-Type': 'image/svg+xml' },
      });
    },
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  try {
    const approved = await fetch(`http://127.0.0.1:${port}/svgdepot/Animals/line/cat.svg`);
    assert.equal(approved.status, 200);
    assert.equal(approved.headers.get('content-type'), 'image/svg+xml');
    assert.equal(await approved.text(), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    assert.deepEqual(requests[0], { url: approvedUrl, options: { redirect: 'error' } });

    const cached = await fetch(`http://127.0.0.1:${port}/svgdepot/Animals/line/cat.svg`);
    assert.equal(cached.status, 200);
    assert.equal(
      requests.filter(request => request.url === approvedUrl).length,
      1,
      'the approved icon is fetched once and then cached',
    );

    const traversal = await fetch(`http://127.0.0.1:${port}/svgdepot/../secret.svg`, {
      redirect: 'manual',
    });
    assert.equal(traversal.status, 404);
    assert.equal(
      requests.some(request => request.url.includes('secret')),
      false,
      'a traversing path must never reach the CDN',
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
