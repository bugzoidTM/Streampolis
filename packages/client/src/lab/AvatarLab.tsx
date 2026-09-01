import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { DEFAULT_AVATAR, type AvatarConfig } from '@streampolis/shared';
import { Renderer, LOOK_DAY } from '../game/Renderer.js';
import { Environment, GOLDEN_HOUR } from '../game/Environment.js';
import { Avatar } from '../game/avatar/Avatar.js';
import { CharacterV2 } from '../game/avatar/v2/CharacterV2.js';
import { auditAvatar, AUDIT_LIMITS } from '../game/avatar/Audit.js';
import { buildMatrix } from './matrix.js';
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
    // O piscar é reflexo e corre sozinho; numa FOLHA DE CONTATO isso viraria
    // ruído (um tile de olho fechado por sorteio). Aqui ele fica preso — e
    // `?blink=1` é a régua que mede onde a pálpebra fecha.
    const blinkPin = params.get('blink') !== null ? Number(params.get('blink')) : 0;

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
    // A review rig can afford a 4k map and a normal bias scaled to a 22 cm
    // head rather than to a room.
    key.shadow.mapSize.set(4096, 4096);
    key.shadow.radius = 2;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.008;
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
    /**
     * EXPERIMENTO AvatarV2. `?v2=1` põe o corpo base do Quaternius ao lado do
     * avatar procedural, na MESMA cena, com a mesma luz e a mesma câmera —
     * porque a pergunta que este experimento responde só se responde lado a
     * lado. `?v2=only` mostra só o V2. Nada aqui substitui nada: o avatar do
     * jogo continua sendo o procedural.
     */
    const v2Mode = params.get('v2');
    const v2s: CharacterV2[] = [];
    // Matrix mode starts empty: the harness drives one combination at a time
    // through __lab.tile(), so every tile gets the same framing and light.
    const matrix = params.get('matrix') === '1';
    const picked = variants.slice(variantStart).concat(variants.slice(0, variantStart));
    const n = matrix ? 0 : Math.min(count, picked.length);
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

    if (v2Mode) {
      const pitch = 0.95;
      // Altura opcional: `?v2h=1.67` mede o pacote contra a nossa proporção,
      // sem ela contra a proporção do próprio autor. As duas perguntas
      // importam e são diferentes.
      const height = params.get('v2h') ? Number(params.get('v2h')) : undefined;
      void Promise.all([
        CharacterV2.load('female', { height, hair: '#3a2a20', hairstyle: params.get('v2hair') ?? 'hair_long' }),
        CharacterV2.load('male', { height, hair: '#1b1614', hairstyle: 'hair_parted' }),
      ]).then(([female, male]) => {
        // À DIREITA da fileira procedural, nunca em cima dela. Os dois grupos
        // se centram de formas diferentes, e somar índices sem levar isso em
        // conta põe um V2 exatamente sobre um avatar do jogo — o que, numa
        // comparação, é a única coisa que não pode acontecer.
        const solo = v2Mode === 'solo';
        const right = n > 0 ? ((n - 1) / 2) * spacing + pitch : -pitch / 2;
        const pair = solo ? [female] : [female, male];
        pair.forEach((c, i) => {
          c.root.position.x = solo ? 0 : right + i * pitch;
          group.add(c.root);
          v2s.push(c);
          for (const mat of c.materials()) env.registerMaterial(mat);
          c.play(params.get('anim') ?? 'Idle_Loop');
        });
        if (solo) male.dispose();
        Object.assign(window as object, {
          __v2: v2s.map((c) => ({
            nativeHeight: +c.nativeHeight.toFixed(3),
            triangles: c.triangles,
            bones: c.bones,
            clips: [...c.clips.keys()],
          })),
        });
      }).catch((err) => console.warn('[v2] não carregou:', err));
    }

    const focus = new THREE.Vector3(0, 0.95, 0);
    key.target.position.copy(focus);
    rim.target.position.copy(focus);
    env.frameShadows(focus, 5);

    renderer.attach(scene, camera, { ...LOOK_DAY, exposure: Number(params.get('exp') ?? (params.get('matrix') === '1' ? 0.4 : 0.55)) });

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
      for (const c of v2s) c.update(dt);
      const t = clock.getElapsedTime();
      group.rotation.y = matrix ? yaw : (spin ? t * 0.28 : yaw);

      const dist = Number(params.get('dist') ?? (matrix ? 3.15 : 2.0 + n * 0.62));
      const cy = Number(params.get('cy') ?? (matrix ? 0.88 : 1.35));
      const ly = Number(params.get('ly') ?? (matrix ? 0.86 : 0.95));
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

        matrix: () => buildMatrix().map(({ index, label, group: g }) => ({ index, label, group: g })),

        /**
         * A hand, framed close. Same reason as the portrait: five fingers are
         * invisible at body scale, and a defect nobody can see is a defect
         * nobody fixes.
         */
        handShot: (cfg: Partial<AvatarConfig>, yaw = 0) => {
          const avatar = new Avatar({ ...DEFAULT_AVATAR, ...cfg });
          avatar.pinBlink(blinkPin);
          group.add(avatar.root);
          const prev = group.rotation.y;
          try {
            group.rotation.y = yaw;
            const p = avatar.rig.restWorld.LeftHand;
            // The hand moves with the group, so the framing has to follow it
            // through the same rotation or the camera stares at empty floor.
            const centre = new THREE.Vector3(p.x, p.y - 0.06, p.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
            // The offset stays in world space: rotating the avatar is the
            // whole point, and a camera that rotates with it shows one view
            // three times.
            camera.position.copy(centre).add(new THREE.Vector3(0, 0.06, 0.50));
            camera.lookAt(centre);
            key.target.position.copy(centre);
            env.update(camera);
            renderer.render(0.016);
            return canvas.toDataURL('image/png');
          } finally {
            group.rotation.y = prev;
            group.remove(avatar.root);
            avatar.dispose();
            key.target.position.copy(focus);
          }
        },

        /**
         * A head, framed as a portrait, in one expression and one yaw. The
         * face is the part of the avatar a live puts on screen for hours, so
         * it gets a review loop of its own rather than being judged from a
         * full-body tile 40 px wide.
         */
        portrait: (cfg: Partial<AvatarConfig>, expression: string, headYaw = 0, zoom = 1) => {
          const avatar = new Avatar({ ...DEFAULT_AVATAR, ...cfg });
          avatar.pinBlink(blinkPin);
          group.add(avatar.root);
          try {
            avatar.setExpression(expression as never);
            // Settle the blend instantly instead of waiting on real seconds.
            for (let i = 0; i < 40; i++) avatar.animate(0.05, 0);
            // Turn the whole avatar, not the neck. Twisting the head 150° to
            // see the back of a style swings a ponytail round to the chest and
            // reviews a pose nobody will ever hold.
            group.rotation.y = headYaw;
            group.updateMatrixWorld(true);

            // `zoom > 1` pulls back: a ponytail or a waist-length style lives
            // mostly BELOW a head-and-shoulders crop, and cannot be reviewed
            // in one.
            const head = avatar.eyeHeight;
            camera.position.set(0, head + 0.02 - 0.20 * (zoom - 1), 0.62 * zoom);
            camera.lookAt(0, head + 0.01 - 0.22 * (zoom - 1), 0);
            key.target.position.set(0, head, 0);
            rim.target.position.set(0, head, 0);
            env.update(camera);
            renderer.render(0.016);
            return canvas.toDataURL('image/png');
          } finally {
            group.rotation.y = 0;
            group.remove(avatar.root);
            avatar.dispose();
            key.target.position.copy(focus);
            rim.target.position.copy(focus);
          }
        },
        /**
         * A whole figure, framed head to floor. The portrait sheet judges the
         * face and the matrix judges geometry; neither answers "does this read
         * as a character?" — that is a silhouette question, and a silhouette
         * is only visible when the whole body is in frame at once.
         */
        figure: (variant: number, yaw = 0, animState = 'idle') => {
          const cfg = variants[variant % variants.length];
          const avatar = new Avatar(cfg);
          group.add(avatar.root);
          const prev = group.rotation.y;
          try {
            avatar.setAnim(animState as never);
            // Settle pose and expression blends without waiting on real time.
            for (let i = 0; i < 60; i++) avatar.animate(0.05, 0);
            group.rotation.y = yaw;
            group.updateMatrixWorld(true);
            const top = avatar.eyeHeight + 0.16;
            camera.position.set(0, top * 0.52, 2.95);
            camera.lookAt(0, top * 0.5, 0);
            key.target.position.set(0, top * 0.6, 0);
            rim.target.position.set(0, top * 0.6, 0);
            env.update(camera);
            renderer.render(0.016);
            return canvas.toDataURL('image/png');
          } finally {
            group.rotation.y = prev;
            group.remove(avatar.root);
            avatar.dispose();
            key.target.position.copy(focus);
            rim.target.position.copy(focus);
          }
        },
        limits: () => AUDIT_LIMITS,

        /**
         * Builds one combination of the regression matrix, measures it and
         * hands back both the numbers and a picture. One avatar at a time so
         * every tile is framed and lit identically and memory stays flat.
         */
        tile: (index: number, withImage = true) => {
          const entries = buildMatrix();
          const item = entries[index];
          if (!item) return null;
          const avatar = new Avatar(item.config);
          group.add(avatar.root);
          try {
            const audit = auditAvatar(avatar);
            let png: string | null = null;
            if (withImage) {
              // Render and read back inside one task: the context is created
              // without preserveDrawingBuffer, so the buffer is gone by the
              // next frame.
              renderer.render(0.016);
              png = canvas.toDataURL('image/png');
            }
            // Bounds per slot: when a gate fails, the first question is always
            // WHICH mesh reached where it should not.
            const bounds: Record<string, number[]> = {};
            avatar.root.traverse((o) => {
              const m = o as THREE.Mesh;
              if (!m.geometry || !m.name) return;
              m.geometry.computeBoundingBox();
              const bb = m.geometry.boundingBox!;
              bounds[m.name] = [bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z]
                .map((v) => +v.toFixed(3));
            });
            return { index, label: item.label, group: item.group, audit, bounds, png };
          } finally {
            group.remove(avatar.root);
            avatar.dispose();
          }
        },
      },
    });

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      for (const a of avatars) a.dispose();
      for (const c of v2s) c.dispose();
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
