import * as THREE from 'three';

/**
 * Collects movement and camera intent from keyboard, mouse, touch and gamepad
 * into one device-agnostic snapshot. Nothing here talks to the network: the
 * caller turns this into a MoveIntent, because the server owns the result
 * (SPECs §15, §16).
 */
export interface InputState {
  /** Planar movement in camera space, already clamped to unit length. */
  moveX: number;
  moveZ: number;
  run: boolean;
  jump: boolean;
  /** Camera orbit delta this frame, in radians. */
  lookYaw: number;
  lookPitch: number;
  /** Zoom acumulado no quadro, em CLIQUES de roda; positivo afasta. */
  zoom: number;
  interact: boolean;
  /** True while any pointer is held on the 3D view. */
  pointerDown: boolean;
}

const KEY_MAP: Record<string, keyof typeof AXES | 'run' | 'jump' | 'interact'> = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  ShiftLeft: 'run', ShiftRight: 'run',
  Space: 'jump',
  KeyE: 'interact',
};

const AXES = { forward: 0, back: 0, left: 0, right: 0 };

/** Radius in px inside which a touch counts as centred on the virtual stick. */
const STICK_DEADZONE = 6;
const STICK_RADIUS = 58;

/**
 * Radianos por pixel arrastado. Dois números porque são dois aparelhos.
 *
 * No dedo, 300 px é um gesto largo numa tela de telefone. No mouse, 300 px é
 * um movimento de pulso — com a mesma sensibilidade do toque, dar meia volta
 * em torno do personagem exigiria arrastar o mouse por três telas, e foi essa
 * a impressão de "a câmera não gira".
 */
const TOQUE_RAD_POR_PX = 0.0042;
const MOUSE_RAD_POR_PX = 0.0072;

/**
 * Um "clique" de roda, seja qual for a unidade que o navegador reportou.
 *
 * `deltaY` vem em pixels no Chrome (≈100 por clique), em LINHAS no Firefox
 * (≈3) e em páginas em alguns modos. Somar o número cru trata um clique de
 * roda como 100 em um navegador e como 3 em outro; o teto por evento existe
 * porque um `deltaMode` de página manda o zoom para o fim do curso de uma vez.
 */
const UNIDADE_DA_RODA = [100, 3, 1];

function notchesOf(ev: WheelEvent): number {
  const unidade = UNIDADE_DA_RODA[ev.deltaMode] ?? 100;
  return Math.max(-3, Math.min(3, ev.deltaY / unidade));
}

export class InputManager {
  readonly state: InputState = {
    moveX: 0, moveZ: 0, run: false, jump: false,
    lookYaw: 0, lookPitch: 0, zoom: 0, interact: false, pointerDown: false,
  };

  /** Set true while a text field has focus, so WASD types instead of walking. */
  /**
   * Teclado e ponteiro ignorados. Ligado enquanto alguém digita no chat: `w`,
   * `a`, `s` e `d` são teclas de movimento e este laço escuta a JANELA, então
   * escrever uma frase fazia o avatar sair andando.
   */
  suspended = false;

  /**
   * Arrastar com o botão ESQUERDO gira a câmera.
   *
   * O jogo é de computador, e num jogo de computador a câmera se orbita com o
   * mouse — girar só com o botão direito é um atalho que ninguém descobre
   * sozinho. Fica desligado enquanto o modo de construção é dono do clique:
   * lá o arrasto esquerdo ARRASTA MÓVEL, e as duas coisas no mesmo botão
   * fariam mover o sofá girar a sala. O botão direito orbita sempre — inclusive
   * decorando, que é quando mais se precisa olhar em volta.
   */
  orbitOnDrag = true;

  private keys = new Set<string>();
  private pressedThisFrame = new Set<string>();
  private pointers = new Map<number, { x: number; y: number; startX: number; startY: number; stick: boolean }>();
  private stickId: number | null = null;
  private lookId: number | null = null;
  /** Qual botão do mouse está girando a câmera agora; nulo se nenhum. */
  private mouseLookButton: number | null = null;
  private detach: Array<() => void> = [];

