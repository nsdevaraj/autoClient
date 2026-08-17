#!/usr/bin/env node

// Materialises the icon corpus into several sub-50 MB repositories, because jsDelivr refuses to
// serve a GitHub package larger than 50 MB and the full corpus is ~511 MB. Icons are read from
// the content-addressed store produced by the corpus fetcher, so this never needs a checkout of
// the upstream icon repository.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { expectedIconUrl } from '../src/icon-candidate.mjs';
import { iconShardIndex } from '../src/icon-shards.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULTS = {
  sourceRoot: resolve(PROJECT_ROOT, '../autoDraw'),
  out: resolve(PROJECT_ROOT, '.cache/icon-shard-repos'),
  shards: 14,
  owner: 'nsdevaraj',
  prefix: 'SVGDepot-cdn-',
  only: null,
  limit: null,
  publish: false,
  apply: false,
  skipBuild: false,
  tag: 'v1.0.0',
};

function printHelp() {
  console.log(`Split the icon corpus into sub-50 MB repositories for jsDelivr.

Usage:
  node scripts/build-icon-shard-repos.mjs [options]

Options:
  --source-root <path>  Repository holding the icon store and index (default: ../autoDraw)
  --out <path>          Where shard repositories are materialised
  --shards <count>      Number of shard repositories (default: ${DEFAULTS.shards})
  --owner <login>       GitHub owner used for repository names (default: ${DEFAULTS.owner})
  --prefix <prefix>     Repository name prefix (default: ${DEFAULTS.prefix})
  --only <id>           Build a single shard, for verification
  --limit <count>       Materialise at most this many icons, for a smoke test
  --publish             Create the GitHub repositories and push them
  --skip-build          Reuse trees already materialised in --out
  --tag <version>       Release tag jsDelivr serves (default: ${DEFAULTS.tag})
  --apply               Rewrite data manifests from a built shard-sources.json
  --help                Show this help

Without --publish nothing is created or pushed; the trees are only written to --out.
`);
}

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      printHelp();
      process.exit(0);
    }
    if (argument === '--publish') { options.publish = true; continue; }
    if (argument === '--skip-build') { options.skipBuild = true; continue; }
    if (argument === '--apply') { options.apply = true; continue; }

    const value = argv[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${argument}`);
    if (argument === '--source-root') options.sourceRoot = resolve(value);
    else if (argument === '--out') options.out = resolve(value);
    else if (argument === '--shards') options.shards = Number(value);
    else if (argument === '--owner') options.owner = value;
    else if (argument === '--prefix') options.prefix = value;
    else if (argument === '--tag') options.tag = value;
    else if (argument === '--only') options.only = Number(value);
    else if (argument === '--limit') options.limit = Number(value);
    else throw new Error(`Unknown option: ${argument}`);
    index += 1;
  }

  if (!Number.isInteger(options.shards) || options.shards < 1) {
    throw new Error('--shards must be a positive integer');
  }
  if (options.only !== null && (!Number.isInteger(options.only) || options.only < 0 || options.only >= options.shards)) {
    throw new Error(`--only must be a shard id from 0 to ${options.shards - 1}`);
  }
  return options;
}

function readJson(path) {
  const raw = readFileSync(path);
  return JSON.parse(path.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8'));
}

function shardName(options, id) {
  return `${options.prefix}${String(id).padStart(2, '0')}`;
}

// Mirrors the corpus index layout: an icon is a pack id plus a filename, and a pack is a
// category id plus a pack directory.
function iconPathsFrom(index) {
  return index.icons.map(([packId, filename], iconId) => {
    const pack = index.packs[packId];
    if (!Array.isArray(pack) || typeof filename !== 'string') {
      throw new Error(`Icon index entry ${iconId} is malformed`);
    }
    const category = index.categories[pack[0]];
    if (typeof category !== 'string') {
      throw new Error(`Icon index entry ${iconId} has an unknown category`);
    }
    return [category, pack[1], filename].filter(Boolean).join('/');
  });
}

function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function buildShards(options) {
  const indexPath = join(options.sourceRoot, 'data/svgdepot-index.json.gz');
  const manifestPath = join(options.sourceRoot, 'data/svgdepot-icon-manifest.json.gz');
  const store = join(options.sourceRoot, '.cache/svgdepot-icons');
  for (const required of [indexPath, manifestPath, store]) {
    if (!existsSync(required)) throw new Error(`Missing corpus input: ${required}`);
  }

  const index = readJson(indexPath);
  const manifest = readJson(manifestPath);
  const paths = iconPathsFrom(index);

  const stats = Array.from({ length: options.shards }, (_, id) => ({ id, files: 0, bytes: 0 }));
  let unavailable = 0;
  let written = 0;

  for (let iconId = 0; iconId < paths.length; iconId += 1) {
    if (options.limit !== null && written >= options.limit) break;
    const iconPath = paths[iconId];
    const slot = manifest.iconDigests[iconId];
    const digest = slot ? manifest.digests[slot - 1] : null;
    if (!digest) { unavailable += 1; continue; }

    const shard = iconShardIndex(iconPath, options.shards);
    if (options.only !== null && shard !== options.only) continue;

    const sourceFile = join(store, digest.slice(0, 2), `${digest}.svg`);
    if (!existsSync(sourceFile)) { unavailable += 1; continue; }

    const destination = join(options.out, shardName(options, shard), iconPath);
    mkdirSync(dirname(destination), { recursive: true });
    const body = readFileSync(sourceFile);
    writeFileSync(destination, body);
    stats[shard].files += 1;
    stats[shard].bytes += body.byteLength;
    written += 1;
  }

  for (const shard of stats) {
    if (options.only !== null && shard.id !== options.only) continue;
    const root = join(options.out, shardName(options, shard.id));
    if (!existsSync(root)) continue;
    writeFileSync(join(root, 'README.md'), `# ${shardName(options, shard.id)}\n\n`
      + `Shard ${shard.id} of ${options.shards} of the SVGDepot icon corpus.\n\n`
      + 'Published as several repositories because jsDelivr does not serve a GitHub package\n'
      + 'larger than 50 MB. The shard holding a path is derived from the path, so this split is\n'
      + 'reproducible and no lookup table is required.\n\n'
      + `Icons: ${shard.files}\n`);
  }

  return { stats, unavailable, written };
}

