import * as THREE from 'three';
import {
  NOIR, SCENE_AREA, SCENE_COLLIDERS, SCENE_SPAWNS, type Placement, type SceneId,
} from '@streampolis/shared';
import { LOOK_NOIR, type GradeLook } from '../Renderer.js';
import { STREET_NIGHT } from '../Environment.js';
import {
  bakeProps, box, boxUV, disposeProp, instanceProp, merge, place, singleProp, xform, type Prop,
} from '../props/Geometry.js';
import { backdropBlock, facadeBuilding } from '../props/Buildings.js';
import { lampPost, litterBin } from '../props/Urban.js';
import { neonSign } from '../props/Stage.js';
import { AmbientCrowd } from '../AmbientCrowd.js';
import { Rain } from '../fx/Rain.js';
import { SceneBase } from './GameScene.js';
import type { QualityTier } from '../QualityManager.js';

/**
 * Distrito Sombra (PRD §34, "Novos bairros").
 *
 * Uma rua de madrugada debaixo de chuva, e o oposto deliberado da praça: lá o
 * espaço é um disco aberto ao meio-dia dourado, aqui é um corredor de fachadas
 * onde a única cor que sobrevive é o vermelho dos letreiros (ver `LOOK_NOIR`).
 * O contraste entre os dois é o que faz cada um parecer um LUGAR — uma cidade
 * inteira com a mesma luz é um cenário com salas diferentes.
 *
 * ## O que sustenta a leitura noir
 *
 * Nenhum dos quatro é decoração; tirar qualquer um derruba a imagem:
 *
 *   1. **preenchimento quase zero** (`STREET_NIGHT`). O escuro precisa ser
 *      escuro de verdade, ou o néon só recolore uma parede que já se via;
 *   2. **as luzes são os letreiros**, luzes pontuais coloridas de alcance
 *      curto. Elas fazem os poços de cor e as sombras duras;
 *   3. **o chão é molhado** — asfalto quase espelhado somado às poças —, e é
 *      ele que dobra cada letreiro numa mancha comprida;
 *   4. **a chuva** (`fx/Rain.ts`), que corta a luz e dá matéria ao ar.
 *
 * ## O orçamento de luz é o que limita a cena
 *
 * Cada luz pontual entra no laço do shader de TODO material que a recebe: dez
 * letreiros com luz própria custam mais que dez letreiros. Por isso o número
 * de luzes vem do tier e os letreiros que não ganham uma continuam acesos —
 * geometria emissiva não custa luz nenhuma, e para um letreiro no fundo da rua
 * é a diferença que ninguém vê.
 */
export class NoirDistrictScene extends SceneBase {
  readonly id: SceneId = 'noir_district';
  readonly look: GradeLook = LOOK_NOIR;
  /**
   * O corredor tem 18 m de largura e as fachadas chegam a 11 andares: com o
   * braço de 9 m da praça a câmera atravessa a fileira e mostra os fundos dos
   * prédios. Seis metros mantêm o olho dentro da rua, que é onde está a cena.
   */
  override readonly maxBoom = 6.4;

  private crowd: AmbientCrowd | null = null;
  private rain: Rain | null = null;
  /** Carimbos usados só como fonte de instanciação; liberados após o build. */
  private stamps: Prop[] = [];
  /** O tremeluzir dos letreiros — ver `update`. */
  private flickers: Array<{ light: THREE.PointLight; base: number; phase: number; rate: number }> = [];

  async build(_renderer: THREE.WebGLRenderer, tier: QualityTier = 'high'): Promise<void> {
    this.makeInterior(_renderer, STREET_NIGHT);

    // A colisão não é autorada aqui: é a tabela do servidor, lida de volta.
    this.bounds = SCENE_AREA.noir_district ?? null;
    this.colliders = [...SCENE_COLLIDERS.noir_district];

    this.buildGround();
    this.buildFacades();
    this.buildSkyline();
    this.buildStreetFurniture();
    this.buildSigns(tier);
    this.buildAlley();
    this.buildRain(tier);

    for (const s of SCENE_SPAWNS.noir_district) {
      this.spawnPoints.push(new THREE.Vector3(s.x, 0, s.z));
    }

    this.registerMaterials();

    for (const stamp of this.stamps) disposeProp(stamp);
    this.stamps = [];
  }