  constructor(private element: HTMLElement) {
    this.attach();
  }

  private on<K extends keyof HTMLElementEventMap>(
    target: HTMLElement | Window | Document,
    type: K | string,
    handler: (e: Event) => void,
    opts?: AddEventListenerOptions,
  ) {
    target.addEventListener(type, handler as EventListener, opts);
    this.detach.push(() => target.removeEventListener(type, handler as EventListener));
  }

  /**
   * Liga ou desliga a suspensão, esquecendo o que estava pressionado.
   *
   * O esquecimento é o ponto: quem estava correndo e abriu o chat com a tecla
   * ainda apertada nunca receberia o `keyup` (ele chega suspenso), e o avatar
   * ficaria correndo para sempre — o mesmo defeito que o `blur` da janela já
   * tratava.
   */
  get isSuspended(): boolean { return this.suspended; }

  setSuspended(on: boolean): void {
    this.suspended = on;
    if (on) this.keys.clear();
  }

  private attach() {
    const el = this.element;

    this.on(window, 'keydown', (e) => {
      const ev = e as KeyboardEvent;
      if (this.suspended) return;
      if (!this.keys.has(ev.code)) this.pressedThisFrame.add(ev.code);
      this.keys.add(ev.code);
      // Space would otherwise scroll the page behind the canvas.
      if (ev.code === 'Space') ev.preventDefault();
    });
    this.on(window, 'keyup', (e) => this.keys.delete((e as KeyboardEvent).code));
    // A window blur with keys held would latch movement on forever. O mesmo
    // vale para o botão do mouse: sair da janela no meio de um arrasto deixaria
    // a câmera presa ao ponteiro, girando sozinha quando ele voltasse.
    this.on(window, 'blur', () => {
      this.keys.clear();
      this.mouseLookButton = null;
      this.pointers.clear();
      this.state.pointerDown = false;
    });

    this.on(el, 'contextmenu', (e) => e.preventDefault());

    this.on(el, 'pointerdown', (e) => {
      const ev = e as PointerEvent;
      el.setPointerCapture?.(ev.pointerId);
      const rect = el.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      // Left half of a touch screen drives the stick, right half the camera.
      const isTouch = ev.pointerType !== 'mouse';
      const stick = isTouch && x < rect.width * 0.45 && this.stickId === null;
      this.pointers.set(ev.pointerId, { x, y, startX: x, startY: y, stick });
      if (stick) this.stickId = ev.pointerId;
      else if (isTouch && this.lookId === null) this.lookId = ev.pointerId;
      if (!isTouch && (ev.button === 2 || (ev.button === 0 && this.orbitOnDrag))) {
        this.mouseLookButton = ev.button;
      }
      this.state.pointerDown = true;
    });

    const endPointer = (e: Event) => {
      const ev = e as PointerEvent;
      this.pointers.delete(ev.pointerId);
      if (this.stickId === ev.pointerId) this.stickId = null;
      if (this.lookId === ev.pointerId) this.lookId = null;
      // Qualquer botão: quem soltar o que estava girando encerra o giro. O
      // teste era só pelo direito, e com o esquerdo também orbitando isso
      // deixaria a câmera presa ao mouse depois do primeiro clique.
      if (this.mouseLookButton === ev.button) this.mouseLookButton = null;
      this.state.pointerDown = this.pointers.size > 0;
    };
    this.on(el, 'pointerup', endPointer);
    this.on(el, 'pointercancel', endPointer);

    this.on(el, 'pointermove', (e) => {
      const ev = e as PointerEvent;
      const p = this.pointers.get(ev.pointerId);
      if (!p) return;
      const rect = el.getBoundingClientRect();
      const nx = ev.clientX - rect.left;
      const ny = ev.clientY - rect.top;
      const dx = nx - p.x;
      const dy = ny - p.y;
      p.x = nx; p.y = ny;

      if (p.stick) return; // Stick reads absolute offset in poll(), not delta.
      const mouse = ev.pointerType === 'mouse';
      if (mouse && this.mouseLookButton === null) return;
      const k = mouse ? MOUSE_RAD_POR_PX : TOQUE_RAD_POR_PX;
      this.state.lookYaw -= dx * k;
      this.state.lookPitch -= dy * k;
    });

    this.on(el, 'wheel', (e) => {
      const ev = e as WheelEvent;
      ev.preventDefault();
      this.state.zoom += notchesOf(ev);
    }, { passive: false } as AddEventListenerOptions);
  }

