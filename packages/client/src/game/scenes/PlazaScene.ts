import * as THREE from 'three';
import {
  PLAZA, SCENE_AREA, SCENE_COLLIDERS, SCENE_SPAWNS, type Placement, type SceneId,
} from '@streampolis/shared';
import { LOOK_DAY, type GradeLook } from '../Renderer.js';
import type { Weather } from '@streampolis/shared';
import { GOLDEN_HOUR, type Environment } from '../Environment.js';
import {
  bakeProps, boxUV, disposeProp, instanceProp, ringSlab, singleProp, xform, type Prop,
} from '../props/Geometry.js';
import { backdropBlock, cityBlock, facadeBuilding } from '../props/Buildings.js';
import { TELAO_SRC, VideoWall } from '../props/Screen.js';
import {
  awning, banner, bench, bollard, flowerBush, fountain, kiosk, lampPost, litterBin, palm, planter, shrub, stairRing, tree,
} from '../props/Urban.js';
import { AmbientCrowd } from '../AmbientCrowd.js';
import { Rain } from '../fx/Rain.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { AssetLibrary } from '../assets/AssetLibrary.js';
import { assetManager } from '../assets/loading.js';
import { assetPassEnabled } from '../assets/pass.js';
import { SceneBase } from './GameScene.js';
import type { QualityTier } from '../QualityManager.js';

/**
 * Central Plaza (PRD §6): the square everyone lands in.
 *
 * Every position comes from `PLAZA` in the shared package, which is also what
 * the server's collision table is built from. That is the point: geometry and
 * collision cannot drift, because there is only one set of coordinates.
 *
 * Composition is deliberate rather than scattered — stairs and a fountain
 * anchor the middle, a tree line closes the space at the edge, and perimeter
 * blocks give the horizon something to sit against. Repeated props are
 * instanced and unique ones are baked per material (SPECs §7).
 */
export class PlazaScene extends SceneBase {
  readonly id: SceneId = 'central_plaza';
  /**
   * Daylight, pulled down most of a stop. A plaza is mostly pale stone: at the
   * neutral exposure the pavement clips to white and every material in frame
   * loses its texture at once.
   */
  readonly look: GradeLook = assetPassEnabled()
    // Menos preenchimento e mais contraste. A crítica de "céu e iluminação
    // lavados" não era do céu: era exposição alta somada a ambiente alto, que
    // juntos apagam a sombra de contato de cada degrau e meio-fio e tiram a
    // profundidade da imagem inteira.
    ? { ...LOOK_DAY, exposure: 0.54, contrast: 1.16, vignette: 0.42, saturation: 1.02 }
    : { ...LOOK_DAY, exposure: 0.58, contrast: 1.08, vignette: 0.34 };

  private wall: VideoWall | null = null;
  /** Stamps used only as instancing sources; freed once the scene is built. */
  private stamps: Prop[] = [];
  private crowd: AmbientCrowd | null = null;
  /** Modelos que passaram pelo passe; nulo quando a praça roda procedural. */
  private lib: AssetLibrary | null = null;
  /** O rig de luz, tipado: é nele que a hora do mundo mexe a cada quadro. */
  private sky: Environment | null = null;
  private lampGlass: THREE.MeshStandardMaterial | null = null;
  private lampLights: THREE.PointLight[] = [];
  private lampPick = 0;
  private lastTod = -1;
  private lastRebakeAt = 0;
  private lastRebakeTod = -1;
  private rain: Rain | null = null;
  private lastRainLevel = -1;

  private tier: QualityTier = 'high';

