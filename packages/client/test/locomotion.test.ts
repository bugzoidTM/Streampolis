import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { LocomotionController } from '../src/game/avatar/v2/LocomotionController.js';
import { compatibleDance } from '../src/game/avatar/v2/AuthoredAnimations.js';
import { extraClips } from '../src/game/avatar/v2/Clips.js';
import { AvatarV2 } from '../src/game/avatar/v2/AvatarV2.js';

const clip = (name: string, duration = 1) => new THREE.AnimationClip(name, duration, [
  new THREE.QuaternionKeyframeTrack('Body.quaternion', [0, duration / 2, duration], [
    0, 0, 0, 1, 0, Math.sin(0.1), 0, Math.cos(0.1), 0, 0, 0, 1,
  ]),
]);

function fixture(names = ['Idle', 'Walk', 'Run']) {
  const root = new THREE.Group();
  const body = new THREE.Bone(); body.name = 'Body'; root.add(body);
  const mixer = new THREE.AnimationMixer(root);
  const clips = new Map(names.map((name, i) => [name, clip(name, 1 + i / 2)]));
  return { mixer, clips, controller: new LocomotionController(mixer, clips) };
}

function advance(f: ReturnType<typeof fixture>, speed: number, frames = 120) {
  for (let i = 0; i < frames; i++) {
    f.controller.update(1 / 60, speed);
    f.mixer.update(1 / 60);
    const r = f.controller.report();
    assert.ok(Math.abs(r.idle + r.walk + r.run - r.weight) < 1e-8);
    assert.ok([r.idle, r.walk, r.run].every((v) => v >= 0 && v <= 1));
  }
}

test('actual speed selects idle, walk and run continuously, with normalized weights', () => {
  const f = fixture();
  advance(f, 0); assert.ok(f.controller.report().idle > 0.999);
  advance(f, 2.4, 1);
  assert.ok(f.controller.report().walk > 0 && f.controller.report().walk < 0.2);
  advance(f, 2.4); assert.ok(f.controller.report().walk > 0.999);
  advance(f, 3.3);
  assert.ok(Math.abs(f.controller.report().walk - 0.5) < 1e-5);
  assert.ok(Math.abs(f.controller.report().run - 0.5) < 1e-5);
  advance(f, 5.2); assert.ok(f.controller.report().run > 0.999);
  advance(f, 0); assert.ok(f.controller.report().idle > 0.999);
});

test('walk and run evaluate the same normalized step through a transition', () => {
  const f = fixture();
  for (const speed of [1.4, 2.4, 3.3, 5.2, 3.3, 0]) {
    advance(f, speed, 40);
    const walk = f.mixer.clipAction(f.clips.get('Walk')!);
    const run = f.mixer.clipAction(f.clips.get('Run')!);
    assert.ok(Math.abs(walk.time / walk.getClip().duration - run.time / run.getClip().duration) < 1e-10);
  }
});

test('gesture interruption fades the complete gait and returns without restarting phase', () => {
  const f = fixture(); advance(f, 2.4);
  f.controller.setActive(false, 0.2);
  advance(f, 2.4, 6); assert.ok(Math.abs(f.controller.report().weight - 0.5) < 1e-8);
  f.controller.setActive(true, 0.2);
  advance(f, 2.4, 12); assert.ok(Math.abs(f.controller.report().weight - 1) < 1e-8);
  f.controller.setActive(false, 0);
  advance(f, 2.4, 1); assert.equal(f.controller.report().weight, 0);
  const phase = f.controller.report().phase;
  advance(f, 2.4, 20); assert.equal(f.controller.report().phase, phase);
  f.controller.setActive(true, 0);
  f.controller.update(0, 2.4); assert.equal(f.controller.report().phase, phase);
});

test('missing clips and invalid speed never produce an underweighted or nonfinite gait', () => {
  for (const names of [['Idle'], ['Walk'], ['Run'], ['Idle', 'Run']]) {
    const f = fixture(names);
    for (const speed of [0, 2.4, 5.2, NaN, Infinity, -2]) advance(f, speed, 20);
    assert.ok(Object.values(f.controller.report()).every(Number.isFinite));
  }
});

test('procedural fallback clips are cached by bind rotations, not by first avatar loaded', () => {
  const root = new THREE.Group();
  const bone = new THREE.Bone(); bone.name = 'Head'; root.add(bone);
  const first = extraClips(root);
  assert.equal(extraClips(root), first);
  bone.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7);
  const second = extraClips(root);
  assert.notEqual(second, first);
  assert.notDeepEqual(second[0].tracks[0].values, first[0].tracks[0].values);
});

test('authored dance accepts a closed four-second bone clip and rejects unsafe targets or seams', () => {
  const bone = new THREE.Bone(); bone.name = 'Body';
  const skeleton = new THREE.Skeleton([bone]);
  const dance = clip('SocialDance', 4);
  assert.equal(compatibleDance([dance], skeleton)?.name, 'Dance');
  const helper = dance.clone(); helper.tracks[0].name = 'IK_Foot_L.quaternion';
  assert.equal(compatibleDance([helper], skeleton), null);
  const open = dance.clone(); open.tracks[0].values[open.tracks[0].values.length - 1] = 0.5;
  assert.equal(compatibleDance([open], skeleton), null);
  const scale = dance.clone(); scale.tracks[0].name = 'Body.scale';
  assert.equal(compatibleDance([scale], skeleton), null);
  const invalid = dance.clone(); invalid.tracks[0].values[5] = NaN;
  assert.equal(compatibleDance([invalid], skeleton), null);
  assert.equal(compatibleDance([clip('SocialDance', 3)], skeleton), null);
});

