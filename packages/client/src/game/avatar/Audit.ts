import * as THREE from 'three';
import type { Avatar } from './Avatar.js';

/**
 * Geometric acceptance test for a dressed avatar.
 *
 * The three defects this measures — shoes fused into one block, skin showing
 * between hem and waistband, no daylight between the legs — are invisible to a
 * unit test and easy to miss by eye across a hundred combinations, so they are
 * measured with rays against the actual rest-pose surface. A number that says
 * "the two shoes are 4 mm apart" is a gate; a screenshot is a discussion.
 *
 * Everything runs on plain meshes built from the same geometry the renderer
 * uses. At rest the skinning matrices are identity, so the surface a ray hits
 * is the surface the player sees standing still.
 */

export interface AuditLimits {
  /** Minimum daylight between the two shoes, in metres. */
  shoeGap: number;
  /** Minimum daylight between the two legs below the knee. */
  legGap: number;
  /** How far body may protrude past the outermost garment before it counts. */
  skinTolerance: number;
  /** Widest daylight allowed between the trunk and an arm at the shoulder. */
  shoulderSeam: number;
}

export const AUDIT_LIMITS: AuditLimits = {
  shoeGap: 0.022,
  legGap: 0.018,
  skinTolerance: 0.0,
  shoulderSeam: 0.0,
};

export interface SkinLeak {
  y: number;
  /** Degrees from +Z, the direction the avatar faces. */
  azimuth: number;
  /** How far the body sticks out past the garment, in metres. */
  depth: number;
  /** Where on the surface, so a failure points at a station rather than a mood. */
  at: [number, number, number];
}

export interface AvatarAudit {
  /** False when the bottom is a skirt, which is exempt from the leg gap. */
  bottomIsLegged: boolean;
  shoeGap: number;
  /** Worst gap across the sampled heights below the knee. */
  legGap: number;
  legGapByHeight: Array<{ y: number; gap: number }>;
  /** Widest gap found between the trunk and an arm across the shoulder band. */
  shoulderSeam: number;
  /** Deepest skin protrusion through a garment; <= 0 means fully covered. */
  skinLeakDepth: number;
  /** How many sampled rays found bare skin where a garment should be. */
  skinLeaks: number;
  worstLeaks: SkinLeak[];
  failures: string[];
  ok: boolean;
}

type Probe = { mesh: THREE.Mesh; slot: string };

function probesFor(avatar: Avatar): { probes: Probe[]; dispose(): void } {
  const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const probes: Probe[] = [];
  avatar.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.geometry || !m.name) return;
    // Rest-pose geometry is already in avatar-root space, so a plain mesh at
    // the origin reproduces the bind pose exactly.
    const probe = new THREE.Mesh(m.geometry, mat);
    probe.updateMatrixWorld(true);
    probes.push({ mesh: probe, slot: m.name });
  });
  return { probes, dispose: () => mat.dispose() };
}

/** All surface crossings along +X at a height and depth, sorted left to right. */
function crossings(probes: Probe[], y: number, z: number, slots: string[]): number[] {
  const meshes = probes.filter((p) => slots.includes(p.slot)).map((p) => p.mesh);
  if (!meshes.length) return [];
  const ray = new THREE.Raycaster(new THREE.Vector3(-0.9, y, z), new THREE.Vector3(1, 0, 0), 0, 1.8);
  return ray.intersectObjects(meshes, false).map((h) => h.point.x).sort((a, b) => a - b);
}

/**
 * Crossings, retried at a slightly different height until they come back in
 * enter/exit pairs. A sample plane that lands exactly on a station ring is
 * coplanar with a whole row of triangles and drops one hit, which reads as two
 * fused legs when the legs are 5 cm apart. Jitter is measurement hygiene, not
 * a tolerance: an odd count after every retry still returns nothing and fails.
 */
