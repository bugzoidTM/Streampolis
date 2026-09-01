import * as THREE from 'three';
import { loft, assemble, mergeGeometries, type Station } from './Loft.js';
import { BONE_INDEX, type BuiltRig } from './Skeleton.js';
import { type FaceShape, skullPoint, headRadius, headCentre } from './BodyBuilder.js';
import {
  makeSkinMaterial, makeHairMaterial, makeIrisMaterial, makeScleraMaterial,
  makeLipMaterial, makeMouthMaterial, makeHighlightMaterial,
} from './Materials.js';

/**
 * Face v1.
 *
 * The head used to be a sculpted egg with two spheres for eyes. A live puts
 * that head in the middle of the screen for hours, so everything here exists
 * to make it read as a person: nose, mouth, brows, ears, iris, pupil, catch
 * light, lashes — as geometry, never as a painted texture, because a painted
 * feature dies the moment the camera moves off axis.
 *
 * Two kinds of part, split by whether they ever move:
 *
 * - STATIC (nose, ears) is merged straight into the head mesh. It costs no
 *   draw call and can never drift away from the skull.
 * - MOVABLE (brows, lids, lashes, lips, eyes) hangs off the Head bone in its
 *   own little rig, because those are the parts an expression is made of.
 */

export type Expression = 'neutral' | 'smile' | 'surprise' | 'focus';

/** Every number an expression is allowed to touch. */
interface Pose {
  /** Vertical offset of the inner brow end, in head radii. */
  browInner: number;
  browOuter: number;
  /** Rotation of the upper lid, radians; larger closes the eye. */
  lidUpper: number;
  lidLower: number;
  /** Corner lift of each mouth half, radians. */
  mouthCorner: number;
  /** 0 closed, 1 wide open. */
  mouthOpen: number;
  mouthWidth: number;
}

/**
 * Four expressions is the minimum a host needs: idle, reacting well, reacting
 * hard, and concentrating. Everything the live layer wants to say — a gift
 * landed, a PK is close, the stream is quiet — is one of these four.
 */
const EXPRESSIONS: Record<Expression, Pose> = {
  neutral:  { browInner: 0,      browOuter: 0,      lidUpper: 0.02,  lidLower: 0.00,  mouthCorner: 0.03,  mouthOpen: 0.00, mouthWidth: 1.00 },
  smile:    { browInner: 0.010,  browOuter: 0.016,  lidUpper: 0.16,  lidLower: 0.14,  mouthCorner: 0.34,  mouthOpen: 0.14, mouthWidth: 1.12 },
  surprise: { browInner: 0.044,  browOuter: 0.050,  lidUpper: -0.20, lidLower: -0.10, mouthCorner: -0.05, mouthOpen: 0.90, mouthWidth: 0.78 },
  focus:    { browInner: -0.024, browOuter: 0.008,  lidUpper: 0.22,  lidLower: 0.08,  mouthCorner: -0.07, mouthOpen: 0.00, mouthWidth: 0.94 },
};

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** A tapered tube through a run of directions on the face. */
function feature(
  dirs: Array<[number, number, number]>,
  radii: Array<[number, number]>,
  lifts: number[],
  R: number,
  face: FaceShape,
): Station[] {
  return dirs.map((d, i) => ({
    pos: skullPoint(V(d[0], d[1], d[2]), R, face, lifts[i]),
    radiusX: radii[i][0] * R,
    radiusZ: radii[i][1] * R,
    bone: 'Head' as const,
    squareness: 2.2,
  }));
}

// --------------------------------------------------------------------------
// Static features, merged into the skull
// --------------------------------------------------------------------------

/**
 * The nose. A real wedge with a bridge, a tip that projects and a base that
 * tucks back under, plus two nostril wings — the old version was a bump in
 * the sphere and vanished completely in profile.
 */