  async build(renderer: THREE.WebGLRenderer, tier: QualityTier = 'high'): Promise<void> {
    this.tier = tier;
    // No tier baixo a praça continua procedural. Dez copas modeladas dobram a
    // contagem de triângulos da cena, e onde o governador já cortou figurante
    // e sombra a resposta certa não é uma praça bonita a 12 fps.
    if (assetPassEnabled() && tier !== 'low') {
      this.lib = await AssetLibrary.load(
        tier === 'high' ? ['tree', 'bush', 'rock', 'building'] : ['tree', 'bush'],
      );
      if (!this.lib.has('tree')) this.lib = null;
      else this.own(this.lib);
    }

    const env = this.sky = this.makeEnvironment(renderer, {
      ...GOLDEN_HOUR,
      elevation: 27, azimuth: 138,
      // Less fill than the default: the sun has to be able to carve a shadow,
      // and ambient at 0.55 flattens every kerb and step in the scene.
      ...(this.lib
        // Sol mais duro, preenchimento mais baixo e névoa que começa antes: a
        // perspectiva aérea é o que faz o anel de prédios recuar em vez de
        // ficar colado no mesmo plano da praça.
        ? { ambientIntensity: 0.26, envIntensity: 0.56, sunIntensity: 3.3, fogNear: 40, fogFar: 200 }
        : { ambientIntensity: 0.34, envIntensity: 0.78, sunIntensity: 3.0, fogNear: 55, fogFar: 260 }),
    });

    // O IBL medido entra depois do rig existir, e a falha dele é silenciosa:
    // sem HDRI a praça acende com o céu procedural, que é pior e não quebrado.
    if (this.lib) {
      await new RGBELoader(assetManager)
        .loadAsync(new URL('assets/env/kloofendal_48d_partly_cloudy_puresky.hdr', document.baseURI).href)
        .then((tex) => env.useHdri(tex))
        .catch((err) => console.warn('[assets] HDRI não carregou:', err));
    }

    // Collision is not authored here — it is the server's table, read back.
    this.bounds = SCENE_AREA.central_plaza ?? null;
    this.colliders = [...SCENE_COLLIDERS.central_plaza];

    this.buildGround();
    this.buildCentre();
    this.buildFurniture();
    this.buildGreenery();
    this.buildPerimeter();
    this.buildOutskirts();
    this.buildScreen();
    // Começa seca: é o estado da sala que liga a chuva (`setWeather`).
    this.rain = new Rain({ count: this.tier === 'low' ? 900 : 2000, box: [30, 18, 30], opacity: 0.4, intensity: 0 });
    this.scene.add(this.rain.mesh);
    this.own(this.rain);

    // The spawn markers ARE the server's: shared table, one ring, no drift. A
    // client that predicts from a different spawn than the server assigned
    // starts life with a snap.
    for (const s of SCENE_SPAWNS.central_plaza) {
      this.spawnPoints.push(new THREE.Vector3(s.x, 0, s.z));
    }

    this.registerMaterials();
    // Material importado também entra na sombra em cascata; sem isto a árvore
    // do passe é a única coisa na praça que não projeta sombra, e nada denuncia
    // um asset colado mais rápido do que isso.
    for (const mat of this.lib?.materials() ?? []) env.registerMaterial(mat);
    env.frameShadows(new THREE.Vector3(0, 0, 0), 26);

    for (const stamp of this.stamps) disposeProp(stamp);
    this.stamps = [];
  }

  /**
   * Figurantes. Chamado pelo World DEPOIS do build, porque quantos cabem é
   * decisão do governador de qualidade e não da cena: num tier baixo o certo é
   * nenhum, e não uma praça cheia a 12 fps.
   */
  override populate(budget: number): void {
    if (budget <= 0 || this.crowd) return;
    this.crowd = new AmbientCrowd(this.scene, PLAZA.crowd, budget);
    this.own(this.crowd);
  }

  limitCrowd(count: number): void {
    this.crowd?.limit(count);
  }

  /** Instances one prop family at the placements the layout dictates. */
  private scatter(stamp: Prop, spots: readonly Placement[], y = 0): void {
    if (spots.length === 0) return;
    const at = spots.map((p) => xform(p.x, y, p.z, p.ry, p.s ?? 1));
    for (const mesh of instanceProp(stamp, at)) this.add(mesh);
    this.stamps.push(stamp);
  }

