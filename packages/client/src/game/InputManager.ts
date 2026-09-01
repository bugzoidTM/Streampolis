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
  /** Zoom delta, positive pulls the camera back. */
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

  private keys = new Set<string>();
  private pressedThisFrame = new Set<string>();
  private pointers = new Map<number, { x: number; y: number; startX: number; startY: number; stick: boolean }>();
  private stickId: number | null = null;
  private lookId: number | null = null;
  private mouseLook = false;
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
    // A window blur with keys held would latch movement on forever.
    this.on(window, 'blur', () => this.keys.clear());

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
      if (!isTouch && ev.button === 2) this.mouseLook = true;
      this.state.pointerDown = true;
    });

    const endPointer = (e: Event) => {
      const ev = e as PointerEvent;
      this.pointers.delete(ev.pointerId);
      if (this.stickId === ev.pointerId) this.stickId = null;
      if (this.lookId === ev.pointerId) this.lookId = null;
      if (ev.button === 2) this.mouseLook = false;
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
      if (ev.pointerType === 'mouse' && !this.mouseLook) return;
      this.state.lookYaw -= dx * 0.0042;
      this.state.lookPitch -= dy * 0.0042;
    });

    this.on(el, 'wheel', (e) => {
      const ev = e as WheelEvent;
      ev.preventDefault();
      this.state.zoom += Math.sign(ev.deltaY) * 0.42;
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
