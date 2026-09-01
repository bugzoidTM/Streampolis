import * as THREE from 'three';
import type { AnimState, AvatarConfig } from '@streampolis/shared';
import { Avatar } from '../avatar/Avatar.js';

/**
 * Retratos 3D para a UI.
 *
 * O feed, o perfil e a loja precisam mostrar PESSOAS, não silhuetas genéricas —
 * e a vantagem de um jogo próprio sobre um feed de vídeo é justamente esta: o
 * avatar de verdade pode ser desenhado sem vídeo nenhum. Este módulo mantém um
 * segundo contexto WebGL, minúsculo, que renderiza um avatar por vez e devolve
 * um PNG.
 *
 * Três decisões que tornam isso barato o suficiente para uma lista:
 *  - resultado em cache por (aparência + enquadramento + pose): o mesmo host em
 *    dez cards custa um render;
 *  - fila serial: montar dois avatares ao mesmo tempo trava a thread e o feed
 *    "pisca" durante a rolagem;
 *  - o avatar é descartado logo depois; ele existe só o tempo do clique do
 *    obturador.
 */

/**
 * Como a peça é enquadrada no card da loja. Uma calça num busto e um tênis de
 * corpo inteiro são a mesma falha: a loja existe para responder "como isso
 * ficaria em mim?", e não responde nada se a peça não couber no quadro.
 */
export type PosterShot = 'full' | 'bust' | 'legs' | 'feet';

export interface PosterOptions {
  shot?: PosterShot;
  pose?: AnimState;
  /** Instante do clipe, em segundos: escolhe o frame que vira a foto. */
  at?: number;
  width?: number;
  height?: number;
  /** Luz de recorte por trás, na cor do card. */
  rim?: number;
  /**
   * Quanto girar o avatar, em radianos. O padrão é um três quartos — de frente
   * ele vira foto 3x4 de documento. Girar meia volta mostra as costas (útil
   * para conferir um cabelo ou uma jaqueta).
   */
  turn?: number;
}

interface Studio {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  key: THREE.DirectionalLight;
  fill: THREE.HemisphereLight;
  rim: THREE.DirectionalLight;
  env: THREE.Texture;
}

let studio: Studio | null = null;
const cache = new Map<string, string>();
let queue: Promise<unknown> = Promise.resolve();

function makeStudio(width: number, height: number): Studio {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setSize(width, height, false);
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = false;

  const scene = new THREE.Scene();

  // IBL de estúdio: uma caixa clara por dentro. Sem environment a pele de
  // MeshPhysicalMaterial fica de borracha, e é a primeira coisa que se nota.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(8, 5, 8),
    [0xdfe6f2, 0xdfe6f2, 0xffffff, 0x8d93a3, 0xdfe6f2, 0xdfe6f2].map(
      (hex) => new THREE.MeshBasicMaterial({ color: hex, side: THREE.BackSide }),
    ),
  );
  const capture = new THREE.Scene();
  capture.add(box);
  const env = pmrem.fromScene(capture, 0.05).texture;
  scene.environment = env;
  scene.environmentIntensity = 1.0;
  box.geometry.dispose();
  for (const m of box.material as THREE.Material[]) m.dispose();
  pmrem.dispose();

  const fill = new THREE.HemisphereLight(0xe8eeff, 0x3a3f4c, 0.55);
  scene.add(fill);

  const key = new THREE.DirectionalLight(0xfff4e6, 2.4);
  key.position.set(1.6, 2.4, 2.2);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x9fd2ff, 2.2);
  rim.position.set(-1.8, 1.6, -2.4);
  scene.add(rim);

  const camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 40);
  return { renderer, scene, camera, key, fill, rim, env };
}

function keyOf(config: AvatarConfig, o: Required<Pick<PosterOptions, 'shot' | 'pose' | 'at' | 'width' | 'height'>>): string {
  return [
    config.bodyPreset, config.skinTone, config.facePreset, config.hair, config.hairColor,
    config.top, config.bottom, config.shoes, config.accessory, config.height,
    o.shot, o.pose, o.at, o.width, o.height,
  ].join('|');
}