  /**
   * Produces this frame's state. Must be called exactly once per frame: it
   * consumes the accumulated look/zoom deltas and the edge-triggered keys.
   */
  poll(): Readonly<InputState> {
    const s = this.state;
    const a = { ...AXES };
    if (!this.suspended) {
      for (const code of this.keys) {
        const action = KEY_MAP[code];
        if (action && action in a) (a as Record<string, number>)[action] = 1;
      }
      s.run = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    } else {
      s.run = false;
    }

    let mx = a.right - a.left;
    let mz = a.back - a.forward;

    // Virtual stick overrides the keyboard when a touch is active.
    if (this.stickId !== null) {
      const p = this.pointers.get(this.stickId);
      if (p) {
        const dx = p.x - p.startX;
        const dy = p.y - p.startY;
        const len = Math.hypot(dx, dy);
        if (len > STICK_DEADZONE) {
          const scale = Math.min(1, len / STICK_RADIUS) / len;
          mx = dx * scale;
          mz = dy * scale;
          s.run = len > STICK_RADIUS * 0.85;
        } else {
          mx = 0; mz = 0;
        }
      }
    }

    const len = Math.hypot(mx, mz);
    if (len > 1) { mx /= len; mz /= len; }
    s.moveX = mx;
    s.moveZ = mz;

    const gp = this.pollGamepad();
    if (gp) {
      s.moveX = gp.x; s.moveZ = gp.z;
      s.lookYaw -= gp.yaw; s.lookPitch -= gp.pitch;
      s.run = s.run || gp.run;
    }

    s.jump = this.pressedThisFrame.has('Space');
    s.interact = this.pressedThisFrame.has('KeyE');
    this.pressedThisFrame.clear();

    const snapshot: InputState = { ...s };
    // Look and zoom are deltas: zero them so they are not applied twice.
    s.lookYaw = 0; s.lookPitch = 0; s.zoom = 0;
    return snapshot;
  }

  private pollGamepad() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pad = Array.from(navigator.getGamepads()).find((p) => p?.connected);
    if (!pad) return null;
    const dz = (v: number) => (Math.abs(v) < 0.16 ? 0 : v);
    const x = dz(pad.axes[0] ?? 0);
    const z = dz(pad.axes[1] ?? 0);
    if (x === 0 && z === 0 && !dz(pad.axes[2] ?? 0) && !dz(pad.axes[3] ?? 0)) return null;
    return {
      x, z,
      yaw: dz(pad.axes[2] ?? 0) * 0.045,
      pitch: dz(pad.axes[3] ?? 0) * 0.035,
      run: (pad.buttons[10]?.pressed ?? false) || (pad.buttons[6]?.value ?? 0) > 0.5,
    };
  }

  /** Converts planar input into a world direction relative to a camera yaw. */
  static toWorld(moveX: number, moveZ: number, cameraYaw: number, out = new THREE.Vector2()) {
    const c = Math.cos(cameraYaw);
    const s = Math.sin(cameraYaw);
    return out.set(moveX * c - moveZ * s, moveX * s + moveZ * c);
  }

  dispose() {
    for (const off of this.detach) off();
    this.detach = [];
    this.keys.clear();
    this.pointers.clear();
  }
}
