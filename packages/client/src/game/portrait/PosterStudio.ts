import * as THREE from 'three';
import type { AnimState, AvatarConfig } from '@streampolis/shared';
import { createAvatar, isProcedural } from '../avatar/createAvatar.js';
import { AvatarV2 } from '../avatar/v2/AvatarV2.js';

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
  /**
   * O id da PEÇA que este retrato existe para mostrar.
   *
   * Com ele o quadro é medido na peça em vez de chutado pelo tipo dela, e
   * `shot` deixa de importar. Ver `frameOnPiece`.
   */
  focus?: string;
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
  const cacheKey = `${keyOf(config, o)}|${turn ?? ''}|${options.focus ?? ''}`;
  const hit = cache.get(cacheKey);
  if (hit) return Promise.resolve(hit);

  const job = queue.then(async () => {
    const again = cache.get(cacheKey);
    if (again) return again;
    const url = await shoot(config, o, options.rim, turn, options.focus);
    cache.set(cacheKey, url);
    return url;
  });
  // A fila nunca quebra por causa de um retrato que falhou.
  queue = job.catch(() => undefined);
  return job;
}

async function shoot(
  config: AvatarConfig,
  o: { shot: PosterShot; pose: AnimState; at: number; width: number; height: number },
  rimColor?: number,
  turn?: number,
  focus?: string,
): Promise<string> {
  if (!studio) studio = makeStudio(o.width, o.height);
  const s = studio;
  s.renderer.setSize(o.width, o.height, false);
  s.camera.aspect = o.width / o.height;
  if (rimColor !== undefined) s.rim.color.setHex(rimColor);

  // O MESMO construtor do jogo: o card tem de mostrar o corpo que a pessoa vai
  // ver na praça, e um estúdio com avatar próprio é como as duas coisas se
  // separam sem ninguém notar.
  const avatar = createAvatar(config);
  // Retrato espera as PEÇAS. O corpo v2 vem de quatro arquivos e nasce vazio;
  // renderizar antes de eles chegarem fotografa o chão.
  if (avatar instanceof AvatarV2) await avatar.ready;
  // Retrato não pisca: o laço abaixo adianta segundos de animação para o corpo
  // ter peso, e o reflexo corre junto — sem prender, um card em cada tantos sai
  // com a modelo de olho fechado. Vale para os DOIS corpos desde que o do
  // pacote também ganhou reflexo.
  avatar.pinBlink(0);
  if (isProcedural(avatar)) {
    // Um frame parado no meio de um clipe é muito mais vivo do que a pose de
    // descanso: o corpo aparece com peso de um lado, os braços fora do eixo.
    avatar.animator.pin(o.pose);
  } else {
    avatar.setAnim(o.pose);
  }
  const step = 1 / 30;
  const previewSpeed = o.pose === 'walk' ? 2.4 : o.pose === 'run' ? 5.2 : 0;
  for (let t = 0; t < o.at; t += step) avatar.animate(step, previewSpeed);
  // Três quartos: de frente o avatar vira foto 3x4 de documento.
  avatar.root.rotation.y = turn ?? (o.shot === 'bust' ? 0.42 : o.shot === 'feet' ? 0.62 : 0.34);
  avatar.root.updateMatrixWorld(true);

  s.scene.add(avatar.root);

  // Enquadramento por trigonometria, não por tentativa: com fov de 30° a
  // altura visível é 2·d·tan(15°) ≈ 0,54·d. Corpo inteiro precisa de ~2,1 m de
  // altura visível (o avatar tem 1,67 m e a moldura pede folga), busto precisa
  // de ~0,8 m. Chutar a distância é o que decapitava o retrato.
  // A ESTATURA, que é a mesma pergunta nos dois corpos.
  //
  // Aqui havia um `if` sobre o tipo concreto dividindo por 0,94, porque o
  // `eyeHeight` de um corpo era a coroa e o do outro a linha dos olhos, uns 6%
  // abaixo — e 6% de 1,7 m é uma cabeça cortada no topo do card. O conserto
  // certo não era o `if`: era o contrato ter um significado só.
  const crown = avatar.stature;
  // A PEÇA manda no quadro quando o retrato existe por causa dela.
  const naPeca = focus && avatar instanceof AvatarV2
    ? frameOnPiece(s.camera, withFace(avatar.pieceBox(focus), crown), o.width / o.height)
    : false;
  if (naPeca) {
    // já enquadrado
  } else if (o.shot === 'bust') {
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
    // Corpo inteiro: com fov de 30° a altura visível é 2·d·tan(15°) ≈ 0,536·d.
    // Pedindo 1,45 altura de folga (cabelo em cima, sombra embaixo), a distância
    // é aritmética e não tentativa — chutar é o que decapita o retrato.
    const distance = (crown * 1.45) / 0.536;
    s.camera.position.set(0.66, crown * 0.58, distance);
    s.camera.lookAt(0, crown * 0.48, 0);
  }
  s.camera.updateProjectionMatrix();

  s.renderer.render(s.scene, s.camera);
  const url = s.renderer.domElement.toDataURL('image/png');

  s.scene.remove(avatar.root);
  avatar.dispose();
  return url;
}

