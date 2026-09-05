import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseWardrobeLod, parseWardrobeLodManifest, selectWardrobeLod } from '../src/game/avatar/v2/WardrobeLod.js';

const id = 'm_casual_character_top';
const manifestInput = () => ({ version: 1, parts: { [id]: { slot: 'top', sourceSha256: 'a'.repeat(64), levels: [
  { level: 1, file: `${id}.lod1.glb`, triangles: 2000, sha256: 'b'.repeat(64) },
  { level: 2, file: `${id}.lod2.glb`, triangles: 900, sha256: 'c'.repeat(64) },
] } } });

test('wardrobe LOD boundaries have hysteresis in both directions', () => {
  assert.equal(chooseWardrobeLod(13.9, 0), 0);
  assert.equal(chooseWardrobeLod(14, 0), 1);
  assert.equal(chooseWardrobeLod(12, 1), 1);
  assert.equal(chooseWardrobeLod(9.9, 1), 0);
  assert.equal(chooseWardrobeLod(26, 1), 2);
  assert.equal(chooseWardrobeLod(23, 2), 2);
  assert.equal(chooseWardrobeLod(21.9, 2), 1);
  assert.equal(chooseWardrobeLod(2, 2), 0);
  assert.equal(chooseWardrobeLod(NaN, 2), 0);
});

test('LOD manifest rejects unsafe files, head swaps, duplicate levels and increasing triangle counts', () => {
  assert.ok(parseWardrobeLodManifest(manifestInput()));
  for (const unsafe of ['../top.glb', 'https://example.com/top.glb', 'top.glb']) {
    const input = manifestInput(); input.parts[id].levels[0].file = unsafe;
    assert.equal(parseWardrobeLodManifest(input), null);
  }
  const duplicate = manifestInput(); duplicate.parts[id].levels[1].level = 1;
  assert.equal(parseWardrobeLodManifest(duplicate), null);
  const larger = manifestInput(); larger.parts[id].levels[1].triangles = 3000;
  assert.equal(parseWardrobeLodManifest(larger), null);
  const heads = manifestInput();
  assert.equal(parseWardrobeLodManifest({ version: 1, parts: { m_casual_character_head: heads.parts[id] } }), null);
});

test('only available copies can be selected; source and procedural face remain the fallback', () => {
  const manifest = parseWardrobeLodManifest(manifestInput())!;
  const available = new Set([`${id}.lod1.glb`, `${id}.lod2.glb`]);
  assert.deepEqual(selectWardrobeLod(id, 30, 0, manifest, available), { level: 2, file: `${id}.lod2.glb` });
  available.delete(`${id}.lod2.glb`);
  assert.deepEqual(selectWardrobeLod(id, 30, 2, manifest, available), { level: 1, file: `${id}.lod1.glb` });
  available.clear();
  assert.deepEqual(selectWardrobeLod(id, 30, 2, manifest, available), { level: 0, file: `${id}.glb` });
  assert.deepEqual(selectWardrobeLod(id, 30, 2, null, available), { level: 0, file: `${id}.glb` });
  assert.equal(selectWardrobeLod('m_casual_character_head', 100, 2, manifest, available).level, 0);
  assert.equal(selectWardrobeLod('under_body', 100, 2, manifest, available).level, 0);
});
