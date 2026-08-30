import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { DEFAULT_AVATAR, type AvatarConfig } from '@streampolis/shared';
import { Renderer, LOOK_DAY } from '../game/Renderer.js';
import { Environment, GOLDEN_HOUR } from '../game/Environment.js';
import { Avatar } from '../game/avatar/Avatar.js';
import { concrete, applySurface } from '../game/materials/Textures.js';

/**
 * Turntable rig used by the visual review loop. Renders a row of avatars on a
 * neutral studio floor under the production lighting and post chain, so what
 * a critic sees here matches what ships.
 */
export function AvatarLab() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const params = new URLSearchParams(location.search);
    const tier = (params.get('tier') as 'low' | 'medium' | 'high' | null) ?? 'high';
    const spin = params.get('spin') !== '0';
    const yaw = Number(params.get('yaw') ?? '0');
    const count = Number(params.get('count') ?? '5');
    const only = params.get('only') ?? 'all';
    const variantStart = Number(params.get('start') ?? '0');

    const renderer = new Renderer(canvas, tier);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 400);

    const env = new Environment(scene, renderer.webgl, {
      ...GOLDEN_HOUR,
      elevation: 24, azimuth: 130,
      sunIntensity: 2.0, ambientIntensity: 0.28, envIntensity: 0.65,
      fogNear: 26, fogFar: 110,
    });

    // Studio floor.
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x8d8f93, roughness: 0.9 });
    applySurface(floorMat, concrete(512, 10, '#8f9195'));
    const floor = new THREE.Mesh(new THREE.CircleGeometry(14, 64), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // A soft key/fill pair on top of the sky, as a portrait setup would use.
    const key = new THREE.SpotLight(0xfff2e2, 9, 16, Math.PI * 0.3, 0.6, 1.4);
    key.position.set(2.6, 3.4, 3.2);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0008;
    key.shadow.normalBias = 0.02;
    scene.add(key, key.target);
    const rim = new THREE.SpotLight(0x9fc6ff, 6, 15, Math.PI * 0.32, 0.75, 1.4);
    rim.position.set(-3.0, 2.8, -2.6);
    scene.add(rim, rim.target);

    const variants: AvatarConfig[] = [
      { ...DEFAULT_AVATAR, bodyPreset: 0, skinTone: 1, facePreset: 0, hair: 'hair_bob_01',      hairColor: 3, top: 'top_tee_01',    bottom: 'bottom_jeans_01', shoes: 'shoes_sneaker_01' },
      { ...DEFAULT_AVATAR, bodyPreset: 1, skinTone: 5, facePreset: 1, hair: 'hair_buzz_01',     hairColor: 0, top: 'top_hoodie_01', bottom: 'bottom_cargo_01', shoes: 'shoes_boot_01' },
      { ...DEFAULT_AVATAR, bodyPreset: 2, skinTone: 3, facePreset: 2, hair: 'hair_ponytail_01', hairColor: 4, top: 'top_jacket_01', bottom: 'bottom_track_01', shoes: 'shoes_sneaker_01' },
      { ...DEFAULT_AVATAR, bodyPreset: 3, skinTone: 6, facePreset: 3, hair: 'hair_afro_01',     hairColor: 1, top: 'top_blazer_01', bottom: 'bottom_jeans_01', shoes: 'shoes_boot_01' },
      { ...DEFAULT_AVATAR, bodyPreset: 2, skinTone: 0, facePreset: 2, hair: 'hair_long_01',     hairColor: 8, top: 'top_holo_01',   bottom: 'bottom_skirt_01', shoes: 'shoes_glow_01' },
    ];

    const group = new THREE.Group();
    const avatars: Avatar[] = [];
    const picked = variants.slice(variantStart).concat(variants.slice(0, variantStart));
    const n = Math.min(count, picked.length);
    const spacing = 0.95;
    for (let i = 0; i < n; i++) {
      const cfg = { ...picked[i] };
      if (only === 'nude') { cfg.top = ''; cfg.bottom = ''; cfg.shoes = ''; cfg.hair = ''; }
      if (only === 'body') { cfg.top = ''; cfg.bottom = ''; cfg.shoes = ''; }
      const a = new Avatar(cfg);
      a.root.position.x = (i - (n - 1) / 2) * spacing;
      group.add(a.root);
      avatars.push(a);
    }
    scene.add(group);

    const focus = new THREE.Vector3(0, 0.95, 0);
    key.target.position.copy(focus);
    rim.target.position.copy(focus);
    env.frameShadows(focus, 5);

    renderer.attach(scene, camera, { ...LOOK_DAY, exposure: Number(params.get('exp') ?? 0.55) });

    const resize = () => {
      const w = canvas.clientWidth || window.innerWidth;
      const h = canvas.clientHeight || window.innerHeight;
      renderer.resize(w, h);
    };
    window.addEventListener('resize', resize);
    resize();

    const clock = new THREE.Clock();
    let raf = 0;
    let ready = 0;

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, clock.getDelta());
      const t = clock.getElapsedTime();
      group.rotation.y = spin ? t * 0.28 : yaw;

      const dist = Number(params.get('dist') ?? (2.0 + n * 0.62));
      const cy = Number(params.get('cy') ?? 1.35);
      const ly = Number(params.get('ly') ?? 0.95);
      camera.position.set(0, cy, dist);
      camera.lookAt(0, ly, 0);

      env.update(camera);
      renderer.render(dt);
      ready++;
      // Signals the screenshot tool that the pipeline has warmed up.
      if (ready === 12) (window as unknown as { __ready?: boolean }).__ready = true;
    };
    frame();

    // Exposed for the automated review harness.
    Object.assign(window as object, {
      __lab: {
        stats: () => renderer.stats(),
        rest: () => {
          const r = avatars[0].rig.restWorld;
          return Object.fromEntries(Object.entries(r).map(
            ([k, v]) => [k, [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)]]));
        },
        bounds: () => Object.fromEntries(avatars[0].root.children
          .filter((c) => (c as THREE.Mesh).geometry)
          .map((c) => {
            const g = (c as THREE.Mesh).geometry;
            g.computeBoundingBox();
            const b = g.boundingBox!;
            return [c.name, {
              min: [+b.min.x.toFixed(3), +b.min.y.toFixed(3), +b.min.z.toFixed(3)],
              max: [+b.max.x.toFixed(3), +b.max.y.toFixed(3), +b.max.z.toFixed(3)],
            }];
          })),
        setYaw: (y: number) => { group.rotation.y = y; },
        avatars,
      },
    });

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      for (const a of avatars) a.dispose();
      env.dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <canvas
      ref={ref}
      style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', display: 'block', background: '#0b0d12' }}
    />
  );
}
