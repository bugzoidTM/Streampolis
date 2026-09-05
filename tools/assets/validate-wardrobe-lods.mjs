#!/usr/bin/env node
/** Read-only gate for separately authored LOD copies. Never rewrites source assets. */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '../..');
const wardrobe = path.join(root, 'packages/client/public/assets/wardrobe');
const manifestPath = process.argv[2]
  ? path.resolve(process.argv[2]) : path.join(wardrobe, 'lods/manifest.json');
const bundle = await build({ entryPoints: [path.join(root, 'packages/client/src/game/avatar/v2/WardrobeLod.ts')],
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const { parseWardrobeLodManifest } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const manifest = parseWardrobeLodManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
assert.ok(manifest, 'Invalid LOD manifest. Heads, lining, path traversal and arbitrary URLs are forbidden.');
const contract = JSON.parse(await readFile(path.join(root, 'assets/rig-contract.json'), 'utf8'));
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const parents = node => node.listParents().filter(p => p.propertyType === 'Node').map(p => p.getName());

function skinContract(doc) {
  return doc.getRoot().listSkins().map(skin => ({
    joints: skin.listJoints().map(node => ({ name: node.getName(), parents: parents(node),
      translation: node.getTranslation(), rotation: node.getRotation(), scale: node.getScale(),
      world: node.getWorldMatrix() })),
    inverseBind: Array.from(skin.getInverseBindMatrices().getArray()),
  }));
}

function meshContract(doc) {
  return doc.getRoot().listNodes().filter(node => node.getMesh()).map(node => ({
    node: node.getName(), parent: parents(node), matrix: node.getWorldMatrix(),
    mesh: node.getMesh().getName(),
    primitives: node.getMesh().listPrimitives().map(primitive => ({
      material: primitive.getMaterial()?.getName() ?? '', mode: primitive.getMode(),
      attributes: [...primitive.listSemantics()].sort(), morphs: primitive.listTargets().length,
    })),
  })).sort((a, b) => a.node.localeCompare(b.node));
}

function triangleCount(doc) {
  return doc.getRoot().listMeshes().reduce((total, mesh) => total + mesh.listPrimitives().reduce((sum, primitive) => {
    assert.equal(primitive.getMode(), 4, 'LOD must use triangle primitives.');
    const position = primitive.getAttribute('POSITION');
    const joints = primitive.getAttribute('JOINTS_0'), weights = primitive.getAttribute('WEIGHTS_0');
    assert.ok(position && joints && weights, 'Every LOD primitive must remain skinned.');
    assert.equal(joints.getCount(), position.getCount()); assert.equal(weights.getCount(), position.getCount());
    assert.equal(joints.getElementSize(), 4); assert.equal(weights.getElementSize(), 4);
    for (const value of position.getArray()) assert.ok(Number.isFinite(value), 'Nonfinite LOD vertex.');
    for (const value of joints.getArray()) assert.ok(Number.isInteger(value) && value >= 0 && value < 62, 'Joint index remapped outside the original62 bones.');
    const weight = [];
    for (let vertex = 0; vertex < weights.getCount(); vertex++) {
      weights.getElement(vertex, weight);
      assert.ok(weight.every(value => Number.isFinite(value) && value >= 0 && value <= 1), 'Invalid skin weight.');
      assert.ok(Math.abs(weight.reduce((a, b) => a + b, 0) - 1) < 0.025, 'Unnormalized skin weights.');
    }
    const indices = primitive.getIndices();
    if (indices) for (const index of indices.getArray()) assert.ok(index >= 0 && index < position.getCount(), 'Invalid triangle index.');
    const count = indices?.getCount() ?? position.getCount();
    assert.equal(count % 3, 0, 'Incomplete triangle.');
    return sum + count / 3;
  }, 0), 0);
}

const report = [];
for (const [id, part] of Object.entries(manifest.parts)) {
  const sourceContract = contract.parts.find(entry => entry.id === id);
  assert.ok(sourceContract, `${id}: unknown original wardrobe part`);
  assert.equal(part.slot, sourceContract.slot, `${id}: wardrobe slot changed`);
  const sourceBytes = await readFile(path.join(wardrobe, `${id}.glb`));
  assert.equal(hash(sourceBytes), sourceContract.sha256, `${id}: original asset changed`);
  assert.equal(part.sourceSha256, sourceContract.sha256, `${id}: wrong source/bind family`);
  const source = await io.readBinary(sourceBytes);
  const sourceSkin = skinContract(source), sourceMeshes = meshContract(source);
  const originalTriangles = triangleCount(source);
  for (const asset of part.levels) {
    // The parser restricts asset.file to an exact plain filename in this folder.
    const bytes = await readFile(path.join(path.dirname(manifestPath), asset.file));
    assert.equal(hash(bytes), asset.sha256, `${asset.file}: file hash mismatch`);
    const lod = await io.readBinary(bytes);
    assert.equal(lod.getRoot().listAnimations().length, 0, `${asset.file}: wardrobe LOD cannot ship animation`);
    assert.deepEqual(skinContract(lod), sourceSkin, `${asset.file}: bones, hierarchy or bind pose changed`);
    assert.deepEqual(meshContract(lod), sourceMeshes, `${asset.file}: primitive/material/slot layout changed`);
    const triangles = triangleCount(lod);
    assert.equal(triangles, asset.triangles, `${asset.file}: incorrect triangle budget`);
    assert.ok(triangles < originalTriangles, `${asset.file}: no geometry reduction`);
    report.push({ part: id, level: asset.level, triangles, originalTriangles, sha256: asset.sha256 });
  }
}
assert.ok(report.length, 'No authored LOD assets were supplied; no LOD gate has passed.');
console.log(JSON.stringify({ validated: report.length, runtimeEnabled: false, assets: report }, null, 2));
