import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { Renderer, LOOK_DAY } from '../game/Renderer.js';
import { Environment, GOLDEN_HOUR } from '../game/Environment.js';
import { AssetLibrary } from '../game/assets/AssetLibrary.js';
import { instanceProp } from '../game/props/Geometry.js';
import { concrete, applySurface } from '../game/materials/Textures.js';

/**
 * Folha de contato de uma família de assets, cada variante ao lado de uma
 * REFERÊNCIA de 1,67 m — a altura do avatar.
 *
 * Existe porque um pacote de terceiro é autorado na escala de quem o desenhou,
 * e "quanto mede este sofá" não é uma pergunta de bounding box: o número diz
 * 3,00 × 1,22 × 1,60 e não diz se isso é um sofá gordo ou um sofá comprido. A
 * régua ao lado responde em um segundo o que uma planilha não responde.
 */
export function AssetLab() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const params = new URLSearchParams(location.search);
    const family = params.get('family') ?? 'furniture';
    const tier = (params.get('tier') as 'low' | 'medium' | 'high' | null) ?? 'high';

    const renderer = new Renderer(canvas, tier);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 400);

    const env = new Environment(scene, renderer.webgl, {
      ...GOLDEN_HOUR,
      elevation: 32, azimuth: 140,
      sunIntensity: 2.4, ambientIntensity: 0.34, envIntensity: 0.7,
      fogNear: 60, fogFar: 200,
    });

    const floorMat = new THREE.MeshStandardMaterial({ color: 0x8d8f93, roughness: 0.95 });
    applySurface(floorMat, concrete(512, 12, '#93959a'));
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    renderer.attach(scene, camera, { ...LOOK_DAY, exposure: Number(params.get('exp') ?? 0.6) });

    let raf = 0;
    let ready = 0;
    let disposeLib: (() => void) | null = null;

    (async () => {
      const lib = await AssetLibrary.load([family]);
      disposeLib = () => lib.dispose();
      for (const mat of lib.materials()) env.registerMaterial(mat);

      const ids = lib.ids(family);
      const cols = Math.ceil(Math.sqrt(ids.length)) || 1;
      const pitch = Number(params.get('pitch') ?? 3.2);

      // A régua: um bloco da altura do avatar, na mesma célula. Sem ela, todo
      // asset "parece do tamanho certo" — é a comparação que denuncia.
      const rulerGeo = new THREE.BoxGeometry(0.36, 1.67, 0.22);
      rulerGeo.translate(0, 1.67 / 2, 0);
      const rulerMat = new THREE.MeshStandardMaterial({ color: 0x2f3540, roughness: 0.8 });

      ids.forEach((id, i) => {
        const x = (i % cols - (cols - 1) / 2) * pitch;
        const z = (Math.floor(i / cols) - (Math.ceil(ids.length / cols) - 1) / 2) * pitch;
        const prop = lib.prop(family, id)!;
        const at = new THREE.Matrix4().setPosition(x, 0, z);
        for (const mesh of instanceProp(prop, [at])) scene.add(mesh);

        const ruler = new THREE.Mesh(rulerGeo, rulerMat);
        ruler.position.set(x - pitch * 0.36, 0, z - pitch * 0.3);
        ruler.castShadow = true;
        scene.add(ruler);
      });

      const span = cols * pitch;
      camera.position.set(span * 0.42, span * 0.62, span * 0.86);
      camera.lookAt(0, 0.5, 0);
      env.frameShadows(new THREE.Vector3(0, 0, 0), span * 0.8);

      (window as unknown as { __assets?: unknown }).__assets = {
        family,
        items: ids.map((id) => ({ id, ...lib.item(family, id) })),
      };
    })();

    const resize = () => renderer.resize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
    window.addEventListener('resize', resize);
    resize();

    const clock = new THREE.Clock();
    const frame = () => {
      raf = requestAnimationFrame(frame);
      env.update(camera);
      renderer.render(Math.min(0.05, clock.getDelta()));
      ready++;
      if (ready === 20) (window as unknown as { __ready?: boolean }).__ready = true;
    };
    frame();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      disposeLib?.();
      env.dispose();
      renderer.dispose();
    };
  }, []);

  return <canvas ref={ref} style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', display: 'block', background: '#0b0d12' }} />;
}