  override populate(budget: number): void {
    if (budget <= 0 || this.crowd) return;
    // Metade do orçamento da praça: uma rua de madrugada cheia de gente lê como
    // calçadão de domingo, e o que se quer aqui é o contrário.
    this.crowd = new AmbientCrowd(this.scene, NOIR.crowd, Math.max(1, Math.floor(budget / 2)));
    this.own(this.crowd);
  }

  private scatter(stamp: Prop, spots: readonly Placement[], y = 0): void {
    if (spots.length === 0) return;
    const at = spots.map((p) => xform(p.x, y, p.z, p.ry, p.s ?? 1));
    for (const mesh of instanceProp(stamp, at)) this.add(mesh);
    this.stamps.push(stamp);
  }

  /**
   * O chão: asfalto molhado, calçadas e poças.
   *
   * O asfalto é quase um espelho de propósito (`roughness` baixíssimo com
   * metalness alto). Não é realismo — asfalto de verdade não é espelho —, é o
   * que faz o letreiro existir DUAS vezes no quadro. Um chão fosco apaga
   * metade da cena, e é a metade que se olha.
   */
  private buildGround(): void {
    const b = NOIR.bounds;

    const asphalt = new THREE.MeshStandardMaterial({
      color: 0x0e1014, roughness: 0.14, metalness: 0.62, envMapIntensity: 1.2,
    });
    this.own(asphalt);
    const street = new THREE.PlaneGeometry(b.hw * 2 + 20, b.hd * 2 + 20);
    boxUV(street, 6);
    const road = new THREE.Mesh(street, asphalt);
    road.rotation.x = -Math.PI / 2;
    road.position.set(b.x, 0, b.z);
    road.receiveShadow = true;
    this.add(road);

    // Calçadas: duas faixas elevadas encostadas nas fachadas. São DESENHO —
    // o meio-fio não entra na colisão, porque um degrau de 15 cm que barra o
    // passo numa rua plana é uma parede invisível.
    const kerb = this.mats.concrete('#4a4d55');
    for (const side of [-1, 1] as const) {
      const walk = box(b.hw * 2, 0.15, 3.2);
      boxUV(walk, 1.4);
      const mesh = new THREE.Mesh(walk, kerb);
      mesh.position.set(b.x, 0.075, side * (NOIR.streetHalf - 1.6));
      mesh.receiveShadow = true;
      this.add(mesh);
    }

    // Faixa central desbotada: o eixo é o que diz ao olho que isto é uma rua.
    const paint = new THREE.MeshStandardMaterial({
      color: 0x8d8672, roughness: 0.7, metalness: 0.0,
    });
    this.own(paint);
    const dashes: THREE.BufferGeometry[] = [];
    for (let x = -32; x <= 32; x += 5.4) dashes.push(place(box(2.6, 0.01, 0.16), x, 0.012, 0));
    this.add(new THREE.Mesh(merge(dashes), paint));

    // Poças. Água parada é o segundo espelho da cena, e o mais convincente:
    // ela é irregular, então o reflexo dela quebra onde o asfalto não quebra.
    const puddle = new THREE.MeshStandardMaterial({
      color: 0x0a0d12, roughness: 0.03, metalness: 0.9,
      envMapIntensity: 1.8, transparent: true, opacity: 0.9,
    });
    this.own(puddle);
    const pools: THREE.BufferGeometry[] = [];
    for (const p of NOIR.puddles) {
      const disc = new THREE.CircleGeometry((p.s ?? 2) * 0.5, 14);
      disc.rotateX(-Math.PI / 2);
      // Achatada num eixo: uma poça redonda lê como tampa de bueiro.
      disc.scale(1, 1, 0.62);
      disc.rotateY(p.ry);
      disc.translate(p.x, 0.016, p.z);
      pools.push(disc);
    }
    this.add(new THREE.Mesh(merge(pools), puddle));
  }

