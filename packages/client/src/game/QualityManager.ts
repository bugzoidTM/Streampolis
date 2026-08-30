import * as THREE from 'three';

export type QualityTier = 'low' | 'medium' | 'high';

export interface QualitySettings {
  tier: QualityTier;
  maxPixelRatio: number;
  shadows: boolean;
  shadowMapSize: number;
  /** Ground-truth ambient occlusion pass. */
  ssao: boolean;
  bloom: boolean;
  /** Sub-pixel morphological AA; off on low (renderer MSAA carries it). */
  smaa: boolean;
  grade: boolean;
  /** Max simultaneous GPU particles across all live effects (SPECs §47). */
  particleBudget: number;
  drawDistance: number;
  /** Decorative crowd NPCs in public scenes. */
  ambientNpcs: number;
  anisotropy: number;
  /** Texture resolution divisor for procedurally generated maps. */
  textureScale: number;
}

const PRESETS: Record<QualityTier, Omit<QualitySettings, 'tier'>> = {
  low: {
    maxPixelRatio: 1.0, shadows: false, shadowMapSize: 1024, ssao: false,
    bloom: true, smaa: false, grade: true, particleBudget: 250,
    drawDistance: 90, ambientNpcs: 0, anisotropy: 1, textureScale: 0.5,
  },
  medium: {
    maxPixelRatio: 1.5, shadows: true, shadowMapSize: 2048, ssao: false,
    bloom: true, smaa: true, grade: true, particleBudget: 900,
    drawDistance: 160, ambientNpcs: 6, anisotropy: 4, textureScale: 1,
  },
  high: {
    maxPixelRatio: 2.0, shadows: true, shadowMapSize: 4096, ssao: true,
    bloom: true, smaa: true, grade: true, particleBudget: 2400,
    drawDistance: 260, ambientNpcs: 14, anisotropy: 8, textureScale: 1,
  },
};

const isMobile = () =>
  typeof navigator !== 'undefined' &&
  /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

/**
 * Picks a starting preset from device capability, then keeps FPS inside a
 * target band by trading resolution first and features second (SPECs §57).
 * Only ever steps down automatically; stepping back up requires sustained
 * headroom, so the quality does not oscillate visibly.
 */
export class QualityManager {
  settings: QualitySettings;
  /** Set by Renderer; applied whenever the effective pixel ratio changes. */
  onPixelRatioChange: ((r: number) => void) | null = null;
  onTierChange: ((s: QualitySettings) => void) | null = null;

  private renderScale = 1;
  private samples: number[] = [];
  private lastAdjust = 0;
  private manual = false;
  private readonly targetFps: number;

  constructor(renderer: THREE.WebGLRenderer, forced?: QualityTier) {
    const tier = forced ?? QualityManager.detect(renderer);
    this.settings = { tier, ...PRESETS[tier] };
    this.manual = forced !== undefined;
    this.targetFps = isMobile() ? 30 : 58;
  }

  static detect(renderer: THREE.WebGLRenderer): QualityTier {
    if (isMobile()) return 'medium';
    const gl = renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    const cores = navigator.hardwareConcurrency ?? 4;
    const mem = (navigator as { deviceMemory?: number }).deviceMemory ?? 8;

    // Software rasterisers and integrated parts cannot hold 60 with SSAO on.
    if (/SwiftShader|llvmpipe|Software|Microsoft Basic/i.test(gpu)) return 'low';
    if (cores <= 2 || mem <= 2) return 'low';
    if (/Intel.*(HD|UHD) Graphics (5|6)\d{2}/i.test(gpu)) return 'low';
    if (/Apple M[1-9]|RTX|Radeon RX|Arc A/i.test(gpu)) return 'high';
    if (cores >= 8 && mem >= 8) return 'high';
    return 'medium';
  }

  setTier(tier: QualityTier) {
    this.manual = true;
    this.settings = { tier, ...PRESETS[tier] };
    this.renderScale = 1;
    this.onTierChange?.(this.settings);
    this.emitPixelRatio();
  }

  /** Effective pixel ratio after the adaptive-resolution governor. */
  pixelRatio(): number {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
    return Math.min(dpr, this.settings.maxPixelRatio) * this.renderScale;
  }

  private emitPixelRatio() { this.onPixelRatioChange?.(this.pixelRatio()); }

  /** Call once per frame with the frame delta in seconds. */
  sample(dt: number, now: number) {
    if (dt <= 0) return;
    this.samples.push(1 / dt);
    if (this.samples.length > 120) this.samples.shift();
    if (this.samples.length < 60 || now - this.lastAdjust < 3_000) return;

    const sorted = [...this.samples].sort((a, b) => a - b);
    const p10 = sorted[Math.floor(sorted.length * 0.1)];
    const median = sorted[Math.floor(sorted.length * 0.5)];

    if (p10 < this.targetFps * 0.75) {
      this.stepDown();
      this.lastAdjust = now;
      this.samples.length = 0;
    } else if (median > this.targetFps * 1.12 && this.renderScale < 1) {
      this.renderScale = Math.min(1, this.renderScale + 0.1);
      this.emitPixelRatio();
      this.lastAdjust = now;
      this.samples.length = 0;
    }
  }

  private stepDown() {
    // Resolution is the cheapest and least visible knob, so spend it first.
    if (this.renderScale > 0.7) {
      this.renderScale = Math.max(0.7, this.renderScale - 0.15);
      this.emitPixelRatio();
      return;
    }
    if (this.manual) return;
    const order: QualityTier[] = ['high', 'medium', 'low'];
    const i = order.indexOf(this.settings.tier);
    if (i < order.length - 1) {
      this.settings = { tier: order[i + 1], ...PRESETS[order[i + 1]] };
      this.renderScale = 1;
      this.onTierChange?.(this.settings);
      this.emitPixelRatio();
    }
  }
}
