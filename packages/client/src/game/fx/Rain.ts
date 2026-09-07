import * as THREE from 'three';

/**
 * Chuva.
 *
 * Uma malha instanciada de riscos finos que caem dentro de uma CAIXA que segue
 * a câmera. Duas decisões carregam o efeito inteiro, e as duas são sobre custo:
 *
 *   * **a queda acontece no vertex shader.** Cada gota tem uma posição de
 *     partida e uma velocidade, e a altura sai de um módulo sobre o tempo.
 *     Três mil objetos atualizados em JavaScript por quadro são três mil
 *     escritas em matriz e um upload de buffer; aqui é um uniforme;
 *   * **a caixa acompanha a câmera e as gotas dão a volta nela.** Chuva
 *     autorada sobre a cena inteira precisaria cobrir 68 × 40 m para que
 *     nenhuma borda aparecesse, e a densidade que sobra perto do olho é
 *     garoa. Um volume de 26 m em torno de quem olha, com as gotas
 *     reentrando pelo topo, dá chuva cheia com um décimo das gotas.
 *
 * O risco é um quad vertical girado em torno de Y para encarar a câmera. Não é
 * billboard de verdade — não se inclina — e é o certo: gota de chuva cai na
 * vertical, e um risco que se deita quando a câmera olha para baixo lê como
 * confete.
 */

const RAIN_VERT = /* glsl */`
uniform float uTime;
uniform float uYaw;
uniform vec3 uOrigin;
uniform vec3 uBox;
uniform float uStreak;
attribute vec3 aSeed;
attribute float aSpeed;
varying float vFade;

void main() {
  // A gota cai e reentra pelo topo: a altura é um módulo, não uma simulação.
  vec3 p = aSeed;
  p.y -= uTime * aSpeed;

  // A caixa segue a camera. O modulo sobre a posicao relativa e o que faz uma
  // gota que saiu por tras reaparecer na frente sem nenhuma lista de reciclo.
  vec3 rel = mod(p - uOrigin + uBox * 0.5, uBox) - uBox * 0.5;

  // O quad local: X é a espessura, Y é o comprimento do risco. Girar só em
  // torno de Y mantém a gota vertical, que é o ponto.
  vec3 local = vec3(position.x, position.y * uStreak, 0.0);
  vec3 turned = vec3(
    local.x * cos(uYaw) + local.z * sin(uYaw),
    local.y,
    -local.x * sin(uYaw) + local.z * cos(uYaw)
  );

  vec3 world = uOrigin + rel + turned;

  // Some na borda do volume: sem isso a chuva termina num plano reto no ar,
  // que é a coisa que denuncia o truque da caixa.
  float d = length(rel.xz) / (uBox.x * 0.5);
  vFade = 1.0 - smoothstep(0.55, 1.0, d);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
}
`;

const RAIN_FRAG = /* glsl */`
precision mediump float;
uniform vec3 uColor;
uniform float uOpacity;
varying float vFade;

void main() {
  if (vFade <= 0.001) discard;
  gl_FragColor = vec4(uColor, uOpacity * vFade);
}
`;

export interface RainOptions {
  /** Quantas gotas. O governador de qualidade manda neste número. */
  count?: number;
  /** Extensão da caixa que segue a câmera, em metros. */
  box?: [number, number, number];
  /** Comprimento do risco em metros: é ele que dá a sensação de velocidade. */
  streak?: number;
  color?: number;
  opacity?: number;
}

export class Rain {
  readonly mesh: THREE.Mesh;

  private readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly box: THREE.Vector3;
  /** Reaproveitado a cada quadro: alocar um Vector3 por quadro é lixo por nada. */
  private readonly aim = new THREE.Vector3();
  private elapsed = 0;

  constructor(opts: RainOptions = {}) {
    const count = opts.count ?? 2600;
    this.box = new THREE.Vector3(...(opts.box ?? [26, 18, 26]));

    const quad = new THREE.PlaneGeometry(0.018, 1);
    const geo = new THREE.InstancedBufferGeometry();
    // Cópias, não os mesmos objetos: `quad.dispose()` logo abaixo avisa o
    // renderizador para liberar os buffers de CADA atributo da geometria
    // descartada, e atributo compartilhado seria liberado debaixo da chuva.
    geo.index = quad.index?.clone() ?? null;
    for (const [nome, attr] of Object.entries(quad.attributes)) geo.setAttribute(nome, attr.clone());
    geo.instanceCount = count;

    const seeds = new Float32Array(count * 3);
    const speeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      seeds[i * 3] = (Math.random() - 0.5) * this.box.x;
      seeds[i * 3 + 1] = Math.random() * this.box.y;
      seeds[i * 3 + 2] = (Math.random() - 0.5) * this.box.z;
      // Velocidades diferentes por gota: uma cortina inteira à mesma
      // velocidade lê como textura rolando, não como chuva.
      speeds[i] = 11 + Math.random() * 9;
    }
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3));
    geo.setAttribute('aSpeed', new THREE.InstancedBufferAttribute(speeds, 1));
    this.geometry = geo;
    quad.dispose();

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uYaw: { value: 0 },
        uOrigin: { value: new THREE.Vector3() },
        uBox: { value: this.box },
        uStreak: { value: opts.streak ?? 0.62 },
        uColor: { value: new THREE.Color(opts.color ?? 0xc9d6e8).convertSRGBToLinear() },
        uOpacity: { value: opts.opacity ?? 0.3 },
      },
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      transparent: true,
      // Sem escrita de profundidade: milhares de quads transparentes ordenados
      // entre si custam mais do que valem, e a chuva não precisa se ocluir.
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    // Malha comum, não `InstancedMesh`: a instanciação já vem da geometria, e
    // uma InstancedMesh carregaria um buffer de matrizes de 16 floats por gota
    // que este shader nunca lê.
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    // A caixa viaja com a câmera, então nenhum frustum culling faz sentido: o
    // bounding volume calculado no build está sempre errado por construção.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  update(dt: number, camera: THREE.Camera): void {
    this.elapsed += dt;
    const u = this.material.uniforms;
    u.uTime.value = this.elapsed;
    camera.getWorldPosition(u.uOrigin.value as THREE.Vector3);
    // A câmera olha na direção -Z do próprio espaço; o risco encara esse eixo.
    camera.getWorldDirection(this.aim);
    u.uYaw.value = Math.atan2(this.aim.x, this.aim.z);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