  /**
   * As duas fileiras.
   *
   * Assadas num prop só por material: dez fachadas únicas não ganham nada com
   * instanciação (não há duas iguais), mas assar junta as dez em um punhado de
   * chamadas de desenho — a mesma conta do anel da praça.
   */
  private buildFacades(): void {
    /**
     * Tons NEUTROS, e isso é regra e não gosto.
     *
     * Os primeiros eram marrons quentes ('#443c36' e parentes). Numa cena que
     * preserva o vermelho por MATIZ, um tijolo alaranjado é indistinguível de
     * um letreiro para o filtro — e a fachada inteira sobrevivia ao preto e
     * branco. O critério de saturação do `GradeShader` fecha essa porta; estas
     * cores fecham a mesma porta do outro lado, que é onde ela é barata.
     */
    const tints = ['#3a3c40', '#33383f', '#3c3e42', '#2f343a', '#353a40'];
    const items: Array<{ prop: Prop; matrix: THREE.Matrix4 }> = [];
    const stamps: Prop[] = [];

    for (const [i, b] of [...NOIR.facades, NOIR.alleyEnd].entries()) {
      const prop = facadeBuilding(this.mats, {
        width: b.width,
        depth: b.depth,
        floors: b.floors,
        style: b.style,
        seed: b.seed,
        // Janela acesa é a terceira fonte de luz do quadro, e a que diz que a
        // cidade está habitada: sem elas o corredor é um desfiladeiro de pedra.
        signColor: i % 3 === 0 ? 0xff2d55 : 0xffb03c,
        wallTint: tints[i % tints.length],
      });
      stamps.push(prop);
      items.push({ prop, matrix: xform(b.x, 0, b.z, b.ry) });
    }

    const baked = bakeProps(items);
    this.add(singleProp(baked));
    for (const s of stamps) disposeProp(s);
    this.stamps.push(baked);
  }

  /** A cidade atrás das fileiras: volume e névoa, sem colisão nenhuma. */
  private buildSkyline(): void {
    const far = NOIR.skyline.map((b) => ({
      prop: backdropBlock(this.mats, b.width, b.floors, b.depth, b.seed),
      matrix: xform(b.x, 0, b.z, b.ry),
    }));
    const baked = bakeProps(far);
    this.add(singleProp(baked));
    for (const b of far) disposeProp(b.prop);
    this.stamps.push(baked);
  }

