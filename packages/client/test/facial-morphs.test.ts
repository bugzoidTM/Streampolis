import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { FACIAL_KEYS, FacialMorphs } from '../src/game/avatar/v2/FacialMorphs.js';

function head() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 0, 2, 0], 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(12).fill(0), 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  geometry.morphTargetsRelative = true;
  geometry.morphAttributes.position = [...FACIAL_KEYS, 'blink'].map((name, i) => {
    const target = new THREE.Float32BufferAttribute([0, 0.02 * (i + 1), 0, 0, 0, 0, 0, 0, 0], 3);
    target.name = name;
    return target;
  });
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
  mesh.name = 'Face';
  mesh.userData.streampolisFacial = { version: 1, mouth: 'integrated', region: 'lowerFace' };
  return mesh;
}

test('current untagged heads retain fallback; incomplete or unsafe morphs are rejected without mutation', () => {
  const mesh = head();
  delete mesh.userData.streampolisFacial;
  const original = mesh.morphTargetInfluences;
  assert.equal(FacialMorphs.create([mesh]), null);
  assert.equal(mesh.morphTargetInfluences, original);
  for (const corrupt of [
    (m: THREE.SkinnedMesh) => { delete m.morphTargetDictionary!.sad; },
    (m: THREE.SkinnedMesh) => { m.morphTargetDictionary!.sad = m.morphTargetDictionary!.smile; },
    (m: THREE.SkinnedMesh) => { m.geometry.morphAttributes.position[0].setX(0, NaN); },
    (m: THREE.SkinnedMesh) => { m.geometry.morphAttributes.position[0].setX(0, 99); },
    (m: THREE.SkinnedMesh) => { m.geometry.morphAttributes.position[0] = new THREE.Float32BufferAttribute([0, 0, 0], 3); },
    (m: THREE.SkinnedMesh) => { m.geometry.morphAttributes.position[0].setY(0, 0); },
  ]) {
    const invalid = head(); corrupt(invalid);
    const influences = invalid.morphTargetInfluences;
    assert.equal(FacialMorphs.create([invalid]), null);
    assert.equal(invalid.morphTargetInfluences, influences);
  }
});

test('expressions and seeded speech change only isolated instance influences, preserving unrelated targets', () => {
  const mesh = head();
  mesh.morphTargetInfluences![4] = 0.35;
  const other = new THREE.SkinnedMesh(mesh.geometry, mesh.material);
  other.morphTargetInfluences = mesh.morphTargetInfluences;
  const initialPosition = [...mesh.geometry.getAttribute('position').array];
  const initialSkin = [...mesh.geometry.getAttribute('skinIndex').array];
  const controller = FacialMorphs.create([mesh]); assert.ok(controller);
  assert.notEqual(mesh.morphTargetInfluences, other.morphTargetInfluences);
  controller.setState('smile');
  controller.update(1 / 60);
  assert.ok(mesh.morphTargetInfluences![0] > 0 && mesh.morphTargetInfluences![0] < 0.2);
  for (let i = 0; i < 180; i++) controller.update(1 / 60);
  assert.equal(mesh.morphTargetInfluences![0], 1);
  controller.speak(1, 23);
  let opened = false;
  for (let i = 0; i < 60; i++) {
    controller.update(1 / 60);
    opened ||= mesh.morphTargetInfluences![3] > 0.05;
  }
  assert.ok(opened); assert.equal(controller.speaking, false);
  for (let i = 0; i < 120; i++) controller.update(1 / 60);
  assert.equal(mesh.morphTargetInfluences![3], 0);
  assert.equal(mesh.morphTargetInfluences![0], 1);
  assert.equal(mesh.morphTargetInfluences![4], 0.35);
  assert.equal(other.morphTargetInfluences![0], 0);
  assert.deepEqual([...mesh.geometry.getAttribute('position').array], initialPosition);
  assert.deepEqual([...mesh.geometry.getAttribute('skinIndex').array], initialSkin);
  controller.dispose();
  assert.equal(mesh.morphTargetInfluences![0], 0);
  assert.equal(mesh.morphTargetInfluences![4], 0.35);
});

test('AnimationMixer can own authored targets without the expression controller overwriting its clip', () => {
  const mesh = head();
  const controller = FacialMorphs.create([mesh]); assert.ok(controller);
  controller.setState('sad'); controller.update(1);
  controller.setDriver('animation');
  const mixer = new THREE.AnimationMixer(mesh);
  const clip = new THREE.AnimationClip('FacialSmile', 1, [
    new THREE.NumberKeyframeTrack('Face.morphTargetInfluences[smile]', [0, 1], [0, 1]),
  ]);
  mixer.clipAction(clip).setLoop(THREE.LoopOnce, 1).play();
  mixer.update(0.5); controller.update(0.5);
  assert.equal(mesh.morphTargetInfluences![0], 0.5);
  assert.equal(mesh.morphTargetInfluences![1], 0);
  mixer.stopAllAction(); controller.setDriver('expressions');
  controller.setState('surprise');
  for (let i = 0; i < 180; i++) controller.update(1 / 60);
  assert.equal(mesh.morphTargetInfluences![2], 1);
  assert.equal(mesh.morphTargetInfluences![0], 0);
  controller.dispose();
});
