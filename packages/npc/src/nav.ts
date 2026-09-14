import { PLAYER_RADIUS, SCENE_AREA, SCENE_COLLIDERS, penetrates, type Collider, type SceneId } from './shared.js';
import type { Point } from './walker.js';

/**
 * Caminho por grade, para quando a reta não serve.
 *
 * A orientação local do `Walker` (girar a direção até o próximo passo não
 * entrar em nada) atravessa uma praça e contorna um banco; não contorna um
 * balcão de quatro metros nem entra num beco por uma abertura de sete — e os
 * três postos atrás de balcão (DJ, recepção, loja) ficaram inalcançáveis por
 * isso. Aqui a cena vira uma grade de 0,5 m marcada como pisável ou não, um
 * A* liga origem a destino, e o caminho é encurtado: só ficam os pontos em
 * que a reta seguinte esbarraria em algo. As pernas continuam as mesmas —
 * recebem um ponto de cada vez —, e o servidor continua o único que move.
 *
 * Custo: a grade é construída uma vez por cena (a maior tem ~25 mil células);
 * um A* custa poucos milissegundos e acontece só quando a reta está bloqueada.
 */
const CELL = 0.5;
const MAX_EXPAND = 60_000;

interface Grid {
  x0: number;
  z0: number;
  w: number;
  h: number;
  walk: Uint8Array;
  colliders: readonly Collider[];
}

const grids = new Map<SceneId, Grid>();

function bounds(id: SceneId): { x0: number; z0: number; x1: number; z1: number } {
  const a = SCENE_AREA[id];
  if (!a) return { x0: -60, z0: -60, x1: 60, z1: 60 };
  if (a.kind === 'circle') return { x0: a.x - a.r, z0: a.z - a.r, x1: a.x + a.r, z1: a.z + a.r };
  return { x0: a.x - a.hw, z0: a.z - a.hd, x1: a.x + a.hw, z1: a.z + a.hd };
}

function inside(id: SceneId, p: Point): boolean {
  const a = SCENE_AREA[id];
  if (!a) return true;
  if (a.kind === 'circle') return Math.hypot(p.x - a.x, p.z - a.z) <= a.r - PLAYER_RADIUS;
  return Math.abs(p.x - a.x) <= a.hw - PLAYER_RADIUS && Math.abs(p.z - a.z) <= a.hd - PLAYER_RADIUS;
}

export function grid(id: SceneId): Grid {
  let g = grids.get(id);
  if (g) return g;
  const b = bounds(id);
  const w = Math.ceil((b.x1 - b.x0) / CELL) + 1;
  const h = Math.ceil((b.z1 - b.z0) / CELL) + 1;
  const colliders = SCENE_COLLIDERS[id] ?? [];
  const walk = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const p = { x: b.x0 + i * CELL, z: b.z0 + j * CELL };
      walk[j * w + i] = inside(id, p) && !penetrates(p, colliders, PLAYER_RADIUS + 0.05) ? 1 : 0;
    }
  }
  g = { x0: b.x0, z0: b.z0, w, h, walk, colliders };
  grids.set(id, g);
  return g;
}

/** A reta entre dois pontos passa sem entrar em nada? (amostrada a cada 0,25 m) */
export function segmentFree(id: SceneId, a: Point, b: Point): boolean {
  const colliders = SCENE_COLLIDERS[id] ?? [];
  const d = Math.hypot(b.x - a.x, b.z - a.z);
  const n = Math.max(1, Math.ceil(d / 0.25));
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const p = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    if (penetrates(p, colliders, PLAYER_RADIUS + 0.02) || !inside(id, p)) return false;
  }
  return true;
}

function cellOf(g: Grid, p: Point): [number, number] {
  return [Math.round((p.x - g.x0) / CELL), Math.round((p.z - g.z0) / CELL)];
}

/** A célula pisável mais perto (até 3 células), para origem/destino encostados num móvel. */
function snap(g: Grid, i: number, j: number): [number, number] | null {
  if (i >= 0 && j >= 0 && i < g.w && j < g.h && g.walk[j * g.w + i]) return [i, j];
  for (let r = 1; r <= 3; r++) {
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const x = i + di;
        const y = j + dj;
        if (x >= 0 && y >= 0 && x < g.w && y < g.h && g.walk[y * g.w + x]) return [x, y];
      }
    }
  }
  return null;
}

