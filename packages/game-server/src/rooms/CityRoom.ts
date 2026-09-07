import type { Client } from '@colyseus/core';
import { CITY_SCENE_IDS, SCENES, type SceneId } from '../shared.js';
import type { AuthIdentity } from '../auth/AuthProvider.js';
import { config } from '../config.js';
import { BaseWorldRoom, type RoomCreateOptions } from './BaseWorldRoom.js';
import { CityMemberState, CityState, type PlayerState } from './schema.js';
import { CityInterest } from '../world/CityInterest.js';
import { GigTracker } from '../world/GigTracker.js';
import { defaultApiGateway } from '../api/ApiGateway.js';
import { MSG } from '../shared.js';

/**
 * Os cenários que esta sala hospeda.
 *
 * Vem do catálogo compartilhado (`cityRoom`), não de um literal aqui: o cliente
 * precisa da MESMA lista para não pedir na URL um cenário que esta sala recusa,
 * e enquanto eram dois literais em pacotes diferentes uma cena nova entrava só
 * num deles — com o jogador caindo na praça sem erro nenhum na tela.
 */
const CITY_SCENES: ReadonlySet<SceneId> = CITY_SCENE_IDS;

/**
 * Public walkable area (SPECs §17). One room per shard: when `central_plaza`
 * fills up the matchmaker creates central-plaza-002 instead of degrading the
 * first one, which is why capacity here is a hard ceiling and not a hint.
 */
export class CityRoom extends BaseWorldRoom<CityState> {
  sceneId: SceneId = 'central_plaza';
  private readonly interest = new CityInterest(config.cityAoiRadius, config.cityAoiLeaveRadius);
  /**
   * O sensor dos bicos (PRD §26). Só existe onde há bico para correr.
   *
   * Nulo na praça, na loja e nas torres de propósito: um rastreador que varre
   * um mapa vazio a cada seis tiques em todo shard da cidade é custo constante
   * para um recurso que só acontece num bairro.
   */
  private gigs: GigTracker | null = null;

  protected createState(): CityState {
    return new CityState();
  }

  override onCreate(options: RoomCreateOptions = {}): void {
    if (options.sceneId && CITY_SCENES.has(options.sceneId)) this.sceneId = options.sceneId;
    const scene = SCENES[this.sceneId];
    // Matchmaking forwards browser options into onCreate. Only the scene and
    // operator configuration may set this ceiling; a client must not expand
    // the shard (and its quadratic AOI work) by submitting capacity: 100000.
    super.onCreate({ ...options, capacity: Math.min(scene.capacity, config.cityCapacity) });

    // filterBy('sceneId') matches on metadata, so this is what keeps a player
    // asking for the store out of a plaza shard.
    this.setMetadata({ sceneId: this.sceneId, name: scene.name });

    if (this.sceneId === 'noir_district') {
      const api = defaultApiGateway();
      this.gigs = new GigTracker(api, ({ userId, result }) => {
        const client = this.clients.find(
          (c) => this.sessions.get(c.sessionId)?.identity.userId === userId,
        );
        client?.send(MSG.gigUpdate, result);
      });

      /**
       * "Aceitei um bico": o cliente pede a releitura, e a sala vai à API.
       *
       * O aviso não carrega qual bico é — se carregasse, o navegador estaria
       * escolhendo a própria rota e o próprio pagamento. É a mesma regra de
       * `redecorate`: o cliente diz *vá perguntar de novo*, nunca *é assim*.
       */
      this.onMessage(MSG.gigSync, (client) => {
        const identity = this.identityOf(client);
        if (identity) void this.gigs?.adopt(identity.userId);
      });
    }
  }

  protected override onPlayerJoined(client: Client, identity: AuthIdentity, player: PlayerState): void {
    this.state.members.set(client.sessionId, new CityMemberState().apply(player));
    // Initialize all views before the new client's full state is encoded.
    this.interest.update(this.clients, this.state.players);
    // Quem entra no bairro já correndo um bico continua correndo: a corrida é
    // da API e sobrevive a trocar de sala, a recarregar a página e a este
    // processo reiniciar.
    void this.gigs?.adopt(identity.userId);
    this.systemChat(`${identity.displayName} chegou.`);
  }

  protected override onPlayerRemoving(sessionId: string, player: PlayerState): void {
    this.interest.remove(this.clients, player);
    this.state.members.delete(sessionId);
  }

  protected override onAppearanceChanged(client: Client, player: PlayerState): void {
    this.state.members.get(client.sessionId)?.apply(player);
  }

  protected override onTick(): void {
    this.interest.update(this.clients, this.state.players);
    // A posição vem do ESTADO da sala, que é a que o servidor acabou de
    // integrar — não de nada que o cliente tenha mandado.
    this.gigs?.tick((userId) => {
      for (const [sessionId, session] of this.sessions) {
        if (session.identity.userId !== userId) continue;
        const player = this.state.players.get(sessionId);
        return player ? { x: player.x, z: player.z } : null;
      }
      return null;
    });
  }

  protected override onPlayerLeft(_client: Client, identity: AuthIdentity): void {
    this.gigs?.forget(identity.userId);
    this.systemChat(`${identity.displayName} saiu.`);
  }
}
