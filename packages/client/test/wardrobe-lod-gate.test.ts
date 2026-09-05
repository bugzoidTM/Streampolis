import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

test('offline LOD gate validates actual copies and rejects bind changes/nonreductions', async t => {
  const root = resolve('.'), id = 'm_casual_character_top';
  const sourcePath = join(root, 'packages/client/public/assets/wardrobe', `${id}.glb`);
  try { await access(sourcePath); await access(join(root, 'assets/rig-contract.json')); }
  catch { t.skip('Original wardrobe and frozen rig contract required for integration fixture.'); return; }
  const scratch = await mkdtemp(join(tmpdir(), 'streampolis-lod-gate-'));
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const source = await readFile(sourcePath), hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const sourceHash = hash(source), file = `${id}.lod1.glb`;
  const manifestPath = join(scratch, 'manifest.json');
  const run = () => execFileSync(process.execPath, [join(root, 'tools/assets/validate-wardrobe-lods.mjs'), manifestPath],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const save = async (bytes: Uint8Array, triangles: number) => {
    await writeFile(join(scratch, file), bytes);
    await writeFile(manifestPath, JSON.stringify({ version: 1, parts: { [id]: { slot: 'top', sourceSha256: sourceHash,
      levels: [{ level: 1, file, triangles, sha256: hash(bytes) }] } } }));
  };
  try {
    const copy = await io.readBinary(source);
    let triangles = 0;
    for (const mesh of copy.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
      const indices = primitive.getIndices()!;
      assert.ok(indices, 'Fixture has indexed primitives.');
      const array = indices.getArray()!;
      const count = Math.max(3, Math.floor(array.length / 6) * 3);
      // A disposable gate fixture, never an authored or shipped LOD model.
      primitive.setIndices(indices.clone().setArray(array.slice(0, count)));
      triangles += count / 3;
    }
    await save(await io.writeBinary(copy), triangles);
    const report = JSON.parse(run());
    assert.equal(report.validated, 1); assert.equal(report.runtimeEnabled, false);
    const inverse = copy.getRoot().listSkins()[0].getInverseBindMatrices()!;
    inverse.getArray()![0] += 0.1;
    await save(await io.writeBinary(copy), triangles);
    assert.throws(run, (error: unknown) => String((error as { stderr?: string }).stderr).includes('bind pose changed'));
    const original = await io.readBinary(source);
    const originalTriangles = original.getRoot().listMeshes().reduce((sum, mesh) => sum
      + mesh.listPrimitives().reduce((n, p) => n + p.getIndices()!.getCount() / 3, 0), 0);
    await save(source, originalTriangles);
    assert.throws(run, (error: unknown) => String((error as { stderr?: string }).stderr).includes('no geometry reduction'));
    assert.equal(hash(await readFile(sourcePath)), sourceHash, 'Gate never rewrites source wardrobe.');
  } finally {
    assert.ok(resolve(scratch).startsWith(resolve(tmpdir(), 'streampolis-lod-gate-')), 'Cleanup remains inside this test fixture.');
    await rm(scratch, { recursive: true, force: true });
  }
});
