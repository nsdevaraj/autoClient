#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));

export async function checkAssets(projectRoot = PROJECT_ROOT) {
  async function asset(path) {
    let bytes;
    try {
      bytes = await readFile(resolve(projectRoot, path));
    } catch (error) {
      throw new Error(`Cannot read asset ${path}: ${error.message}`, { cause: error });
    }
    if (bytes.subarray(0, 100).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1')) {
      throw new Error(
        `Asset ${path} is a Git LFS pointer, not a binary. In an LFS checkout, run git lfs install --local and git lfs pull before serving.`,
      );
    }
    if (bytes.length === 0) throw new Error(`Asset ${path} is empty`);
    return bytes;
  }

  const wasmPath = 'vendor/ort-wasm-simd-threaded.wasm';
  if (!WebAssembly.validate(await asset(wasmPath))) {
    throw new Error(`Asset ${wasmPath} is not valid WebAssembly`);
  }
  for (const model of ['quickdraw-mvp', 'sketch-embedder']) {
    await asset(`models/${model}/${model}.onnx`);
  }

  const index = JSON.parse(await asset('data/icon-embeddings/index.json'));
  if (!Array.isArray(index.shards) || index.shards.length === 0) {
    throw new Error('Icon embedding index must contain shards');
  }
  for (const [id, shard] of index.shards.entries()) {
    if (
      shard.id !== id
      || !Number.isInteger(shard.bytes)
      || shard.bytes < 0
      || !/^[a-f0-9]{64}$/.test(shard.sha256 ?? '')
      || !/^[a-f0-9]{64}$/.test(shard.metaSha256 ?? '')
    ) {
      throw new Error(`Icon embedding shard ${id} has invalid integrity metadata`);
    }
    for (const [suffix, expectedHash] of [
      ['bin', shard.sha256],
      ['meta.json.gz', shard.metaSha256],
    ]) {
      const path = `data/icon-embeddings/shard-${id}.${suffix}`;
      const bytes = await asset(path);
      if (suffix === 'bin' && bytes.length !== shard.bytes) {
        throw new Error(`Asset ${path} has an unexpected byte length`);
      }
      if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
        throw new Error(`Asset ${path} failed SHA-256 verification`);
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await checkAssets();
    console.log('Runtime assets verified: WASM, models, and icon-index shards.');
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}
