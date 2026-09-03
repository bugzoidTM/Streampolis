import * as THREE from 'three';
import { PORTALS, type ChatMessage, type HomePlacement, type Portal } from '@streampolis/shared';
import { InteriorScene } from './scenes/InteriorScene.js';
import {
  DEFAULT_AVATAR,
  GIFT_BY_ID,
  PLAY_AREA,
  applyMoveIntent,
  type AnimState,
  type AvatarConfig,
  type GiftEvent,
  type SceneId,
} from '@streampolis/shared';
import { Renderer } from './Renderer.js';
import { LoadTracker, type LoadReport } from './assets/loading.js';
import { CameraManager } from './CameraManager.js';
import { InputManager } from './InputManager.js';
import type { AvatarLike } from './avatar/AvatarLike.js';
import { crowdParts } from './AmbientCrowd.js';
import { createAvatar, isProcedural, preloadAvatarBodies } from './avatar/createAvatar.js';
import { NameTag, disposeNameTags } from './NameTag.js';
import { SpeechBubble } from './SpeechBubble.js';
import { Portals } from './Portals.js';
import { createScene } from './scenes/index.js';
import type { GameScene } from './scenes/GameScene.js';
import { clipReport, type ClipReport } from './anim/Library.js';
import { GiftEffectManager } from './fx/GiftEffects.js';
import type { AnyWorldConnection } from '../network/WorldConnection.js';
import type { RenderPose } from '../network/types.js';
import { attachStores } from '../network/bridge.js';

/**
 * Em que quadro a tela de carregamento pode sair.
 *
 * Não é o primeiro: `warmUp()` compila os materiais da cena, mas os passes de
 * pós-processamento têm shaders próprios e só compilam quando desenham —
 * revelar no quadro 1 mostra a praça sem grade nem bloom por um instante.
 */
const REVEAL_FRAME = 4;

export interface WorldOptions {
  /**
   * Avisa que o jogador entrou (ou saiu) do alcance de uma porta. Quem oferece
   * a viagem é a interface; quem sabe onde o corpo está é o mundo.
   */
  onPortal?: (portal: Portal | null) => void;
  canvas: HTMLCanvasElement;
  /**
   * Sala JÁ CONECTADA. Quem escolhe em qual entrar é a camada de sessão
   * (network/session.ts), não o mundo: o mundo desenha a sala em que está.
   * Ausente = modo offline.
   */
  connection?: AnyWorldConnection | null;
  /** Só no offline: qual cena desenhar sem servidor nenhum. */
  sceneId?: SceneId;
  tier?: 'low' | 'medium' | 'high';
  /** Look used only in offline mode; online it comes signed in the token. */
  avatar?: AvatarConfig;
  displayName?: string;
}

interface Actor {
  /** Id do jogador (o da API), não o da sessão: é por ele que o presente chega. */
  userId: string;
  /**
   * Tipado pela INTERFACE, não pela classe. É o que faz a troca por um corpo
   * comprado ser uma linha em `createAvatar()` e não uma cirurgia aqui — o
   * laço de jogo só precisa de `root`, `stature`, `setAnim` e `animate`.
   */
  avatar: AvatarLike;
  /** Nulo no avatar local: ninguém precisa de uma placa com o próprio nome. */
  tag: NameTag | null;
  /**
   * A última fala, pairando sobre a cabeça. O balão do jogador LOCAL também
   * aparece — ao contrário da placa de nome, que seria redundante: ver a
   * própria fala sair é o retorno de que ela foi aceita pelo servidor, e sem
   * isso quem fala num canto vazio não sabe se o chat funcionou.
   */
  bubble: SpeechBubble | null;
  /** Smoothed yaw, so a remote turning in place does not snap. */
  yaw: number;
  /** Where this actor was drawn last frame, to measure its real speed. */
  last: THREE.Vector3;
  /** Smoothed ground speed in m/s; what the locomotion clips are timed to. */
  speed: number;
}

const LOCAL_ID = 'local';

