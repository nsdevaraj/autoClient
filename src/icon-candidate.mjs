import { PINNED_ICON_REF, iconShardRef, resolveIconShard } from './icon-shards.mjs';

export function isConfinedSvgPath(value) {
  if (typeof value !== 'string' || !value.endsWith('.svg') || value.includes('\\')) return false;
  const segments = value.split('/');
  return segments.length > 1
    && segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

function repositorySlug(repository) {
  if (typeof repository !== 'string') return null;
  try {
    const url = new URL(repository);
    const segments = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (
      url.protocol !== 'https:'
      || url.hostname !== 'github.com'
      || url.username
      || url.password
      || url.port
      || url.search
      || url.hash
      || segments.length !== 2
      || segments.some(segment => !segment)
    ) return null;
    return `${segments[0]}/${segments[1].replace(/\.git$/, '')}`;
  } catch {
    return null;
  }
}

function encodedPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

// The corpus spans several pinned repositories, so the path selects which one holds it.
export function expectedIconUrl(source, path) {
  if (typeof path !== 'string') return null;
  const shard = resolveIconShard(source, path);
  const repository = repositorySlug(shard?.repository);
  const ref = iconShardRef(shard);
  if (!repository || !ref) return null;
  return `https://cdn.jsdelivr.net/gh/${repository}@${ref}/${encodedPath(path)}`;
}

export function isApprovedIconUrl(value, path, source) {
  if (typeof value !== 'string' || !isConfinedSvgPath(path)) return false;
  const expected = source ? expectedIconUrl(source, path) : null;
  if (source) return expected !== null && value === expected;
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/gh\/[^/]+\/[^/@]+@([^/]+)\/(.+)$/);
    return url.protocol === 'https:'
      && url.hostname === 'cdn.jsdelivr.net'
      && !url.username
      && !url.password
      && !url.port
      && !url.search
      && !url.hash
      && match !== null
      && PINNED_ICON_REF.test(match[1])
      && decodeURIComponent(match[2]) === path;
  } catch {
    return false;
  }
}

export function assertApprovedIconSource(value, label = 'Icon', source) {
  if (!isConfinedSvgPath(value?.path)) {
    throw new Error(`${label} must contain a confined SVG path`);
  }
  if (!isApprovedIconUrl(value?.url, value.path, source)) {
    const detail = source ? 'commit-pinned jsDelivr URL matching its candidate path' : 'commit-pinned jsDelivr URL';
    throw new Error(`${label} must use a ${detail}`);
  }
}