function pushWithRetry(root, slug, attempts = 5, args = ['push', '-q', '--force', '-u', 'origin', 'main']) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = git(root, args, { allowFailure: true });
    if (result.status === 0) return;
    if (attempt === attempts) {
      throw new Error(`pushing ${slug} failed after ${attempts} attempts: ${result.stderr || result.stdout}`);
    }
    const backoff = attempt * 10;
    console.log(`  push of ${slug} failed, retrying in ${backoff}s (attempt ${attempt + 1}/${attempts})`);
    spawnSync('sleep', [String(backoff)]);
  }
}

function publishShards(options, stats) {
  const sources = [];
  for (const shard of stats) {
    if (options.only !== null && shard.id !== options.only) continue;
    const name = shardName(options, shard.id);
    const root = join(options.out, name);
    if (!existsSync(root)) continue;

    if (!existsSync(join(root, '.git'))) git(root, ['init', '-q', '-b', 'main']);
    git(root, ['add', '-A']);
    const pending = git(root, ['status', '--porcelain'], { allowFailure: true }).stdout.trim();
    if (pending) {
      git(root, ['-c', 'user.name=icon-shard-builder', '-c', 'user.email=icon-shard-builder@local',
        'commit', '-q', '-m', `Publish icon shard ${shard.id} of ${options.shards}`]);
    }

    const slug = `${options.owner}/${name}`;
    git(root, ['remote', 'remove', 'origin'], { allowFailure: true });
    git(root, ['remote', 'add', 'origin', `https://github.com/${slug}.git`]);
    // Each shard pushes tens of MB in one pack, which HTTPS proxies often reset mid-transfer.
    git(root, ['config', 'http.postBuffer', '524288000']);
    git(root, ['config', 'http.version', 'HTTP/1.1']);

    // Existence is probed over git rather than the API, because the GitHub GraphQL endpoint
    // returns transient 503s that must not be mistaken for a missing repository.
    const probe = git(root, ['ls-remote', 'origin'], { allowFailure: true });
    if (probe.status !== 0) {
      const created = spawnSync('gh', ['repo', 'create', slug, '--public',
        '--description', `SVGDepot icon corpus shard ${shard.id} of ${options.shards}`],
      { encoding: 'utf8' });
      if (created.status !== 0 && !/already exists/i.test(`${created.stderr}${created.stdout}`)) {
        throw new Error(`gh repo create ${slug} failed: ${created.stderr || created.stdout}`);
      }
    }

    const commit = git(root, ['rev-parse', 'HEAD']).stdout.trim();
    const remote = git(root, ['ls-remote', 'origin', 'refs/heads/main'], { allowFailure: true });
    if (remote.status === 0 && remote.stdout.startsWith(commit)) {
      console.log(`skipped ${slug} @ ${commit} (already pushed)`);
    } else {
      pushWithRetry(root, slug);
      console.log(`published ${slug} @ ${commit}${shard.files ? ` (${shard.files} icons)` : ''}`);
    }

    // jsDelivr resolves a GitHub package by released version, so an untagged push stays
    // unreachable no matter how small it is.
    const tagged = git(root, ['rev-parse', `refs/tags/${options.tag}`], { allowFailure: true });
    if (tagged.status !== 0) {
      git(root, ['tag', '-a', options.tag, '-m', `Icon shard ${shard.id} of ${options.shards}`]);
    }
    const remoteTag = git(root, ['ls-remote', 'origin', `refs/tags/${options.tag}`], { allowFailure: true });
    if (remoteTag.status !== 0 || !remoteTag.stdout.trim()) {
      pushWithRetry(root, `${slug} tag ${options.tag}`, 5, ['push', '-q', 'origin', options.tag]);
      console.log(`  tagged ${slug} ${options.tag}`);
    }
    sources.push({ id: shard.id, repository: `https://github.com/${slug}.git`, commit, tag: options.tag });
  }

  const target = join(options.out, 'shard-sources.json');
  writeFileSync(target, `${JSON.stringify({ shards: options.shards, sources }, null, 2)}\n`);
  console.log(`wrote ${target}`);
  return sources;
}

