import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { checkAssets } from '../scripts/check-assets.mjs';

const WASM_PATH = 'vendor/ort-wasm-simd-threaded.wasm';
const MODEL_PATH = 'models/sketch-embedder/sketch-embedder.onnx';
const SHARD_PATH = 'data/icon-embeddings/shard-0.bin';
const META_PATH = 'data/icon-embeddings/shard-0.meta.json.gz';
const POINTER = 'version https://git-lfs.github.com/spec/v1\noid sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nsize 100\n';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'autodraw-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shard = Buffer.from([1, 2, 3]);
  const meta = Buffer.from('metadata fixture');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const files = {
    [WASM_PATH]: Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
    [MODEL_PATH]: 'model fixture',
    'models/quickdraw-mvp/quickdraw-mvp.onnx': 'model fixture',
    [SHARD_PATH]: shard,
    [META_PATH]: meta,
    'data/icon-embeddings/index.json': JSON.stringify({
      shards: [{ id: 0, bytes: shard.length, sha256: hash(shard), metaSha256: hash(meta) }],
    }),
  };
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  return root;
}

test('valid runtime assets pass preflight', async t => {
  await checkAssets(await fixture(t));
});

for (const path of [WASM_PATH, MODEL_PATH, SHARD_PATH, META_PATH]) {
  test(`preflight rejects a Git LFS pointer at ${path}`, async t => {
    const root = await fixture(t);
    await writeFile(join(root, path), POINTER);
    await assert.rejects(checkAssets(root), error => {
      assert.match(error.message, /Git LFS pointer/);
      assert.ok(error.message.includes(path));
      assert.match(error.message, /git lfs pull/);
      return true;
    });
  });
}

test('preflight rejects non-WASM responses before runtime initialization', async t => {
  const root = await fixture(t);
  await writeFile(join(root, WASM_PATH), '<html>Not found</html>');
  await assert.rejects(checkAssets(root), /not valid WebAssembly/);
});

test('preflight names a missing model', async t => {
  const root = await fixture(t);
  await unlink(join(root, MODEL_PATH));
  await assert.rejects(checkAssets(root), /Cannot read asset models\/sketch-embedder/);
});

test('preflight rejects empty model assets', async t => {
  const root = await fixture(t);
  await writeFile(join(root, MODEL_PATH), '');
  await assert.rejects(checkAssets(root), /is empty/);
});

test('preflight rejects a truncated shard', async t => {
  const root = await fixture(t);
  await writeFile(join(root, SHARD_PATH), Buffer.from([1]));
  await assert.rejects(checkAssets(root), /unexpected byte length/);
});

for (const path of [SHARD_PATH, META_PATH]) {
  test(`preflight verifies the manifest hash of ${path}`, async t => {
    const root = await fixture(t);
    await writeFile(join(root, path), path === SHARD_PATH ? Buffer.from([3, 2, 1]) : 'changed');
    await assert.rejects(checkAssets(root), /failed SHA-256 verification/);
  });
}
