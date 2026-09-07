import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { GradeShader } from './fx/GradeShader.js';
import { QualityManager, type QualitySettings } from './QualityManager.js';

export interface GradeLook {
  lift: [number, number, number];
  gamma: [number, number, number];
  gain: [number, number, number];
  saturation: number;
  contrast: number;
  vignette: number;
  aberration: number;
  grain: number;
  exposure: number;
  /**
   * Passe noir: quanto da imagem vai a preto e branco (0 desliga).
   *
   * Opcional porque só uma cena o usa, e um campo obrigatório obrigaria os
   * outros três looks a declarar `noir: 0` — um número que não quer dizer nada
   * lá. Quem não declara não paga: o `if` no shader sai do caminho.
   */
  noir?: number;
  /** O matiz que sobrevive ao preto e branco, em voltas. 0 = vermelho. */
  keepHue?: number;
  /** Meia-largura da janela de matiz preservada, em voltas. */
  keepWidth?: number;
  /** Ganho de saturação do que sobreviveu. */
  keepBoost?: number;
  bloomStrength: number;
  bloomThreshold: number;
  bloomRadius: number;
}

/** Warm, slightly teal-shadowed daylight look for outdoor scenes. */
export const LOOK_DAY: GradeLook = {
  lift: [-0.004, 0.0, 0.014], gamma: [1.0, 1.0, 1.02], gain: [1.03, 1.005, 0.985],
  saturation: 1.08, contrast: 1.05, vignette: 0.3, aberration: 0.0014,
  grain: 0.02, exposure: 1.0, bloomStrength: 0.28, bloomThreshold: 0.86, bloomRadius: 0.5,
};

/** High-contrast magenta/cyan look for live rooms and the arena. */
export const LOOK_LIVE: GradeLook = {
  lift: [0.012, 0.0, 0.026], gamma: [0.99, 1.0, 1.02], gain: [1.05, 0.99, 1.06],
  saturation: 1.18, contrast: 1.09, vignette: 0.42, aberration: 0.0026,
  grain: 0.028, exposure: 1.05, bloomStrength: 0.62, bloomThreshold: 0.72, bloomRadius: 0.62,
};

/**
 * Noir: preto e branco de alto contraste com o VERMELHO preservado.
 *
 * Os três números que fazem a leitura, e o porquê de cada um:
 *
 *   * `saturation: 0.9` antes do passe noir, não 0. Dessaturar duas vezes
 *     mata o pouco de cor que o néon precisa ter para atravessar a janela de
 *     matiz — quem tira a cor aqui é `noir`, e ele tira com critério;
 *   * `contrast: 1.34` é o que transforma cinza em preto e branco. Sem ele o
 *     resultado é uma foto dessaturada, que é a coisa mais distante deste
 *     alvo: o assunto é a SILHUETA, e silhueta é preto contra branco;
 *   * `grain: 0.055`, mais que o dobro do dia. Grão é o que separa "noite" de
 *     "escuro", e uma imagem quase sem cor tem espaço de sobra para ele.
 *
 * O bloom fica alto e com limiar baixo porque a única luz da cena é letreiro:
 * o halo do néon na chuva é metade da imagem.
 */
export const LOOK_NOIR: GradeLook = {
  lift: [0.004, 0.006, 0.016], gamma: [1.02, 1.0, 0.97], gain: [0.98, 0.99, 1.04],
  saturation: 0.9, contrast: 1.34, vignette: 0.5, aberration: 0.0022,
  grain: 0.055, exposure: 1.32, bloomStrength: 0.68, bloomThreshold: 0.66, bloomRadius: 0.72,
  // Janela estreita: ±11° em torno do vermelho. A de ±20° da primeira versão
  // pegava o laranja do tijolo junto.
  noir: 0.92, keepHue: 0.0, keepWidth: 0.032, keepBoost: 1.55,
};

/** Soft, low-contrast interior look. */
export const LOOK_INTERIOR: GradeLook = {
  lift: [0.006, 0.004, 0.01], gamma: [1.0, 1.0, 1.0], gain: [1.02, 1.0, 0.99],
  saturation: 1.04, contrast: 1.02, vignette: 0.26, aberration: 0.001,
  grain: 0.018, exposure: 0.98, bloomStrength: 0.2, bloomThreshold: 0.9, bloomRadius: 0.45,
};

