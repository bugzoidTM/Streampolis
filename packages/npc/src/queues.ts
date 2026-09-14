import type { Poi } from './poi.js';
import type { Point } from './walker.js';

/**
 * Filas curtas e ordenadas num ponto de serviço (frente do quiosque, bar do
 * clube). Registro do processo POR SALA: cada personagem que entra recebe um
 * índice; a vaga é a cabeça deslocada `spacing × índice` na direção da fila;
 * quem sai faz os de trás avançarem (o índice deles cai e a vaga muda, e é
 * o Walker que os leva). O primeiro "é atendido" por alguns segundos e vai
 * embora. Nenhuma compra acontece — é postura, como tudo o que os figurantes
 * fazem.
 */
const lines = new Map<string, string[]>();

function key(roomId: string, poiId: string): string {
  return `${roomId}|${poiId}`;
}

export const QUEUES = {
  /** Entra na fila; nulo se está cheia. */
  join(roomId: string, poi: Poi, npcId: string): number | null {
    if (!poi.queue) return null;
    const k = key(roomId, poi.id);
    const line = lines.get(k) ?? [];
    const idx = line.indexOf(npcId);
    if (idx >= 0) return idx;
    if (line.length >= poi.queue.max) return null;
    line.push(npcId);
    lines.set(k, line);
    return line.length - 1;
  },
  indexOf(roomId: string, poi: Poi, npcId: string): number {
    return (lines.get(key(roomId, poi.id)) ?? []).indexOf(npcId);
  },
  length(roomId: string, poi: Poi): number {
    return (lines.get(key(roomId, poi.id)) ?? []).length;
  },
  leave(roomId: string, poi: Poi, npcId: string): void {
    const k = key(roomId, poi.id);
    const line = lines.get(k);
    if (!line) return;
    const i = line.indexOf(npcId);
    if (i >= 0) line.splice(i, 1);
    if (!line.length) lines.delete(k);
  },
  /** Onde fica quem está no índice `i`. */
  slot(poi: Poi, i: number): Point {
    const q = poi.queue!;
    return { x: q.head.x + q.dir.x * q.spacing * i, z: q.head.z + q.dir.z * q.spacing * i };
  },
  reset(): void {
    lines.clear();
  },
};