  private buildGround(): void {
    // Two discs instead of one: the pavement reads as a designed square and the
    // asphalt beyond it keeps the horizon from ending in void under the fog.
    // O asfalto tem de chegar mais longe do que o horizonte construído, ou os
    // últimos quarteirões ficam pousados no vazio.
    const outer = new THREE.CircleGeometry(300, 10);
    const asphalt = new THREE.Mesh(outer, this.mats.asphalt());
    asphalt.rotation.x = -Math.PI / 2;
    asphalt.position.y = -0.04;
    asphalt.receiveShadow = true;
    this.add(asphalt);

    const paving = new THREE.CircleGeometry(PLAZA.radius + 2.5, 96);
    // Ladrilho maior e junta mais fraca. A crítica de que "o piso quadriculado
    // domina a imagem" era literal: a 1,6 m por ladrilho a grade ocupava
    // metade do quadro e tinha mais contraste que qualquer coisa em pé nela.
    // O chão é o fundo, não o assunto.
    boxUV(paving, this.lib ? 4.0 : 1.6);
    const floor = new THREE.Mesh(paving, this.lib
      ? this.mats.paving('#ada596', '#a69e91', 0.26)
      : this.mats.paving('#b3a189', '#7d6a54'));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.add(floor);

    // Caminhos radiais: uma faixa de pedra mais clara do adro até a borda,
    // apontando para as portas. Custam seis quads e são o que impede o
    // calçamento novo de ler como um pátio — e são desenho, não colisão:
    // atravessar um caminho a pé tem de ser possível.
    const pathMat = this.mats.paving('#c3bbac', '#8f8778', 0.2);
    const pathLen = PLAZA.radius + 2.5 - PLAZA.apron;
    for (const angle of PLAZA.paths) {
      const strip = new THREE.PlaneGeometry(3.4, pathLen);
      boxUV(strip, this.lib ? 4.0 : 1.6);
      const mesh = new THREE.Mesh(strip, pathMat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.rotation.z = -angle;
      mesh.position.set(
        Math.cos(angle) * (PLAZA.apron + pathLen / 2),
        0.012,
        Math.sin(angle) * (PLAZA.apron + pathLen / 2),
      );
      mesh.receiveShadow = true;
      this.add(mesh);
    }

    // E a RUA, saindo pela boca aberta no anel de fachadas: o caminho de pedra
    // vira asfalto na borda da praça e segue por entre os quarteirões. Sem
    // ela, a fatia vazia do anel é um buraco na fileira; com ela, é uma rua —
    // e é a rua que faz a cidade continuar em vez de acabar.
    const streetMat = this.mats.asphalt();
    for (const angle of PLAZA.streets) {
      const len = 58;
      const strip = new THREE.PlaneGeometry(10, len);
      boxUV(strip, 6);
      const mesh = new THREE.Mesh(strip, streetMat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.rotation.z = -angle;
      const mid = PLAZA.radius + 2.5 + len / 2;
      mesh.position.set(Math.cos(angle) * mid, 0.008, Math.sin(angle) * mid);
      mesh.receiveShadow = true;
      this.add(mesh);
    }

    // Inner apron. Kept close in value to the pavement and finished with a
    // stone kerb: a disc that contrasts reads as a stain on the ground, not as
    // a change of paving.
    const inner = new THREE.CircleGeometry(PLAZA.apron, 72);
    boxUV(inner, this.lib ? 2.1 : 1.05);
    // Rosácea em terracota: o miolo da praça é o ponto quente do chão.
    const rosette = new THREE.Mesh(inner, this.lib
      ? this.mats.paving('#ab9179', '#a58b74', 0.4)
      : this.mats.paving('#bf8a63', '#8a5f45'));
    rosette.rotation.x = -Math.PI / 2;
    rosette.position.y = 0.012;
    rosette.receiveShadow = true;
    this.add(rosette);

    const kerb = ringSlab(PLAZA.apron, PLAZA.apron + 0.36, 0.06, 96);
    boxUV(kerb, 0.8);
    const kerbMesh = new THREE.Mesh(kerb, this.mats.concrete('#a3937f'));
    kerbMesh.receiveShadow = true;
    kerbMesh.castShadow = true;
    this.add(kerbMesh);
  }

  private buildCentre(): void {
    const steps = stairRing(this.mats, PLAZA.stairInner, PLAZA.stairSteps);
    this.add(singleProp(steps));
    this.stamps.push(steps);

    const water = fountain(this.mats, PLAZA.fountainRadius);
    const basin = singleProp(water);
    basin.position.y = PLAZA.stairSteps * 0.15;
    this.add(basin);
    this.stamps.push(water);
  }

  private buildFurniture(): void {
    this.scatter(bench(this.mats), PLAZA.benches);
    this.scatter(lampPost(this.mats, 4.6), PLAZA.lamps);
    // O vidro da luminária é UM material partilhado (a MatLib guarda por
    // chave): a hora do mundo o acende e apaga por aqui.
    this.lampGlass = this.mats.emissive(0xffd9a0, 3.2) as THREE.MeshStandardMaterial;
    // Luz de verdade só em alguns postes — os mais perto da câmera, escolhidos
    // de tempos em tempos (ver `setTimeOfDay`). Doze luzes pontuais na praça
    // inteira seriam o custo de sombra que o tier baixo não paga.
    const budget = this.tier === 'high' ? 8 : this.tier === 'medium' ? 5 : 3;
    for (let i = 0; i < budget; i++) {
      const light = new THREE.PointLight(0xffd9a0, 0, 22, 2);
      light.position.set(PLAZA.lamps[i % PLAZA.lamps.length]!.x, 4.6, PLAZA.lamps[i % PLAZA.lamps.length]!.z);
      this.scene.add(light);
      this.lampLights.push(light);
    }
    this.scatter(bollard(this.mats), PLAZA.bollards);
    this.scatter(litterBin(this.mats), PLAZA.bins);
    this.scatter(planter(this.mats, 1.6, 1.6, 0.55), PLAZA.planters);
    // Bandeiras em três cores, não uma: uma praça inteira do mesmo azul lê
    // como decoração de estoque.
    const flags = ['#c2542f', '#2f6fb8', '#c89a3c'];
    flags.forEach((tint, i) => {
      this.scatter(
        banner(this.mats, 0.62, 1.9, tint),
        PLAZA.banners.filter((_, j) => j % flags.length === i),
        3.0,
      );
    });

    const first = PLAZA.kiosks[0];
    this.scatter(
      kiosk(this.mats, first.width, first.depth),
      PLAZA.kiosks.map((k) => ({ x: k.x, z: k.z, ry: k.ry })),
    );
    // Toldo em cada quiosque: pano na altura da cabeça é o que transforma
    // uma fileira de fachadas em rua.
    this.scatter(
      awning(this.mats, first.width * 0.92, 1.0, 0xc2542f),
      PLAZA.kiosks.map((k) => ({
        x: k.x + Math.sin(k.ry) * (first.depth / 2),
        z: k.z + Math.cos(k.ry) * (first.depth / 2),
        ry: k.ry,
      })),
      2.35,
    );
  }

  private buildGreenery(): void {
    if (this.lib?.has('tree')) { this.buildGreeneryFromAssets(); return; }
    // One instanced draw per canopy variant: three calls for thirty trees.
    // Variant 2 is a palm — three identical round canopies was a skyline of
    // lollipops however good the light was.
    for (let variant = 0; variant < 3; variant++) {
      const spots = PLAZA.trees.filter((t) => t.variant === variant);
      if (!spots.length) continue;
      this.scatter(variant === 2 ? palm(this.mats, variant) : tree(this.mats, variant), spots);
    }
    // Half the shrubs are in bloom. The flowers are the only saturated thing
    // in the greenery, and they are what the eye reads as "somebody tends it".
    this.scatter(shrub(this.mats, 0.6), PLAZA.shrubs.filter((_, i) => i % 2 === 0));
    this.scatter(flowerBush(this.mats, 0.6, 0xd8567a), PLAZA.shrubs.filter((_, i) => i % 4 === 1));
    this.scatter(flowerBush(this.mats, 0.55, 0xe8b23c), PLAZA.shrubs.filter((_, i) => i % 4 === 3));
  }

  /**
   * A mesma vegetação, com os modelos do passe.
   *
   * As POSIÇÕES não mudam — são as de `shared/layout.ts`, as mesmas que o
   * servidor conhece. O que muda é o que cresce nelas: dez copas em vez de
   * três, dez arbustos em vez de dois, e escala variando de verdade. A queixa
   * era "volumosa e repetitiva", e a repetição é metade dela: três carimbos
   * girados trinta vezes continuam sendo três carimbos, por melhor que cada um
   * seja.
   */
  private buildGreeneryFromAssets(): void {
    const lib = this.lib!;
    const bucket = new Map<string, Placement[]>();
    const put = (family: string, id: string, p: Placement) => {
      const key = `${family}/${id}`;
      const list = bucket.get(key);
      if (list) list.push(p); else bucket.set(key, [p]);
    };

    const trees = lib.bag('tree');
    PLAZA.trees.forEach((t, i) => {
      // Um índice que anda em passo primo com o tamanho da lista: vizinhos
      // nunca caem na mesma variante, e o anel não vira um padrão.
      const id = trees[(i * 7) % trees.length];
      // A escala já vem da altura declarada na curadoria; o que sobra aqui é
      // a variação, e ela precisa ser ampla. Um bosque em que toda árvore tem
      // a mesma altura lê como papel de parede.
      put('tree', id, { ...t, s: (t.s ?? 1) * (0.82 + ((i * 11) % 9) * 0.048) });
    });

    const bushes = lib.bag('bush');
    PLAZA.shrubs.forEach((b, i) => {
      put('bush', bushes[(i * 5) % bushes.length], { ...b, s: (b.s ?? 1) * (0.85 + ((i * 7) % 7) * 0.06) });
    });

    // Pedras nas frestas entre os arbustos: nada diz "isto é um lugar" como
    // uma coisa que ninguém colocou de propósito.
    const rocks = lib.bag('rock');
    if (rocks.length) {
      PLAZA.shrubs.forEach((b, i) => {
        if (i % 3) return;
        const a = Math.atan2(b.z, b.x) + 0.09;
        const r = Math.hypot(b.x, b.z) + 1.4;
        put('rock', rocks[(i * 3) % rocks.length], {
          x: Math.cos(a) * r, z: Math.sin(a) * r, ry: (i * 2.1) % (Math.PI * 2), s: 0.7 + ((i * 5) % 6) * 0.15,
        });
      });
    }

    for (const [key, spots] of bucket) {
      const [family, id] = key.split('/');
      const prop = lib.prop(family, id);
      if (!prop) continue;
      for (const mesh of instanceProp(prop, spots.map((p) => xform(p.x, 0, p.z, p.ry, p.s ?? 1)))) {
        this.add(mesh);
      }
    }
  }

  /**
   * Perimeter blocks. Every façade is unique, so instancing would not help —
   * baking them per material turns fourteen buildings into a handful of calls.
   */
  private buildPerimeter(): void {
    const items: Array<{ prop: Prop; matrix: THREE.Matrix4 }> = [];
    const stamps: Prop[] = [];
    const signs = [0xff3d7f, 0x2f7bff, 0xffcc33, 0x39d98a];
    // Fachadas em família quente, ainda dessaturadas: a saturação alta é
    // reservada ao que é interativo (LED, presente, PK, AO VIVO).
    const tints = ['#c9a184', '#d8bc94', '#b4a894', '#a8b3a2', '#c98f70', '#bcae9c'];

    // Cinco das catorze passam a ser modelos do passe. Cinco e não catorze de
    // propósito: é a experiência que o dono pediu, e é ela que responde se o
    // ganho vale o pipeline antes de a cidade inteira depender dele. As fatias
    // trocadas ficam espalhadas pelo anel, senão metade do horizonte muda e a
    // outra metade não, e a comparação vira uma emenda visível.
    const modelled = this.lib?.ids('building') ?? [];
    PLAZA.buildings.forEach((b, i) => {
      if (modelled.length && i % 3 === 0) {
        const id = modelled[(i / 3) % modelled.length];
        const prop = this.lib!.prop('building', id)!;
        const item = this.lib!.item('building', id);
        // Encaixado na largura da fatia, não na altura: catorze prédios num
        // anel de 38 m têm 17 m de arco cada, e um modelo mais largo que isso
        // atravessa o vizinho.
        const fit = item ? Math.min(1, (b.width * 1.5) / item.size[0]) : 1;
        items.push({ prop, matrix: xform(b.x, 0, b.z, b.ry + Math.PI, fit) });
        return;
      }
      const prop = facadeBuilding(this.mats, {
        width: b.width,
        depth: b.depth,
        floors: b.floors,
        style: b.style,
        seed: b.seed,
        signColor: signs[i % signs.length],
        wallTint: tints[i % tints.length],
      });
      stamps.push(prop);
      items.push({ prop, matrix: xform(b.x, 0, b.z, b.ry) });
    });

    const baked = bakeProps(items);
    this.add(singleProp(baked));
    for (const s of stamps) disposeProp(s);
    this.stamps.push(baked);
  }

  /**
   * A cidade além do anel: bairros pelos vãos e horizonte ao fundo.
   *
   * Assada em UM prop por camada. São sessenta e oito volumes a mais e menos de
   * dez chamadas de desenho, porque o que custa numa cidade de fundo não é o
   * número de prédios — é o número de materiais.
   */
  private buildOutskirts(): void {
    const tints = ['#c9a184', '#d8bc94', '#b4a894', '#a8b3a2', '#c98f70', '#bcae9c'];
    const blocks = PLAZA.districts.map((b, i) => {
      const prop = cityBlock(this.mats, {
        width: b.width, depth: b.depth, floors: b.floors, style: b.style, seed: b.seed,
        wallTint: tints[(i * 5) % tints.length],
      });
      return { prop, matrix: xform(b.x, 0, b.z, b.ry) };
    });
    const bakedBlocks = bakeProps(blocks);
    this.add(singleProp(bakedBlocks));
    for (const b of blocks) disposeProp(b.prop);
    this.stamps.push(bakedBlocks);

    const far = PLAZA.skyline.map((b) => {
      // `floors` é altura em metros no horizonte (ver `skylineRing`).
      const prop = backdropBlock(this.mats, b.width, b.floors, b.depth, b.seed);
      return { prop, matrix: xform(b.x, 0, b.z, b.ry) };
    });
    const bakedFar = bakeProps(far);
    this.add(singleProp(bakedFar));
    for (const b of far) disposeProp(b.prop);
    this.stamps.push(bakedFar);
  }

  /**
   * The plaza's live billboard (PRD §6): the feed, visible from the ground.
   *
   * Ele toca o vídeo compartilhado do jogo (`TELAO_SRC`), o MESMO que a arena,
   * a loja, o saguão, a torre, a sala de live, o apartamento e o Distrito
   * Sombra mostram — e não uma cópia sincronizada: literalmente o mesmo
   * elemento de vídeo e a mesma textura (ver `props/Screen.ts`).
   *
   * Se o arquivo não estiver lá, o painel volta a ser a onda de LED de sempre;
   * ninguém vê um retângulo preto (ver `props/Screen.ts`).
   */
  private buildScreen(): void {
    const s = PLAZA.screen;
    const wall = new VideoWall(this.mats, {
      width: s.width, height: s.height, base: s.base, freestanding: true,
      colors: [0xff3d7f, 0x2f7bff], gain: 2.0,
      video: TELAO_SRC,
    });
    wall.group.position.set(s.x, 0, s.z);
    wall.group.rotation.y = s.ry;
    this.add(wall.group);
    this.own(wall);
    this.wall = wall;
  }

  /**
   * A praça reage à hora do mundo (shared/clock.ts): céu, sol, luz ambiente e
   * iluminação urbana, por interpolação entre quadros-chave. Só desenho.
   *
   * O céu procedural recebe o sol de verdade (abaixo do horizonte à noite); a
   * luz que projeta sombra recebe, à noite, uma "lua" noutra direção — sem
   * isso o céu ficaria claro de madrugada ou a sombra viria de baixo do chão.
   * O IBL medido (HDRI) não muda; só a intensidade dele, que é um número. Sem
   * HDRI, o rebote do céu procedural é re-assado no máximo a cada 12 s quando
   * a hora andou o bastante.
   */
  setWeather(weather: Weather): void {
    this.rain?.set(weather === 'rain');
  }

  setTimeOfDay(minutes: number, _dt: number): void {
    if (!this.sky) return;
    const rain = this.rain?.level ?? 0;
    if (Math.abs(minutes - this.lastTod) < 0.05 && Math.abs(rain - this.lastRainLevel) < 0.01) return;
    this.lastTod = minutes;
    this.lastRainLevel = rain;
    const p = timeOfDayParams(minutes);
    const withLib = this.lib !== null;
    // Chuva: céu carregado, sol coberto, névoa mais perto e mais cinza. Uma
    // mistura por intensidade — a chuva chega e vai embora em segundos.
    const grey = (c: number, k: number) => mixHex(c, 0x8a94a8, k);
    this.sky.applyLive({
      turbidity: p.turbidity + 6 * rain, rayleigh: p.rayleigh, mieCoefficient: p.mie + 0.012 * rain, mieDirectionalG: 0.82,
      elevation: p.elevation, azimuth: p.azimuth,
      lightElevation: p.lightElevation, lightAzimuth: p.lightAzimuth,
      sunIntensity: p.sunIntensity * (1 - 0.65 * rain), sunColor: grey(p.sunColor, 0.5 * rain),
      skyColor: grey(p.skyColor, 0.6 * rain), groundColor: p.groundColor,
      ambientIntensity: p.ambient * (withLib ? 0.8 : 1) * (1 - 0.1 * rain),
      fogColor: grey(p.fogColor, 0.7 * rain), fogNear: p.fogNear * (1 - 0.45 * rain), fogFar: p.fogFar * (1 - 0.4 * rain),
      envIntensity: p.env * (withLib ? 0.7 : 1) * (1 - 0.3 * rain),
    });
    if (!withLib) {
      const now = performance.now();
      if (now - this.lastRebakeAt > 12_000 && Math.abs(minutes - this.lastRebakeTod) > 20) {
        this.lastRebakeAt = now;
        this.lastRebakeTod = minutes;
        this.sky.refreshEnvironment();
      }
    }
    // Iluminação urbana: acende quando a luz do dia cai.
    if (this.lampGlass) this.lampGlass.emissiveIntensity = 0.15 + 4.5 * p.lamps;
    for (const l of this.lampLights) l.intensity = 90 * p.lamps;
  }

  /** As luzes pontuais mudam de poste para acompanhar a câmera, uma vez por segundo. */
  private relampLights(camera: THREE.Camera): void {
    if (!this.lampLights.length) return;
    const cx = camera.position.x;
    const cz = camera.position.z;
    const ranked = PLAZA.lamps
      .map((l) => ({ l, d: Math.hypot(l.x - cx, l.z - cz) }))
      .sort((a, b) => a.d - b.d);
    this.lampLights.forEach((light, i) => {
      const l = ranked[i]?.l;
      if (l) light.position.set(l.x, 4.6, l.z);
    });
  }

  override update(dt: number, camera: THREE.Camera): void {
    this.crowd?.update(dt);
    super.update(dt, camera);
    this.wall?.update(dt);
    this.rain?.update(dt, camera);
    this.lampPick += dt;
    if (this.lampPick > 1) { this.lampPick = 0; this.relampLights(camera); }
  }
}


// ---------------------------------------------------------------------------
// A hora do mundo em parâmetros de luz.
// ---------------------------------------------------------------------------
interface TodParams {
  elevation: number; azimuth: number; lightElevation: number; lightAzimuth: number;
  sunIntensity: number; sunColor: number; skyColor: number; groundColor: number; ambient: number;
  fogColor: number; fogNear: number; fogFar: number; env: number;
  turbidity: number; rayleigh: number; mie: number;
  /** Iluminação urbana, 0 (apagada) a 1 (acesa). */
  lamps: number;
}

/**
 * Quadros-chave por hora do mundo. Entre dois, interpolação linear (cores em
 * RGB linear). A noite tem o sol do céu a −12° (céu escuro) e a luz vinda de
 * uma lua a 35°, fria e fraca; o dia é a praça de sempre.
 */
const TOD_KEYS: Array<[number, TodParams]> = [
  [0, { elevation: -12, azimuth: 300, lightElevation: 35, lightAzimuth: 300, sunIntensity: 0.7, sunColor: 0xa9bcff, skyColor: 0x2e3b68, groundColor: 0x1a1928, ambient: 0.62, fogColor: 0x171d34, fogNear: 34, fogFar: 180, env: 0.38, turbidity: 2, rayleigh: 0.6, mie: 0.003, lamps: 1 }],
  [4.8, { elevation: -12, azimuth: 80, lightElevation: 35, lightAzimuth: 300, sunIntensity: 0.7, sunColor: 0xa9bcff, skyColor: 0x2e3b68, groundColor: 0x1a1928, ambient: 0.62, fogColor: 0x171d34, fogNear: 34, fogFar: 180, env: 0.38, turbidity: 2, rayleigh: 0.6, mie: 0.003, lamps: 1 }],
  [6.2, { elevation: 2, azimuth: 100, lightElevation: 6, lightAzimuth: 100, sunIntensity: 1.3, sunColor: 0xffb070, skyColor: 0x6a6f9a, groundColor: 0x3a3040, ambient: 0.32, fogColor: 0x8a7f96, fogNear: 35, fogFar: 190, env: 0.45, turbidity: 6, rayleigh: 3, mie: 0.008, lamps: 0.6 }],
  [7.8, { elevation: 14, azimuth: 115, lightElevation: 14, lightAzimuth: 115, sunIntensity: 3.0, sunColor: 0xfff0dc, skyColor: 0xbcd8ff, groundColor: 0x6b5f52, ambient: 0.34, fogColor: 0xc9d8e8, fogNear: 55, fogFar: 240, env: 0.78, turbidity: 4.2, rayleigh: 2.1, mie: 0.0055, lamps: 0 }],
  [12, { elevation: 52, azimuth: 168, lightElevation: 52, lightAzimuth: 168, sunIntensity: 3.4, sunColor: 0xfff6e8, skyColor: 0xa8ccff, groundColor: 0x7a7062, ambient: 0.32, fogColor: 0xd6e4f2, fogNear: 60, fogFar: 280, env: 0.78, turbidity: 3, rayleigh: 1.4, mie: 0.004, lamps: 0 }],
  [16.5, { elevation: 27, azimuth: 138, lightElevation: 27, lightAzimuth: 138, sunIntensity: 3.2, sunColor: 0xfff0dc, skyColor: 0xbcd8ff, groundColor: 0x6b5f52, ambient: 0.34, fogColor: 0xc9d8e8, fogNear: 55, fogFar: 260, env: 0.78, turbidity: 4.2, rayleigh: 2.1, mie: 0.0055, lamps: 0 }],
  [18.3, { elevation: 3.5, azimuth: 235, lightElevation: 5, lightAzimuth: 235, sunIntensity: 2.0, sunColor: 0xffb26b, skyColor: 0x4a5f92, groundColor: 0x2b2540, ambient: 0.4, fogColor: 0x6d6a8c, fogNear: 30, fogFar: 180, env: 0.5, turbidity: 8, rayleigh: 3.4, mie: 0.008, lamps: 0.55 }],
  [19.6, { elevation: -12, azimuth: 250, lightElevation: 35, lightAzimuth: 300, sunIntensity: 0.7, sunColor: 0xa9bcff, skyColor: 0x2e3b68, groundColor: 0x1a1928, ambient: 0.62, fogColor: 0x171d34, fogNear: 34, fogFar: 180, env: 0.38, turbidity: 2, rayleigh: 0.6, mie: 0.003, lamps: 1 }],
  [24, { elevation: -12, azimuth: 300, lightElevation: 35, lightAzimuth: 300, sunIntensity: 0.7, sunColor: 0xa9bcff, skyColor: 0x2e3b68, groundColor: 0x1a1928, ambient: 0.62, fogColor: 0x171d34, fogNear: 34, fogFar: 180, env: 0.38, turbidity: 2, rayleigh: 0.6, mie: 0.003, lamps: 1 }],
];

const cA = new THREE.Color();
const cB = new THREE.Color();
function mixHex(a: number, b: number, t: number): number {
  cA.setHex(a);
  cB.setHex(b);
  return cA.lerp(cB, t).getHex();
}

export function timeOfDayParams(minutes: number): TodParams {
  const h = (((minutes % 1440) + 1440) % 1440) / 60;
  let i = 0;
  while (i < TOD_KEYS.length - 2 && h >= TOD_KEYS[i + 1]![0]) i++;
  const [h0, a] = TOD_KEYS[i]!;
  const [h1, b] = TOD_KEYS[i + 1]!;
  const t = Math.max(0, Math.min(1, (h - h0) / (h1 - h0)));
  const n = (x: number, y: number) => x + (y - x) * t;
  return {
    elevation: n(a.elevation, b.elevation), azimuth: n(a.azimuth, b.azimuth),
    lightElevation: n(a.lightElevation, b.lightElevation), lightAzimuth: n(a.lightAzimuth, b.lightAzimuth),
    sunIntensity: n(a.sunIntensity, b.sunIntensity), sunColor: mixHex(a.sunColor, b.sunColor, t),
    skyColor: mixHex(a.skyColor, b.skyColor, t), groundColor: mixHex(a.groundColor, b.groundColor, t),
    ambient: n(a.ambient, b.ambient), fogColor: mixHex(a.fogColor, b.fogColor, t),
    fogNear: n(a.fogNear, b.fogNear), fogFar: n(a.fogFar, b.fogFar), env: n(a.env, b.env),
    turbidity: n(a.turbidity, b.turbidity), rayleigh: n(a.rayleigh, b.rayleigh), mie: n(a.mie, b.mie),
    lamps: n(a.lamps, b.lamps),
  };
}