function crossingsEven(probes: Probe[], y: number, z: number, slots: string[]): number[] {
  for (const dy of [0.0027, -0.0031, 0.0059, -0.0071]) {
    const xs = crossings(probes, y + dy, z, slots);
    if (xs.length >= 2 && xs.length % 2 === 0) return xs;
  }
  return [];
}

/**
 * The widest span of genuine daylight a ray crosses, measured with a depth
 * counter rather than by parity.
 *
 * Parity is wrong here: the body is a MERGED set of interpenetrating shells,
 * not a boolean union, so an arm buried in a torso still contributes two
 * surfaces inside the solid and a crossing count says "gap" where there is a
 * metre of flesh. Walking the hits and tracking how many shells the ray is
 * currently inside gets it right for any number of overlapping parts: only
 * when the counter returns to zero between the first entry and the last exit
 * is the ray actually in the open.
 */
function daylightSpan(probes: Probe[], y: number, z: number, slots: string[]): number {
  const meshes = probes.filter((p) => slots.includes(p.slot)).map((p) => p.mesh);
  if (!meshes.length) return 0;
  const ray = new THREE.Raycaster(new THREE.Vector3(-0.9, y, z), new THREE.Vector3(1, 0, 0), 0, 1.8);
  const hits = ray.intersectObjects(meshes, false);

  let depth = 0;
  let started = false;
  let lastExit = 0;
  let worst = 0;
  for (const hit of hits) {
    // A front face on a ray travelling +X has a normal pointing back at it.
    const entering = (hit.face?.normal.x ?? 0) < 0;
    if (entering) {
      if (started && depth === 0) worst = Math.max(worst, hit.point.x - lastExit);
      depth++;
      started = true;
    } else if (depth > 0) {
      depth--;
      if (depth === 0) lastExit = hit.point.x;
    }
  }
  return worst;
}

/**
 * The daylight in the middle of a left/right pair. Rays are cast against
 * double-sided surfaces from well outside, so crossings alternate enter, exit,
 * enter, exit — and the empty spans are the exit→enter pairs. Reading the
 * middle two hits directly would call a single fused block a wide gap.
 */
function midGap(xs: number[]): number {
  if (xs.length < 4 || xs.length % 2 !== 0) return 0;
  let best = 0;
  for (let i = 1; i + 1 < xs.length; i += 2) {
    const a = xs[i];
    const b = xs[i + 1];
    if (a < 0 && b > 0) best = Math.max(best, b - a);
  }
  return best;
}

