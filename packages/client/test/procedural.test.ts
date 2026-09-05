import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { solveTwoBone, aimBone, lookAngles } from '../src/game/avatar/v2/PoseMath.js';
import { ProceduralPose } from '../src/game/avatar/v2/ProceduralPose.js';
import type { ProceduralFrame } from '../src/game/avatar/AvatarLike.js';

const close = (a: number, b: number, epsilon = 1e-6) => assert.ok(Math.abs(a - b) < epsilon, `${a} ≠ ${b}`);
const flat: ProceduralFrame = {
  enabled: true, grounded: true, lookTarget: null,
  ground: (_x, _z, normal) => { normal.set(0, 1, 0); return 0; },
};

test('two-bone solution preserves both segment lengths and the knee plane', () => {
  const hip = new THREE.Vector3(2, 1.1, -3), target = new THREE.Vector3(2, 0.22, -3);
  const knee = new THREE.Vector3(), ankle = new THREE.Vector3();
  assert.ok(solveTwoBone(hip, target, new THREE.Vector3(0, 0, 1), 0.5, 0.5, knee, ankle));
  close(hip.distanceTo(knee), 0.5);
  close(knee.distanceTo(ankle), 0.5);
  close(ankle.distanceTo(target), 0);
  assert.ok(knee.z > hip.z);
  assert.ok(solveTwoBone(hip, target.clone().setY(-20), new THREE.Vector3(0, 0, 1), 0.5, 0.5, knee, ankle));
  assert.ok(hip.distanceTo(ankle) < 1);
  close(hip.distanceTo(knee), 0.5);
  close(knee.distanceTo(ankle), 0.5);
  assert.equal(solveTwoBone(hip, hip, new THREE.Vector3(), 0.5, 0.5, knee, ankle), false);
  assert.equal(solveTwoBone(hip, target, new THREE.Vector3(), NaN, 0.5, knee, ankle), false);
});

test('bone aiming works below rotated/scaled imported parents without local-axis assumptions', () => {
  const root = new THREE.Group(), upper = new THREE.Bone(), child = new THREE.Bone();
  root.rotation.set(0.4, 1.2, -0.1); root.scale.setScalar(100);
  root.add(upper); upper.add(child); child.position.set(0, 0.004, 0);
  upper.rotation.set(0.2, -0.1, 0.6); root.updateMatrixWorld(true);
  const start = upper.getWorldPosition(new THREE.Vector3());
  const target = start.clone().add(new THREE.Vector3(0.2, 0.1, 0.3).normalize().multiplyScalar(0.4));
  aimBone(upper, child, target, Math.PI);
  close(child.getWorldPosition(new THREE.Vector3()).distanceTo(target), 0);
  close(child.position.length(), 0.004);
});

test('head yaw/pitch clamp naturally and targets behind the shoulders release attention', () => {
  assert.deepEqual(lookAngles(new THREE.Vector3(0, 0, -2)), { yaw: 0, pitch: 0 });
  assert.deepEqual(lookAngles(new THREE.Vector3(NaN, 1, 2)), { yaw: 0, pitch: 0 });
  const angles = lookAngles(new THREE.Vector3(100, 100, 0.01));
  close(angles.yaw, Math.PI / 3);
  assert.ok(angles.pitch >= -Math.PI / 8 && angles.pitch < 0);
});

function syntheticRig() {
  const root = new THREE.Group(), body = new THREE.Bone(); body.name = 'Body';
  root.add(body); body.position.y = 0.95;
  const bones = [body];
  for (const side of ['L', 'R']) {
    const upper = new THREE.Bone(), lower = new THREE.Bone(), foot = new THREE.Bone();
    upper.name = `UpperLeg${side}`; lower.name = `LowerLeg${side}`; foot.name = `Foot${side}`;
    body.add(upper); upper.position.x = side === 'L' ? 0.12 : -0.12;
    upper.add(lower); lower.position.set(0, -0.46, 0.05);
    root.add(foot); foot.position.set(upper.position.x, 0.025, 0);
    bones.push(upper, lower, foot);
  }
  const neck = new THREE.Bone(), head = new THREE.Bone(); neck.name = 'Neck'; head.name = 'Head';
  body.add(neck); neck.position.y = 0.5; neck.add(head); head.position.y = 0.1;
  bones.push(neck, head); root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  return { root, skeleton, body, head, controller: new ProceduralPose(root, skeleton, 1.72) };
}