function nose(R: number, face: FaceShape): THREE.BufferGeometry {
  const stations = feature(
    [[0, 0.19, 0.94], [0, 0.10, 0.99], [0, 0.020, 1.00], [0, -0.042, 1.00], [0, -0.098, 0.96]],
    [[0.030, 0.022], [0.038, 0.040], [0.052, 0.060], [0.060, 0.062], [0.040, 0.030]],
    [-0.008, 0.038, 0.100, 0.124, 0.028],
    R, face,
  );
  const parts = [loft(stations, { segments: 14, capStart: true, capEnd: true, capRound: 0.5, subdivisions: 2 })];

  // Nostril wings: the flare that makes the base of a nose read as a nose and
  // not as the end of a tube.
  for (const side of [-1, 1]) {
    const wing = feature(
      [[side * 0.050, -0.047, 0.97], [side * 0.105, -0.072, 0.95], [side * 0.090, -0.102, 0.94]],
      [[0.028, 0.028], [0.034, 0.030], [0.022, 0.022]],
      [0.066, 0.040, 0.006],
      R, face,
    );
    parts.push(loft(wing, { segments: 10, capStart: true, capEnd: true, capRound: 0.7, subdivisions: 2 }));
  }
  return assemble(parts);
}

/**
 * Ears: a bowl flattened against the skull with the helix curling around it.
 * Both are swept in the head's own YZ plane at the ear's anchor, so they lie
 * on the skull however the jaw and cranium presets reshape it.
 */
function ears(R: number, face: FaceShape): THREE.BufferGeometry {
  const parts: ReturnType<typeof loft>[] = [];

  for (const side of [-1, 1]) {
    // Ears sit BEHIND the widest point of the skull. Anchored at the widest
    // point they landed on the cheek and read as spectacles in profile.
    const anchor = skullPoint(V(side, -0.02, -0.34), R, face);

    // The helix, from the top of the ear round the back to the lobe.
    const helix: Station[] = [];
    for (let i = 0; i <= 7; i++) {
      const t = i / 7;
      const ang = THREE.MathUtils.lerp(-0.85, 2.55, t);
      helix.push({
        pos: anchor.clone().add(V(
          side * R * (0.030 - t * 0.014),
          Math.cos(ang) * R * 0.145 + R * 0.012,
          Math.sin(ang) * R * 0.090,
        )),
        radiusX: R * (0.036 - 0.014 * t),
        radiusZ: R * (0.028 - 0.009 * t),
        bone: 'Head',
        roll: Math.PI / 2,
      });
    }
    parts.push(loft(helix, { segments: 10, capStart: true, capEnd: true, capRound: 0.7, subdivisions: 2 }));

    // The concha, sunk slightly so the helix stands proud of it.
    const bowl: Station[] = [];
    for (let i = 0; i <= 3; i++) {
      const t = i / 3;
      bowl.push({
        pos: anchor.clone().add(V(side * R * (0.006 - t * 0.006), R * (0.105 - t * 0.215), R * 0.006)),
        radiusX: R * (0.056 + Math.sin(t * Math.PI) * 0.026),
        radiusZ: R * 0.018,
        bone: 'Head',
        roll: Math.PI / 2,
        squareness: 2.4,
      });
    }
    parts.push(loft(bowl, { segments: 10, capStart: true, capEnd: true, capRound: 0.5, subdivisions: 2 }));
  }

  return assemble(parts);
}

/**
 * Nose and ears in world rest space, ready to merge into the head mesh. They
 * ride the Head bone exactly like the skull does, so nothing can come apart.
 */
export function buildFaceStatic(rig: BuiltRig, face: FaceShape): THREE.BufferGeometry {
  const R = headRadius(rig, face);
  const c = headCentre(rig, face);
  const geo = mergeGeometries([nose(R, face), ears(R, face)]);
  geo.translate(0, rig.restWorld.Head.y + c.y, c.z);
  geo.computeVertexNormals();
  return geo;
}

// --------------------------------------------------------------------------
// The expression rig
// --------------------------------------------------------------------------

export interface FaceRig {
  /** Parent this to the Head bone. */
  group: THREE.Group;
  setExpression(e: Expression): void;
  /** Blends toward the requested expression; call once per frame. */
  update(dt: number): void;
  current: Expression;
  dispose(): void;
}

interface Movable {
  browL: THREE.Object3D;
  browR: THREE.Object3D;
  lidUpper: THREE.Object3D[];
  lidLower: THREE.Object3D[];
  mouthL: THREE.Object3D;
  mouthR: THREE.Object3D;
  mouthOpen: THREE.Object3D;
  mouth: THREE.Object3D;
}

/**
 * A shallow cap that hugs a sphere of radius `r`, covering `frac` of its
 * radius across, opening toward +Z.
 *
 * Flat discs do not work here: a disc wide enough to be an iris is wider than
 * the sphere's cross-section where it sits, so the sclera covers its middle
 * and only the rim escapes — which is exactly how the first pass ended up with
 * grey eyes wearing a dark ring.
 */
