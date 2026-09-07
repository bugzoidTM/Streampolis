import * as THREE from 'three';
import type { MatLib } from './Materials.js';
import { box, boxUV, cyl, merge, place } from './Geometry.js';

/**
 * Animated LED surfaces.
 *
 * Streampolis is a game about broadcasting, so every public space needs a
 * screen that is visibly *playing* something. A texture would be a still
 * frame; a 40-line fragment shader costs one draw call, no memory, and moves.
 * Output is deliberately above 1.0 so the bloom pass blooms it.
 *
 * ## E, quando existe um vídeo, ele entra NO MESMO material
 *
 * O telão da praça (PRD §6) passou a poder tocar um arquivo. A tentação seria
 * pôr um segundo plano por cima do painel com um `MeshBasicMaterial` de
 * `VideoTexture` — e aí seriam duas chamadas de desenho, dois materiais para
 * dispor e um z-fighting a resolver com `polygonOffset`.
 *
 * Aqui o vídeo é uma AMOSTRA dentro do mesmo shader: fora do retângulo dele
 * continua a onda de LED de sempre, e por cima de tudo continuam as scanlines e
 * a grade de pixel. O painel continua custando uma chamada, e um vídeo vertical
 * num telão deitado lê como um telão de palco mostrando um celular — que é
 * exatamente o que ele é.
 *
 * ## O vídeo nunca é obrigatório
 *
 * `uHasVideo` só vira 1 quando o elemento tem quadro pronto (`readyState >= 2`).
 * Arquivo ausente, formato recusado, autoplay barrado: o telão continua o que
 * sempre foi. Uma praça cujo telão fica um retângulo preto porque um `.mp4` não
 * subiu seria pior do que uma praça sem vídeo nenhum.
 */

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform float uGain;
uniform vec3 uA;
uniform vec3 uB;
uniform float uBars;
uniform sampler2D uVideo;
uniform float uHasVideo;
/** Retângulo do vídeo em UV: (x0, y0, x1, y1). Vem do ASPECTO real do arquivo. */
uniform vec4 uRect;

float hash(float n) { return fract(sin(n) * 43758.5453123); }

