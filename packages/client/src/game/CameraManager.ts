import * as THREE from 'three';

/** Named framings the viewer can pick during a live (PRD §12). */
export type Framing = 'default' | 'close' | 'full_body' | 'room' | 'interior';

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
  // 17% mais perto do que era. O personagem é o produto — é nele que o
  // jogador gasta dinheiro — e a 3,4 m ele ocupava um décimo da altura do
  // quadro numa praça de 26 m de raio: o cenário ganhava a composição.
  default:   { fov: 39, distance: 2.82, targetY: 1.12, pitch: 0.14, offsetX: 0.16 },
  // 85 mm portrait lens pulled in tight.
  close:     { fov: 26, distance: 1.9, targetY: 1.46, pitch: 0.06, offsetX: 0.10 },
  full_body: { fov: 36, distance: 4.6, targetY: 0.94, pitch: 0.12, offsetX: 0.14 },
  // Wider, but kept off 60+ so the room does not bow at the edges.
  room:      { fov: 52, distance: 7.2, targetY: 1.05, pitch: 0.22, offsetX: 0.0 },
  // Um quarto não é uma praça. Aproximar a câmera resolveu a composição ao ar
  // livre — o personagem ocupava um décimo do quadro num raio de 26 m — e
  // estragou a de dentro, onde ele já é grande e o que falta ver é a MOBÍLIA
  // que a pessoa comprou. Mais campo e um pouco mais de recuo, dentro do que o
  // braço curto de um interior admite.
  interior:  { fov: 46, distance: 3.9, targetY: 1.06, pitch: 0.17, offsetX: 0.10 },
};

export interface CameraLimits {
  minDistance: number;
  maxDistance: number;
  minPitch: number;
  maxPitch: number;
}

/**
 * Quanto um clique de roda muda o braço, em fração dele.
 *
 * 0,16 dá cerca de 17% por clique: uns doze cliques cobrem o curso inteiro de
 * 1,4 m a 9 m — perto o bastante para o gesto parecer imediato, longe o
 * bastante para dar para parar no meio.
 */
const ZOOM_POR_CLIQUE = 0.16;

const WORLD_LIMITS: CameraLimits = {
  minDistance: 1.4, maxDistance: 9.0,
  minPitch: -0.52, maxPitch: 1.05,
};

/** Marca um objeto (e seus filhos) como atravessável pela câmera. */
export function makeCameraTransparent<T extends THREE.Object3D>(obj: T): T {
  obj.traverse((o) => { o.userData.noCameraCollision = true; });
  return obj;
}

function passesThrough(obj: THREE.Object3D): boolean {
  let node: THREE.Object3D | null = obj;
  while (node) {
    if (node.userData?.noCameraCollision) return true;
    node = node.parent;
  }
  return false;
}

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
  distance = 2.82;

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

  /**
   * Gira e aproxima. `zoom` vem em CLIQUES de roda, não em metros.
   *
   * O zoom é MULTIPLICATIVO de propósito. O braço vai de 1,4 m a 9 m, e uma
   * quantidade fixa em metros por clique é grosseira num extremo e lenta no
   * outro: 40 cm colado no rosto é meio personagem, 40 cm a nove metros não se
   * vê. Uma fração constante da distância dá o mesmo passo APARENTE em todo o
   * curso, e é por isso que a conta é uma exponencial.
   *
   * (Aqui morava um defeito silencioso: quem chamava passava a roda crua
   * multiplicada por 0,01, o que dava quatro MILÍMETROS por clique. O zoom
   * existia, respondia, e não movia nada que o olho pudesse notar.)
   */
  applyInput(lookYaw: number, lookPitch: number, zoom: number) {
    this.yaw += lookYaw;
    this.pitch = THREE.MathUtils.clamp(this.pitch + lookPitch, this.limits.minPitch, this.limits.maxPitch);
    this.distance = THREE.MathUtils.clamp(
      this.distance * Math.exp(zoom * ZOOM_POR_CLIQUE),
      this.limits.minDistance, this.limits.maxDistance,
    );
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
    // Nem toda geometria é parede. Feixes de luz, marcas no chão e brilhos
    // aditivos são decoração que a câmera atravessa — tratá-los como obstáculo
    // encurtava o braço para 1,5 m toda vez que um refletor cruzava o caminho,
    // e o enquadramento da live virava um close no umbigo do host.
    const blocker = hits.find((hit) => !passesThrough(hit.object));
    if (!blocker) return desired;
    // Keep the near plane clear of the surface we hit.
    return Math.max(this.limits.minDistance, blocker.distance - 0.28);
  }

  resize(width: number, height: number) {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }
}
