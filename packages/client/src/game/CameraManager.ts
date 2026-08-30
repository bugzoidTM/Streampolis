import * as THREE from 'three';

/** Named framings the viewer can pick during a live (PRD §12). */
export type Framing = 'default' | 'close' | 'full_body' | 'room';

export interface FramingDef {
  /** Vertical field of view in degrees. A long lens flatters faces. */
  fov: number;
  distance: number;
  /** Height of the look-at target above the avatar's feet. */
  targetY: number;
  /** Orbit pitch in radians; positive looks down at the subject. */
  pitch: number;
  /** Lateral offset, so the subject sits off-centre when the HUD needs room. */
  offsetX: number;
}

export const FRAMINGS: Record<Framing, FramingDef> = {
  // 50 mm equivalent: natural, no perspective distortion on the face.
  default:   { fov: 39, distance: 3.4, targetY: 1.15, pitch: 0.16, offsetX: 0.18 },
  // 85 mm portrait lens pulled in tight.
  close:     { fov: 26, distance: 1.9, targetY: 1.46, pitch: 0.06, offsetX: 0.10 },
  full_body: { fov: 36, distance: 4.6, targetY: 0.94, pitch: 0.12, offsetX: 0.14 },
  // Wider, but kept off 60+ so the room does not bow at the edges.
  room:      { fov: 52, distance: 7.2, targetY: 1.05, pitch: 0.22, offsetX: 0.0 },
};

export interface CameraLimits {
  minDistance: number;
  maxDistance: number;
  minPitch: number;
  maxPitch: number;
}

const WORLD_LIMITS: CameraLimits = {
  minDistance: 1.4, maxDistance: 9.0,
  minPitch: -0.52, maxPitch: 1.05,
};

/**
 * Third-person orbit camera with collision, framing presets and critically
 * damped smoothing. The damping is framerate-independent — a plain
 * `lerp(a, b, 0.1)` per frame makes the camera behave differently at 30 and
 * 144 FPS, which is the most common way a follow camera feels wrong.
 */
export class CameraManager {
  readonly camera: THREE.PerspectiveCamera;

  yaw = 0;
  pitch = 0.18;
  distance = 3.4;

  /** Objects the camera must not pass through; usually the scene's colliders. */
  obstacles: THREE.Object3D[] = [];

  private target = new THREE.Vector3();
  private smoothTarget = new THREE.Vector3();
  private smoothDistance = 3.4;
  private desiredFov = 39;
  private limits: CameraLimits = { ...WORLD_LIMITS };
  private ray = new THREE.Raycaster();
  private shakeAmount = 0;
  private shakeDecay = 1;
  private shakeSeed = Math.random() * 1000;
  private offsetX = 0.18;
  private targetY = 1.15;
  private initialised = false;

  constructor(aspect = 1) {
    this.camera = new THREE.PerspectiveCamera(39, aspect, 0.1, 400);
    this.ray.far = WORLD_LIMITS.maxDistance;
  }

  setFraming(name: Framing, snap = false) {
    const f = FRAMINGS[name];
    this.desiredFov = f.fov;
    this.distance = f.distance;
    this.pitch = f.pitch;
    this.offsetX = f.offsetX;
    this.targetY = f.targetY;
    if (snap) {
      this.smoothDistance = f.distance;
      this.camera.fov = f.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  setLimits(limits: Partial<CameraLimits>) {
    this.limits = { ...this.limits, ...limits };
    this.ray.far = this.limits.maxDistance;
  }

  /** Kick the camera; used by gift impacts and PK results. */
  shake(amount: number, decayPerSecond = 3.2) {
    this.shakeAmount = Math.max(this.shakeAmount, amount);
    this.shakeDecay = decayPerSecond;
  }

  /** Point the rig at a world position, typically the avatar's feet. */
  follow(position: THREE.Vector3) {
    this.target.set(position.x, position.y + this.targetY, position.z);
    if (!this.initialised) {
      this.smoothTarget.copy(this.target);
      this.initialised = true;
    }
  }

  applyInput(lookYaw: number, lookPitch: number, zoom: number) {
    this.yaw += lookYaw;
    this.pitch = THREE.MathUtils.clamp(this.pitch + lookPitch, this.limits.minPitch, this.limits.maxPitch);
    this.distance = THREE.MathUtils.clamp(this.distance + zoom, this.limits.minDistance, this.limits.maxDistance);
  }

  update(dt: number) {
    // Exponential smoothing rewritten as a half-life so the response is the
    // same regardless of frame rate.
    const follow = 1 - Math.pow(0.0001, dt);
    this.smoothTarget.lerp(this.target, follow);

    const wanted = this.collide(this.distance);
    // Pull in fast when something intrudes, ease out slowly when it clears —
    // otherwise the camera lunges forward every time a wall clips the frame.
    const zoomRate = wanted < this.smoothDistance ? 1 - Math.pow(0.000001, dt) : 1 - Math.pow(0.02, dt);
    this.smoothDistance += (wanted - this.smoothDistance) * zoomRate;

    const cp = Math.cos(this.pitch);
    const offset = new THREE.Vector3(
      Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cp,
    ).multiplyScalar(this.smoothDistance);

    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const pos = this.smoothTarget.clone().add(offset).addScaledVector(right, this.offsetX);

    if (this.shakeAmount > 0.0005) {
      const t = performance.now() * 0.001 + this.shakeSeed;
      // Two incommensurable frequencies keep the shake from looking periodic.
      pos.x += (Math.sin(t * 27.3) + Math.sin(t * 41.7) * 0.6) * this.shakeAmount;
      pos.y += (Math.sin(t * 31.1) + Math.sin(t * 53.3) * 0.6) * this.shakeAmount;
      this.shakeAmount *= Math.pow(1 / (1 + this.shakeDecay), dt);
    } else {
      this.shakeAmount = 0;
    }

    this.camera.position.copy(pos);
    this.camera.lookAt(this.smoothTarget);

    if (Math.abs(this.camera.fov - this.desiredFov) > 0.01) {
      this.camera.fov += (this.desiredFov - this.camera.fov) * (1 - Math.pow(0.001, dt));
      this.camera.updateProjectionMatrix();
    }
  }

  /** Shortens the boom so the camera does not end up inside geometry. */
  private collide(desired: number): number {
    if (this.obstacles.length === 0) return desired;
    const cp = Math.cos(this.pitch);
    const dir = new THREE.Vector3(
      Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cp,
    );
    this.ray.set(this.smoothTarget, dir);
    this.ray.far = desired;
    const hits = this.ray.intersectObjects(this.obstacles, true);
    if (hits.length === 0) return desired;
    // Keep the near plane clear of the surface we hit.
    return Math.max(this.limits.minDistance, hits[0].distance - 0.28);
  }

  resize(width: number, height: number) {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }
}