void main() {
  vec2 uv = vUv;
  // Rolling diagonal wash between the two brand colours.
  float wave = sin((uv.x * 2.4 + uv.y * 1.1) * 3.14159 - uTime * 0.55) * 0.5 + 0.5;
  vec3 col = mix(uA, uB, wave);

  // Soft vignette so the panel does not read as a flat rectangle of light.
  float r = length((uv - 0.5) * vec2(1.7, 1.0));
  col *= 1.0 - r * 0.45;

  // Audio-meter bars along the lower third.
  if (uBars > 0.5) {
    float cols = 24.0;
    float i = floor(uv.x * cols);
    float h = 0.08 + 0.34 * (0.5 + 0.5 * sin(uTime * (2.0 + hash(i) * 4.0) + i));
    float bar = step(uv.y, h) * step(0.06, fract(uv.x * cols));
    col += bar * mix(uB, vec3(1.0), 0.45) * 0.9;
  }

  // Highlight sweep, like a lower-third animation looping.
  float sweep = smoothstep(0.06, 0.0, abs(uv.y - fract(uTime * 0.11) * 1.2 + 0.1));
  col += sweep * 0.35;

  // O vídeo, quando existe: substitui a onda DENTRO do retângulo dele.
  //
  // A conversão de sRGB para linear é feita à mão de propósito. Três injeta o
  // decode automaticamente nos materiais dele, mas não num ShaderMaterial —
  // sem esta linha o vídeo aparece lavado, e o erro é do tipo que se atribui à
  // gradação da cena em vez de à textura.
  if (uHasVideo > 0.5) {
    vec2 d = smoothstep(vec2(0.0), vec2(0.004), uv - uRect.xy)
           * smoothstep(vec2(0.0), vec2(0.004), uRect.zw - uv);
    float dentro = d.x * d.y;
    if (dentro > 0.0) {
      vec2 vuv = (uv - uRect.xy) / max(uRect.zw - uRect.xy, vec2(1e-4));
      // Sem inverter o V à mão: a VideoTexture do Three já nasce com flipY, e
      // inverter de novo aqui punha o vídeo de cabeça para baixo. Dois flips
      // são zero flips, e o defeito é invisível num vídeo abstrato — só
      // aparece quando entra alguém em pé no quadro.
      vec3 quadro = texture2D(uVideo, vuv).rgb;
      quadro = pow(quadro, vec3(2.2));
      // O ganho do vídeo é 1.0: ele não passa pelo uGain do painel. Um
      // filme multiplicado por 2 estoura no bloom e vira um borrão branco, que
      // é o oposto de mostrar um vídeo.
      col = mix(col, quadro, dentro);
    }
  }

  // Scanlines and pixel grid keep it reading as an LED wall up close.
  float scan = 0.92 + 0.08 * sin(uv.y * 620.0);
  float grid = 0.94 + 0.06 * sin(uv.x * 900.0);
  // O ganho de bloom vale para o LED, não para o filme: uHasVideo recorta o
  // brilho extra fora do retângulo do vídeo.
  float ganho = mix(uGain, 1.0, uHasVideo * step(uRect.x, uv.x) * step(uv.x, uRect.z)
                                * step(uRect.y, uv.y) * step(uv.y, uRect.w));
  gl_FragColor = vec4(col * scan * grid * ganho, 1.0);
}
`;

export function screenMaterial(a: number, b: number, gain = 2.1, bars = true): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uGain: { value: gain },
      uA: { value: new THREE.Color(a).convertSRGBToLinear() },
      uB: { value: new THREE.Color(b).convertSRGBToLinear() },
      uBars: { value: bars ? 1 : 0 },
      uVideo: { value: null },
      uHasVideo: { value: 0 },
      uRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    toneMapped: true,
  });
}

export interface VideoWallOpts {
  width: number;
  height: number;
  /** Height of the screen's bottom edge above the ground. */
  base: number;
  colors?: [number, number];
  gain?: number;
  bars?: boolean;
  /** Adds a truss mast and back-stays; off for wall-mounted panels. */
  freestanding?: boolean;
  /**
   * Arquivo a tocar no painel, em laço e SEM SOM.
   *
   * Ausente (o caso de todos os outros telões do jogo) mantém o painel como
   * sempre foi. O caminho é servido pelo próprio site, então mesma origem —
   * um vídeo de outro domínio precisaria de CORS e mancharia a textura.
   */
  video?: string;
}

/** A framed LED wall with its own animation clock. */
export class VideoWall {
  readonly group = new THREE.Group();
  private mat: THREE.ShaderMaterial;
  private geos: THREE.BufferGeometry[] = [];
  private video: HTMLVideoElement | null = null;
  private videoTex: THREE.VideoTexture | null = null;
  private solto: Array<() => void> = [];

  constructor(lib: MatLib, opts: VideoWallOpts) {
    const { width: W, height: H, base } = opts;
    const [a, b] = opts.colors ?? [0xff3d7f, 0x2f7bff];
    this.mat = screenMaterial(a, b, opts.gain ?? 2.1, opts.bars ?? true);

    const panel = new THREE.PlaneGeometry(W, H);
    const screen = new THREE.Mesh(panel, this.mat);
    screen.position.set(0, base + H / 2, 0.06);
    this.group.add(screen);
    this.geos.push(panel);

    const frameParts = [
      place(box(W + 0.34, 0.28, 0.34), 0, base + H + 0.14, 0),
      place(box(W + 0.34, 0.28, 0.34), 0, base - 0.14, 0),
      place(box(0.28, H + 0.56, 0.34), -W / 2 - 0.17, base + H / 2, 0),
      place(box(0.28, H + 0.56, 0.34), W / 2 + 0.17, base + H / 2, 0),
      place(box(W, H, 0.12), 0, base + H / 2, -0.06),
    ];
    if (opts.freestanding) {
      for (const sx of [-1, 1]) {
        frameParts.push(place(box(0.34, base + 0.2, 0.34), sx * (W / 2 - 0.4), (base + 0.2) / 2, 0));
        frameParts.push(place(cyl(0.06, 0.06, base * 1.15, 8), sx * (W / 2 - 0.4), base * 0.5, -0.9, 0.5, 0, 0));
        frameParts.push(place(box(1.2, 0.16, 1.6), sx * (W / 2 - 0.4), 0.08, -0.4));
      }
      frameParts.push(place(box(W - 0.4, 0.24, 0.24), 0, base * 0.62, -0.1));
    }
    const frame = merge(frameParts);
    boxUV(frame, 0.7);
    const frameMesh = new THREE.Mesh(frame, lib.metal('#2c3037', 0.55, 0.8));
    frameMesh.castShadow = true;
    frameMesh.receiveShadow = true;
    this.group.add(frameMesh);
    this.geos.push(frame);

    if (opts.video) this.playVideo(opts.video, W, H);
  }

  /**
   * Põe um arquivo no painel: em laço, mudo, e sem nunca virar caminho crítico.
   *
   * ## Mudo não é uma propriedade, é a condição de tocar
   *
   * Nenhum navegador deixa um vídeo com som começar sozinho — a política de
   * autoplay existe justamente contra isso. `muted` mais `playsInline` é o que
   * torna o autoplay permitido, e é por isso que os dois são escritos ANTES do
   * `src`: definidos depois, o Safari já decidiu que o elemento tem áudio e
   * recusa a reprodução. (`defaultMuted` é o que fixa o atributo no HTML, e não
   * só a propriedade — a mesma armadilha, do outro lado.)
   *
   * ## E mesmo assim o `play()` pode ser recusado
   *
   * Alguns navegadores (e a "economia de dados" de outros) bloqueiam até o
   * autoplay mudo. A recuperação é um gesto do jogador: o primeiro clique ou
   * tecla na página tenta de novo, uma vez. Sem isso o telão ficaria parado no
   * primeiro quadro em uma fatia real dos aparelhos.
   */
  private playVideo(src: string, W: number, H: number): void {
    if (typeof document === 'undefined') return;
    const v = document.createElement('video');
    // A ordem importa: mudo e inline ANTES da fonte (ver o comentário acima).
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.loop = true;
    v.autoplay = true;
    v.preload = 'auto';
    v.src = src;
    this.video = v;

    const tex = new THREE.VideoTexture(v);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    // Sem mipmaps: o quadro muda toda hora e gerar a pirâmide a cada quadro é
    // caro para uma superfície que se olha de frente.
    tex.generateMipmaps = false;
    this.videoTex = tex;
    this.mat.uniforms.uVideo.value = tex;

    const tentar = () => { void v.play().catch(() => undefined); };

    /**
     * O retângulo do vídeo dentro do painel, por CONTER e nunca por cortar.
     *
     * O telão da praça é deitado (13,5 × 7,4) e o arquivo pode ser vertical.
     * Preencher cortaria o vídeo pelos lados — num vídeo vertical, isso corta
     * exatamente o meio, que é onde está tudo. Contido, sobra onda de LED dos
     * dois lados e o painel lê como um telão de palco mostrando um celular.
     *
     * O aspecto vem do ARQUIVO (`videoWidth/videoHeight`), nunca presumido:
     * trocar o vídeo por um deitado passa a preencher o painel sozinho.
     */
    const encaixar = () => {
      if (!v.videoWidth || !v.videoHeight) return;
      const painel = W / H;
      const filme = v.videoWidth / v.videoHeight;
      const w = filme >= painel ? 1 : filme / painel;
      const h = filme >= painel ? painel / filme : 1;
      this.mat.uniforms.uRect.value.set((1 - w) / 2, (1 - h) / 2, (1 + w) / 2, (1 + h) / 2);
    };

    const pronto = () => {
      if (v.readyState < 2) return;
      encaixar();
      // Só agora o shader passa a amostrar. Antes disto o painel desenharia um
      // retângulo preto — pior do que não ter vídeo nenhum.
      this.mat.uniforms.uHasVideo.value = 1;
    };

    const ouvir = (alvo: EventTarget, evento: string, fn: () => void) => {
      alvo.addEventListener(evento, fn);
      this.solto.push(() => alvo.removeEventListener(evento, fn));
    };

    ouvir(v, 'loadedmetadata', encaixar);
    ouvir(v, 'loadeddata', pronto);
    ouvir(v, 'canplay', () => { pronto(); tentar(); });
    // Arquivo ausente ou formato recusado: o telão volta a ser o de sempre, sem
    // barulho no console do jogador.
    ouvir(v, 'error', () => { this.mat.uniforms.uHasVideo.value = 0; });

    // Aba escondida: parar de decodificar. Um vídeo rodando numa aba de fundo
    // é CPU gasta em quadros que ninguém vê — e num telefone é bateria.
    ouvir(document, 'visibilitychange', () => {
      if (document.hidden) v.pause();
      else tentar();
    });

    // O gesto de recuperação, uma vez só.
    const noGesto = () => {
      tentar();
      window.removeEventListener('pointerdown', noGesto);
      window.removeEventListener('keydown', noGesto);
    };
    window.addEventListener('pointerdown', noGesto);
    window.addEventListener('keydown', noGesto);
    this.solto.push(() => {
      window.removeEventListener('pointerdown', noGesto);
      window.removeEventListener('keydown', noGesto);
    });

    tentar();
  }

  update(dt: number) { this.mat.uniforms.uTime.value += dt; }

  dispose() {
    for (const off of this.solto) off();
    this.solto = [];
    if (this.video) {
      this.video.pause();
      // Esvaziar a fonte e recarregar é o que solta o decodificador. Só soltar
      // a referência deixa o elemento vivo baixando o arquivo até o coletor
      // passar — e trocar de cena é exatamente quando isso mais custa.
      this.video.removeAttribute('src');
      this.video.load();
      this.video = null;
    }
    this.videoTex?.dispose();
    this.videoTex = null;
    this.mat.dispose();
    for (const g of this.geos) g.dispose();
  }
}