function cap(r: number, frac: number, seg = 20): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, seg, Math.max(4, Math.round(seg * 0.5)), 0, Math.PI * 2, 0, Math.asin(Math.min(0.999, frac)));
  g.rotateX(Math.PI / 2);

  // A sphere's own UVs are cylindrical, which smears a radial iris texture
  // into a band of colour — the eye ends up one flat hue with no pupil. Flat
  // projection down the cap's axis is what the texture was drawn for.
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const span = 2 * r * frac;
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, 0.5 + pos.getX(i) / span, 0.5 + pos.getY(i) / span);
  }
  uv.needsUpdate = true;
  return g;
}

/**
 * An eyelid, as a spherical patch whose rim is an ALMOND rather than a circle.
 *
 * Circular lid caps leave the eye open across the ball's whole width, so the
 * sclera escapes at both ends and the eye reads as a white marble with a dot
 * on it — the googly-eye look, and the loudest single defect the face had.
 * A real aperture closes at the corners: the two rims meet at the canthus and
 * overlap past it, which is what this builds.
 *
 * `open` is the rim's elevation at the centre of the eye, in radians. The
 * patch runs from that rim to the pole, so rotating the whole lid about X
 * still opens and closes the eye exactly as a cap did.
 */
function lidShell(r: number, open: number, up: boolean, seg = 20, rings = 4): THREE.BufferGeometry {
  /** Azimuth of the canthus, and how far past it the lid keeps covering. */
  const A = 1.10;
  const AMAX = 1.50;
  const dir = up ? 1 : -1;

  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];

  for (let i = 0; i <= seg; i++) {
    const psi = -AMAX + (i / seg) * 2 * AMAX;
    const k = Math.min(1, Math.abs(psi) / A);
    // 1 at the centre of the eye, 0 at the corner.
    const shape = Math.pow(Math.cos(k * Math.PI * 0.5), 0.55);
    // Past the corner both rims cross the equator, so they overlap instead of
    // leaving a slot of bare sclera exactly where the lids should meet.
    const over = Math.max(0, Math.abs(psi) - A) / (AMAX - A);
    const rim = dir * (open * shape - 0.13 * over);

    for (let j = 0; j <= rings; j++) {
      const e = THREE.MathUtils.lerp(rim, dir * Math.PI * 0.5, j / rings);
      const ce = Math.cos(e);
      pos.push(Math.sin(psi) * ce * r, Math.sin(e) * r, Math.cos(psi) * ce * r);
      uv.push(i / seg, j / rings);
    }
  }

  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < rings; j++) {
      const a = i * (rings + 1) + j;
      const b = a + rings + 1;
      if (up) idx.push(a, b, a + 1, a + 1, b, b + 1);
      else idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * The lash line: a solid form sitting on the upper lid's rim, following the
 * same almond. A torus followed a circle the rim no longer is, and hung in the
 * air at the corners.
 */
function lashBand(r: number, open: number, thickness: number, seg = 20): THREE.BufferGeometry {
  const A = 1.10;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];

  for (let i = 0; i <= seg; i++) {
    const psi = -A + (i / seg) * 2 * A;
    const shape = Math.pow(Math.cos(Math.min(1, Math.abs(psi) / A) * Math.PI * 0.5), 0.55);
    const rim = open * shape;
    // Thicker over the middle of the eye and tapering to nothing at both
    // corners, the way a lash line actually sits.
    const w = thickness * (0.35 + 0.65 * shape);
    for (let j = 0; j <= 1; j++) {
      const e = rim + j * w;
      const ce = Math.cos(e);
      pos.push(Math.sin(psi) * ce * r, Math.sin(e) * r, Math.cos(psi) * ce * r);
      uv.push(i / seg, j);
    }
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Eye direction for a side, as a unit vector out of the socket. */
const EYE_DIR = (side: number) => V(side * 0.42, 0.08, 0.92);

export function buildFaceRig(
  rig: BuiltRig,
  face: FaceShape,
  opts: { skinTone: number; hairColor: number; eyeColor: number },
): FaceRig {
  const R = headRadius(rig, face);
  const group = new THREE.Group();
  group.position.copy(headCentre(rig, face));

  const disposables: Array<{ dispose(): void }> = [];
  const skinMat = makeSkinMaterial(opts.skinTone);
  const hairMat = makeHairMaterial(opts.hairColor);
  const scleraMat = makeScleraMaterial();
  const irisMat = makeIrisMaterial(opts.eyeColor);
  const pupilMat = makeMouthMaterial();
  const lipMat = makeLipMaterial(opts.skinTone);
  const glintMat = makeHighlightMaterial();
  disposables.push(skinMat, hairMat, scleraMat, irisMat, pupilMat, lipMat, glintMat);

  const track = <T extends THREE.BufferGeometry>(g: T): T => { disposables.push(g); return g; };

  // ---- Eyes --------------------------------------------------------------
  const eyeR = R * 0.132;
  const lidUpper: THREE.Object3D[] = [];
  const lidLower: THREE.Object3D[] = [];

  for (const side of [-1, 1]) {
    const dir = EYE_DIR(side);
    const surface = skullPoint(dir, R, face);
    const eye = new THREE.Group();
    // Sunk into the socket by most of its radius, which is what stops the
    // eyeball reading as a marble stuck on the front of the face.
    eye.position.copy(surface).addScaledVector(dir.clone().normalize(), -eyeR * 0.74);
    eye.quaternion.setFromUnitVectors(V(0, 0, 1), dir.clone().normalize());
    group.add(eye);

    const ball = new THREE.Mesh(track(new THREE.SphereGeometry(eyeR, 20, 16)), scleraMat);
    eye.add(ball);

    // Iris, pupil and catch light, stacked forward so each gets its own
    // specular response instead of one flat disc doing all three jobs. The
    // iris is deliberately large: a small iris in a wide sclera is how a doll
    // stares, and the aperture below is now almond enough to carry it.
    const iris = new THREE.Mesh(track(cap(eyeR * 1.004, 0.74, 24)), irisMat);
    const pupil = new THREE.Mesh(track(cap(eyeR * 1.010, 0.33, 20)), pupilMat);
    const glint = new THREE.Mesh(track(cap(eyeR * 1.018, 0.11, 12)), glintMat);
    // Up and inboard, where a key light above and in front of the face puts it.
    glint.position.set(-side * eyeR * 0.30, eyeR * 0.30, 0);
    eye.add(iris, pupil, glint);

    // Lids are shells a hair wider than the ball, hinged at its centre.
    const upper = new THREE.Group();
    const upperShell = new THREE.Mesh(track(lidShell(eyeR * 1.07, 0.46, true)), skinMat);
    upper.add(upperShell);
    // The lash line is a solid form on the lid's rim, not a painted stripe.
    upper.add(new THREE.Mesh(track(lashBand(eyeR * 1.09, 0.46, 0.125)), hairMat));
    eye.add(upper);
    lidUpper.push(upper);

    const lower = new THREE.Group();
    lower.add(new THREE.Mesh(track(lidShell(eyeR * 1.045, 0.40, false)), skinMat));
    eye.add(lower);
    lidLower.push(lower);
  }

  // ---- Brows -------------------------------------------------------------
  const brows: THREE.Object3D[] = [];
  for (const side of [-1, 1]) {
    const st = feature(
      [[side * 0.17, 0.30, 0.95], [side * 0.36, 0.33, 0.90], [side * 0.54, 0.30, 0.80], [side * 0.66, 0.23, 0.71]],
      // Mais grossa do que parece pouco. A 0,020 de raio (2,5 mm) a
      // sobrancelha some contra a franja num close e o rosto perde a única
      // linha que dá expressão a ele — vira um risco pintado.
      [[0.026, 0.019], [0.032, 0.024], [0.026, 0.018], [0.013, 0.010]],
      [0.010, 0.013, 0.013, 0.010],
      R, face,
    );
    // Pivot at the inner end: a brow tilts by lifting its OUTER end, and a
    // brow rotated about the head's centre just slides across the forehead.
    const pivot = st[0].pos.clone();
    for (const s of st) s.pos.sub(pivot);
    const brow = new THREE.Mesh(
      track(assemble([loft(st, { segments: 8, capStart: true, capEnd: true, capRound: 0.7, subdivisions: 2 })])),
      hairMat,
    );
    brow.position.copy(pivot);
    group.add(brow);
    brows.push(brow);
  }

  // ---- Mouth -------------------------------------------------------------
  // Two halves hinged at the midline: a smile is the corners rising, and a
  // mouth that can only scale or rotate as one piece cannot do that.
  const mouth = new THREE.Group();
  const mouthCentre = skullPoint(V(0, -0.33, 0.94), R, face);
  mouth.position.copy(mouthCentre);
  group.add(mouth);

  const halves: THREE.Object3D[] = [];
  for (const side of [-1, 1]) {
    const half = new THREE.Group();
    const lip = (dirs: Array<[number, number, number]>, radii: Array<[number, number]>, lifts: number[]) => {
      const st = feature(dirs, radii, lifts, R, face);
      for (const s of st) s.pos.sub(mouthCentre);
      return new THREE.Mesh(
        track(assemble([loft(st, { segments: 10, capStart: true, capEnd: true, capRound: 0.7, subdivisions: 2 })])),
        lipMat,
      );
    };

    half.add(lip(
      [[0, -0.335, 0.95], [side * 0.075, -0.345, 0.94], [side * 0.135, -0.365, 0.91], [side * 0.180, -0.382, 0.88]],
      [[0.020, 0.016], [0.019, 0.015], [0.013, 0.011], [0.005, 0.005]],
      [0.010, 0.009, 0.006, 0.001],
    ));
    half.add(lip(
      [[0, -0.425, 0.93], [side * 0.075, -0.420, 0.92], [side * 0.135, -0.404, 0.90], [side * 0.178, -0.386, 0.88]],
      [[0.026, 0.021], [0.023, 0.018], [0.015, 0.013], [0.005, 0.005]],
      [0.012, 0.011, 0.007, 0.001],
    ));
    mouth.add(half);
    halves.push(half);
  }

  // The dark inside, revealed as the mouth opens.
  const open = new THREE.Mesh(track(new THREE.SphereGeometry(R * 0.075, 16, 10)), pupilMat);
  open.position.set(0, R * -0.01, -R * 0.03);
  open.scale.set(1, 0.12, 0.35);
  mouth.add(open);

  const parts: Movable = {
    browL: brows[1], browR: brows[0],
    lidUpper, lidLower,
    mouthL: halves[1], mouthR: halves[0],
    mouthOpen: open,
    mouth,
  };

  // Rest transforms, so a pose is always applied to the same baseline.
  const browRestY = brows.map((b) => b.position.y);

  let current: Expression = 'neutral';
  let pose: Pose = { ...EXPRESSIONS.neutral };
  let target: Pose = { ...EXPRESSIONS.neutral };

  const apply = (p: Pose) => {
    parts.browL.position.y = browRestY[1] + (p.browInner + p.browOuter) * 0.5 * R;
    parts.browR.position.y = browRestY[0] + (p.browInner + p.browOuter) * 0.5 * R;
    // The tilt between inner and outer end is what separates worry from anger
    // from delight; without it every expression is just "brows moved".
    const tilt = (p.browOuter - p.browInner) * 3.2;
    parts.browL.rotation.z = -tilt;
    parts.browR.rotation.z = tilt;

    for (const lid of parts.lidUpper) lid.rotation.x = p.lidUpper;
    for (const lid of parts.lidLower) lid.rotation.x = -p.lidLower;

    parts.mouthL.rotation.z = p.mouthCorner;
    parts.mouthR.rotation.z = -p.mouthCorner;
    parts.mouth.scale.set(p.mouthWidth, 1, 1);
    parts.mouthOpen.scale.set(p.mouthWidth, 0.12 + p.mouthOpen * 1.5, 0.35 + p.mouthOpen * 0.5);
    parts.mouthL.position.y = -p.mouthOpen * R * 0.035;
    parts.mouthR.position.y = -p.mouthOpen * R * 0.035;
  };
  apply(pose);

  const KEYS = Object.keys(EXPRESSIONS.neutral) as Array<keyof Pose>;

  return {
    group,
    get current() { return current; },
    setExpression(e: Expression) {
      current = e;
      target = EXPRESSIONS[e] ?? EXPRESSIONS.neutral;
    },
    update(dt: number) {
      // A face that snaps between poses reads as a puppet. 12 Hz is fast
      // enough to feel reactive and slow enough to look like muscle.
      const k = 1 - Math.exp(-12 * dt);
      let moved = false;
      for (const key of KEYS) {
        const next = THREE.MathUtils.lerp(pose[key], target[key], k);
        if (Math.abs(next - pose[key]) > 1e-5) moved = true;
        pose[key] = next;
      }
      if (moved) apply(pose);
    },
    dispose() {
      for (const d of disposables) d.dispose();
      disposables.length = 0;
    },
  };
}