/**
 * Wires engine, scene, input and network into a running world.
 *
 * Deliberately framework-free: React mounts it and gets out of the way. The
 * render loop must not go through a component tree — a state update per frame
 * is how a 60 FPS scene becomes a 20 FPS one.
 *
 * Without a token it runs offline: the same scene, the same camera and a local
 * avatar driven by the same `applyMoveIntent` the server would run. That is
 * what makes the plaza reviewable in a screenshot without booting a server.
 */
export class World {
  readonly renderer: Renderer;
  readonly camera: CameraManager;
  readonly input: InputManager;

  private scene: GameScene | null = null;
  private gifts: GiftEffectManager | null = null;
  private offGift: (() => void) | null = null;
  private offChat: (() => void) | null = null;
  private portals: Portals | null = null;
  private nearPortal: Portal | null = null;
  private sceneId: SceneId = 'central_plaza';
  /** The boom starts behind the avatar, once, on the first pose it sees. */
  private cameraAligned = false;
  /** Debug override from the screenshot tool; never set during play. */
  private forcedAnim: AnimState | null = null;
  private connection: AnyWorldConnection | null = null;
  private detachStores: (() => void) | null = null;
  private actors = new Map<string, Actor>();
  private clock = new THREE.Clock();
  private raf = 0;
  private frames = 0;
  private disposed = false;
  private paused = false;

  /** Offline pose, integrated locally with the server's own function. */
  private solo = { x: 0, z: 6, yaw: Math.PI, moving: false };
  private soloSeq = 0;

  constructor(private opts: WorldOptions) {
    this.renderer = new Renderer(opts.canvas, opts.tier);
    this.camera = new CameraManager(1);
    this.input = new InputManager(opts.canvas);
  }

  get online(): boolean {
    return this.connection !== null;
  }

  /**
   * O corpo do jogador está em movimento AGORA.
   *
   * Medido no que foi desenhado, como a animação: o `moving` do servidor chega
   * atrasado e o do preditor é intenção, não corpo. Quem pergunta é a barra de
   * gestos — o servidor recusa gesto de quem anda, e um botão que não faz nada
   * e não explica parece um jogo quebrado.
   */
  get localMoving(): boolean {
    const me = this.actors.get(this.localKey());
    return (me?.speed ?? 0) > 0.12;
  }

  /**
   * A casa em que este mundo entrou, com o id de verdade.
   *
   * A intenção do jogador pode dizer `me`; a conexão sabe qual casa isso virou.
   * Quem pergunta é a barra de decoração, e perguntar à intenção era o que
   * fazia o botão "Decorar" sumir dentro do próprio apartamento.
   */
  get apartmentId(): string | null {
    return this.connection?.apartmentId ?? null;
  }

  /** Disparado uma vez, quando o primeiro quadro chega à tela. */
  private onFirstFrame: (() => void) | null = null;

