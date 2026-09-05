#!/usr/bin/env node
/** Bake samples authored by Blender onto the unchanged original glTF node axes. */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '../..');
const sourceDir = path.join(root, 'assets/vendor/authoring');
const outDir = path.join(root, 'packages/client/public/assets/animations');
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const blenderToGltf = new Matrix4().makeRotationX(-Math.PI / 2);
const gltfToBlender = blenderToGltf.clone().invert();
const matrix = (rows) => new Matrix4().set(...rows);
await mkdir(outDir, { recursive: true });

for (const rig of process.argv.slice(2).length ? process.argv.slice(2) : ['m', 'f']) {
  assert.ok(['m', 'f'].includes(rig));
  const samples = JSON.parse(await readFile(path.join(sourceDir, `dance-${rig}-samples.json`), 'utf8'));
  const original = await io.read(path.join(sourceDir, `${rig}.glb`));
  const nodes = original.getRoot().listNodes();
  const byName = new Map(nodes.map((node) => [node.getName(), node]));
  const boneNames = new Set(samples.names);
  const skin = original.getRoot().listSkins()[0];
  const meshNode = nodes.find(node => node.getSkin() === skin && node.getMesh());
  assert.ok(skin && meshNode, 'Source must include original skin and mesh bind transform');
  const bindMatrices = skin.getInverseBindMatrices().getArray();
  const meshBindWorld = new Matrix4().fromArray(meshNode.getWorldMatrix());
  assert.equal(boneNames.size, 62);
  assert.equal(samples.frames.length, 121);
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('StreamPolis animation only');
  const copies = new Map(nodes.map((node) => [node, doc.createNode(node.getName())
    .setTranslation(node.getTranslation()).setRotation(node.getRotation()).setScale(node.getScale())]));
  for (const node of nodes) {
    for (const child of node.listChildren()) copies.get(node).addChild(copies.get(child));
    if (!node.getParentNode()) scene.addChild(copies.get(node));
  }
  const corrections = new Map(samples.names.map((name) => {
    assert.ok(byName.has(name), `Unknown deform bone: ${name}`);
    // Node TRS in the source file is a posed idle, NOT its inverse-bind pose.
    // Deriving axes from that pose applies the idle rotation twice (arms fold
    // backwards). Blender builds edit bones from the actual skin bind instead.
    const jointIndex = skin.listJoints().indexOf(byName.get(name));
    assert.ok(jointIndex >= 0);
    const originalBind = meshBindWorld.clone().multiply(new Matrix4().fromArray(bindMatrices, jointIndex * 16).invert());
    return [name, matrix(samples.bindWorld[name]).invert().multiply(gltfToBlender).multiply(originalBind)];
  }));
  const tracks = new Map(samples.names.map((name) => [name, { positions: [], rotations: [] }]));
  let maxScaleError = 0;
  let maxFootTravel = 0;
  const firstFoot = new Map();
  for (const frame of samples.frames) {
    const world = new Map(samples.names.map((name) => [name,
      blenderToGltf.clone().multiply(matrix(frame[name])).multiply(corrections.get(name))]));
    for (const name of samples.names) {
      const originalNode = byName.get(name);
      const parent = originalNode.getParentNode();
      const parentWorld = parent ? world.get(parent.getName()) ?? new Matrix4().fromArray(parent.getWorldMatrix()) : new Matrix4();
      const local = parentWorld.clone().invert().multiply(world.get(name));
      const p = new Vector3(); const q = new Quaternion(); const s = new Vector3();
      local.decompose(p, q, s);
      const expectedScale = originalNode.getScale();
      maxScaleError = Math.max(maxScaleError, ...s.toArray().map((v, i) => Math.abs(v - expectedScale[i])));
      const track = tracks.get(name);
      if (track.rotations.length) {
        const prev = new Quaternion().fromArray(track.rotations, track.rotations.length - 4);
        if (q.dot(prev) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      }
      track.positions.push(...p.toArray());
      track.rotations.push(...q.normalize().toArray());
      if (/^Foot\./.test(name)) {
        const foot = new Vector3().setFromMatrixPosition(world.get(name));
        if (!firstFoot.has(name)) firstFoot.set(name, foot.clone());
        maxFootTravel = Math.max(maxFootTravel, foot.distanceTo(firstFoot.get(name)));
      }
    }
  }
  assert.ok(maxScaleError < .001, `Unexpected animated scaling ${maxScaleError}`);
  assert.ok(maxFootTravel < .025, `Planted foot slides ${maxFootTravel}m`);
  const times = doc.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(Float32Array.from({ length: 121 }, (_, i) => i / 30));
  const clip = doc.createAnimation('SocialDance');
  let maxClosure = 0;
  for (const [name, track] of tracks) {
    for (const [target, values, dimension] of [['translation', track.positions, 3], ['rotation', track.rotations, 4]]) {
      let closure;
      if (dimension === 4) closure = 1 - Math.abs(new Quaternion().fromArray(values).dot(new Quaternion().fromArray(values, values.length - 4)));
      else closure = Math.max(...values.slice(0, 3).map((v, i) => Math.abs(v - values[values.length - 3 + i])));
      maxClosure = Math.max(maxClosure, closure);
      assert.ok(closure < .0001, `${name} loop discontinuity: ${closure}`);
      for (let k = 0; k < dimension; k++) values[values.length - dimension + k] = values[k];
      const output = doc.createAccessor().setType(dimension === 4 ? 'VEC4' : 'VEC3').setBuffer(buffer).setArray(new Float32Array(values));
      const sampler = doc.createAnimationSampler().setInput(times).setOutput(output).setInterpolation('LINEAR');
      clip.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(copies.get(byName.get(name))).setTargetPath(target).setSampler(sampler));
    }
  }
  const filepath = path.join(outDir, `social_dance_${rig}.glb`);
  await io.write(filepath, doc);
  const report = { rig, authoredWith: 'Blender MCP 4.5.9 LTS', duration: 4, frames: 121, fps: 30,
    deformBones: 62, tracks: clip.listChannels().length, meshes: 0, skins: 0, helpersExported: 0,
    maxFootTravelMetres: maxFootTravel, maxScaleError, maxLoopClosureError: maxClosure };
  await writeFile(path.join(outDir, `social_dance_${rig}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}
