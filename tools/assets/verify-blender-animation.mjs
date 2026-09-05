#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { AnimationMixer, Box3, LoopOnce, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const reference = JSON.parse(await readFile('assets/blender-dance-reference.json', 'utf8'));
const loader = new GLTFLoader();
async function load(file) {
  const bytes = await readFile(file);
  return loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
}
for (const rig of ['m', 'f']) {
  const model = await load(`assets/vendor/authoring/${rig}.glb`);
  const motion = await load(`packages/client/public/assets/animations/social_dance_${rig}.glb`);
  const mixer = new AnimationMixer(model.scene);
  const action = mixer.clipAction(motion.animations[0]).setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  let maxError = 0;
  for (const frame of reference[rig]) {
    mixer.setTime(frame.time);
    model.scene.updateMatrixWorld(true);
    const bounds = new Box3();
    const point = new Vector3();
    model.scene.traverse(mesh => {
      if (!mesh.isMesh) return;
      mesh.skeleton?.update();
      for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
        mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld);
        bounds.expandByPoint(point);
      }
    });
    const actual = [...bounds.min.toArray(), ...bounds.max.toArray()];
    const expected = [...frame.min, ...frame.max];
    const error = Math.max(...actual.map((v, i) => Math.abs(v - expected[i])));
    maxError = Math.max(maxError, error);
    console.log(`${rig} t=${frame.time}: geometry bounds differ ${(error * 1000).toFixed(3)} mm`);
    assert.ok(error < .004, `Blender/Three geometry disagree: ${error}m`);
  }
  console.log(`PASS ${rig}: Blender bake and Three skin deformation agree within ${(maxError * 1000).toFixed(3)}mm`);
}