  async start(onProgress?: (report: LoadReport) => void): Promise<void> {
    const track = new LoadTracker(onProgress ?? (() => {}));
    // A sala chega pronta. O mundo não escolhe onde entrar — ele pergunta ao
    // estado da sala onde ELE está. Era esse o elo que faltava: com o World
    // abrindo a conexão sozinho, toda sala virava uma CityRoom e uma live
    // acontecia dentro da praça.
    this.connection = this.opts.connection ?? null;
    this.sceneId = this.connection?.state?.sceneId ?? this.opts.sceneId ?? 'central_plaza';

    if (this.connection) {
      this.detachStores = attachStores(this.connection);
    }

    const scene = createScene(this.sceneId);
    // Os arquivos primeiro: é a parte que depende da rede e a única com
    // contagem honesta. A cena chama os carregadores lá dentro, e todos eles
    // passam pelo manager compartilhado.
    track.followAssets('Carregando o cenário');
    try {
      // Cenário e corpos na MESMA fase: os dois são arquivo, os dois contam no
      // mesmo denominador, e um corpo que chega depois da barra sumir faz a
      // praça abrir vazia e ir se povoando — que parece defeito.
      await Promise.all([
        scene.build(this.renderer.webgl, this.renderer.quality.settings.tier),
        preloadAvatarBodies(crowdParts(this.renderer.quality.settings.ambientNpcs)),
      ]);
    } finally {
      track.stopFollowingAssets();
    }
    track.begin('scene', 'Montando a cena');
    this.scene = scene;
    this.renderer.attach(scene.scene, this.camera.camera, scene.look);
    // Snapshot of the static world, taken before any avatar exists. Handing
    // the camera the live scene instead would raycast sprites and skinned
    // meshes every frame — Sprite.raycast needs a camera the boom does not
    // have, and it throws once per frame.
    this.camera.obstacles = [...scene.scene.children];
    this.camera.setFraming(scene.framing, true);
    this.camera.setLimits({ maxDistance: scene.maxBoom });
    scene.populate?.(this.renderer.quality.settings.ambientNpcs);

    // As portas da cena. Ficam FORA da cena autoral de propósito: uma porta é
    // navegação, não cenário, e a tabela que a descreve é compartilhada com o
    // servidor.
    this.portals = new Portals(scene.scene, this.sceneId);

    this.gifts = new GiftEffectManager(scene.scene, {
      budget: this.renderer.quality.settings.particleBudget,
      shake: (amount) => this.camera.shake(amount),
      camera: () => this.camera.camera,
      viewHeight: () => this.opts.canvas.clientHeight || window.innerHeight,
    });
    // O presente só vira efeito depois de cobrado: este evento chega do
    // servidor DEPOIS do débito, e um replay nunca chega (SPECs §68 regra 4).
    this.offGift = this.connection?.on('gift', (event) => this.showGift(event)) ?? null;
    // A fala vira balão no mundo. Vem do MESMO evento que alimenta o painel de
    // chat, e não de um eco local: quem decide se a mensagem existe, se passou
    // no filtro e em que ordem ela entra é o servidor (SPECs §31).
    this.offChat = this.connection?.on('chat', (message) => this.say(message)) ?? null;

    if (!this.connection) {
      const spawn = scene.spawnPoints[0] ?? new THREE.Vector3(0, 0, 6);
      this.solo = { x: spawn.x, z: spawn.z, yaw: Math.atan2(-spawn.x, -spawn.z), moving: false };
    }

    this.resize();

    // Compilar ANTES de mostrar. O primeiro quadro de uma cena nova compila
    // todo shader que ela usa, e isso trava a aba por segundos — com a tela já
    // revelada, o jogador vê o jogo congelar assim que aparece, que é pior do
    // que esperar mais um pouco na tela de carregamento.
    track.begin('compile', 'Preparando os materiais');
    await this.renderer.warmUp();

    // "Pronto" é o PRIMEIRO QUADRO DESENHADO, não o fim do `start()`. Anunciar
    // aqui tirava a tela de carregamento antes de existir imagem, e o jogador
    // voltava a olhar para o preto — o defeito que esta tela veio consertar,
    // reintroduzido três linhas antes do fim.
    this.onFirstFrame = () => {
      track.begin('ready', 'Pronto');
      track.step(1, 'Pronto');
    };

    this.loop();
  }

  /** Onde o efeito do presente cai: em cima de quem recebeu. */
  private showGift(event: GiftEvent): void {
    if (!this.gifts) return;
    const target = this.actorOfUser(event.receiverId);
    const at = target
      ? target.avatar.root.position.clone()
      // Sem corpo em cena (espectador presenteando o host de outra sala, ou um
      // host ainda não desenhado) o efeito acontece à frente da câmera, para
      // que um presente pago nunca seja invisível.
      : this.inFrontOfCamera();
    this.gifts.play(event, at);
  }

  /**
   * Põe uma fala sobre a cabeça de quem falou.
   *
   * Mensagem de sistema não ganha balão: ela não tem boca. E fala de alguém que
   * não está desenhado aqui — um espectador de outra sala, alguém que acabou de
   * sair — simplesmente não aparece no mundo; ela continua no painel de chat,
   * que é onde esse tipo de mensagem pertence.
   */
  private say(message: ChatMessage): void {
    if (message.system) return;
    const actor = this.actorOfUser(message.senderId);
    if (!actor) return;
    actor.bubble?.dispose();
    // O balão fica LOGO ACIMA DA CABEÇA, e é a placa de nome que sai da frente.
    //
    // Empilhar balão sobre placa parece a solução óbvia e põe o texto a trinta
    // centímetros da coroa: a três metros de distância — que é onde as pessoas
    // conversam numa praça — a fala se descola de quem falou e passa a parecer
    // do poste atrás. Pior no jogador local, que não tem placa nenhuma e fica
    // com o balão sobre um palmo de ar. Quem fala tem nome dito pelo painel de
    // chat; a placa volta quando o balão morre.
    const bubble = new SpeechBubble(message.text, actor.avatar.stature + 0.08);
    bubble.place(0);
    actor.avatar.root.add(bubble.sprite);
    actor.bubble = bubble;
    if (actor.tag) actor.tag.sprite.visible = false;
  }

