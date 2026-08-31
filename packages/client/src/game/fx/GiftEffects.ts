import * as THREE from 'three';
import { GIFT_BY_ID, combinedEffectScale, type GiftEvent } from '@streampolis/shared';

/**
 * Presentes que se veem.
 *
 * O caminho do dinheiro já estava completo — o servidor cobra, valida e
 * transmite o `GiftEvent` — mas ele terminava numa linha de chat: ninguém via
 * a rosa. Isto é o outro lado da mesma moeda: o efeito só existe DEPOIS que a
 * cobrança passou (SPECs §68 regra 4), e cada evento cobrado aparece exatamente
 * uma vez, porque o replay é descartado no servidor e nunca chega aqui.
 *
 * Três níveis, e a diferença entre eles é a promessa que o preço faz:
 *
 *   petal   — 1 a 20 coins. Um gesto: pétalas subindo perto de quem recebeu.
 *   burst   — 99 a 2.000. Um evento: explosão, anel e um flash de luz.
 *   rocket  — 9.999. Um espetáculo: um foguete cruza a sala, explode e a
 *             câmera treme.
 *
 * Tudo é GPU: a posição de cada partícula é integrada no vertex shader a
 * partir da velocidade inicial e do tempo, então um envio de 500 partículas
 * não custa 500 objetos atualizados por frame na CPU (SPECs §47).
 */

export type GiftTier = 'petal' | 'burst' | 'rocket';

/** Qual animação do catálogo vira qual nível de espetáculo. */
const TIER_BY_ANIMATION: Record<string, GiftTier> = {
  fx_rose: 'petal',
  fx_coffee: 'petal',
  fx_heart: 'petal',
  fx_star: 'burst',
  fx_diamond: 'burst',
  fx_crown: 'burst',
  fx_rocket: 'rocket',
};

const VERT = /* glsl */`
attribute vec3 aVelocity;
attribute float aSize;
attribute float aDelay;
attribute float aSpin;

uniform float uTime;
uniform float uLife;
uniform float uGravity;
uniform float uDrag;
uniform float uScale;
/**
 * Altura do viewport dividida por 2*tan(fov/2): converte um tamanho em METROS
 * para pixels na distância certa. Sem isso o tamanho vira uma constante mágica
 * que, num quadro apertado, transforma cada pétala num disco de 900 px.
 */
uniform float uProject;

varying float vFade;
varying float vSpin;

void main() {
  float t = max(0.0, uTime - aDelay);
  float life = clamp(t / uLife, 0.0, 1.0);

  // Integração fechada de um arrasto exponencial: v(t) = v0 * exp(-k t).
  // Fazer isso no shader é o que mantém o custo por partícula em zero na CPU.
  float k = max(0.0001, uDrag);
  vec3 drift = aVelocity * (1.0 - exp(-k * t)) / k;
  vec3 pos = position + drift;
  pos.y -= 0.5 * uGravity * t * t;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  // Some no fim da vida e nasce rápido: um pop no início lê como impacto.
  vFade = smoothstep(0.0, 0.06, life) * (1.0 - smoothstep(0.55, 1.0, life));
  vFade *= step(0.0, uTime - aDelay);
  vSpin = aSpin + t * 2.4;

  gl_PointSize = clamp(aSize * uScale * uProject / max(0.05, -mv.z), 1.0, 180.0);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */`