/** Frames ignored before the quality governor starts believing the clock. */
const WARMUP_FRAMES = 45;

/**
 * Owns the WebGL context and the post-processing chain. Kept deliberately
 * free of game rules: it is handed a scene and a camera and produces pixels
 * (architecture rule 1 in the SPECs).
 */
export class Renderer {
  readonly webgl: THREE.WebGLRenderer;
  readonly quality: QualityManager;
  readonly canvas: HTMLCanvasElement;

  private composer!: EffectComposer;
  private renderPass!: RenderPass;
  private gtao: GTAOPass | null = null;
  private bloom!: UnrealBloomPass;
  private grade!: ShaderPass;
  private smaa: SMAAPass | null = null;
  private output!: OutputPass;

  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private look: GradeLook = LOOK_DAY;
  private size = new THREE.Vector2(1, 1);
  private elapsed = 0;
  private frames = 0;

  constructor(canvas: HTMLCanvasElement, forcedTier?: 'low' | 'medium' | 'high') {
    this.canvas = canvas;
    this.webgl = new THREE.WebGLRenderer({
      canvas,
      antialias: false,          // SMAA in the composer handles edges instead.
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
      // NOT preserveDrawingBuffer. Keeping the back buffer alive across the
      // frame costs a full-screen copy every single frame on most drivers, and
      // it buys nothing at gameplay: `capture()` below renders on demand and
      // reads the canvas back inside the same task, which is the one moment
      // the buffer is guaranteed to still be there.
      preserveDrawingBuffer: false,
    });

    this.webgl.outputColorSpace = THREE.SRGBColorSpace;
    this.webgl.toneMapping = THREE.ACESFilmicToneMapping;
    this.webgl.toneMappingExposure = 1.0;
    this.webgl.shadowMap.enabled = true;
    this.webgl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.webgl.info.autoReset = false;

    this.quality = new QualityManager(this.webgl, forcedTier);
    this.quality.onPixelRatioChange = (r) => {
      this.webgl.setPixelRatio(r);
      this.composer?.setPixelRatio(r);
    };
    this.quality.onTierChange = (s) => this.applyTier(s);
    this.webgl.setPixelRatio(this.quality.pixelRatio());
  }

  attach(scene: THREE.Scene, camera: THREE.PerspectiveCamera, look: GradeLook = LOOK_DAY) {
    this.scene = scene;
    this.camera = camera;
    this.look = look;
    this.buildComposer();
    this.applyLook(look);
  }

  setLook(look: GradeLook) {
    this.look = look;
    this.applyLook(look);
  }

  private applyLook(look: GradeLook) {
    this.webgl.toneMappingExposure = look.exposure;
    if (this.bloom) {
      this.bloom.strength = look.bloomStrength;
      this.bloom.threshold = look.bloomThreshold;
      this.bloom.radius = look.bloomRadius;
    }
    if (this.grade) {
      const u = this.grade.uniforms;
      u.uLift.value = look.lift;
      u.uGamma.value = look.gamma;
      u.uGain.value = look.gain;
      u.uSaturation.value = look.saturation;
      u.uContrast.value = look.contrast;
      u.uVignette.value = look.vignette;
      u.uAberration.value = look.aberration;
      u.uGrain.value = look.grain;
      u.uNoir.value = look.noir ?? 0;
      u.uKeepHue.value = look.keepHue ?? 0;
      u.uKeepWidth.value = look.keepWidth ?? 0.055;
      u.uKeepBoost.value = look.keepBoost ?? 1;
    }
  }