export function auditAvatar(avatar: Avatar): AvatarAudit {
  const { probes, dispose } = probesFor(avatar);
  const rw = avatar.rig.restWorld;
  const h = avatar.rig.proportions.height;
  const failures: string[] = [];

  try {
    // ---- Feet ------------------------------------------------------------
    // Sampled across the length of the foot: heel, arch, ball. A shoe pair can
    // be clear at the heel and welded at the toe box.
    const soleY = Math.min(rw.LeftFoot.y - 0.02, rw.LeftToeBase.y);
    let shoeGap = Infinity;
    for (const zOff of [-0.02, 0.03, 0.09]) {
      const z = rw.LeftFoot.z + zOff;
      for (const y of [soleY + 0.012, soleY + 0.035]) {
        shoeGap = Math.min(shoeGap, midGap(crossingsEven(probes, y, z, ['body', 'shoes'])));
      }
    }
    if (!Number.isFinite(shoeGap)) shoeGap = 0;

    // ---- Legs ------------------------------------------------------------
    const knee = rw.LeftLeg.y;
    const ankle = rw.LeftFoot.y;
    // Is the bottom garment two legs or one volume? A skirt has no gap
    // between the knees BY DESIGN, and failing it for that is the gate being
    // wrong about the garment rather than the garment being broken. Four
    // crossings at knee height means two separate tubes; two means a skirt.
    const bottomIsLegged = (() => {
      const xs = crossingsEven(probes, knee - 0.02, rw.LeftLeg.z, ['bottom']);
      return xs.length >= 4;
    })();
    const slots = bottomIsLegged ? ['body', 'bottom', 'shoes'] : ['body', 'shoes'];

    const legGapByHeight: Array<{ y: number; gap: number; xs?: number[] }> = [];
    for (const t of [0.0, 0.35, 0.7]) {
      const y = THREE.MathUtils.lerp(knee, ankle + 0.06, t);
      let gap = Infinity;
      let worstXs: number[] = [];
      for (const zOff of [-0.02, 0, 0.02]) {
        const xs = crossingsEven(probes, y, rw.LeftLeg.z + zOff, slots);
        const g = midGap(xs);
        if (g < gap) { gap = g; worstXs = xs.map((x) => +x.toFixed(3)); }
      }
      legGapByHeight.push({ y: +y.toFixed(3), gap: +(Number.isFinite(gap) ? gap : 0).toFixed(4), xs: worstXs });
    }
    const legGap = Math.min(...legGapByHeight.map((s) => s.gap));

    // ---- Shoulder seam ---------------------------------------------------
    // A ray across the figure at shoulder height must not find open air
    // between the trunk and either arm. When it does, the arm is a separate
    // tube hung off the ribcage — which is what an articulated doll looks
    // like, and what this figure did look like. Measured on skin only:
    // whether a sleeve happens to bridge the hole is not the question.
    let shoulderSeam = 0;
    {
      const armY = rw.LeftArm.y;
      for (const y of [armY - 0.045, armY - 0.03, armY - 0.015, armY, armY + 0.012, armY + 0.024, armY + 0.036]) {
        for (const z of [-0.06, -0.03, 0, 0.03, 0.06]) {
          shoulderSeam = Math.max(shoulderSeam, daylightSpan(probes, y, z, ['body']));
        }
      }
    }

    // ---- Waist seam ------------------------------------------------------
    // Rays fired inward at the trunk from front and back. The sides are left
    // out on purpose: an arm hangs there and its skin is not a leak.
    const bodyMeshes = probes.filter((p) => p.slot === 'body').map((p) => p.mesh);
    const clothMeshes = probes.filter((p) => p.slot === 'top' || p.slot === 'bottom').map((p) => p.mesh);
    const leaks: SkinLeak[] = [];
    let skinLeakDepth = -Infinity;

    if (bodyMeshes.length) {
      // Front and back arcs where an arm can hang. Past ~45° a bare forearm
      // below a short sleeve is not a hole in the shirt, and the first version
      // of this gate failed every tee on exactly that.
      const arcs: number[] = [];
      for (let a = -42; a <= 42; a += 7) arcs.push(a);
      for (let a = 138; a <= 222; a += 7) arcs.push(a);
      // BELOW the waist there is no arm, so the sides get swept too. The hips
      // were the one place the old probe could not see, and they were exactly
      // where the trunk profile stopped short of the thigh and left a wedge of
      // bare skin on each side of every outfit in the catalogue.
      const allArcs: number[] = [];
      for (let a = 0; a < 360; a += 7) allArcs.push(a);
      const armFree = rw.Hips.y + 0.06 * h;

      // A hand hangs at hip height, so sweeping the sides puts the first hit
      // on a knuckle rather than on the trunk. Bare skin on a hand is not a
      // hole in the trousers: anything within reach of the arm chain is not
      // this gate's business.
      const armSegments = (['Left', 'Right'] as const).flatMap((side) => [
        [rw[`${side}Arm` as const], rw[`${side}ForeArm` as const]] as const,
        [rw[`${side}ForeArm` as const], rw[`${side}Hand` as const]] as const,
      ]);
      const scratch = new THREE.Vector3();
      const nearArm = (p: THREE.Vector3) => armSegments.some(([a, b]) => {
        const ab = scratch.subVectors(b, a);
        const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1);
        return p.distanceTo(a.clone().addScaledVector(ab, t)) < 0.11 * h;
      });
      // The WAIST SEAM, not the whole trunk. Above the navel, coverage is a
      // design decision — a tank bares the shoulders on purpose, and a gate
      // that reads that as a hole in the shirt bans sleeveless clothing.
      // What the contract promises is that no combination of top and bottom
      // opens a band of skin where they meet, and that is this band.
      const from = rw.Hips.y - 0.10 * h;
      const to = rw.Spine.y + 0.05 * h;
      const R = 0.9;

      for (let i = 0; i <= 14; i++) {
        const y = THREE.MathUtils.lerp(from, to, i / 14);
        const low = y < armFree;
        for (const deg of low ? allArcs : arcs) {
          const rad = THREE.MathUtils.degToRad(deg);
          const dir = new THREE.Vector3(Math.sin(rad), 0, Math.cos(rad));
          const origin = dir.clone().multiplyScalar(R).setY(y);
          const inward = dir.clone().negate();
          const ray = new THREE.Raycaster(origin, inward, 0, R * 1.9);

          const skin = ray.intersectObjects(bodyMeshes, false)[0];
          // A hit this far off the mid-plane is an arm, not the trunk. Below
          // the waist the limit opens up, because down there the widest thing
          // off the mid-plane IS the body.
          if (!skin || Math.abs(skin.point.x) > (low ? 0.30 : 0.145) * h) continue;
          if (low && nearArm(skin.point)) continue;
          const cloth = clothMeshes.length ? ray.intersectObjects(clothMeshes, false)[0] : undefined;

          // Distance is measured from the same origin, so a nearer garment hit
          // means the garment is outside the skin. No hit at all is a leak.
          const depth = cloth ? skin.distance - cloth.distance : Infinity;
          const exposed = cloth ? -depth : Infinity;
          if (exposed > AUDIT_LIMITS.skinTolerance) {
            leaks.push({
              y: +y.toFixed(3),
              azimuth: deg,
              depth: +(Number.isFinite(exposed) ? exposed : 1).toFixed(4),
              at: [+skin.point.x.toFixed(3), +skin.point.y.toFixed(3), +skin.point.z.toFixed(3)],
            });
          }
          skinLeakDepth = Math.max(skinLeakDepth, Number.isFinite(exposed) ? exposed : 1);
        }
      }
    }
    if (!Number.isFinite(skinLeakDepth)) skinLeakDepth = -1;

    if (shoeGap < AUDIT_LIMITS.shoeGap) {
      failures.push(`calçados a ${(shoeGap * 1000).toFixed(0)} mm (mínimo ${AUDIT_LIMITS.shoeGap * 1000})`);
    }
    if (legGap < AUDIT_LIMITS.legGap) {
      failures.push(`vão entre as pernas ${(legGap * 1000).toFixed(0)} mm (mínimo ${AUDIT_LIMITS.legGap * 1000})`);
    }
    if (leaks.length) {
      failures.push(`pele à mostra em ${leaks.length} raios, até ${(skinLeakDepth * 1000).toFixed(0)} mm`);
    }
    if (shoulderSeam > AUDIT_LIMITS.shoulderSeam) {
      failures.push(`braço solto do tronco: ${(shoulderSeam * 1000).toFixed(0)} mm de vão no ombro`);
    }

    leaks.sort((a, b) => b.depth - a.depth);
    return {
      bottomIsLegged,
      shoeGap: +shoeGap.toFixed(4),
      legGap,
      legGapByHeight,
      shoulderSeam: +shoulderSeam.toFixed(4),
      skinLeakDepth: +skinLeakDepth.toFixed(4),
      skinLeaks: leaks.length,
      worstLeaks: leaks.slice(0, 5),
      failures,
      ok: failures.length === 0,
    };
  } finally {
    dispose();
  }
}