precision highp float;
uniform vec3 uColor;
uniform float uIntensity;
uniform float uPetal;
varying float vFade;
varying float vSpin;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  // Gira o sprite: pétalas idênticas e paradas leem como um chuveiro de pixels.
  float c = cos(vSpin), s = sin(vSpin);
  uv = mat2(c, -s, s, c) * uv;

  float d = length(uv);
  // Pétala = disco achatado num eixo; brilho = disco radial macio.
  float petal = smoothstep(0.5, 0.06, length(vec2(uv.x * 1.9, uv.y)));
  float spark = smoothstep(0.5, 0.0, d);
  float mask = mix(spark, petal, uPetal);
  if (mask <= 0.001) discard;

  gl_FragColor = vec4(uColor * uIntensity, mask * vFade);
}
`;

interface Burst {
  points: THREE.Points;
  material: THREE.ShaderMaterial;
  geometry: THREE.BufferGeometry;
  /** Segundos desde o disparo. */
  age: number;
  life: number;
  count: number;
}

interface Flash {
  light: THREE.PointLight;
  age: number;
  life: number;
  peak: number;
}

interface Rocket {
  group: THREE.Group;
  from: THREE.Vector3;
  to: THREE.Vector3;
  age: number;
  travel: number;
  color: THREE.Color;
  quantity: number;
  exploded: boolean;
}

export interface GiftFxOptions {
  /** Teto de partículas vivas ao mesmo tempo, vindo do QualityManager. */
  budget: number;
  /** Chamado quando o efeito quer sacudir a câmera. */
  shake?: (amount: number) => void;
  /** A câmera do quadro: define o tamanho em pixels e por onde o foguete entra. */
  camera: () => THREE.PerspectiveCamera;
  /** Altura do canvas em pixels, para converter metros em tamanho de sprite. */
  viewHeight: () => number;
}

/** Máximo de rajadas simultâneas; além disso a mais velha some. */
const MAX_BURSTS = 8;

export class GiftEffectManager {
  private bursts: Burst[] = [];
  private flashes: Flash[] = [];
  private rockets: Rocket[] = [];
  private rocketGeo: THREE.BufferGeometry[] = [];
  private budget: number;
  private live = 0;

  constructor(private readonly scene: THREE.Scene, private opts: GiftFxOptions) {
    this.budget = Math.max(120, opts.budget);
  }

  setBudget(budget: number): void {
    this.budget = Math.max(120, budget);
  }

  /** Pixels por metro a um metro de distância, no quadro atual. */
  private projection(): number {
    const camera = this.opts.camera();
    const fov = THREE.MathUtils.degToRad(camera.fov);
    return this.opts.viewHeight() / (2 * Math.tan(fov / 2));
  }

  /**
   * Toca o efeito de um presente já cobrado.
   *
   * `at` é onde o presente cai: a posição de quem RECEBE. Um envio em massa
   * não vira N efeitos — o catálogo já define isso (SPECs §47) e aqui vira um
   * efeito maior, com mais partículas e mais duração.
   */
  play(event: GiftEvent, at: THREE.Vector3): void {
    const gift = GIFT_BY_ID.get(event.giftId);
    const tier = TIER_BY_ANIMATION[event.animationId ?? ''] ?? (gift ? tierByPrice(gift.coinCost) : 'petal');
    const color = new THREE.Color(gift?.color ?? '#ff4d6d');
    const scale = combinedEffectScale(Math.max(1, event.quantity));
    const budget = Math.min(gift?.particleBudget ?? 200, this.budget);

    switch (tier) {
      case 'petal':
        this.spawnPetals(at, color, Math.round(Math.min(budget, 60 * scale)), scale);
        break;
      case 'burst':
        this.spawnBurst(at, color, Math.round(Math.min(budget, 150 * scale)), scale);
        this.spawnFlash(at, color, 0.9 * scale, 0.5);
        this.opts.shake?.(0.02 * scale);
        break;
      case 'rocket':
        this.spawnRocket(at, color, Math.max(1, event.quantity));
        break;
    }
  }

  private canSpawn(count: number): number {
    // Em vez de recusar o efeito quando o orçamento aperta, ele encolhe: um
    // presente pago que não aparece é pior do que um presente pequeno.
    const room = Math.max(0, this.budget - this.live);
    return Math.max(24, Math.min(count, room));
  }

  private spawnPetals(at: THREE.Vector3, color: THREE.Color, count: number, scale: number): void {
    const n = this.canSpawn(count);
    const life = 2.6;
    const geo = this.makeGeometry(n, () => {
      const a = Math.random() * Math.PI * 2;
      const r = 0.25 + Math.random() * 0.55 * scale;
      return {
        // Nascem em volta do peito de quem recebe, não num ponto só.
        position: new THREE.Vector3(Math.cos(a) * r, 0.9 + Math.random() * 0.9, Math.sin(a) * r),
        velocity: new THREE.Vector3(
          Math.cos(a) * (0.25 + Math.random() * 0.5),
          0.9 + Math.random() * 1.1,
          Math.sin(a) * (0.25 + Math.random() * 0.5),
        ),
        size: 0.07 + Math.random() * 0.06,
        delay: Math.random() * 0.45,
        spin: Math.random() * Math.PI * 2,
      };
    });
    this.addBurst(geo, n, {
      at, color, life, gravity: 1.4, drag: 1.6, petal: 1, intensity: 0.85, scale: 1,
    });
  }

  private spawnBurst(at: THREE.Vector3, color: THREE.Color, count: number, scale: number): void {
    const n = this.canSpawn(count);
    const life = 2.2;
    const geo = this.makeGeometry(n, (i) => {
      // Metade explode em esfera, metade sobe num anel: a esfera dá o impacto,
      // o anel dá a leitura de que houve um evento e não só um brilho.
      const ring = i % 2 === 0;
      const a = Math.random() * Math.PI * 2;
      const speed = (ring ? 2.2 : 1.2) + Math.random() * 2.4;
      const pitch = ring ? 0.1 + Math.random() * 0.25 : Math.random() * Math.PI - Math.PI / 2;
      return {
        position: new THREE.Vector3(0, 1.25, 0),
        velocity: new THREE.Vector3(
          Math.cos(a) * Math.cos(pitch) * speed,
          Math.sin(pitch) * speed + (ring ? 1.4 : 0.6),
          Math.sin(a) * Math.cos(pitch) * speed,
        ),
        size: 0.05 + Math.random() * 0.07,
        delay: Math.random() * 0.12,
        spin: Math.random() * Math.PI * 2,
      };
    });
    this.addBurst(geo, n, {
      at, color, life, gravity: 2.2, drag: 2.4, petal: 0, intensity: 1.5, scale,
    });
  }

  private spawnRocket(at: THREE.Vector3, color: THREE.Color, quantity: number): void {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.16, 0.5, 6, 12),
      new THREE.MeshBasicMaterial({ color: 0xf2f4ff, fog: false }),
    );
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 0.36, 12),
      new THREE.MeshBasicMaterial({ color, fog: false }),
    );
    nose.position.y = 0.42;
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.15, 0.7, 10, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffd07a, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }),
    );
    flame.position.y = -0.6;
    flame.rotation.x = Math.PI;
    group.add(body, nose, flame);
    for (const mesh of [body, nose, flame]) this.rocketGeo.push(mesh.geometry);

    // Entra DENTRO DO QUADRO, não de um canto fixo do mundo: um foguete que
    // voa fora da tela é dinheiro gasto que ninguém viu.
    //
    // O ponto de entrada é longe da câmera e a poucos graus do eixo dela — o
    // contrário (perto e bem para o lado) parece render mais dramático e cai
    // fora do campo de visão, que foi exatamente o primeiro erro aqui: a 3,5 m
    // da câmera, 8 m de deslocamento lateral são 66 graus fora do eixo.
    const camera = this.opts.camera();
    const toTarget = at.clone().sub(camera.position).setY(0);
    if (toTarget.lengthSq() < 1e-4) toTarget.set(0, 0, 1);
    const distance = Math.max(3, toTarget.length());
    toTarget.normalize();
    const swing = (Math.random() < 0.5 ? -1 : 1) * 0.38;
    const entry = toTarget.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), swing);
    const from = camera.position.clone()
      .addScaledVector(entry, Math.min(18, distance * 1.9));
    from.y = 0.8;
    const to = at.clone().setY(at.y + 1.7);
    group.position.copy(from);
    this.scene.add(group);
    this.rockets.push({ group, from, to, age: 0, travel: 1.5, color, quantity, exploded: false });
    this.opts.shake?.(0.03);
  }

  private spawnFlash(at: THREE.Vector3, color: THREE.Color, peak: number, life: number): void {
    const light = new THREE.PointLight(color, 0, 9, 2);
    light.position.set(at.x, at.y + 1.4, at.z);
    this.scene.add(light);
    this.flashes.push({ light, age: 0, life, peak: peak * 14 });
  }

  private makeGeometry(
    count: number,
    make: (i: number) => {
      position: THREE.Vector3; velocity: THREE.Vector3;
      size: number; delay: number; spin: number;
    },
  ): THREE.BufferGeometry {
    const position = new Float32Array(count * 3);
    const velocity = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const delay = new Float32Array(count);
    const spin = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const p = make(i);
      position.set([p.position.x, p.position.y, p.position.z], i * 3);
      velocity.set([p.velocity.x, p.velocity.y, p.velocity.z], i * 3);
      size[i] = p.size;
      delay[i] = p.delay;
      spin[i] = p.spin;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geo.setAttribute('aVelocity', new THREE.BufferAttribute(velocity, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aDelay', new THREE.BufferAttribute(delay, 1));
    geo.setAttribute('aSpin', new THREE.BufferAttribute(spin, 1));
    // Partículas nunca são descartadas por frustum: a bounding box do sistema é
    // a do quadro zero, e o efeito inteiro sumiria assim que se espalhasse.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 40);
    return geo;
  }

  private addBurst(
    geometry: THREE.BufferGeometry, count: number,
    o: {
      at: THREE.Vector3; color: THREE.Color; life: number;
      gravity: number; drag: number; petal: number; intensity: number; scale: number;
    },
  ): void {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uLife: { value: o.life },
        uGravity: { value: o.gravity },
        uDrag: { value: o.drag },
        uScale: { value: Math.min(2.2, o.scale) },
        uProject: { value: 600 },
        uColor: { value: o.color.clone().convertSRGBToLinear() },
        uIntensity: { value: o.intensity },
        uPetal: { value: o.petal },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });

    const points = new THREE.Points(geometry, material);
    points.position.copy(o.at);
    points.frustumCulled = false;
    this.scene.add(points);
    this.bursts.push({ points, material, geometry, age: 0, life: o.life + 0.6, count });
    this.live += count;

    // Uma live cheia manda presente aos montes; a rajada mais velha sai antes
    // que o orçamento estoure.
    while (this.bursts.length > MAX_BURSTS) this.retire(this.bursts[0]);
  }

  update(dt: number): void {
    const projection = this.projection();
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const burst = this.bursts[i];
      burst.age += dt;
      burst.material.uniforms.uTime.value = burst.age;
      burst.material.uniforms.uProject.value = projection;
      if (burst.age >= burst.life) this.retire(burst);
    }

    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const flash = this.flashes[i];
      flash.age += dt;
      const u = flash.age / flash.life;
      if (u >= 1) {
        this.scene.remove(flash.light);
        flash.light.dispose();
        this.flashes.splice(i, 1);
        continue;
      }
      // Sobe num piscar e cai devagar: a curva de um flash de verdade.
      flash.light.intensity = flash.peak * Math.pow(1 - u, 2.2);
    }

    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const rocket = this.rockets[i];
      rocket.age += dt;
      const u = Math.min(1, rocket.age / rocket.travel);
      const pos = rocket.from.clone().lerp(rocket.to, u);
      // Arco: sobe no meio do caminho em vez de vir em linha reta.
      pos.y += Math.sin(u * Math.PI) * 3.2;
      const dir = rocket.to.clone().sub(pos).normalize();
      rocket.group.position.copy(pos);
      rocket.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      rocket.group.scale.setScalar(1 + Math.sin(rocket.age * 22) * 0.04);

      // Rastro contínuo, uma pequena rajada por vez.
      if (u < 1 && Math.random() < dt * 26) {
        this.spawnTrail(pos, rocket.color);
      }

      if (u >= 1 && !rocket.exploded) {
        rocket.exploded = true;
        const scale = combinedEffectScale(rocket.quantity) * 1.6;
        this.spawnBurst(rocket.to, rocket.color, Math.round(Math.min(this.budget, 320 * scale)), scale);
        this.spawnBurst(rocket.to, new THREE.Color(0xffe9a8), Math.round(Math.min(this.budget, 140 * scale)), scale * 0.8);
        this.spawnFlash(rocket.to, rocket.color, 2.4, 0.9);
        this.opts.shake?.(0.16);
        this.scene.remove(rocket.group);
        this.rockets.splice(i, 1);
      }
    }
  }

  private spawnTrail(at: THREE.Vector3, color: THREE.Color): void {
    const n = 8;
    const geo = this.makeGeometry(n, () => ({
      position: new THREE.Vector3(
        (Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.12,
      ),
      velocity: new THREE.Vector3(
        (Math.random() - 0.5) * 0.5, -0.3 - Math.random() * 0.5, (Math.random() - 0.5) * 0.5,
      ),
      size: 0.09 + Math.random() * 0.07,
      delay: 0,
      spin: Math.random() * 6.28,
    }));
    this.addBurst(geo, n, {
      at: at.clone(), color, life: 0.7, gravity: -0.4, drag: 3.4, petal: 0, intensity: 1.2, scale: 1,
    });
  }

  private retire(burst: Burst): void {
    const i = this.bursts.indexOf(burst);
    if (i < 0) return;
    this.bursts.splice(i, 1);
    this.live = Math.max(0, this.live - burst.count);
    this.scene.remove(burst.points);
    burst.geometry.dispose();
    burst.material.dispose();
  }

  /** Quantas partículas estão vivas agora. Só para o HUD de performance. */
  get activeParticles(): number {
    return this.live;
  }

  dispose(): void {
    for (const burst of [...this.bursts]) this.retire(burst);
    for (const flash of this.flashes) {
      this.scene.remove(flash.light);
      flash.light.dispose();
    }
    this.flashes = [];
    for (const rocket of this.rockets) this.scene.remove(rocket.group);
    this.rockets = [];
    for (const geo of this.rocketGeo) geo.dispose();
    this.rocketGeo = [];
  }
}

/** Presente sem animação conhecida: o preço diz que espetáculo ele merece. */
function tierByPrice(coins: number): GiftTier {
  if (coins >= 5_000) return 'rocket';
  return coins >= 99 ? 'burst' : 'petal';
}