// Rewrites the shipped manifests so every icon URL points at the shard that now holds it.
function applyShardSources(options) {
  const sourcesFile = join(options.out, 'shard-sources.json');
  if (!existsSync(sourcesFile)) throw new Error(`Missing ${sourcesFile}; run with --publish first`);
  const published = readJson(sourcesFile);
  if (published.sources.length !== published.shards) {
    throw new Error(`shard-sources.json holds ${published.sources.length} of ${published.shards} shards`);
  }
  const shards = published.sources
    .slice()
    .sort((left, right) => left.id - right.id)
    .map(({ repository, commit, tag }) => (tag ? { repository, commit, tag } : { repository, commit }));

  const candidatesPath = resolve(PROJECT_ROOT, 'data/quickdraw-candidates.json');
  const candidates = readJson(candidatesPath);
  candidates.source = { ...candidates.source, shards };
  let rewritten = 0;
  for (const candidateClass of candidates.classes) {
    for (const candidate of candidateClass.candidates ?? []) {
      const url = expectedIconUrl(candidates.source, candidate.path);
      if (!url) throw new Error(`Could not derive a shard URL for ${candidate.path}`);
      candidate.url = url;
      rewritten += 1;
    }
  }
  writeFileSync(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`);

  const indexPath = resolve(PROJECT_ROOT, 'data/icon-embeddings/index.json');
  const index = readJson(indexPath);
  index.source = { ...index.source, shards };
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  console.log(`applied ${shards.length} shard sources; rewrote ${rewritten} candidate URLs`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.apply) {
    applyShardSources(options);
  } else {
    let stats;
    if (options.skipBuild) {
      stats = Array.from({ length: options.shards }, (_, id) => ({ id, files: 0, bytes: 0 }));
      console.log(`reusing trees already materialised in ${options.out}`);
    } else {
      const built = buildShards(options);
      stats = built.stats;
      console.log(`materialised ${built.written} icons (${built.unavailable} unavailable) into ${options.out}`);
      for (const shard of stats) {
        if (options.only !== null && shard.id !== options.only) continue;
        console.log(`  ${shardName(options, shard.id)}: ${shard.files} icons, ${(shard.bytes / 1048576).toFixed(1)} MB`);
      }
      const largest = Math.max(...stats.map(shard => shard.bytes));
      if (largest > 50 * 1024 * 1024) {
        console.warn(`warning: largest shard is ${(largest / 1048576).toFixed(1)} MB, over the 50 MB jsDelivr limit`);
      }
    }
    if (options.publish) publishShards(options, stats);
  }
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
}