  /**
   * Suspende o teclado do jogo enquanto alguém DIGITA.
   *
   * Sem isto, escrever "vamos" no chat manda o avatar andar para trás e para a
   * esquerda — o `w` e o `a` são teclas de movimento, e o laço de entrada
   * escuta a janela inteira. O interruptor já existia no `InputManager` e nunca
   * tinha sido ligado por ninguém; o chat da live tinha o mesmo defeito.
   */
  setTyping(typing: boolean): void {
    this.input.setSuspended(typing);
  }

  private actorOfUser(userId: string): Actor | undefined {
    for (const [, actor] of this.actors) {
      if (actor.userId === userId) return actor;
    }
    return undefined;
  }

  private inFrontOfCamera(): THREE.Vector3 {
    const dir = new THREE.Vector3();
    this.camera.camera.getWorldDirection(dir);
    return this.camera.camera.position.clone().addScaledVector(dir, 4.5).setY(0);
  }

  resize(): void {
    const canvas = this.opts.canvas;
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    this.renderer.resize(w, h);
    this.camera.resize(w, h);
  }

  /**
   * Congela o laço sem desmontar nada. Enquanto pausado o relógio continua
   * sendo consumido: sem isso, ao voltar, o primeiro quadro receberia o tempo
   * inteiro que a tela ficou aberta e teleportaria todo mundo.
   */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    // Pausado só DEPOIS de existir imagem. O mundo entra pausado sempre que o
    // jogador abre outra aba da casca enquanto ele carrega, e um laço que sai
    // aqui no primeiro quadro nunca desenha, nunca chega ao quarto quadro e
    // nunca anuncia "pronto" — a tela de carregamento ficava para sempre por
    // cima da Loja. Os quatro primeiros quadros correm de qualquer jeito;
    // além de destravarem o anúncio, são eles que deixam a cena PINTADA
    // embaixo da pausa, em vez de um retângulo preto.
    if (this.paused && this.frames >= REVEAL_FRAME) return;
    const input = this.input.poll();

    // A roda chega em cliques e a câmera os interpreta; aqui não há conversão
    // nenhuma a fazer. O `* 0.01` que havia neste lugar era o zoom inteiro
    // virando quatro milímetros por clique.
    this.camera.applyInput(input.lookYaw, input.lookPitch, input.zoom);

    // Movement is expressed against what the player actually sees, so it is
    // derived from the camera basis rather than from a yaw convention.
    const forward = new THREE.Vector3();
    this.camera.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    const right = new THREE.Vector3(-forward.z, 0, forward.x);

    const dir = new THREE.Vector3()
      .addScaledVector(right, input.moveX)
      .addScaledVector(forward, -input.moveZ);
    const moving = dir.lengthSq() > 1e-6;
    if (moving) dir.normalize();
    // Face where you walk; standing still keeps the last facing.
    const yaw = moving ? Math.atan2(dir.x, dir.z) : this.facing();

    if (this.connection) {
      this.connection.update(dt, { dx: dir.x, dz: dir.z, yaw, run: input.run });
      this.syncActors(this.connection.poses(), dt);
    } else {
      this.stepSolo(dir.x, dir.z, yaw, input.run);
      this.syncActors([this.soloPose()], dt);
    }

    const me = this.actors.get(this.localKey());
    if (me) this.camera.follow(me.avatar.root.position);

