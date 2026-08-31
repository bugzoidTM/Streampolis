import * as THREE from 'three';
import {
  applySurface, asphalt, brick, carpet, concrete, fabric, metalPanel,
  pavingTile, plaster, slatWall, woodFloor, type SurfaceMaps,
} from '../materials/Textures.js';

/**
 * Shared material palette for a scene.
 *
 * Every material is memoised by key and owned by the library, so a hundred
 * props asking for "dark metal" get the exact same instance — which is what
 * lets `InstancedMesh` collapse them into one draw call — and a scene teardown
 * disposes the whole set at once (SPECs §7, §12).
 *
 * Texture tiling is *not* set on the texture (the maps are cached globally and
 * shared across scenes); density is controlled per mesh by `boxUV`.
 */
export class MatLib {
  private cache = new Map<string, THREE.Material>();

  private make<T extends THREE.Material>(key: string, build: () => T): T {
    const hit = this.cache.get(key);
    if (hit) return hit as T;
    const mat = build();
    mat.name = key;
    this.cache.set(key, mat);
    return mat;
  }

  private surface(
    key: string, maps: SurfaceMaps,
    opts: { color?: number; roughness?: number; metalness?: number; normalScale?: number } = {},
  ): THREE.MeshStandardMaterial {
    return this.make(key, () => {
      const mat = new THREE.MeshStandardMaterial({
        color: opts.color ?? 0xffffff,
        roughness: opts.roughness ?? 1,
        metalness: opts.metalness ?? 0,
      });
      applySurface(mat, maps, { normalScale: opts.normalScale ?? 1 });
      return mat;
    });
  }

  // --- Ground -------------------------------------------------------------

  paving(tint = '#b9b3aa', grout = '#5f5b55') {
    return this.surface(`paving-${tint}-${grout}`, pavingTile(512, 1, tint, grout), { roughness: 1 });
  }

  concrete(tint = '#9a9a9b') {
    return this.surface(`concrete-${tint}`, concrete(512, 1, tint), { roughness: 1 });
  }

  asphalt() {
    return this.surface('asphalt', asphalt(512, 1), { roughness: 1 });
  }

  /** Carpet noise doubles as clumped turf when tinted green and lit outdoors. */
  turf(tint = '#4c6a3a') {
    return this.surface(`turf-${tint}`, carpet(256, 1, tint), { roughness: 1, normalScale: 1.4 });
  }

  soil(tint = '#453629') {
    return this.surface(`soil-${tint}`, concrete(256, 1, tint), { roughness: 1 });
  }

  // --- Architecture -------------------------------------------------------

  brick(tint = '#9c5340') {
    return this.surface(`brick-${tint}`, brick(512, 1, tint), { roughness: 1, normalScale: 1.1 });
  }

  plaster(tint = '#e6e1d8') {
    return this.surface(`plaster-${tint}`, plaster(256, 1, tint), { roughness: 1 });
  }

  slats(tint = '#8a6647') {
    return this.surface(`slats-${tint}`, slatWall(512, 1, tint), { roughness: 1, normalScale: 1.2 });
  }

  wood(tint = '#a9714b') {
    return this.surface(`wood-${tint}`, woodFloor(512, 1, tint), { roughness: 1 });
  }

  metal(tint = '#8e939b', roughness = 0.42, metalness = 0.85) {
    return this.surface(`metal-${tint}-${roughness}`, metalPanel(256, 1, tint), { roughness, metalness });
  }

  fabric(tint = '#4a5a78', weave = 120) {
    return this.surface(`fabric-${tint}-${weave}`, fabric(256, 1, tint, weave), { roughness: 1 });
  }

  carpet(tint = '#6d5f57') {
    return this.surface(`carpet-${tint}`, carpet(256, 1, tint), { roughness: 1 });
  }

  // --- Flat / special -----------------------------------------------------

  /** Untextured but never flat-shaded: colour plus a real roughness value. */
  painted(hex: number, roughness = 0.55, metalness = 0.0) {
    return this.make(`painted-${hex}-${roughness}-${metalness}`, () =>
      new THREE.MeshStandardMaterial({ color: hex, roughness, metalness }));
  }

  /**
   * Dark architectural glazing. Real transmission costs a second render of the
   * scene, so glass is faked with a low-roughness dark surface that mirrors the
   * sky IBL — which is what a tower actually looks like from the street.
   */
  glass(hex = 0x1d2a38, roughness = 0.08) {
    return this.make(`glass-${hex}-${roughness}`, () =>
      new THREE.MeshStandardMaterial({
        color: hex, roughness, metalness: 0.9, envMapIntensity: 1.5,
      }));
  }

  emissive(hex: number, intensity = 2.0, base = 0x0a0a0a) {
    return this.make(`emissive-${hex}-${intensity}`, () =>
      new THREE.MeshStandardMaterial({
        color: base, emissive: hex, emissiveIntensity: intensity,
        roughness: 0.4, metalness: 0,
      }));
  }

  /** Foliage: two-sided, slightly translucent-looking green with leaf noise. */
  foliage(hex = 0x4e7a3a) {
    return this.make(`foliage-${hex}`, () => {
      const mat = new THREE.MeshStandardMaterial({
        color: hex, roughness: 0.85, metalness: 0, side: THREE.DoubleSide,
      });
      applySurface(mat, carpet(256, 1, '#7fae5c'), { normalScale: 0.8 });
      mat.map = null; // keep the tint clean; only the normal/rough break-up is wanted
      return mat;
    });
  }

  water(hex = 0x2b5c72) {
    return this.make(`water-${hex}`, () =>
      new THREE.MeshStandardMaterial({
        color: hex, roughness: 0.06, metalness: 0.4,
        transparent: true, opacity: 0.82, envMapIntensity: 1.4,
      }));
  }

  /** Every material the scene owns, for CSM registration and teardown. */
  all(): THREE.Material[] { return [...this.cache.values()]; }

  dispose() {
    // Textures live in the global bake cache and are shared between scenes, so
    // only the materials themselves are released here.
    for (const m of this.cache.values()) m.dispose();
    this.cache.clear();
  }
}
