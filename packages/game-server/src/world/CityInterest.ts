import type { Client } from '@colyseus/core';
import { StateView, type MapSchema } from '@colyseus/schema';
import type { PlayerState } from '../rooms/schema.js';

/** Per-client body visibility. Never changes membership, presence, or movement. */
export class CityInterest {
  private readonly enterSquared: number;
  private readonly leaveSquared: number;

  constructor(enterRadius: number, leaveRadius: number) {
    if (!Number.isFinite(enterRadius) || enterRadius <= 0
      || !Number.isFinite(leaveRadius) || leaveRadius < enterRadius) {
      throw new Error('City AOI requires 0 < enter radius <= leave radius');
    }
    this.enterSquared = enterRadius ** 2;
    this.leaveSquared = leaveRadius ** 2;
  }

  update(clients: readonly Pick<Client, 'sessionId' | 'view'>[], players: MapSchema<PlayerState>): void {
    // City shards are capped at 36: at most 1,296 squared-distance checks.
    // A wider leave radius prevents full re-sends on every boundary crossing.
    for (const client of clients) {
      const observer = players.get(client.sessionId);
      if (!observer) continue;
      const view = client.view ??= new StateView();
      for (const [sessionId, player] of players) {
        const visible = view.has(player);
        const distanceSquared = (observer.x - player.x) ** 2 + (observer.z - player.z) ** 2;
        const wanted = sessionId === client.sessionId
          || distanceSquared <= (visible ? this.leaveSquared : this.enterSquared);
        if (wanted && !visible) view.add(player);
        else if (!wanted && visible) view.remove(player);
      }
    }
  }

  /** Must run BEFORE MapSchema.delete(), while StateView can find the parent. */
  remove(clients: readonly Pick<Client, 'view'>[], player: PlayerState): void {
    for (const client of clients) {
      if (client.view?.has(player)) client.view.remove(player);
    }
  }
}
