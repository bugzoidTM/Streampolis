import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { DEFAULT_AVATAR, type AvatarConfig } from '@streampolis/shared';
import { Renderer, LOOK_DAY } from '../game/Renderer.js';
import { Environment, GOLDEN_HOUR } from '../game/Environment.js';
import { Avatar } from '../game/avatar/Avatar.js';
import { createAvatar } from '../game/avatar/createAvatar.js';
import { CharacterV2 } from '../game/avatar/v2/CharacterV2.js';
import { LINING } from '../game/avatar/v2/Wardrobe.js';
import { auditAvatar, AUDIT_LIMITS } from '../game/avatar/Audit.js';
import { buildMatrix } from './matrix.js';
import { concrete, applySurface } from '../game/materials/Textures.js';
import { renderPoster } from '../game/portrait/PosterStudio.js';

/**
 * Alcance da régua de profundidade das passadas de máscara, em metros.
 *
 * Oito metros cobrem qualquer enquadramento do laboratório com folga, e em 16
 * bits sobram 0,12 mm de resolução — três ordens de grandeza abaixo da
 * interpenetração que se quer flagrar.
 */
const DEPTH_RANGE = 8;

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
      /**
       * Prova de corpo CANDIDATO, para a decisão de qual pacote adotar.
       *
       * `?v2=1&v2base=assets/candidates/&v2ids=mini-f,mini-m` põe qualquer GLB
       * do mesmo formato no rig do jogo, com a nossa luz e o nosso pós. Julgar
       * um pacote pela foto do vendedor é escolher tinta pelo nome do catálogo:
       * o que decide é como ele fica NESTA cena, ao lado do que já existe.
       */
      const base = params.get('v2base') ?? undefined;
      const ids = params.get('v2ids')?.split(',').filter(Boolean) ?? null;
      void Promise.all(
        ids
          ? ids.map((id) => CharacterV2.load(id as 'male', {
            height,
            outfit: params.get('v2outfit')?.split(',').filter(Boolean),
          }, base))
          : [
            CharacterV2.load('female', {
              height, hair: '#3a2a20', hairstyle: params.get('v2hair') ?? 'hair_long',
              outfit: params.get('v2outfit')?.split(',').filter(Boolean),
            }, base),
            CharacterV2.load('male', { height, hair: '#1b1614', hairstyle: 'hair_parted' }, base),
          ],
      ).then(([female, male]) => {
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
            // A linha dos olhos, derivada da estatura: um retrato se enquadra
            // pelos olhos, e é ela que o contrato deixou de fingir que sabia.
            const head = avatar.stature * 0.888;
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
            const top = avatar.stature;
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
        /**
         * A figura do avatar **QUE O JOGO DESENHA HOJE**, montado pela mesma
         * `createAvatar()` da praça.
         *
         * Todo o resto desta bancada — `figure`, `portrait`, `handShot`, `tile`
         * e a matriz de 176 combinações — instancia `new Avatar(...)`, o corpo
         * PROCEDURAL, que desde a migração v2 só aparece no jogo com `?body=v1`.
         * Ou seja: o repositório inteiro julgava um corpo aposentado. Foi assim
         * que 21 camisas sem braço e 17 tênis sem sola entraram na praça sem
         * ninguém ver — nenhum instrumento apontava para lá.
         *
         * Ela é ASSÍNCRONA porque o corpo v2 nasce vazio e se monta quando os
         * quatro arquivos chegam; fotografar antes disso é fotografar o chão.
         *
         * Devolve a imagem E o inventário de malhas: quando uma peça some, a
         * primeira pergunta é sempre "ela chegou a entrar na cena?", e um PNG
         * não responde isso.
         */
        /**
         * A figura que o jogo desenha.
         *
         * `aim` é a altura que a câmera encara, em fração da ESTATURA — 0,5 é a
         * cintura, 0,1 o tornozelo. Existe porque o que se julga aqui são
         * EMENDAS, e uma emenda no tornozelo vista de um enquadramento centrado
         * na cintura tem trinta pixels de altura: aproximar sem mirar só traz o
         * quadril para mais perto.
         */
        gameFigure: async (
          look: Partial<AvatarConfig>, yaw = 0, animState = 'idle', zoom = 1, aim = 0.5,
        ) => {
          const avatar = createAvatar({ ...DEFAULT_AVATAR, ...look });
          await (avatar as { ready?: Promise<void> }).ready;
          group.add(avatar.root);
          const prev = group.rotation.y;
          try {
            avatar.setAnim(animState as never);
            for (let i = 0; i < 60; i++) avatar.animate(0.05, 0);
            group.rotation.y = yaw;
            group.updateMatrixWorld(true);
            const top = avatar.stature;
            camera.position.set(0, top * (aim + 0.02), 2.95 * zoom);
            camera.lookAt(0, top * aim, 0);
            key.target.position.set(0, top * (aim + 0.1), 0);
            rim.target.position.set(0, top * (aim + 0.1), 0);
            env.update(camera);
            renderer.render(0.016);
            const png = canvas.toDataURL('image/png');
            const meshes: Array<{ name: string; material: string; tris: number }> = [];
            avatar.root.traverse((o) => {
              const m = o as THREE.SkinnedMesh;
              if (!m.isSkinnedMesh) return;
              const g = m.geometry;
              const mat = m.material as THREE.Material;
              meshes.push({
                name: m.name,
                material: Array.isArray(m.material) ? '(múltiplos)' : (mat?.name ?? ''),
                tris: Math.round((g.index ? g.index.count : g.attributes.position.count) / 3),
              });
            });
            return { png, meshes, stature: +avatar.stature.toFixed(3) };
          } finally {
            group.rotation.y = prev;
            group.remove(avatar.root);
            avatar.dispose();
            key.target.position.copy(focus);
            rim.target.position.copy(focus);
          }
        },
        /**
         * O ROSTO do corpo que o jogo desenha, de perto e com o piscar preso.
         *
         * `face-sheet` e `face-close` fotografam o rosto procedural: uma malha
         * com pálpebra, sobrancelha e lábio articulados que o jogo não desenha
         * mais. Este rosto é outro problema — um olho e uma sobrancelha em
         * primitivos separados — e a pergunta que ele precisa responder também
         * é outra: **o olho fechado lê como olho fechado?** Só se responde
         * grande e com o reflexo PRESO, porque um piscar dura 220 ms e nenhuma
         * captura o pega de propósito.
         */
        /**
         * O PERFIL do rosto, medido por raio, em espaço da cabeça.
         *
         * Existe porque uma peça de rosto nova — a boca foi a primeira — precisa
         * saber onde a PELE está, e a pele destas cabeças não está nos vértices:
         * abaixo do nariz o rosto é um quadrilátero só, e no meio dele, que é
         * exatamente onde a boca vai, não há vértice nenhum para amostrar. Um
         * feixe de raios contra a malha responde o que a malha realmente é.
         *
         * Devolve também para onde a boca foi, e a que distância do osso da
         * cabeça ela fica em cada estado de animação: presa ao osso, essa
         * distância não pode mudar — se mudar, ela não está presa, está sendo
         * carregada por outra coisa.
         */
        headProfile: async (look: Partial<AvatarConfig>, states = ['idle', 'dance', 'walk']) => {
          const avatar = createAvatar({ ...DEFAULT_AVATAR, ...look });
          await (avatar as { ready?: Promise<void> }).ready;
          group.add(avatar.root);
          try {
            avatar.setAnim('idle' as never);
            for (let i = 0; i < 20; i++) avatar.animate(0.05, 0);
            group.updateMatrixWorld(true);
            const face = (avatar as { faceReport?: () => unknown }).faceReport?.() ?? null;
            const origins = (avatar as { origins?: () => Map<THREE.SkinnedMesh, string> }).origins?.();
            const alvos: THREE.Object3D[] = [];
            let bone: THREE.Bone | null = null;
            let boca: THREE.Object3D | null = null;
            avatar.root.traverse((o) => {
              if ((o as THREE.SkinnedMesh).isSkinnedMesh) {
                const id = origins?.get(o as THREE.SkinnedMesh) ?? '';
                if (id.endsWith('_head')) alvos.push(o);
              }
              if ((o as THREE.Bone).isBone && o.name === 'Head' && !bone) bone = o as THREE.Bone;
              if (o.name === 'MouthV2') boca = o;
            });

            // A pele, varrida em mundo e devolvida em espaço da cabeça.
            const ray = new THREE.Raycaster();
            const p = new THREE.Vector3();
            const eixo = new THREE.Vector3(0, 0, -1);
            const superficie: number[][] = [];
            for (let iy = -22; iy <= 6; iy++) {
              for (let ix = -8; ix <= 8; ix++) {
                ray.set(new THREE.Vector3(ix * 0.006, avatar.stature * 0.933 + iy * 0.005, 1.2), eixo);
                const hits = ray.intersectObjects(alvos, false);
                if (!hits.length || !bone) continue;
                p.copy(hits[0].point);
                (bone as THREE.Bone).worldToLocal(p);
                // Pele ou pelo: numa cabeça barbada o raio bate na BARBA, que
                // fica na frente do rosto. Quem quiser saber onde a cara está
                // precisa poder descartar o que é cabelo.
                const mat = (hits[0].object as THREE.Mesh).material as THREE.Material;
                const pele = /skin/i.test((Array.isArray(mat) ? mat[0]?.name : mat?.name) ?? '') ? 1 : 0;
                superficie.push([+p.x.toFixed(6), +p.y.toFixed(6), +p.z.toFixed(6), pele]);
              }
            }

            // E a prova de que a boca é do OSSO: a distância entre os dois não
            // pode mudar de um gesto para outro.
            const presa: Record<string, number> = {};
            if (boca && bone) {
              const a = new THREE.Vector3();
              const b = new THREE.Vector3();
              for (const state of states) {
                avatar.setAnim(state as never);
                for (let i = 0; i < 30; i++) avatar.animate(0.05, 1.4);
                group.updateMatrixWorld(true);
                (boca as THREE.Object3D).getWorldPosition(a);
                (bone as THREE.Bone).getWorldPosition(b);
                presa[state] = +a.distanceTo(b).toFixed(6);
              }
            }
            // Os MATERIAIS da cabeça, para quem for mexer neles: um material de
            // pele com brilho de plástico e um com brilho de pele são o mesmo
            // material no inventário e rostos diferentes na tela.
            const materiais: unknown[] = [];
            avatar.root.traverse((o) => {
              const m = o as THREE.Mesh;
              if (!m.isMesh) return;
              const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
              if (!mat) return;
              // Onde esta malha VIVE, em espaço da cabeça: é o que diz se o
              // segundo material de pele do pacote é lábio, orelha ou pescoço.
              let caixa = null;
              if ((m as THREE.SkinnedMesh).isSkinnedMesh && bone) {
                const b = new THREE.Box3();
                const p2 = new THREE.Vector3();
                const geo = m.geometry.getAttribute('position');
                const inv = (m as THREE.SkinnedMesh).skeleton.boneInverses[
                  (m as THREE.SkinnedMesh).skeleton.bones.findIndex((x) => x.name === 'Head')
                ];
                if (inv) {
                  for (let i = 0; i < geo.count; i++) b.expandByPoint(p2.fromBufferAttribute(geo, i).applyMatrix4(inv));
                  caixa = [b.min.toArray().map((v) => +v.toFixed(5)), b.max.toArray().map((v) => +v.toFixed(5))];
                }
              }
              materiais.push({
                caixa,
                malha: m.name, material: mat.name,
                cor: `#${mat.color?.getHexString?.() ?? ''}`,
                roughness: mat.roughness, metalness: mat.metalness,
                mapa: !!mat.map, vertexColors: mat.vertexColors,
                de: origins?.get(o as THREE.SkinnedMesh) ?? '',
              });
            });
            return { face, superficie, presa, materiais };
          } finally {
            group.remove(avatar.root);
            avatar.dispose();
          }
        },
        gameFace: async (look: Partial<AvatarConfig>, yaw = 0, blink = 0, zoom = 1, mouth = '') => {
          const avatar = createAvatar({ ...DEFAULT_AVATAR, ...look });
          await (avatar as { ready?: Promise<void> }).ready;
          avatar.pinBlink(blink);
          // A expressão é pedida ANTES dos quadros de acomodação abaixo: a boca
          // atravessa de uma forma à outra em ~55 ms, e fotografá-la no meio da
          // travessia é fotografar uma quinta expressão que não existe.
          if (mouth) (avatar as { setMouth?: (s: string) => void }).setMouth?.(mouth);
          group.add(avatar.root);
          const prev = group.rotation.y;
          try {
            avatar.setAnim('idle' as never);
            for (let i = 0; i < 40; i++) avatar.animate(0.05, 0);
            group.rotation.y = yaw;
            group.updateMatrixWorld(true);
            // A linha dos olhos, derivada da estatura.
            // A linha dos olhos fica a 0,933 da estatura: o osso da cabeça está a
            // 0,87 e o olho uns 11 cm acima dele. A 0,9 o retrato saía cortando
            // a testa e enchendo o quadro de bochecha.
            const eye = avatar.stature * 0.933;
            camera.position.set(0, eye, 0.78 * zoom);
            camera.lookAt(0, eye - 0.02, 0);
            key.target.position.set(0, eye, 0);
            rim.target.position.set(0, eye, 0);
            env.update(camera);
            renderer.render(0.016);
            const face = (avatar as { faceReport?: () => unknown }).faceReport?.() ?? null;
            return { png: canvas.toDataURL('image/png'), face };
          } finally {
            group.rotation.y = prev;
            group.remove(avatar.root);
            avatar.dispose();
            key.target.position.copy(focus);
            rim.target.position.copy(focus);
          }
        },
        /**
         * O piscar ao longo do tempo, sem prender nada.
         *
         * Uma captura não prova reflexo: um piscar inteiro dura 220 ms e cai a
         * cada quatro segundos, então uma foto ao acaso o perde em 95% das
         * vezes — e uma que o pegasse por sorte não seria prova de nada. Isto
         * adianta o relógio e devolve a série, que é o que se pode medir.
         */
        blinkTrace: async (look: Partial<AvatarConfig>, seconds = 14, fps = 30) => {
          const avatar = createAvatar({ ...DEFAULT_AVATAR, ...look });
          await (avatar as { ready?: Promise<void> }).ready;
          try {
            const step = 1 / fps;
            const trace: number[] = [];
            for (let t = 0; t < seconds; t += step) {
              avatar.animate(step, 0);
              const face = (avatar as { faceReport?: () => { piscar?: number | null } | null }).faceReport?.();
              trace.push(face?.piscar ?? -1);
            }
            return trace;
          } finally {
            avatar.dispose();
          }
        },
        /**
         * A sonda do guarda-roupa v2: **onde o corpo tem BURACO**.
         *
         * O portão do corpo procedural mede pele escapando por fora da roupa,
         * porque lá existe um corpo por baixo e a roupa é ele inflado. Aqui não
         * existe corpo nenhum: as quatro peças SÃO o personagem — o `top` traz
         * o pano e os braços, o `bottom` traz as pernas —, e quando duas peças
         * não se encontram o que aparece não é pele, é o cenário atrás. Um
         * avatar partido na cintura. Essa é a falha que o v2 pode ter e o v1
         * não podia, e é ela que esta sonda procura.
         *
         * Mede por FAIXA DE ALTURA e não por raio: com os vértices já
         * deformados pelo esqueleto, marcar as faixas que cada triângulo cruza
         * custa uma passada pela malha, enquanto raio contra malha com pele
         * custa uma travessia por disparo. São 160 combinações.
         *
         * Só a COLUNA central conta (|x| < 12 cm do eixo). Sem esse recorte um
         * braço pendurado ao lado do quadril cobre a faixa da cintura e o
         * buraco passa despercebido — foi assim que a sonda de pele do v1
         * escondeu por meses a cunha do quadril.
         */
        wardrobeProbe: async (look: Partial<AvatarConfig>) => {
          const avatar = createAvatar({ ...DEFAULT_AVATAR, ...look });
          await (avatar as { ready?: Promise<void> }).ready;
          try {
            avatar.setAnim('idle' as never);
            // Um passo de zero segundos: aplica o clipe no instante 0 e mede
            // sempre a MESMA pose. Uma sonda que mede um quadro sorteado
            // reprova por acaso.
            avatar.animate(0, 0);
            avatar.root.updateMatrixWorld(true);

            // Caixa de cada malha no MUNDO, por material.
            //
            // Quando o portão reprova, a primeira pergunta é sempre QUAL peça
            // foi parar onde não devia — e uma medida de faixa diz que falta
            // corpo, não quem sumiu. É a mesma razão que fez o inventário de
            // malhas entrar na folha de contato.
            const caixas: Record<string, number[]> = {};
            const colunas: Record<string, [number, number]> = {};
            const origens = (avatar as { origins?: () => Map<THREE.SkinnedMesh, string> })
              .origins?.() ?? new Map<THREE.SkinnedMesh, string>();

            const BAND = 0.004;
            const AXIS = 0.12;
            const bands = new Uint8Array(Math.ceil(2.4 / BAND));
            const a = new THREE.Vector3();
            const b = new THREE.Vector3();
            const c = new THREE.Vector3();
            let tris = 0;
            avatar.root.traverse((o) => {
              const mesh = o as THREE.SkinnedMesh;
              if (!mesh.isSkinnedMesh) return;
              const box = new THREE.Box3();
              const p = new THREE.Vector3();
              const vertices = mesh.geometry.getAttribute('position').count;
              for (let i = 0; i < vertices; i++) {
                mesh.getVertexPosition(i, p);
                box.expandByPoint(mesh.localToWorld(p));
              }
              const label = (Array.isArray(mesh.material) ? '?' : mesh.material?.name) || mesh.name;
              const chave = `${origens.get(mesh) ?? '?'} ${label}:${vertices}`;
              caixas[chave] = [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z]
                .map((v) => +v.toFixed(3));
              // A caixa MENTE sobre o que a malha cobre na coluna: o mínimo do
              // torso de um forro são as MÃOS, que penduram meio metro abaixo
              // dele. Quem responde "esta peça cobre a cintura?" é a faixa que
              // ela ocupa perto do eixo, e é ela que aponta a peça culpada.
              const coluna: [number, number] = [Infinity, -Infinity];
              colunas[chave] = coluna;

              const index = mesh.geometry.getIndex();
              const count = index ? index.count : mesh.geometry.getAttribute('position').count;
              for (let t = 0; t + 2 < count; t += 3) {
                const ia = index ? index.getX(t) : t;
                const ib = index ? index.getX(t + 1) : t + 1;
                const ic = index ? index.getX(t + 2) : t + 2;
                mesh.getVertexPosition(ia, a); mesh.localToWorld(a);
                mesh.getVertexPosition(ib, b); mesh.localToWorld(b);
                mesh.getVertexPosition(ic, c); mesh.localToWorld(c);
                tris++;
                if (Math.abs((a.x + b.x + c.x) / 3) > AXIS) continue;
                const lo = Math.min(a.y, b.y, c.y);
                const hi = Math.max(a.y, b.y, c.y);
                coluna[0] = Math.min(coluna[0], lo);
                coluna[1] = Math.max(coluna[1], hi);
                for (let y = Math.max(0, Math.floor(lo / BAND)); y <= Math.floor(hi / BAND) && y < bands.length; y++) {
                  bands[y] = 1;
                }
              }
            });

            // A janela de interesse: do peito do pé ao queixo. Fora dela não há
            // o que provar — abaixo é solado, acima é cabelo.
            const stature = avatar.stature;
            const from = Math.floor((stature * 0.07) / BAND);
            const to = Math.floor((stature * 0.84) / BAND);
            const gaps: Array<[number, number]> = [];
            let run = -1;
            for (let i = from; i <= to; i++) {
              if (!bands[i]) { if (run < 0) run = i; } else if (run >= 0) { gaps.push([run, i]); run = -1; }
            }
            if (run >= 0) gaps.push([run, to + 1]);
            return {
              stature: +stature.toFixed(3),
              tris,
              caixas,
              colunas: Object.fromEntries(Object.entries(colunas)
                .filter(([, v]) => Number.isFinite(v[0]))
                .map(([k, v]) => [k, [+v[0].toFixed(3), +v[1].toFixed(3)]])),
              // Quem termina logo ABAIXO do buraco e quem começa logo ACIMA: é a
              // dupla que não se encontra, e é o que um relatório de portão
              // precisa dizer para alguém poder consertar.
              culpados: gaps.filter(([lo, hi]) => (hi - lo) * BAND >= 0.006).map(([lo, hi]) => {
                const de = lo * BAND; const ate = hi * BAND;
                const abaixo = Object.entries(colunas)
                  .filter(([, v]) => Number.isFinite(v[0]) && v[1] <= de + 0.01)
                  .sort((x, y) => y[1][1] - x[1][1])[0];
                const acima = Object.entries(colunas)
                  .filter(([, v]) => Number.isFinite(v[0]) && v[0] >= ate - 0.01)
                  .sort((x, y) => x[1][0] - y[1][0])[0];
                return { abaixo: abaixo?.[0] ?? null, acima: acima?.[0] ?? null };
              }),
              buracos: gaps
                .map(([lo, hi]) => ({ de: +(lo * BAND).toFixed(3), ate: +(hi * BAND).toFixed(3), mm: Math.round((hi - lo) * BAND * 1000) }))
                .filter((g) => g.mm >= 6)
                .sort((x, y) => y.mm - x.mm),
            };
          } finally {
            avatar.dispose();
          }
        },
        /**
         * O FORRO ESTÁ APARECENDO POR CIMA DA ROUPA?
         *
         * O forro existe para tapar o vão entre duas peças que não se
         * encontram, e a sonda de faixas (`wardrobeProbe`) confirma que ele
         * tapa. Ela não vê o preço: o forro é uma PEÇA DE ROUPA fazendo as
         * vezes de corpo, e duas roupas de formatos diferentes sobre as mesmas
         * pernas se atravessam. Quando isso acontece o avatar ganha manchas cor
         * de pele no meio da calça — um defeito pior do que o buraco que o
         * forro veio consertar, porque aparece em TODO visual misturado e não
         * só nos poucos que tinham vão.
         *
         * Mede-se em PIXEL, que é onde o defeito mora, e em duas passadas com
         * a mesma câmera:
         *
         *   silhueta  — a roupa toda branca, SEM forro: onde o traje já cobre.
         *   forro     — a roupa toda preta e só o forro branco: onde o forro
         *               vence o teste de profundidade e chega à tela.
         *
         * O que sai da conta:
         *   `vazamento` — forro visível DENTRO da silhueta do traje. É a
         *                 mancha. Tem de ser zero.
         *   `tapado`    — forro visível FORA dela: exatamente o buraco que ele
         *                 foi posto para tapar. Quanto maior, mais ele serviu.
         *
         * Passada por material chapado e sem o composer de propósito: o bloom
         * espalha a borda por uma dúzia de pixels e contaminaria as duas
         * máscaras.
         *
         * **E ENQUADRADA NA EMENDA, uma passada por vão.** A primeira versão
         * fotografava a figura inteira, e a figura inteira mede o defeito
         * errado: um avatar de 1,8 m num quadro de 400 px dá quatro pixels a
         * um estilhaço de três centímetros, e a conta o dilui em sessenta mil
         * pixels de silhueta. Ela aprovou — 0 de 30 em vazamento e 0 de 30 em
         * fresta — um forro que em close estava EXPLODIDO, com lascas
         * atravessando a canela e um cone saindo da cintura. As emendas ficam
         * em duas faixas de dez centímetros, e é nelas que a câmera tem de
         * estar.
         */
        liningExposure: async (
          look: Partial<AvatarConfig>, yaw = 0, cor = false, anim = 'idle', fase = 0,
        ) => {
          const avatar = createAvatar({ ...DEFAULT_AVATAR, ...look });
          await (avatar as { ready?: Promise<void> }).ready;
          const origens = (avatar as { origins?: () => Map<THREE.SkinnedMesh, string> })
            .origins?.() ?? new Map<THREE.SkinnedMesh, string>();

          // Cena própria, fundo preto e sem luz: as duas máscaras não podem
          // depender do chão, do céu nem de para onde o sol aponta.
          const palco = new THREE.Scene();
          palco.background = new THREE.Color(0x000000);
          // Só entra no quadro em cor: as máscaras são de material chapado e
          // não podem depender de luz nenhuma.
          //
          // Forte, e sem o céu do laboratório: aqui não há mapa de ambiente
          // nenhum, e o que ilumina estas peças na cena de verdade é ele. Com a
          // intensidade da cena o quadro sai quase preto.
          const luz = new THREE.HemisphereLight(0xffffff, 0x8a8f99, 9);
          const sol = new THREE.DirectionalLight(0xfff4e6, 4);
          sol.position.set(1.4, 2.2, 2.6);
          luz.add(sol);
          const pivo = new THREE.Group();
          pivo.rotation.y = yaw;
          palco.add(pivo);
          pivo.add(avatar.root);

          // A régua da passada: DISTÂNCIA à câmera, em 16 bits, e não uma
          // mancha branca.
          //
          // A primeira versão pintava o traje de branco, o forro de branco na
          // outra passada, e chamava de vazamento todo pixel em que os dois
          // caíam juntos. Isso conta como defeito a OCLUSÃO LEGÍTIMA, e num
          // enquadramento de meio metro ela é enorme: a perna esquerda passa à
          // frente da bota direita, e a perna inteira passa à frente do avesso
          // de uma saia rodada — nos dois casos o forro está na frente do
          // traje, nos dois casos está certo. Era isso, e não uma peça mal
          // vestida, que dava 26% de "vazamento" a um close que a olho nu está
          // correto.
          //
          // Com distância dá para separar o que importa: interpenetração é o
          // forro furando a roupa por milímetros; oclusão é ele estar à frente
          // por um membro inteiro. `PROXIMO`, em `v2-lining.mjs`, é onde se
          // corta.
          //
          // Sem `#include <colorspace_fragment>` nem tonemapping: o valor
          // chega ao canvas como foi escrito.
          //
          // **Face frontal, como o jogo desenha.** Com dupla face, olhar para
          // dentro do cano de uma bota registra a parede de TRÁS dela, e a
          // perna passa à frente dessa parede por quatro centímetros — o que é
          // exatamente o que uma perna dentro de uma bota faz. Era esse o caso
          // do grosso das acusações: das 16 mil que sobravam no pior visual,
          // 12 mil estavam a mais de um centímetro do pano, distância que
          // nenhuma interpenetração de roupa tem. O que o jogador vê é a face
          // frontal, e é ela que julga.
          //
          // E o AZUL carrega a identidade da malha, não só um "tem superfície
          // aqui". Quando o portão acusa, a pergunta seguinte é sempre com QUE
          // peça o forro está brigando, e sem isso a resposta sai de olhar
          // fotografia e adivinhar.
          const profundidade = (id: number) => new THREE.ShaderMaterial({
            vertexShader: `
              #include <common>
              #include <skinning_pars_vertex>
              varying float vDist;
              void main() {
                #include <skinbase_vertex>
                #include <begin_vertex>
                #include <skinning_vertex>
                #include <project_vertex>
                vDist = -mvPosition.z;
              }
            `,
            fragmentShader: `
              varying float vDist;
              void main() {
                float t = clamp(vDist / ${DEPTH_RANGE.toFixed(1)}, 0.0, 1.0);
                // Dois canais para a distância: 8 bits seriam 3 cm de
                // resolução em 8 m, e a conta toda é sobre milímetros. O azul
                // é a malha, contada a partir de 1 — zero é o fundo, que não
                // foi desenhado.
                gl_FragColor = vec4(floor(t * 255.0) / 255.0, fract(t * 255.0), ${(id / 255).toFixed(6)}, 1.0);
              }
            `,
          });
          const malhas: Array<{
            mesh: THREE.SkinnedMesh; mat: THREE.Material | THREE.Material[];
            forro: boolean; pele: boolean; regua: THREE.ShaderMaterial; nome: string;
          }> = [];
          avatar.root.traverse((o) => {
            const mesh = o as THREE.SkinnedMesh;
            if (!mesh.isSkinnedMesh) return;
            const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
            const forro = origens.get(mesh) === LINING;
            malhas.push({
              mesh, mat: mesh.material, forro,
              // PELE, e não pano: metade das peças do acervo traz um pedaço de
              // corpo junto — o `top` traz os braços, dezessete calçados trazem
              // o tornozelo —, e `tint` pinta todos eles com o tom de pele do
              // jogador, o mesmo do forro. Forro atravessando um desses não é
              // defeito nenhum: é pele da mesma cor sobre pele da mesma cor, e
              // não há o que ver. Quem julga isso é o portão; aqui só se diz
              // qual malha é qual.
              pele: forro || /skin/i.test(material?.name ?? ''),
              regua: profundidade(malhas.length + 1),
              nome: `${origens.get(mesh) ?? '?'} ${material?.name || mesh.name}`,
            });
          });

          try {
            // A POSE também é uma pergunta. O forro é recortado e apertado uma
            // vez, na pose em que o avatar nasce, e a margem que o enfia por
            // baixo da peça vizinha existe justamente para o que acontece
            // depois: a perna dobra, a bainha sobe, e uma margem curta demais
            // abre a emenda no meio do passo. Medir só parado é medir o
            // problema com o movimento desligado.
            avatar.setAnim(anim as never);
            avatar.animate(0, 0);
            for (let i = 0; i * 0.05 < fase; i++) avatar.animate(0.05, 0);
            palco.updateMatrixWorld(true);
            const top = avatar.stature;
            camera.position.set(0, top * 0.52, 2.95);
            camera.lookAt(0, top * 0.5, 0);
            camera.updateMatrixWorld(true);

            // Uma passada só o traje, outra só o forro. Não é preciso pintar o
            // que não interessa de preto: o que não entra na passada não é
            // desenhado, e o fundo já responde "não há superfície aqui".
            const passada = (paraForro: boolean) => {
              for (const m of malhas) {
                m.mesh.visible = m.forro === paraForro;
                if (m.mesh.visible) m.mesh.material = m.regua;
              }
              renderer.webgl.render(palco, camera);
              return canvas.toDataURL('image/png');
            };

            // As faixas em que o forro entrou, PERGUNTADAS AO AVATAR.
            //
            // Nunca deduzidas da caixa envolvente das malhas do forro: quando
            // o recorte era feito só no ÍNDICE, os vértices descartados
            // continuavam na malha e a caixa de um punho de dez centímetros ia
            // do tornozelo à cintura. Enquadrar por ela é enquadrar a figura
            // inteira achando que se está de perto — e foi assim que esta
            // sonda aprovou, com 0 de 30 em vazamento e 0 em fresta, um forro
            // que em close estava explodido em lascas.
            const juntas = (avatar as { liningBands?: () => Array<[number, number]> })
              .liningBands?.() ?? [];

            const quadros = juntas.map(([de, ate]) => {
              const meio = (de + ate) / 2;
              // A câmera chega o bastante para a faixa mais a folga das
              // vizinhas ocuparem o quadro: é a emenda que se julga, e a
              // emenda inclui a bainha de quem está por cima.
              const alto = Math.max(0.22, (ate - de) + 0.14);
              camera.position.set(0, meio, alto * 1.9);
              camera.lookAt(0, meio, 0);
              camera.updateMatrixWorld(true);
              // O quadro em COR, no mesmo enquadramento, só quando pedido.
              //
              // Uma máscara diz onde o forro venceu o traje e não diz o que
              // aquilo é. Ver a mancha por cima da figura é a diferença entre
              // "12% de vazamento" e "a canela está por cima do cano da bota"
              // — e às vezes entre um defeito e um falso positivo.
              let quadro: string | null = null;
              if (cor) {
                for (const m of malhas) { m.mesh.visible = true; m.mesh.material = m.mat; }
                palco.add(luz);
                renderer.webgl.render(palco, camera);
                palco.remove(luz);
                quadro = canvas.toDataURL('image/png');
              }
              return { de, ate, traje: passada(false), forro: passada(true), cor: quadro };
            });
            return {
              quadros, temForro: malhas.some((m) => m.forro), escala: DEPTH_RANGE,
              // Na ordem do azul: a malha de id `n` é `pecas[n - 1]`.
              pecas: malhas.map((m) => m.nome),
              pele: malhas.map((m) => m.pele),
            };
          } finally {
            for (const m of malhas) { m.mesh.material = m.mat; m.mesh.visible = true; m.regua.dispose(); }
            pivo.remove(avatar.root);
            avatar.dispose();
          }
        },
        /**
         * O PERFIL de cada primitivo de uma peça: até onde ele cobre a coluna
         * do corpo e qual o seu raio máximo por faixa de altura.
         *
         * É a medida que escolhe o doador do forro. Um forro tem de satisfazer
         * duas coisas ao mesmo tempo, e olhar só para uma delas foi o que pôs
         * uma calça de alfaiate por baixo de todo mundo: precisa COBRIR (do
         * tornozelo até acima do umbigo) e precisa CABER (ser mais estreito que
         * a peça mais justa do acervo, ou aparece por cima dela).
         */
        /**
         * O forro CABE? A medida contra a medida, faixa de altura por faixa.
         *
         * O portão fotografa e diz que o forro está por cima do pano. Ele não
         * diz por quê, e há duas causas opostas: ou a folga do traje foi medida
         * e o forro não obedeceu, ou não havia folga medida ali — e nesse caso
         * o defeito está em `outfitClearance`, não em `shrink`. Esta sonda põe
         * as duas colunas lado a lado.
         */
        /** Só monta e descarta: o custo do avatar sem o custo de desenhar. */
        buildOnly: async (look: Partial<AvatarConfig>) => {
          const avatar = createAvatar({ ...DEFAULT_AVATAR, ...look });
          await (avatar as { ready?: Promise<void> }).ready;
          avatar.dispose();
        },
        liningFit: async (look: Partial<AvatarConfig>) => {
          const avatar = createAvatar({ ...DEFAULT_AVATAR, ...look });
          await (avatar as { ready?: Promise<void> }).ready;
          const origens = (avatar as { origins?: () => Map<THREE.SkinnedMesh, string> })
            .origins?.() ?? new Map<THREE.SkinnedMesh, string>();
          const folgas = (avatar as { liningClearance?: () => Map<number, Float32Array> | null })
            .liningClearance?.() ?? null;
          try {
            avatar.setAnim('idle' as never);
            avatar.animate(0, 0);
            avatar.root.updateMatrixWorld(true);
            const BANDA = 0.004;
            // Por OSSO e faixa, que é a chave em que a folga foi medida.
            const forro = new Map<string, { osso: number; faixa: number; r: number }>();
            const traje = new Map<string, number>();
            let ossos: THREE.Bone[] = [];
            const p = new THREE.Vector3();
            avatar.root.traverse((o) => {
              const mesh = o as THREE.SkinnedMesh;
              if (!mesh.isSkinnedMesh) return;
              const ehForro = origens.get(mesh) === LINING;
              ossos = mesh.skeleton?.bones ?? ossos;
              const skinIndex = mesh.geometry.getAttribute('skinIndex');
              const skinWeight = mesh.geometry.getAttribute('skinWeight');
              if (!skinIndex || !skinWeight) return;
              // Só os vértices que o índice usa. Hoje `clipToBands` corta a
              // geometria e não sobra vértice órfão, mas medir o que é
              // DESENHADO em vez do que está guardado é o que torna esta sonda
              // independente de como o recorte é feito.
              const idx = mesh.geometry.getIndex();
              const vivos = new Set<number>();
              if (idx) for (let k = 0; k < idx.count; k++) vivos.add(idx.getX(k));
              else for (let k = 0; k < skinIndex.count; k++) vivos.add(k);
              for (const i of vivos) {
                let dom = -1; let maior = 0;
                for (let j = 0; j < 4; j++) {
                  const w = skinWeight.getComponent(i, j);
                  if (w > maior) { maior = w; dom = skinIndex.getComponent(i, j); }
                }
                if (dom < 0) continue;
                mesh.getVertexPosition(i, p);
                mesh.localToWorld(p);
                const e = mesh.skeleton.bones[dom].matrixWorld.elements;
                const faixa = Math.floor(p.y / BANDA);
                const r = Math.hypot(p.x - e[12], p.z - e[14]);
                const chave = `${dom}:${faixa}`;
                if (ehForro) {
                  const antes = forro.get(chave);
                  if (!antes || r > antes.r) forro.set(chave, { osso: dom, faixa, r });
                } else {
                  traje.set(chave, Math.min(traje.get(chave) ?? Infinity, r));
                }
              }
            });
            const linhas: Array<Record<string, number | string>> = [];
            for (const [chave, { osso, faixa, r }] of forro) {
              const folga = folgas?.get(osso)?.[faixa] ?? Infinity;
              linhas.push({
                osso: ossos[osso]?.name ?? String(osso), y: +(faixa * BANDA).toFixed(3),
                forro: +r.toFixed(4),
                traje: Number.isFinite(traje.get(chave) ?? Infinity) ? +(traje.get(chave) as number).toFixed(4) : 0,
                folga: Number.isFinite(folga) ? +folga.toFixed(4) : 'sem medida',
              });
            }
            linhas.sort((a, b) => String(a.osso).localeCompare(String(b.osso)) || (a.y as number) - (b.y as number));
            return { linhas, bandas: (avatar as { liningBands?: () => Array<[number, number]> }).liningBands?.() ?? [] };
          } finally {
            avatar.dispose();
          }
        },
        pieceProfile: async (look: Partial<AvatarConfig>, alvo: string) => {
          const avatar = createAvatar({ ...DEFAULT_AVATAR, ...look });
          await (avatar as { ready?: Promise<void> }).ready;
          const origens = (avatar as { origins?: () => Map<THREE.SkinnedMesh, string> })
            .origins?.() ?? new Map<THREE.SkinnedMesh, string>();
          try {
            avatar.setAnim('idle' as never);
            avatar.animate(0, 0);
            avatar.root.updateMatrixWorld(true);
            const saida: Array<Record<string, unknown>> = [];
            const p = new THREE.Vector3();
            avatar.root.traverse((o) => {
              const mesh = o as THREE.SkinnedMesh;
              if (!mesh.isSkinnedMesh || origens.get(mesh) !== alvo) return;
              let de = Infinity; let ate = -Infinity; let raio = 0;
              const BANDA = 0.02;
              const perfil = new Float32Array(Math.ceil(2.2 / BANDA));
              const n = mesh.geometry.getAttribute('position').count;
              // O raio é medido a partir do EIXO DA PERNA, não do eixo do
              // corpo: da linha do quadril para baixo são duas pernas, e a
              // distância ao centro do avatar mediria o vão entre elas.
              for (let i = 0; i < n; i++) {
                mesh.getVertexPosition(i, p);
                mesh.localToWorld(p);
                de = Math.min(de, p.y); ate = Math.max(ate, p.y);
                const eixo = p.y < avatar.stature * 0.53 ? Math.sign(p.x) * 0.09 : 0;
                const r = Math.hypot(p.x - eixo, p.z);
                raio = Math.max(raio, r);
                const faixa = Math.floor(p.y / BANDA);
                if (faixa >= 0 && faixa < perfil.length) perfil[faixa] = Math.max(perfil[faixa], r);
              }
              const mat = Array.isArray(mesh.material) ? '?' : (mesh.material as THREE.Material).name;
              saida.push({ mat: mat || mesh.name, de, ate, raio, verts: n, perfil: Array.from(perfil) });
            });
            return saida;
          } finally {
            avatar.dispose();
          }
        },
        /**
         * O CARD DA LOJA, do jeito que a loja o pede.
         *
         * `renderPoster` é o que desenha a vitrine, o feed e o perfil, e até
         * agora nenhuma ferramenta o exercitava: as capturas de loja saíam do
         * cliente inteiro, com login e navegação, o que responde "a loja
         * abriu?" e não "a peça aparece no quadro?". São perguntas diferentes,
         * e a segunda é a que vende.
         */
        poster: (config: Partial<AvatarConfig>, opts: Record<string, unknown> = {}) =>
          renderPoster({ ...DEFAULT_AVATAR, ...config }, opts as Parameters<typeof renderPoster>[1]),

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
