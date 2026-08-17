// jsDelivr refuses to serve a GitHub package larger than 50 MB, and the icon corpus is ~511 MB,
// so icons are published across several sub-50 MB repositories pinned to their own commits.
// The shard that holds a path is derived from the path itself rather than stored, so the client
// never ships a 210k-entry lookup table just to build a URL.

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const pathEncoder = new TextEncoder();

// Hashing the UTF-8 bytes keeps the assignment identical for any builder that reproduces the
// corpus, instead of depending on how a particular language indexes the string.
export function iconPathHash(path) {
  if (typeof path !== 'string') throw new Error('Icon path must be a string');
  const bytes = pathEncoder.encode(path);
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

export function iconShardIndex(path, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error('Icon shard count must be a positive integer');
  }
  return iconPathHash(path) % shardCount;
}

// jsDelivr resolves a GitHub package by released version, so shards are pinned to an immutable
// release tag. The commit stays recorded alongside it as provenance for the published tree.
export const PINNED_ICON_REF = /^(?:[0-9a-f]{40}|v\d+\.\d+\.\d+)$/;

export function iconShardRef(shard) {
  const ref = typeof shard?.tag === 'string' && shard.tag.length > 0 ? shard.tag : shard?.commit;
  return typeof ref === 'string' && PINNED_ICON_REF.test(ref) ? ref : null;
}

export function iconShardSources(source) {
  const shards = source?.shards;
  return Array.isArray(shards) && shards.length > 0 ? shards : null;
}

// A single-repository source stays its own shard so a corpus small enough for one repository,
// and every manifest written before the split, keeps resolving through one code path.
export function resolveIconShard(source, path) {
  const shards = iconShardSources(source);
  if (!shards) return source ?? null;
  return shards[iconShardIndex(path, shards.length)] ?? null;
}