/** Fila de prioridade mínima (heap binário) sobre índices de célula. */
class Heap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size(): number { return this.keys.length; }
  push(key: number, val: number): void {
    this.keys.push(key); this.vals.push(val);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p]! <= this.keys[i]!) break;
      [this.keys[p], this.keys[i]] = [this.keys[i]!, this.keys[p]!];
      [this.vals[p], this.vals[i]] = [this.vals[i]!, this.vals[p]!];
      i = p;
    }
  }
  pop(): number {
    const top = this.vals[0]!;
    const lk = this.keys.pop()!;
    const lv = this.vals.pop()!;
    if (this.keys.length) {
      this.keys[0] = lk; this.vals[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && this.keys[l]! < this.keys[m]!) m = l;
        if (r < this.keys.length && this.keys[r]! < this.keys[m]!) m = r;
        if (m === i) break;
        [this.keys[m], this.keys[i]] = [this.keys[i]!, this.keys[m]!];
        [this.vals[m], this.vals[i]] = [this.vals[i]!, this.vals[m]!];
        i = m;
      }
    }
    return top;
  }
}

/**
 * O caminho de `from` a `to` como lista de pontos INTERMEDIÁRIOS (sem a
 * origem, com o destino no fim), já encurtado. Nulo se não há caminho.
 * Vazio quando a reta já serve.
 */
export function findPath(id: SceneId, from: Point, to: Point): Point[] | null {
  if (segmentFree(id, from, to)) return [to];
  const g = grid(id);
  const s = snap(g, ...cellOf(g, from));
  const t = snap(g, ...cellOf(g, to));
  if (!s || !t) return null;
  const start = s[1] * g.w + s[0];
  const goal = t[1] * g.w + t[0];
  const came = new Int32Array(g.w * g.h).fill(-1);
  const cost = new Float32Array(g.w * g.h).fill(Infinity);
  const open = new Heap();
  cost[start] = 0;
  open.push(0, start);
  const hx = (idx: number) => {
    const di = Math.abs((idx % g.w) - t[0]);
    const dj = Math.abs(Math.floor(idx / g.w) - t[1]);
    return Math.max(di, dj) + (Math.SQRT2 - 1) * Math.min(di, dj);
  };
  let expanded = 0;
  let found = false;
  while (open.size) {
    const cur = open.pop();
    if (cur === goal) { found = true; break; }
    if (++expanded > MAX_EXPAND) break;
    const ci = cur % g.w;
    const cj = Math.floor(cur / g.w);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = ci + di;
        const nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= g.w || nj >= g.h) continue;
        const n = nj * g.w + ni;
        if (!g.walk[n]) continue;
        // Diagonal só se os dois ortogonais estão livres: sem cortar quina de móvel.
        if (di && dj && (!g.walk[cj * g.w + ni] || !g.walk[nj * g.w + ci])) continue;
        const step = di && dj ? Math.SQRT2 : 1;
        const c = cost[cur]! + step;
        if (c < cost[n]!) {
          cost[n] = c;
          came[n] = cur;
          open.push(c + hx(n), n);
        }
      }
    }
  }
  if (!found) return null;
  const cells: Point[] = [];
  for (let c = goal; c !== -1 && c !== start; c = came[c]!) {
    cells.push({ x: g.x0 + (c % g.w) * CELL, z: g.z0 + Math.floor(c / g.w) * CELL });
  }
  cells.reverse();
  if (cells.length) cells[cells.length - 1] = to; else cells.push(to);
  // Encurtar: de cada ponto, pular para o mais distante que a reta alcança.
  const out: Point[] = [];
  let anchor = from;
  let k = 0;
  while (k < cells.length) {
    let far = k;
    for (let m = cells.length - 1; m > k; m--) {
      if (segmentFree(id, anchor, cells[m]!)) { far = m; break; }
    }
    out.push(cells[far]!);
    anchor = cells[far]!;
    k = far + 1;
  }
  return out;
}
