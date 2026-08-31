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
}

export const AUDIT_LIMITS: AuditLimits = {
  shoeGap: 0.022,
  legGap: 0.018,
  skinTolerance: 0.0,
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

    // ---- Waist seam ------------------------------------------------------
    // Rays fired inward at the trunk from front and back. The sides are left
    // out on purpose: an arm hangs there and its skin is not a leak.
    const bodyMeshes = probes.filter((p) => p.slot === 'body').map((p) => p.mesh);
    const clothMeshes = probes.filter((p) => p.slot === 'top' || p.slot === 'bottom').map((p) => p.mesh);
    const leaks: SkinLeak[] = [];
    let skinLeakDepth = -Infinity;

    if (bodyMeshes.length) {
      // Front and back arcs only. Past ~45° the arm hangs in the way, and a
      // bare forearm below a short sleeve is not a hole in the shirt — the
      // first version of this gate failed every tee on exactly that.
      const arcs: number[] = [];
      for (let a = -42; a <= 42; a += 7) arcs.push(a);
      for (let a = 138; a <= 222; a += 7) arcs.push(a);
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
        for (const deg of arcs) {
          const rad = THREE.MathUtils.degToRad(deg);
          const dir = new THREE.Vector3(Math.sin(rad), 0, Math.cos(rad));
          const origin = dir.clone().multiplyScalar(R).setY(y);
          const inward = dir.clone().negate();
          const ray = new THREE.Raycaster(origin, inward, 0, R * 1.9);

          const skin = ray.intersectObjects(bodyMeshes, false)[0];
          // A hit this far off the mid-plane is an arm, not the trunk.
          if (!skin || Math.abs(skin.point.x) > 0.145 * h) continue;
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

    leaks.sort((a, b) => b.depth - a.depth);
    return {
      bottomIsLegged,
      shoeGap: +shoeGap.toFixed(4),
      legGap,
      legGapByHeight,
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
