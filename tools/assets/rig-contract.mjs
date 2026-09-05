#!/usr/bin/env node
/** Freeze the shipped wardrobe contract before Blender authoring. Never rewrites GLBs. */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '../..');
const directory = path.join(root, 'packages/client/public/assets/wardrobe');
const target = path.join(root, 'assets/rig-contract.json');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const catalogBytes = await readFile(path.join(directory, 'catalog.json'));
const catalog = JSON.parse(catalogBytes);
const contract = { version: 1, catalogSha256: hash(catalogBytes), boneCount: 62, parts: [] };
let referenceNames;
for (const part of [...catalog.parts].sort((a, b) => a.id.localeCompare(b.id))) {
  const file = path.join(directory, `${part.id}.glb`);
  const bytes = await readFile(file);
  const doc = await io.readBinary(bytes);
  let triangles = 0;
  const skins = doc.getRoot().listSkins().map((skin) => {
    const names = skin.listJoints().map((joint) => joint.getName());
    assert.equal(names.length, 62, `${part.id}: expected 62 joints`);
    referenceNames ??= names;
    assert.deepEqual(names, referenceNames, `${part.id}: joint order changed`);
    return { names, inverseBindSha256: hash(Buffer.from(skin.getInverseBindMatrices().getArray().buffer)) };
  });
  assert.ok(skins.length, `${part.id}: missing skin`);
  const primitives = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const positions = primitive.getAttribute('POSITION');
      const joints = primitive.getAttribute('JOINTS_0');
      const weights = primitive.getAttribute('WEIGHTS_0');
      triangles += (primitive.getIndices()?.getCount() ?? positions.getCount()) / 3;
      if (joints && weights) {
        const j = joints.getArray(); const w = weights.getArray();
        for (let i = 0; i < j.length; i++) assert.ok(j[i] < 62, `${part.id}: invalid skin index`);
        const scale = weights.getNormalized() ? (w instanceof Uint8Array ? 255 : 65535) : 1;
        for (let v = 0; v < weights.getCount(); v++) {
          let sum = 0;
          for (let k = 0; k < 4; k++) sum += w[v * 4 + k] / scale;
          assert.ok(Math.abs(sum - 1) < 0.025, `${part.id}: unnormalized vertex weights ${sum}`);
        }
        primitives.push({ mesh: mesh.getName(), vertices: positions.getCount(), skinIndicesSha256: hash(Buffer.from(j.buffer)), weightsSha256: hash(Buffer.from(w.buffer)) });
      }
    }
  }
  contract.parts.push({ id: part.id, slot: part.slot, gender: part.gender, sha256: hash(bytes), triangles, skins, primitives });
}
if (process.argv.includes('--capture')) {
  await writeFile(target, `${JSON.stringify(contract, null, 2)}\n`);
  console.log(`Frozen ${contract.parts.length} pieces, 62 ordered bones, bind poses, indices, weights and wardrobe slots.`);
} else {
  const expected = JSON.parse(await readFile(target, 'utf8'));
  assert.deepEqual(contract, expected, 'Wardrobe contract changed. Restore original assets; never overwrite this baseline to bypass review.');
  console.log(`PASS: ${contract.parts.length} original wardrobe pieces unchanged (including bind, indices, weights and slots).`);
}