/**
 * Aponta a câmera para a caixa da peça, e chega perto o bastante para ela
 * PREENCHER o quadro.
 *
 * O enquadramento era um chute de altura por tipo de item — busto para blusa,
 * pés para calçado —, e ele erra por construção agora que o guarda-roupa tem 83
 * peças de vinte e um personagens: a bota do aventureiro sobe até o joelho e a
 * sandália mal cobre o pé, e o mesmo quadro fixo corta uma e perde a outra num
 * quadro vazio. Pior, o que enchia o card de um calçado era a CALÇA de quem
 * estava olhando — grande, escura, e na frente.
 *
 * A conta é a de sempre e não tem chute nenhum: com `fov` vertical, a altura
 * visível a uma distância `d` é `2·d·tan(fov/2)`, e a largura é ela vezes o
 * aspecto. A distância pedida é a MAIOR das duas — a que faz caber a altura e a
 * que faz caber a largura —, porque caber num eixo e estourar no outro é
 * exatamente o card que corta a peça.
 *
 * A folga é multiplicativa (`FOLGA`) e não em metros: uma cabeça e uma calça
 * não pedem a mesma sobra em centímetros, pedem a mesma sobra em proporção.
 *
 * E a caixa é INFLADA a um mínimo (`MINIMO`): uma peça pequena — um pé de
 * sandália — enquadrada justa vira uma macrofotografia de dedo, sem corpo em
 * volta para dizer o que aquilo é. O card precisa mostrar a peça E onde ela
 * fica.
 */
const FOLGA = 1.2;
const MINIMO = 0.26;

/**
 * De onde a câmera olha a peça, em direção — a distância é que se calcula.
 *
 * De três quartos como todo retrato daqui: o avatar já foi girado, então quem
 * mostra o perfil é o corpo e a câmera só sai um pouco do eixo.
 */
const OLHAR = new THREE.Vector3(0.18, 0, 1).normalize();

/**
 * Sobe a caixa até a coroa quando a peça é do tronco para cima.
 *
 * Uma blusa enquadrada justa é um quadro de tecido: a caixa de um `top` vai do
 * ombro ao punho e o rosto fica de fora, e o card perde a pessoa que está
 * vestindo — que é metade do que ele vende. Da cintura para baixo não há esse
 * problema, porque não há rosto a incluir, e forçar a coroa faria de um card de
 * calçado um retrato de corpo inteiro com o sapato do tamanho de uma unha.
 *
 * O corte é a linha da cintura, e não o nome do slot: quem decide é onde a peça
 * ESTÁ, e há vestido que desce até o joelho e bota que sobe até ele.
 *
 * E quem responde "onde ela está" é o CENTRO da caixa, não o topo dela: pelo
 * topo, uma calça — que começa na cintura — conta como peça de tronco e o card
 * dela vira um retrato de corpo inteiro com a calça na metade de baixo. Pelo
 * centro, calça é calça e blusa é blusa, sem consultar o nome do slot.
 */
function withFace(box: THREE.Box3 | null, crown: number): THREE.Box3 | null {
  const cintura = crown * 0.55;
  if (!box || box.getCenter(new THREE.Vector3()).y < cintura) return box;
  const comRosto = box.clone();
  comRosto.max.y = Math.max(comRosto.max.y, crown);
  // E o quadro para na cintura por baixo. A caixa de uma blusa desce até o
  // PUNHO, porque a manga vai junto com o braço, e um quadro que vai do punho
  // à coroa é o corpo inteiro menos as pernas: a câmera recua e a peça — que é
  // o que o card vende — vira detalhe no meio. Manga caída é braço; a roupa
  // está no tronco.
  comRosto.min.y = Math.max(comRosto.min.y, cintura);
  return comRosto;
}

function frameOnPiece(
  camera: THREE.PerspectiveCamera, box: THREE.Box3 | null, aspect: number,
): boolean {
  if (!box) return false;
  const centro = box.getCenter(new THREE.Vector3());
  const tamanho = box.getSize(new THREE.Vector3());
  // A largura que importa é a que a peça ocupa NA TELA, e não o maior lado da
  // caixa: a caixa é do mundo, e a câmera olha de viés. Com os pés afastados
  // numa passada, o lado Z da caixa de um calçado é meio metro de PROFUNDIDADE
  // — tratá-lo como largura afasta a câmera até o sapato virar um detalhe.
  // Para uma caixa alinhada aos eixos, a sombra dela sobre a direita da câmera
  // é a soma dos lados vezes o quanto cada um aponta para lá.
  const direita = new THREE.Vector3().crossVectors(OLHAR, camera.up).normalize();
  const alto = Math.max(tamanho.y, MINIMO) * FOLGA;
  const largo = Math.max(
    Math.abs(direita.x) * tamanho.x + Math.abs(direita.z) * tamanho.z, MINIMO,
  ) * FOLGA;
  const meio = THREE.MathUtils.degToRad(camera.fov) / 2;
  const distancia = Math.max(alto / 2 / Math.tan(meio), largo / 2 / Math.tan(meio) / aspect);
  camera.position.copy(OLHAR).multiplyScalar(distancia).add(centro);
  camera.lookAt(centro);
  return true;
}

/** Libera o contexto do estúdio. Só o teardown da aplicação chama isto. */
export function disposePosterStudio(): void {
  if (!studio) return;
  studio.env.dispose();
  studio.renderer.dispose();
  studio = null;
  cache.clear();
}
