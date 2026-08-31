import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { CSM } from 'three/examples/jsm/csm/CSM.js';

export interface SkyParams {
  /** Rayleigh scattering coefficient — higher is a bluer, hazier sky. */
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
  /** Sun elevation in degrees above the horizon. */
  elevation: number;
  azimuth: number;
  sunIntensity: number;
  sunColor: number;
  /** Hemisphere fill, standing in for bounced skylight. */
  skyColor: number;
  groundColor: number;
  ambientIntensity: number;
  fogColor: number;
  fogNear: number;
  fogFar: number;
  envIntensity: number;
}

export const GOLDEN_HOUR: SkyParams = {
  turbidity: 4.2, rayleigh: 2.1, mieCoefficient: 0.0055, mieDirectionalG: 0.82,
  elevation: 14, azimuth: 145, sunIntensity: 3.1, sunColor: 0xfff0dc,
  skyColor: 0xbcd8ff, groundColor: 0x6b5f52, ambientIntensity: 0.55,
  fogColor: 0xc9d8e8, fogNear: 40, fogFar: 220, envIntensity: 1.0,
};

export const MIDDAY: SkyParams = {
  turbidity: 3.0, rayleigh: 1.4, mieCoefficient: 0.004, mieDirectionalG: 0.8,
  elevation: 52, azimuth: 168, sunIntensity: 3.6, sunColor: 0xfff6e8,
  skyColor: 0xa8ccff, groundColor: 0x7a7062, ambientIntensity: 0.6,
  fogColor: 0xd6e4f2, fogNear: 60, fogFar: 280, envIntensity: 1.0,
};

export const DUSK: SkyParams = {
  turbidity: 8.0, rayleigh: 3.4, mieCoefficient: 0.008, mieDirectionalG: 0.86,
  elevation: 3.5, azimuth: 205, sunIntensity: 2.2, sunColor: 0xffb26b,
  skyColor: 0x4a5f92, groundColor: 0x2b2540, ambientIntensity: 0.42,
  fogColor: 0x6d6a8c, fogNear: 30, fogFar: 180, envIntensity: 0.9,
};

/**
 * What a scene needs from whatever is lighting it. The plaza gets a sky and a
 * sun; a room gets neither, and the scene base must not care which it holds.
 */
export interface LightRig {
  update(camera: THREE.Camera): void;
  /** CSM patches materials at creation; new materials have to opt in. */
  registerMaterial(mat: THREE.Material): void;
  dispose(): void;
}

/**
 * Builds the outdoor lighting rig: a Preetham sky used both as a backdrop and
 * as the IBL source, a sun with cascaded shadow maps, and a hemisphere fill.
 *
 * The environment map is generated once via PMREM from the sky itself, so
 * ambient light and specular reflections agree with what the player sees on
 * the horizon rather than being an unrelated constant (SPECs §8).
 */
export class Environment implements LightRig {
  readonly sky: Sky;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly sunPosition = new THREE.Vector3();

  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private csm: CSM | null = null;
  private params: SkyParams;

  constructor(
    private scene: THREE.Scene,
    private renderer: THREE.WebGLRenderer,
    params: SkyParams = GOLDEN_HOUR,
  ) {
    this.params = { ...params };
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();

    this.sky = new Sky();
    this.sky.scale.setScalar(45_000);
    // The sky dome must never be occluded or shadowed by world geometry.
    this.sky.renderOrder = -1;
    (this.sky.material as THREE.ShaderMaterial).depthWrite = false;
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(params.sunColor, params.sunIntensity);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.028;
    this.sun.shadow.mapSize.set(2048, 2048);
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(params.skyColor, params.groundColor, params.ambientIntensity);
    scene.add(this.hemi);

    this.apply(this.params);
  }

  /**
   * Enables cascaded shadow maps for large outdoor scenes. CSM keeps texel
   * density high near the camera without the acne a single 300 m frustum
   * would produce.
   */
  enableCascades(camera: THREE.Camera, maxFar: number, mapSize: number) {
    this.disableCascades();
    this.sun.castShadow = false;
    this.csm = new CSM({
      maxFar,
      cascades: 3,
      mode: 'practical',
      parent: this.scene,
      shadowMapSize: mapSize,
      shadowBias: -0.0006,
      lightDirection: this.sunPosition.clone().negate().normalize(),
      camera,
      lightIntensity: this.params.sunIntensity,
    });
    for (const l of this.csm.lights) l.color.setHex(this.params.sunColor);
    this.csm.fade = true;
  }