test('post-mixer pose restores exactly; 600 frames do not accumulate or change binds', () => {
  const { root, skeleton, body, controller } = syntheticRig();
  const inverse = skeleton.boneInverses.map(m => m.toArray());
  const names = skeleton.bones.map(b => b.name);
  const base = skeleton.bones.map(b => ({ position: b.position.clone(), rotation: b.quaternion.clone() }));
  const context = { ...flat, lookTarget: new THREE.Vector3(2, 1.7, 4),
    ground: (_x: number, _z: number, normal: THREE.Vector3) => { normal.set(0, 1, 0); return -0.05; } };
  for (let frame = 0; frame < 600; frame++) {
    controller.restore();
    for (let i = 0; i < base.length; i++) {
      close(skeleton.bones[i].position.distanceTo(base[i].position), 0);
      close(skeleton.bones[i].quaternion.angleTo(base[i].rotation), 0);
    }
    controller.apply(1 / 60, 'idle', context);
    assert.ok(body.position.y <= base[0].position.y);
    assert.ok(body.position.y >= base[0].position.y - 0.065 - 1e-6);
  }
  controller.restore(); root.updateMatrixWorld(true);
  assert.deepEqual(skeleton.boneInverses.map(m => m.toArray()), inverse);
  assert.deepEqual(skeleton.bones.map(b => b.name), names);
});

test('emotes, airborne frames and distance/quality LOD leave the mixer pose untouched', () => {
  const { skeleton, controller } = syntheticRig();
  for (const context of [flat, { ...flat, grounded: false }, { ...flat, enabled: false }]) {
    const state = context === flat ? 'dance' : 'idle';
    const original = skeleton.bones.map(b => [...b.position.toArray(), ...b.quaternion.toArray()]);
    controller.apply(1 / 60, state, { ...context, lookTarget: new THREE.Vector3(3, 2, 3) });
    assert.deepEqual(skeleton.bones.map(b => [...b.position.toArray(), ...b.quaternion.toArray()]), original);
  }
});

test('15/60/120 FPS converge to the same grounded pose and attention', () => {
  const results = [15, 60, 120].map(fps => {
    const { root, skeleton, controller, head } = syntheticRig();
    const context = { ...flat, lookTarget: new THREE.Vector3(1, 1.7, 4),
      ground: (_x: number, _z: number, normal: THREE.Vector3) => { normal.set(0, 1, 0); return 0.04; } };
    for (let frame = 0; frame < fps * 2; frame++) {
      controller.restore(); controller.apply(1 / fps, 'idle', context);
    }
    root.updateMatrixWorld(true);
    return {
      foot: skeleton.bones.find(b => b.name === 'FootL')!.getWorldPosition(new THREE.Vector3()),
      head: head.getWorldQuaternion(new THREE.Quaternion()),
    };
  });
  for (const result of results.slice(1)) {
    close(result.foot.distanceTo(results[0].foot), 0, 1e-6);
    close(result.head.angleTo(results[0].head), 0, 1e-5);
  }
});