/** PNG (data URL) de um avatar. Serializado e com cache. */
export function renderPoster(config: AvatarConfig, options: PosterOptions = {}): Promise<string> {
  const o = {
    shot: options.shot ?? 'full',
    pose: options.pose ?? ('idle' as AnimState),
    at: options.at ?? 1.4,
    width: options.width ?? 300,
    height: options.height ?? (options.shot === 'bust' ? 300 : 420),
  };
  const turn = options.turn;
  const cacheKey = `${keyOf(config, o)}|${turn ?? ''}`;
  const hit = cache.get(cacheKey);
  if (hit) return Promise.resolve(hit);

  const job = queue.then(() => {
    const again = cache.get(cacheKey);
    if (again) return again;
    const url = shoot(config, o, options.rim, turn);
    cache.set(cacheKey, url);
    return url;
  });
  // A fila nunca quebra por causa de um retrato que falhou.
  queue = job.catch(() => undefined);
  return job;
}

function shoot(
  config: AvatarConfig,
  o: { shot: PosterShot; pose: AnimState; at: number; width: number; height: number },
  rimColor?: number,
  turn?: number,
): string {
  if (!studio) studio = makeStudio(o.width, o.height);
  const s = studio;
  s.renderer.setSize(o.width, o.height, false);
  s.camera.aspect = o.width / o.height;
  if (rimColor !== undefined) s.rim.color.setHex(rimColor);

  const avatar = new Avatar(config);
  // Retrato não pisca: o laço abaixo adianta segundos de animação para o corpo
  // ter peso, e o reflexo corre junto — sem prender, um card em cada tantos
  // sai com a modelo de olho fechado.
  avatar.pinBlink(0);
  // Um frame parado no meio de um clipe é muito mais vivo do que a pose de
  // descanso: o corpo aparece com peso de um lado, os braços fora do eixo.
  avatar.animator.pin(o.pose);
  const step = 1 / 30;
  for (let t = 0; t < o.at; t += step) avatar.animate(step, 0);
  // Três quartos: de frente o avatar vira foto 3x4 de documento.
  avatar.root.rotation.y = turn ?? (o.shot === 'bust' ? 0.42 : o.shot === 'feet' ? 0.62 : 0.34);
  avatar.root.updateMatrixWorld(true);

  s.scene.add(avatar.root);

  // Enquadramento por trigonometria, não por tentativa: com fov de 30° a
  // altura visível é 2·d·tan(15°) ≈ 0,54·d. Corpo inteiro precisa de ~2,1 m de
  // altura visível (o avatar tem 1,67 m e a moldura pede folga), busto precisa
  // de ~0,8 m. Chutar a distância é o que decapitava o retrato.
  const crown = avatar.eyeHeight;
  if (o.shot === 'bust') {
    // Folga acima da cabeça: um cabelo com volume (afro, moicano) precisa de
    // mais quadro do que a coroa do crânio.
    s.camera.position.set(0.34, crown * 0.97, 1.62);
    s.camera.lookAt(0, crown * 0.86, 0);
  } else if (o.shot === 'legs') {
    // Da cintura ao chão: é onde vive uma calça, e o quadro tem de sobrar um
    // pouco embaixo para o sapato não ficar cortado na borda.
    s.camera.position.set(0.52, crown * 0.34, 2.05);
    s.camera.lookAt(0, crown * 0.27, 0);
  } else if (o.shot === 'feet') {
    s.camera.position.set(0.40, crown * 0.16, 1.05);
    s.camera.lookAt(0, crown * 0.07, 0);
  } else {
    s.camera.position.set(0.66, crown * 0.62, 3.7);
    s.camera.lookAt(0, crown * 0.52, 0);
  }
  s.camera.updateProjectionMatrix();

  s.renderer.render(s.scene, s.camera);
  const url = s.renderer.domElement.toDataURL('image/png');

  s.scene.remove(avatar.root);
  avatar.dispose();
  return url;
}

/** Libera o contexto do estúdio. Só o teardown da aplicação chama isto. */
export function disposePosterStudio(): void {
  if (!studio) return;
  studio.env.dispose();
  studio.renderer.dispose();
  studio = null;
  cache.clear();
}