  disableCascades() {
    if (!this.csm) return;
    this.csm.dispose();
    this.csm = null;
    this.sun.castShadow = true;
  }

  /** CSM patches materials at creation time; new meshes must opt in. */
  registerMaterial(mat: THREE.Material) {
    this.csm?.setupMaterial(mat);
  }

  /** Sizes a single (non-cascaded) shadow frustum to an explicit world box. */
  frameShadows(center: THREE.Vector3, radius: number) {
    if (this.csm) return;
    const cam = this.sun.shadow.camera;
    cam.left = -radius; cam.right = radius;
    cam.top = radius; cam.bottom = -radius;
    cam.near = 0.5;
    cam.far = radius * 4.5;
    cam.updateProjectionMatrix();
    this.sun.target.position.copy(center);
    this.sun.target.updateMatrixWorld();
    this.sun.position.copy(center).addScaledVector(this.sunPosition, radius * 2.2);
  }

  apply(params: Partial<SkyParams>) {
    Object.assign(this.params, params);
    const p = this.params;
    const u = (this.sky.material as THREE.ShaderMaterial).uniforms;
    u.turbidity.value = p.turbidity;
    u.rayleigh.value = p.rayleigh;
    u.mieCoefficient.value = p.mieCoefficient;
    u.mieDirectionalG.value = p.mieDirectionalG;

    const phi = THREE.MathUtils.degToRad(90 - p.elevation);
    const theta = THREE.MathUtils.degToRad(p.azimuth);
    this.sunPosition.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(this.sunPosition);

    this.sun.color.setHex(p.sunColor);
    this.sun.intensity = p.sunIntensity;
    this.hemi.color.setHex(p.skyColor);
    this.hemi.groundColor.setHex(p.groundColor);
    this.hemi.intensity = p.ambientIntensity;

    if (this.csm) {
      this.csm.lightDirection.copy(this.sunPosition).negate().normalize();
      this.csm.lightIntensity = p.sunIntensity;
      for (const l of this.csm.lights) l.color.setHex(p.sunColor);
    }

    this.scene.fog = new THREE.Fog(p.fogColor, p.fogNear, p.fogFar);
    this.scene.environmentIntensity = p.envIntensity;
    this.refreshEnvironment();
  }

  /** Re-bakes the IBL. Costly, so only called when the sky itself changes. */
  refreshEnvironment() {
    this.envRT?.dispose();
    // PMREM must see only the sky, not the populated world.
    const capture = new THREE.Scene();
    const skyClone = this.sky.clone() as Sky;
    capture.add(skyClone);
    this.envRT = this.pmrem.fromScene(capture, 0.04);
    this.scene.environment = this.envRT.texture;
    skyClone.geometry.dispose();
  }

  update(camera: THREE.Camera) {
    if (this.csm) {
      this.csm.update();
      // CSM only follows the camera it was constructed with.
      if (this.csm.camera !== camera) this.csm.camera = camera as THREE.PerspectiveCamera;
    }
  }

  dispose() {
    this.disableCascades();
    this.envRT?.dispose();
    this.pmrem.dispose();
    this.scene.remove(this.sky, this.sun, this.sun.target, this.hemi);
    this.sky.geometry.dispose();
    (this.sky.material as THREE.Material).dispose();
  }
}


// ---------------------------------------------------------------------------
// Interiors
// ---------------------------------------------------------------------------

export interface InteriorParams {
  /** Hemisphere fill: what the ceiling and the floor bounce back. */
  ceilingColor: number;
  floorColor: number;
  ambientIntensity: number;
  /** Direction the key light travels, from the window into the room. */
  keyDirection: [number, number, number];
  keyColor: number;
  keyIntensity: number;
  /** Half-size of the shadow frustum; roughly the room's largest dimension. */
  keyRadius: number;
  /** Colours of the six faces of the box the IBL is baked from. */
  envTop: number;
  envSide: number;
  envFloor: number;
  /** One bright face standing in for the window wall. */
  envWindow: number;
  envIntensity: number;
  fogColor: number;
  fogNear: number;
  fogFar: number;
}

export const ROOM_DAY: InteriorParams = {
  ceilingColor: 0xdfe7f2, floorColor: 0x6b6259, ambientIntensity: 0.5,
  keyDirection: [-0.35, -0.72, 0.6], keyColor: 0xfff0d8, keyIntensity: 2.6, keyRadius: 7,
  envTop: 0x9fb4cc, envSide: 0x6d6a66, envFloor: 0x3b3733, envWindow: 0xcfe2ff,
  envIntensity: 0.95, fogColor: 0x2a2e36, fogNear: 24, fogFar: 90,
};