  private buildStreetFurniture(): void {
    this.scatter(lampPost(this.mats, 5.2), NOIR.lamps);
    this.scatter(litterBin(this.mats), NOIR.bins);

    /**
     * O poço de luz de cada poste: um disco aditivo no chão.
     *
     * Vale para os DEZ, e é o que sustenta a leitura da rua de longe. Luz de
     * verdade só os alternados ganham (ver abaixo): dez luzes pontuais somadas
     * aos letreiros estouram o laço de luzes de todo material da cena, e a
     * mancha molhada — que é o que o olho lê num poste — o disco já dá.
     */
    const pool = new THREE.MeshBasicMaterial({
      // Fraco: os postes alternados ganharam luz de VERDADE logo abaixo, e o
      // disco somado a ela estourava num borrão branco no chão.
      color: 0x2a3550, transparent: true, opacity: 0.2,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.own(pool);
    const discs: THREE.BufferGeometry[] = [];
    for (const l of NOIR.lamps) {
      const d = new THREE.CircleGeometry(3.1, 20);
      d.rotateX(-Math.PI / 2);
      d.translate(l.x, 0.02, l.z);
      discs.push(d);
    }
    const glow = new THREE.Mesh(merge(discs), pool);
    glow.renderOrder = 1;
    this.add(glow);

    /**
     * E luz DE VERDADE em postes alternados.
     *
     * Sem ela a avenida é uniforme, e uniforme é o contrário do alvo: o que se
     * quer é o jogador atravessando poços de luz e sumindo entre eles. Também é
     * o que torna um avatar de roupa escura legível — ele aparece quando entra
     * num poço, e vira silhueta quando sai, que é a leitura certa aqui.
     *
     * Branco-frio, nunca sódio. Um poste alaranjado teria matiz vizinha à do
     * néon e atravessaria a janela de cor do `LOOK_NOIR` — e aí o vermelho
     * deixaria de ser o acento da cena para virar a cor da rua.
     */
    for (const [i, l] of NOIR.lamps.entries()) {
      if (i % 2 !== 0) continue;
      const light = new THREE.PointLight(0xbcd0ff, 26, 18, 2);
      light.position.set(l.x, 4.9, l.z);
      this.add(light);
    }
  }

  /**
   * Os letreiros — e as luzes que só alguns deles ganham.
   *
   * A ordem da lista é a ordem de prioridade: os primeiros são os da avenida
   * que se veem de quem chega. Quem fica de fora do orçamento continua ACESO,
   * porque a geometria é emissiva; o que ele perde é iluminar o que está à
   * volta, e para um letreiro no fundo da rua isso não aparece.
   */
  private buildSigns(tier: QualityTier): void {
    const orcamento = tier === 'high' ? 5 : tier === 'medium' ? 3 : 0;

    for (const [i, s] of NOIR.signs.entries()) {
      const prop = neonSign(this.mats, s.tint, s.w, s.h);
      const mesh = singleProp(prop);
      mesh.position.set(s.x, s.y, s.z);
      mesh.rotation.y = s.ry;
      this.add(mesh);
      this.stamps.push(prop);

      if (i >= orcamento) continue;
      /**
       * Alcance curto, intensidade baixa e afastada da parede.
       *
       * A primeira versão tinha 26 de intensidade a 15 m e produziu o defeito
       * que se via de longe: a fachada inteira virava um plano VERMELHO
       * chapado. E como o `LOOK_NOIR` preserva o vermelho, o preto e branco
       * ficava com uma parede de vinte metros de cor no meio — o contrário de
       * um acento. Néon acende o pedaço de parede ao lado dele, não o
       * quarteirão; o resto do vermelho na cena tem de vir do próprio letreiro,
       * que é emissivo e não depende de luz nenhuma.
       */
      const light = new THREE.PointLight(s.tint, 6, 9.5, 2);
      light.position.set(
        s.x + Math.sin(s.ry) * 2.9,
        s.y - 0.3,
        s.z + Math.cos(s.ry) * 2.9,
      );
      this.add(light);
      this.flickers.push({
        light, base: light.intensity,
        phase: i * 1.7, rate: 1.4 + (i % 3) * 0.6,
      });
    }
  }

  /**
   * O beco: contêineres, o tambor aceso e a escada de incêndio.
   *
   * O tambor é a única luz QUENTE da cena, e é ele que faz o beco ser um lugar
   * onde alguém está em vez de um corredor fechado. Ele também é o argumento
   * do vermelho preservado pelo `LOOK_NOIR`: fogo e néon são a mesma cor no
   * quadro, e é por isso que a janela de matiz é uma só.
   */
  private buildAlley(): void {
    const metal = this.mats.metal('#2b2f36', 0.5, 0.75);
    const dumpsters: THREE.BufferGeometry[] = [];
    for (const d of NOIR.dumpsters) {
      const body = merge([
        place(box(2.0, 1.15, 1.24), 0, 0.58, 0),
        place(box(2.06, 0.08, 1.3), 0, 1.2, 0),
        place(box(0.1, 0.36, 0.1), -0.8, 1.34, 0),
        place(box(0.1, 0.36, 0.1), 0.8, 1.34, 0),
      ]);
      boxUV(body, 0.7);
      body.rotateY(d.ry);
      body.translate(d.x, 0, d.z);
      dumpsters.push(body);
    }
    const bins = new THREE.Mesh(merge(dumpsters), metal);
    bins.castShadow = true;
    bins.receiveShadow = true;
    this.add(bins);

    // O tambor.
    const barrel = merge([
      place(box(0.62, 0.9, 0.62), 0, 0.45, 0),
    ]);
    boxUV(barrel, 0.4);
    barrel.translate(NOIR.barrel.x, 0, NOIR.barrel.z);
    const drum = new THREE.Mesh(barrel, this.mats.metal('#3a2a22', 0.72, 0.5));
    drum.castShadow = true;
    this.add(drum);

    const fire = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 10, 8),
      this.mats.emissive(0xff7326, 6.0),
    );
    fire.position.set(NOIR.barrel.x, 1.02, NOIR.barrel.z);
    this.add(fire);

    const fireLight = new THREE.PointLight(0xff7326, 18, 11, 2);
    fireLight.position.set(NOIR.barrel.x, 1.15, NOIR.barrel.z);
    this.add(fireLight);
    this.flickers.push({ light: fireLight, base: 18, phase: 0.4, rate: 5.2 });

    // Escada de incêndio na parede leste do beco: em Sin City o beco é sempre
    // vertical, e o zigue-zague de ferro é o que dá altura a ele.
    const rails: THREE.BufferGeometry[] = [];
    const wall = NOIR.alley.x1 - 0.12;
    for (let floor = 0; floor < 4; floor++) {
      const y = 3.2 + floor * 2.8;
      rails.push(place(box(0.06, 0.06, 2.6), wall, y, -14));
      rails.push(place(box(1.5, 0.08, 2.6), wall - 0.75, y - 0.06, -14));
      for (let r = 0; r < 5; r++) {
        rails.push(place(box(0.05, 1.0, 0.05), wall - 0.1, y + 0.5, -15.2 + r * 0.6));
      }
      // O lance inclinado até o patamar de baixo.
      rails.push(place(box(0.06, 3.0, 0.06), wall - 0.6, y - 1.4, -12.6, 0.62, 0, 0));
    }
    const escape = new THREE.Mesh(merge(rails), metal);
    escape.castShadow = true;
    this.add(escape);
  }

