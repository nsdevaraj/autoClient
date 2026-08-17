import assert from 'node:assert/strict';
import test from 'node:test';

import { expectedIconUrl, isApprovedIconUrl } from '../src/icon-candidate.mjs';
import { iconPathHash, iconShardIndex, resolveIconShard } from '../src/icon-shards.mjs';

const COMMITS = ['a', 'b', 'c', 'd'].map(character => character.repeat(40));
const SHARDED_SOURCE = {
  repository: 'https://github.com/owner/corpus.git',
  commit: COMMITS[0],
  shards: [
    { repository: 'https://github.com/owner/cdn-00.git', commit: COMMITS[1] },
    { repository: 'https://github.com/owner/cdn-01.git', commit: COMMITS[2] },
    { repository: 'https://github.com/owner/cdn-02.git', commit: COMMITS[3] },
  ],
};
const SINGLE_SOURCE = { repository: 'https://github.com/owner/corpus.git', commit: COMMITS[0] };
const ICON_PATH = 'Icon Libraries & Named Packs/bowtie-icons/358668-cloud.svg';

test('the shard of a path is stable and within range', () => {
  for (let index = 0; index < 500; index += 1) {
    const path = `Category ${index % 7}/pack-${index % 13}/icon-${index}.svg`;
    const shard = iconShardIndex(path, 14);
    assert.ok(Number.isInteger(shard) && shard >= 0 && shard < 14);
    assert.equal(shard, iconShardIndex(path, 14));
  }
  assert.equal(iconPathHash(ICON_PATH), iconPathHash(ICON_PATH));
});

test('the shard function spreads a corpus across every repository', () => {
  const counts = new Array(14).fill(0);
  for (let index = 0; index < 20000; index += 1) {
    counts[iconShardIndex(`Category/pack-${index % 400}/icon-${index}.svg`, 14)] += 1;
  }
  const expected = 20000 / 14;
  for (const count of counts) {
    assert.ok(count > expected * 0.8, `shard is underfilled: ${count}`);
    assert.ok(count < expected * 1.2, `shard is overfilled: ${count}`);
  }
});

test('an icon URL points at the shard repository that holds it', () => {
  const shard = iconShardIndex(ICON_PATH, SHARDED_SOURCE.shards.length);
  const url = expectedIconUrl(SHARDED_SOURCE, ICON_PATH);
  assert.equal(
    url,
    `https://cdn.jsdelivr.net/gh/owner/cdn-0${shard}@${SHARDED_SOURCE.shards[shard].commit}`
      + '/Icon%20Libraries%20%26%20Named%20Packs/bowtie-icons/358668-cloud.svg',
  );
  assert.ok(isApprovedIconUrl(url, ICON_PATH, SHARDED_SOURCE));
});

test('an icon URL from the wrong shard is rejected', () => {
  const shard = iconShardIndex(ICON_PATH, SHARDED_SOURCE.shards.length);
  const other = (shard + 1) % SHARDED_SOURCE.shards.length;
  const wrong = `https://cdn.jsdelivr.net/gh/owner/cdn-0${other}@${SHARDED_SOURCE.shards[other].commit}`
    + '/Icon%20Libraries%20%26%20Named%20Packs/bowtie-icons/358668-cloud.svg';
  assert.equal(isApprovedIconUrl(wrong, ICON_PATH, SHARDED_SOURCE), false);
});

test('a source without shards keeps resolving to its own repository', () => {
  assert.equal(resolveIconShard(SINGLE_SOURCE, ICON_PATH), SINGLE_SOURCE);
  const url = expectedIconUrl(SINGLE_SOURCE, ICON_PATH);
  assert.ok(url.startsWith(`https://cdn.jsdelivr.net/gh/owner/corpus@${COMMITS[0]}/`));
  assert.ok(isApprovedIconUrl(url, ICON_PATH, SINGLE_SOURCE));
});

test('shard URLs stay approved when no source is supplied', () => {
  const url = expectedIconUrl(SHARDED_SOURCE, ICON_PATH);
  assert.ok(isApprovedIconUrl(url, ICON_PATH));
});

test('a malformed shard list does not produce a URL', () => {
  assert.equal(expectedIconUrl({ ...SINGLE_SOURCE, shards: [{ repository: 'https://github.com/o/r.git' }] }, ICON_PATH), null);
  assert.equal(expectedIconUrl(SHARDED_SOURCE, 42), null);
  assert.throws(() => iconShardIndex(ICON_PATH, 0), /positive integer/);
});
