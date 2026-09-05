import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { assetManager } from '../../assets/loading.js';
import type { Rig } from './Wardrobe.js';

const danceByRig = new Map<Rig, Promise<THREE.AnimationClip[]>>();

/** Only animation data is used. The author's scene/rig never replaces V2. */
export function loadAuthoredDance(rig: Rig): Promise<THREE.AnimationClip[]> {
  const hit = danceByRig.get(rig);
  if (hit) return hit;
  const url = new URL(`assets/animations/social_dance_${rig}.glb`, document.baseURI).href;
  const pending = new GLTFLoader(assetManager).loadAsync(url).then((gltf) => gltf.animations);
  pending.catch(() => {
    if (danceByRig.get(rig) === pending) danceByRig.delete(rig);
  });
  danceByRig.set(rig, pending);
  return pending;
}

/** Reject helpers, unknown targets, malformed data and a visible loop seam. */
export function compatibleDance(
  clips: readonly THREE.AnimationClip[], skeleton: THREE.Skeleton,
): THREE.AnimationClip | null {
  const source = clips.find((clip) => /^(social[_ ]?dance|dance)$/i.test(clip.name));
  if (!source || Math.abs(source.duration - 4) > 1 / 24 || !source.tracks.length) return null;
  const names = new Set(skeleton.bones.map((bone) => bone.name));
  const bindings = new Set<string>();
  for (const track of source.tracks) {
    let parsed: ReturnType<typeof THREE.PropertyBinding.parseTrackName>;
    try { parsed = THREE.PropertyBinding.parseTrackName(track.name); } catch { return null; }
    if (!names.has(parsed.nodeName) || parsed.objectName || parsed.propertyIndex
      || !['position', 'quaternion'].includes(parsed.propertyName) || bindings.has(track.name)) return null;
    bindings.add(track.name);
    const size = track.getValueSize();
    if (size !== (parsed.propertyName === 'quaternion' ? 4 : 3) || track.times.length < 2) return null;
    if (Math.abs(track.times[0]) > 1e-4 || Math.abs(track.times[track.times.length - 1] - source.duration) > 1e-3) return null;
    for (let i = 0; i < track.times.length; i++) {
      if (!Number.isFinite(track.times[i]) || (i > 0 && track.times[i] <= track.times[i - 1])) return null;
    }
    for (const value of track.values) if (!Number.isFinite(value)) return null;
    const last = track.values.length - size;
    // q and -q describe the same rotation and are both valid loop endpoints.
    let direct = 0; let antipodal = 0;
    for (let axis = 0; axis < size; axis++) {
      direct += (track.values[axis] - track.values[last + axis]) ** 2;
      antipodal += (track.values[axis] + track.values[last + axis]) ** 2;
    }
    if (Math.min(direct, size === 4 ? antipodal : Infinity) > 1e-5) return null;
  }
  const clip = source.clone();
  clip.name = 'Dance';
  return clip;
}