  private buildComposer() {
    if (!this.scene || !this.camera) return;
    this.composer?.dispose();

    const s = this.quality.settings;
    // HalfFloat keeps highlights above 1.0 intact all the way to the bloom
    // and tone-map passes; an 8-bit target would clip them at the first pass.
    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
      samples: s.tier === 'low' ? 0 : 4,
    });

    this.composer = new EffectComposer(this.webgl, target);
    this.composer.setPixelRatio(this.quality.pixelRatio());

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    if (s.ssao) {
      this.gtao = new GTAOPass(this.scene, this.camera, 1, 1);
      this.gtao.output = GTAOPass.OUTPUT.Default;
      this.gtao.updateGtaoMaterial({
        radius: 0.32, distanceExponent: 1.6, thickness: 1.0,
        scale: 2.2, samples: 16, distanceFallOff: 1.0, screenSpaceRadius: false,
      });
      this.composer.addPass(this.gtao);
    } else {
      this.gtao = null;
    }

    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.3, 0.5, 0.85);
    this.bloom.enabled = s.bloom;
    this.composer.addPass(this.bloom);

    this.output = new OutputPass();
    this.composer.addPass(this.output);

    this.grade = new ShaderPass(GradeShader);
    this.grade.enabled = s.grade;
    this.composer.addPass(this.grade);

    if (s.smaa) {
      this.smaa = new SMAAPass(this.size.x, this.size.y);
      this.composer.addPass(this.smaa);
    } else {
      this.smaa = null;
    }

    this.applyLook(this.look);
    this.resize(this.size.x, this.size.y);
  }

  private applyTier(s: QualitySettings) {
    this.webgl.shadowMap.enabled = s.shadows;
    this.buildComposer();
  }

  /**
   * Compila todo shader da cena antes do primeiro quadro.
   *
   * Sem isto, o primeiro quadro de uma cena nova compila dezenas de programas
   * de uma vez e trava a aba por segundos — e trava DEPOIS de a tela de
   * carregamento sair, que é quando o jogador conclui que o jogo travou. Aqui
   * a espera acontece onde ela é esperada.
   *
   * `compileAsync` não existe em todo navegador; onde faltar, o caminho velho
   * é um `compile` síncrono, que ainda é melhor do que compilar no laço.
   */
  async warmUp(): Promise<void> {
    if (!this.scene || !this.camera) return;
    const gl = this.webgl as THREE.WebGLRenderer & {
      compileAsync?: (s: THREE.Object3D, c: THREE.Camera) => Promise<unknown>;
    };
    try {
      if (typeof gl.compileAsync === 'function') await gl.compileAsync(this.scene, this.camera);
      else this.webgl.compile(this.scene, this.camera);
    } catch (err) {
      console.warn('[render] warm-up falhou, seguindo mesmo assim:', err);
    }
  }

  resize(width: number, height: number) {
    this.size.set(Math.max(1, width), Math.max(1, height));
    this.webgl.setSize(this.size.x, this.size.y, false);
    this.composer?.setSize(this.size.x, this.size.y);
    this.bloom?.setSize(this.size.x, this.size.y);
    this.gtao?.setSize(this.size.x, this.size.y);
    if (this.grade) {
      const r = this.quality.pixelRatio();
      this.grade.uniforms.uResolution.value = [this.size.x * r, this.size.y * r];
    }
    if (this.camera) {
      this.camera.aspect = this.size.x / this.size.y;
      this.camera.updateProjectionMatrix();
    }
  }

  render(dt: number) {
    if (!this.scene || !this.camera) return;
    this.elapsed += dt;
    this.frames++;

    // Feed the governor. The first frames are skipped on purpose: shader
    // compilation and the first upload of every texture land there, and a
    // governor that believes those numbers drops a fast machine to low tier
    // before the scene has drawn once.
    if (this.frames > WARMUP_FRAMES) {
      this.quality.sample(dt, performance.now());
    }

    if (this.grade) this.grade.uniforms.uTime.value = this.elapsed;
    this.webgl.info.reset();
    this.composer.render(dt);
  }

  /**
   * A PNG of the current frame.
   *
   * Renders one frame and reads the canvas back in the SAME task, which is why
   * the context does not need `preserveDrawingBuffer`: the drawing buffer is
   * only cleared when the browser composites, and that cannot happen before
   * this function returns.
   */
  capture(mime = 'image/png', quality?: number): string {
    this.render(0);
    return this.canvas.toDataURL(mime, quality);
  }

  /** renderer.info snapshot for the perf HUD (SPECs §7). */
  stats() {
    const i = this.webgl.info;
    return {
      calls: i.render.calls,
      triangles: i.render.triangles,
      programs: i.programs?.length ?? 0,
      geometries: i.memory.geometries,
      textures: i.memory.textures,
      pixelRatio: this.quality.pixelRatio(),
      tier: this.quality.settings.tier,
    };
  }

  dispose() {
    this.composer?.dispose();
    this.webgl.dispose();
  }
}