    // Porta ao alcance. O aviso só sobe quando MUDA: um callback por quadro
    // faria a casca do React renderizar sessenta vezes por segundo para dizer
    // a mesma coisa.
    if (me && this.portals) {
      const p = me.avatar.root.position;
      const near = this.portals.update(dt, p.x, p.z);
      if ((near?.id ?? null) !== (this.nearPortal?.id ?? null)) {
        this.nearPortal = near;
        this.opts.onPortal?.(near);
      }
    }

    this.camera.update(dt);
    this.scene?.update(dt, this.camera.camera);
    this.gifts?.update(dt);
    this.renderer.render(dt);

    this.frames++;
    // Quatro quadros antes de revelar. `warmUp()` compila os materiais da
    // cena, mas os passes de pós-processamento têm shaders próprios e só
    // compilam quando desenham — revelar no primeiro quadro mostra a cena sem
    // grade nem bloom por um instante.
    if (this.frames === REVEAL_FRAME && this.onFirstFrame) {
      const fire = this.onFirstFrame;
      this.onFirstFrame = null;
      fire();
    }
    // The screenshot tool waits on this: post-processing shaders compile on
    // the first frames and an early capture catches an unshaded scene.
    if (this.frames === 12) (window as unknown as { __ready?: boolean }).__ready = true;
  };

  private facing(): number {
    const me = this.actors.get(this.localKey());
    return me ? me.yaw : this.solo.yaw;
  }

  private localKey(): string {
    return this.connection ? this.connection.sessionId : LOCAL_ID;
  }

  /** Offline integration — same function and same fixed step as the server. */
  private stepSolo(dx: number, dz: number, yaw: number, run: boolean): void {
    const next = applyMoveIntent(
      this.solo,
      { dx, dz, yaw, run, seq: ++this.soloSeq },
      PLAY_AREA[this.sceneId],
    );
    const clamped = this.scene?.clamp(
      new THREE.Vector3(this.solo.x, 0, this.solo.z),
      new THREE.Vector3(next.x, 0, next.z),
    );
    this.solo = {
      x: clamped ? clamped.x : next.x,
      z: clamped ? clamped.z : next.z,
      yaw: next.yaw,
      moving: next.moving,
    };
  }

  private soloPose(): RenderPose {
    return {
      id: LOCAL_ID,
      sessionId: LOCAL_ID,
      name: this.opts.displayName ?? 'Você',
      x: this.solo.x,
      y: 0,
      z: this.solo.z,
      yaw: this.solo.yaw,
      anim: this.solo.moving ? 'walk' : 'idle',
      moving: this.solo.moving,
      gifterLevel: 0,
      avatar: this.opts.avatar ?? DEFAULT_AVATAR,
      isLocal: true,
    };
  }

  /**
   * Reconciles the actor pool with this frame's poses. Avatars are built and
   * destroyed here and nowhere else, which is what keeps a busy plaza from
   * leaking a skinned mesh per visitor that ever passed through.
   */
  private syncActors(poses: RenderPose[], dt: number): void {
    const seen = new Set<string>();

    for (const pose of poses) {
      seen.add(pose.sessionId);
      let actor = this.actors.get(pose.sessionId);
      if (!actor) {
        const avatar = createAvatar(pose.avatar ?? DEFAULT_AVATAR);
        // O próprio jogador não ganha placa: em terceira pessoa ela fica entre
        // a câmera e a cabeça dele, e numa live tapa exatamente o que está
        // sendo transmitido.
        const tag = pose.isLocal
          ? null
          : new NameTag(pose.name, pose.gifterLevel, avatar.stature);
        if (tag) avatar.root.add(tag.sprite);
        this.scene?.scene.add(avatar.root);
        actor = {
          userId: pose.id,
          avatar, tag, bubble: null, yaw: pose.yaw,
          last: new THREE.Vector3(pose.x, pose.y, pose.z),
          speed: 0,
        };
        this.actors.set(pose.sessionId, actor);
      }

      // Speed is measured from what was actually drawn, not from the server's
      // `moving` flag: a remote arriving through the interpolation buffer moves
      // at the buffer's pace, and timing the walk to anything else is exactly
      // what makes feet skate.
      const travelled = Math.hypot(pose.x - actor.last.x, pose.z - actor.last.z);
      const instant = dt > 1e-4 ? travelled / dt : 0;
      // Half-life smoothing, so one dropped packet does not stop the legs.
      const k = 1 - Math.exp(-dt / 0.09);
      actor.speed += (Math.min(instant, 12) - actor.speed) * k;
      actor.last.set(pose.x, pose.y, pose.z);

      if (pose.isLocal && !this.cameraAligned) {
        // Atrás do jogador, olhando para onde ele olha. Deixar o braço em yaw 0
        // punha a câmera entre o host e o painel de LED em toda live room.
        //
        // Exceto no palco: quem transmite se vê como a plateia vê, de frente —
        // é o enquadramento de uma live, e é o único jeito de a pessoa saber o
        // que está indo ao ar.
        const role = this.connection?.localPlayer?.role;
        const onStage = role === 'host' || role === 'cohost';
        this.camera.yaw = onStage ? pose.yaw : pose.yaw + Math.PI;
        this.cameraAligned = true;
      }

      actor.avatar.root.position.set(pose.x, pose.y, pose.z);
      // Remote yaw already comes interpolated; this only damps the local
      // avatar's turn, which changes instantly with the input.
      actor.yaw = shortestLerp(actor.yaw, pose.yaw, pose.isLocal ? 0.35 : 1);
      actor.avatar.root.rotation.y = actor.yaw;

      // The state travels on the wire; here is where it becomes movement.
      // O estado vem do servidor; `forcedAnim` é a trava da revisão visual, que
      // manda o mesmo gesto para todo mundo. No corpo procedural ela entra pelo
      // `Animator`; no v2, que não tem um, ela simplesmente VIRA o estado.
      actor.avatar.setAnim(this.forcedAnim ?? pose.anim ?? 'idle');
      if (isProcedural(actor.avatar)) actor.avatar.animator.pin(this.forcedAnim);
      actor.avatar.animate(dt, actor.speed);

      if (actor.bubble && !actor.bubble.update(dt)) {
        actor.bubble.dispose();
        actor.bubble = null;
        if (actor.tag) actor.tag.sprite.visible = true;
      }
    }

    for (const [key, actor] of this.actors) {
      if (seen.has(key)) continue;
      actor.tag?.dispose();
      actor.bubble?.dispose();
      this.scene?.scene.remove(actor.avatar.root);
      actor.avatar.dispose();
      this.actors.delete(key);
    }
  }

  /**
   * Forces every avatar into one state. For the visual review loop only —
   * `tools/shoot.mjs --anim=dance` has to be able to photograph a pose without
   * a second player and a server.
   */
  forceAnim(state: AnimState | null): void {
    this.forcedAnim = state;
  }

  /** What the compiler measured for each clip, for the review loop. */
  animReport(): ClipReport[] {
    const any = this.actors.values().next().value;
    if (!any) return [];
    // Relatório de clipe é ferramenta de revisão do corpo PROCEDURAL: um
    // corpo de pacote traz os clipes do autor e não este catálogo.
    return isProcedural(any.avatar) ? clipReport(any.avatar.rig) : [];
  }

  /** A PNG data URL of the current frame (see Renderer.capture). */
  capture(mime = 'image/png'): string {
    return this.renderer.capture(mime);
  }

  /**
   * Dispara o efeito de um presente sem passar pela economia. Existe para a
   * revisão visual — e SÓ para ela: nada aqui cobra, credita ou pontua PK, e é
   * por isso que o caminho de verdade continua sendo o evento do servidor.
   */
  previewGift(giftId: string, quantity = 1): boolean {
    const gift = GIFT_BY_ID.get(giftId);
    if (!gift || !this.gifts) return false;
    const me = this.actors.get(this.localKey());
    this.gifts.play(
      {
        eventId: `preview_${Date.now()}`,
        senderId: 'preview',
        senderName: 'Preview',
        gifterLevel: 0,
        giftId: gift.id,
        quantity,
        animationId: gift.animationId,
        receiverId: me?.userId ?? '',
        pkPoints: 0,
        timestamp: Date.now(),
      },
      me ? me.avatar.root.position.clone() : new THREE.Vector3(),
    );
    return true;
  }

  /** Debug surface for tools/probe.mjs. */
  stats(): Record<string, unknown> {
    return {
      online: this.online,
      scene: this.sceneId,
      actors: this.actors.size,
      // Pergunta ao CORPO o que ele está tocando. Perguntava ao `Animator`, que
      // só o procedural tem, e desde a migração respondia "idle" para todo
      // mundo — inclusive para um avatar dançando na tela.
      anim: [...this.actors.values()].map((a) => ({
        state: a.avatar.anim,
        speed: Math.round(a.speed * 100) / 100,
      })),
      renderer: this.renderer.stats(),
      particles: this.gifts?.activeParticles ?? 0,
      // Quantas falas estão no ar. É por aqui que `tools/chat-check.mjs` prova
      // que a mensagem virou balão sobre uma cabeça, e não só uma linha no
      // painel — as duas coisas podem falhar separadamente.
      bubbles: [...this.actors.values()].filter((a) => a.bubble !== null).length,
      typing: this.input.isSuspended,
      local: this.connection ? this.connection.predictor.stats : { solo: this.solo },
      // Onde o corpo do jogador ESTÁ, depois de predição e colisão. O relatório
      // do preditor fala de reconciliação, não de posição, e toda ferramenta
      // que quis saber "onde ele está" acabou lendo zero de um campo que não
      // existia ali.
      player: (() => {
        const me = this.actors.get(this.localKey());
        return me ? { x: me.avatar.root.position.x, z: me.avatar.root.position.z } : null;
      })(),
      portal: this.nearPortal?.id ?? null,
      // As portas desta cena, com onde ficam e quanto alcançam.
      //
      // Publicado porque toda ferramenta que quis andar até uma porta acabou
      // escrevendo a coordenada dela na mão — e uma coordenada copiada envelhece
      // calada: `tools/travel-check.mjs` mediu distância até uma porta imaginária
      // no meio da parede sul por semanas, enquanto a de verdade estava dois
      // metros ao lado.
      doors: (PORTALS[this.sceneId] ?? []).map((p) => ({ id: p.id, x: p.x, z: p.z, r: p.r })),
      // A roupa como a SALA a conhece, que é diferente do que a interface
      // desenha: é aqui que se prova que trocar de visual chegou ao servidor.
      // Publicado por este caminho, e não lido do objeto de conexão, porque em
      // produção o código é minificado e campo privado troca de nome — uma
      // ferramenta que espia campo interno passa no dev e falha no ar.
      look: this.connection?.localPlayer
        ? {
          skinTone: this.connection.localPlayer.avatar.skinTone,
          hairColor: this.connection.localPlayer.avatar.hairColor,
          hair: this.connection.localPlayer.avatar.hair,
          top: this.connection.localPlayer.avatar.top,
        }
        : null,
      portals: (PORTALS[this.sceneId] ?? []).length,
    };
  }

  /**
   * The room the player owns, furnished. Only an interior can be furnished, so
   * anywhere else this is a no-op rather than an error — the caller is the UI,
   * and the UI should not have to know which scene class is on screen.
   */
  applyHomeLayout(list: readonly HomePlacement[]): boolean {
    const scene = this.scene as { setPlacements?: (l: readonly HomePlacement[]) => void } | null;
    if (!scene?.setPlacements) return false;
    scene.setPlacements(list);
    return true;
  }

  /** Handles build mode needs to drive picking against this world. */
  get editable(): { canvas: HTMLCanvasElement; camera: THREE.Camera; scene: InteriorScene } | null {
    const scene = this.scene;
    if (!scene || !(scene instanceof InteriorScene)) return null;
    return { canvas: this.renderer.webgl.domElement, camera: this.camera.camera, scene };
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.offGift?.();
    this.gifts?.dispose();
    this.detachStores?.();
    this.offChat?.();
    this.portals?.dispose();
    void this.connection?.leave();
    for (const [, actor] of this.actors) {
      actor.tag?.dispose();
      actor.avatar.dispose();
    }
    this.actors.clear();
    disposeNameTags();
    this.input.dispose();
    this.scene?.dispose();
    this.renderer.dispose();
  }
}

function shortestLerp(from: number, to: number, k: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return from + d * k;
}