const assetRoot = resolve('packages/client/public/assets/wardrobe');
for (const file of ['m_casual_character_head.glb', 'f_adventurer_head.glb']) {
  test(`real ${file}: detached V2 feet ground without modifying 62-bone contract`, async t => {
    const path = resolve(assetRoot, file);
    try { await access(path); } catch { t.skip('Fetch production wardrobe assets to run the integration fixture.'); return; }
    const bytes = await readFile(path);
    const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    const root = new THREE.Group(); root.add(gltf.scene);
    let skeleton: THREE.Skeleton | undefined;
    gltf.scene.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skeleton ??= (o as THREE.SkinnedMesh).skeleton; });
    assert.ok(skeleton); assert.equal(skeleton.bones.length, 62);
    root.updateMatrixWorld(true);
    const highest = Math.max(...skeleton.bones.map(b => b.getWorldPosition(new THREE.Vector3()).y));
    root.scale.setScalar(1.72 / (highest / 0.87)); root.updateMatrixWorld(true);
    const controller = new ProceduralPose(root, skeleton, 1.72);
    const foot = skeleton.bones.find(b => b.name === 'FootL')!;
    const body = skeleton.bones.find(b => b.name === 'Body')!;
    const restHeight = foot.getWorldPosition(new THREE.Vector3()).y;
    const names = skeleton.bones.map(b => [b.name, b.parent?.uuid]);
    const inverse = skeleton.boneInverses.map(m => m.toArray());
    const before = skeleton.bones.map(b => [...b.position.toArray(), ...b.quaternion.toArray()]);
    const originalBody = body.getWorldPosition(new THREE.Vector3()).y;
    for (let frame = 0; frame < 90; frame++) {
      controller.restore();
      controller.apply(1 / 60, 'idle', { ...flat,
        ground: (_x, _z, normal) => { normal.set(0, 1, 0); return 0.04; },
        lookTarget: new THREE.Vector3(1, 1.6, 4) });
    }
    const achieved = foot.getWorldPosition(new THREE.Vector3()).y;
    close(achieved, restHeight + 0.04, 0.003);
    assert.ok(Math.abs(body.getWorldPosition(new THREE.Vector3()).y - originalBody) <= 0.065);
    controller.restore();
    assert.deepEqual(skeleton.bones.map(b => [...b.position.toArray(), ...b.quaternion.toArray()]), before);
    assert.deepEqual(skeleton.bones.map(b => [b.name, b.parent?.uuid]), names);
    assert.deepEqual(skeleton.boneInverses.map(m => m.toArray()), inverse);
    const animBytes = await readFile(resolve(assetRoot, `animations_${file[0]}.glb`));
    const animations = await new GLTFLoader().parseAsync(
      animBytes.buffer.slice(animBytes.byteOffset, animBytes.byteOffset + animBytes.byteLength), '');
    const mixer = new THREE.AnimationMixer(gltf.scene);
    for (const state of ['idle', 'walk', 'run'] as const) {
      const clip = animations.animations.find(c => c.name.replace('CharacterArmature|', '').toLowerCase() === state);
      assert.ok(clip);
      mixer.stopAllAction(); mixer.clipAction(clip).play();
      for (let frame = 0; frame < 90; frame++) {
        controller.restore();
        mixer.update(1 / 60);
        root.position.x += 0.01; root.rotation.y += 0.005; root.updateMatrixWorld(true);
        const animated = skeleton.bones.map(b => [...b.position.toArray(), ...b.quaternion.toArray()]);
        const footBefore = foot.getWorldPosition(new THREE.Vector3());
        controller.apply(1 / 60, state, flat);
        const footAfter = foot.getWorldPosition(new THREE.Vector3());
        assert.ok(footAfter.distanceTo(footBefore) < 0.13, 'contact correction stays within12cm reach budget');
        for (const bone of skeleton.bones) {
          assert.ok([...bone.position.toArray(), ...bone.quaternion.toArray()].every(Number.isFinite));
        }
        controller.restore();
        assert.deepEqual(skeleton.bones.map(b => [...b.position.toArray(), ...b.quaternion.toArray()]), animated);
      }
    }
    mixer.stopAllAction(); mixer.uncacheRoot(gltf.scene);
    assert.deepEqual(skeleton.bones.map(b => [b.name, b.parent?.uuid]), names);
    assert.deepEqual(skeleton.boneInverses.map(m => m.toArray()), inverse);
    gltf.scene.traverse(o => {
      if ((o as THREE.Mesh).isMesh) {
        const mesh = o as THREE.Mesh; mesh.geometry.dispose();
        for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) mat.dispose();
      }
    });
    skeleton.dispose();
  });
}