  /**
   * A chuva, com o número de gotas que o tier permite.
   *
   * No tier baixo ela sai INTEIRA em vez de ficar rala. Meia dúzia de riscos
   * não lê como chuva — lê como sujeira na tela —, e a rua molhada continua
   * molhada sem ela: quem faz o chão brilhar é o material, não a gota.
   */
  private buildRain(tier: QualityTier): void {
    const gotas = tier === 'high' ? 3000 : tier === 'medium' ? 1400 : 0;
    if (gotas === 0) return;
    this.rain = new Rain({ count: gotas, box: [26, 18, 26] });
    this.add(this.rain.mesh);
    this.own(this.rain);
  }

  /**
   * O tremeluzir.
   *
   * Ruído somado de dois senos de frequências que não são múltiplas: o
   * resultado não se repete a olho nu, e não custa nem um `Math.random` por
   * quadro. Um letreiro de intensidade constante é a coisa que faz uma rua
   * noturna parecer uma maquete — o que se lembra de um néon é ele oscilando.
   */
  override update(dt: number, camera: THREE.Camera): void {
    super.update(dt, camera);
    this.crowd?.update(dt);
    this.rain?.update(dt, camera);
    for (const f of this.flickers) {
      const t = this.elapsed * f.rate + f.phase;
      const ruido = Math.sin(t) * 0.5 + Math.sin(t * 2.37 + 1.1) * 0.32;
      f.light.intensity = f.base * (0.82 + ruido * 0.18);
    }
  }
}