for (const rig of ['m', 'f']) test(`real ${rig} locomotion clips bind without altering skeleton contract`, async (t) => {
  const base = 'packages/client/public/assets/wardrobe/';
  let data: Buffer;
  try { data = await readFile(`${base}animations_${rig}.glb`); }
  catch { t.skip('Wardrobe assets must be fetched for the GLB integration check.'); return; }
  const headFile = rig === 'm' ? 'm_casual_character_head.glb' : 'f_adventurer_head.glb';
  const headData = await readFile(`${base}${headFile}`);
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '');
  const head = await loader.parseAsync(headData.buffer.slice(headData.byteOffset, headData.byteOffset + headData.byteLength), '');
  let mesh: THREE.SkinnedMesh | null = null;
  head.scene.traverse((node) => { if (!mesh && (node as THREE.SkinnedMesh).isSkinnedMesh) mesh = node as THREE.SkinnedMesh; });
  assert.ok(mesh);
  const skin = mesh as THREE.SkinnedMesh;
  const skeleton = skin.skeleton;
  assert.equal(skeleton.bones.length, 62);
  const names = skeleton.bones.map((bone) => bone.name);
  const inverse = skeleton.boneInverses.map((matrix) => [...matrix.elements]);
  const indices = [...skin.geometry.getAttribute('skinIndex').array];
  const mixer = new THREE.AnimationMixer(head.scene);
  const clips = new Map(gltf.animations.map((c) => [c.name.replace('CharacterArmature|', ''), c]));
  const f = { mixer, clips, controller: new LocomotionController(mixer, clips) };
  for (const speed of [0, 1.4, 2.4, 3.3, 5.2, 0]) {
    advance(f, speed, 60);
    head.scene.updateMatrixWorld(true);
    for (const bone of skeleton.bones) assert.ok(bone.matrixWorld.elements.every(Number.isFinite), bone.name);
  }
  assert.deepEqual(skeleton.bones.map((bone) => bone.name), names);
  assert.deepEqual(skeleton.boneInverses.map((matrix) => [...matrix.elements]), inverse);
  assert.deepEqual([...skin.geometry.getAttribute('skinIndex').array], indices);
  const authoredPath = `packages/client/public/assets/animations/social_dance_${rig}.glb`;
  const authoredData = await readFile(authoredPath).catch(() => null);
  if (authoredData) {
    const authored = await loader.parseAsync(authoredData.buffer.slice(authoredData.byteOffset, authoredData.byteOffset + authoredData.byteLength), '');
    assert.ok(compatibleDance(authored.animations, skeleton), `${rig} authored GLB must pass runtime admission`);
  }
  mixer.stopAllAction(); skeleton.dispose();
});

test('assembled V2 keeps gait and gesture weights normalized across rapid state changes', async (t) => {
  const assets = path.resolve('packages/client/public/assets');
  try { await readFile(path.join(assets, 'wardrobe/m_casual_character_head.glb')); }
  catch { t.skip('Wardrobe assets must be fetched for the avatar integration check.'); return; }
  const server = createServer(async (req, res) => {
    const route = new URL(req.url ?? '/', 'http://localhost').pathname;
    const file = path.resolve(assets, `.${route.replace(/^\/assets/, '')}`);
    if (!file.startsWith(`${assets}${path.sep}`)) { res.writeHead(403).end(); return; }
    const data = await readFile(file).catch(() => null);
    if (!data) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': data.length });
    res.end(data);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const globals = globalThis as unknown as Record<string, unknown>;
  const previousDocument = globals.document;
  const previousProgressEvent = globals.ProgressEvent;
  globals.document = { baseURI: `http://127.0.0.1:${address.port}/` };
  globals.ProgressEvent ??= class extends Event {
    constructor(type: string, public readonly detail: unknown) { super(type); }
  };
  const look = {
    head: 'm_casual_character_head', top: 'm_casual_character_top',
    bottom: 'm_casual_character_bottom', shoes: 'm_casual_character_shoes',
  };
  const avatar = new AvatarV2({
    bodyPreset: 0, skinTone: 3, facePreset: 0, hair: look.head, hairColor: 1,
    top: look.top, bottom: look.bottom, shoes: look.shoes, accessory: '', height: 1,
  }, look, { face: false, castShadow: false });
  try {
    await avatar.ready;
    assert.ok(avatar.animationReport().locomotion, 'the model and mixer must actually assemble');
    for (const state of ['dance', 'walk', 'run', 'idle', 'clap', 'wave', 'celebrate', 'pkWin', 'walk', 'run', 'idle'] as const) {
      avatar.setAnim(state);
      for (let i = 0; i < 5; i++) {
        avatar.animate(1 / 60, state === 'run' ? 5.2 : state === 'walk' ? 2.4 : 0);
        const report = avatar.animationReport();
        const gait = report.locomotion as { weight: number };
        assert.ok(Math.abs(gait.weight + Number(report.gestureWeight) - 1) < 1e-8, state);
      }
    }
    for (let i = 0; i < 30; i++) avatar.animate(1 / 60, 0);
    assert.equal(avatar.animationReport().gestureWeight, 0);
  } finally {
    avatar.dispose();
    if (previousDocument === undefined) delete globals.document; else globals.document = previousDocument;
    if (previousProgressEvent === undefined) delete globals.ProgressEvent; else globals.ProgressEvent = previousProgressEvent;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