export const ROOM_NIGHT: InteriorParams = {
  ceilingColor: 0x2c3550, floorColor: 0x14161c, ambientIntensity: 0.34,
  keyDirection: [-0.2, -0.85, 0.45], keyColor: 0x9fb6ff, keyIntensity: 0.7, keyRadius: 9,
  envTop: 0x1a2030, envSide: 0x20222c, envFloor: 0x0d0e12, envWindow: 0x3b4a6b,
  envIntensity: 0.7, fogColor: 0x0b0d12, fogNear: 18, fogFar: 70,
};

/**
 * Lighting for a room.
 *
 * No sky, no PMREM of a sky: an interior lit by the outdoor rig looks like a
 * film set with the roof torn off. The IBL here is baked from a tinted box —
 * bright ceiling, darker walls, one luminous face where the window is — which
 * is the cheapest thing that still gives materials somewhere plausible to
 * reflect. Practical lamps are added by the scene as point lights on top.
 */
export class InteriorRig implements LightRig {
  readonly key: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;

  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private params: InteriorParams;
  private boxGeo: THREE.BoxGeometry | null = null;

  constructor(
    private scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    params: InteriorParams = ROOM_DAY,
  ) {
    this.params = { ...params };
    this.pmrem = new THREE.PMREMGenerator(renderer);

    this.hemi = new THREE.HemisphereLight(
      this.params.ceilingColor, this.params.floorColor, this.params.ambientIntensity,
    );
    scene.add(this.hemi);

    this.key = new THREE.DirectionalLight(this.params.keyColor, this.params.keyIntensity);
    this.key.castShadow = true;
    this.key.shadow.bias = -0.0007;
    this.key.shadow.normalBias = 0.03;
    this.key.shadow.mapSize.set(2048, 2048);
    scene.add(this.key, this.key.target);

    this.apply(this.params);
  }

  apply(params: Partial<InteriorParams>) {
    Object.assign(this.params, params);
    const p = this.params;

    this.hemi.color.setHex(p.ceilingColor);
    this.hemi.groundColor.setHex(p.floorColor);
    this.hemi.intensity = p.ambientIntensity;

    this.key.color.setHex(p.keyColor);
    this.key.intensity = p.keyIntensity;
    const dir = new THREE.Vector3(...p.keyDirection).normalize();
    this.key.position.copy(dir).multiplyScalar(-p.keyRadius * 2.2);
    this.key.target.position.set(0, 0, 0);
    this.key.target.updateMatrixWorld();
    const cam = this.key.shadow.camera;
    cam.left = -p.keyRadius; cam.right = p.keyRadius;
    cam.top = p.keyRadius; cam.bottom = -p.keyRadius;
    cam.near = 0.5;
    cam.far = p.keyRadius * 5;
    cam.updateProjectionMatrix();

    this.scene.fog = new THREE.Fog(p.fogColor, p.fogNear, p.fogFar);
    this.scene.background = new THREE.Color(p.fogColor);
    this.scene.environmentIntensity = p.envIntensity;
    this.bakeEnvironment();
  }

  /** Bakes the IBL from a tinted box. Cheap enough to redo on a look change. */
  private bakeEnvironment() {
    this.envRT?.dispose();
    const p = this.params;
    const capture = new THREE.Scene();
    this.boxGeo?.dispose();
    this.boxGeo = new THREE.BoxGeometry(12, 6, 12);
    const faces = [p.envSide, p.envWindow, p.envTop, p.envFloor, p.envSide, p.envSide];
    const mats = faces.map((hex) =>
      new THREE.MeshBasicMaterial({ color: hex, side: THREE.BackSide }));
    const boxMesh = new THREE.Mesh(this.boxGeo, mats);
    capture.add(boxMesh);
    this.envRT = this.pmrem.fromScene(capture, 0.06);
    this.scene.environment = this.envRT.texture;
    for (const m of mats) m.dispose();
  }

  /** Nothing to track per frame: a room's light does not follow the camera. */
  update(_camera: THREE.Camera) {}

  registerMaterial(_mat: THREE.Material) {}

  dispose() {
    this.envRT?.dispose();
    this.pmrem.dispose();
    this.boxGeo?.dispose();
    this.scene.remove(this.key, this.key.target, this.hemi);
    this.scene.environment = null;
    this.scene.background = null;
  }
}
