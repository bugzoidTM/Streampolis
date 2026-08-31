import { ArraySchema, MapSchema, Schema, type } from '@colyseus/schema';
import type { AnimState, AvatarConfig, PKPhase, SceneId } from '../shared.js';

/**
 * Synchronised state (SPECs §19). Two rules shape everything here:
 *
 *   1. Positions travel as float32. A double per axis per player per tick is
 *      the single fattest thing a city room could send, and 24-bit mantissa is
 *      still millimetre-accurate over a 80 m plaza.
 *   2. Cosmetics are NOT continuous state. AvatarState changes on join and on
 *      a wardrobe swap; it must never be touched inside the tick loop.
 */

export class AvatarState extends Schema {
  @type('uint8') bodyPreset = 0;
  @type('uint8') skinTone = 3;
  @type('uint8') facePreset = 0;
  @type('string') hair = '';
  @type('uint8') hairColor = 0;
  @type('string') top = '';
  @type('string') bottom = '';
  @type('string') shoes = '';
  @type('string') accessory = '';
  @type('float32') height = 1;

  apply(cfg: AvatarConfig): this {
    this.bodyPreset = cfg.bodyPreset;
    this.skinTone = cfg.skinTone;
    this.facePreset = cfg.facePreset;
    this.hair = cfg.hair;
    this.hairColor = cfg.hairColor;
    this.top = cfg.top;
    this.bottom = cfg.bottom;
    this.shoes = cfg.shoes;
    this.accessory = cfg.accessory;
    this.height = cfg.height;
    return this;
  }

  toConfig(): AvatarConfig {
    return {
      bodyPreset: this.bodyPreset,
      skinTone: this.skinTone,
      facePreset: this.facePreset,
      hair: this.hair,
      hairColor: this.hairColor,
      top: this.top,
      bottom: this.bottom,
      shoes: this.shoes,
      accessory: this.accessory,
      height: this.height,
    };
  }
}

/** What a player is allowed to do in this particular room. */
export type RoomRole = 'visitor' | 'owner' | 'host' | 'cohost' | 'spectator';

export class PlayerState extends Schema {
  @type('string') id = '';
  @type('string') name = '';
  @type('float32') x = 0;
  @type('float32') y = 0;
  @type('float32') z = 0;
  @type('float32') yaw = 0;
  @type('string') anim: AnimState = 'idle';
  @type('boolean') moving = false;
  @type('uint8') gifterLevel = 0;
  @type('string') agency = '';
  @type('string') role: RoomRole = 'visitor';
  @type(AvatarState) avatar = new AvatarState();
}

export class PKStateSchema extends Schema {
  @type('string') phase: PKPhase = 'WAITING';
  @type('string') hostA = '';
  @type('string') hostB = '';
  @type('string') nameA = '';
  @type('string') nameB = '';
  @type('uint32') scoreA = 0;
  @type('uint32') scoreB = 0;
  /** Epoch ms. The client renders the countdown; it never computes it. */
  @type('float64') endsAt = 0;
  @type('string') winnerId = '';
}

/** City, lobby, store, agency, apartment — anything you walk around in. */
export class WorldState extends Schema {
  @type('string') sceneId: SceneId = 'central_plaza';
  @type('string') shard = '';
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  /** Server tick counter; useful for client-side debug overlays. */
  @type('uint32') tick = 0;
}

export class ApartmentState extends WorldState {
  @type('string') ownerId = '';
  @type('string') ownerName = '';
  /** Item ids placed by the owner, in placement order (PRD §8). */
  @type(['string']) decor = new ArraySchema<string>();
}

/**
 * Live room state (SPECs §10, §17). Deliberately thin: `players` here holds
 * the stage only — host and co-host. A spectator is a viewer count and a chat
 * badge, never a walking avatar, and that is what makes a 100-viewer live
 * cheaper than a 36-player plaza.
 */
export class LiveState extends WorldState {
  @type('string') liveId = '';
  @type('string') hostId = '';
  @type('string') hostName = '';
  @type('string') title = '';
  @type('string') category = '';
  @type('boolean') isPK = false;
  @type('boolean') ended = false;
  @type('float64') startedAt = 0;
  @type('uint32') viewers = 0;
  @type('uint32') likes = 0;
  @type('uint32') coinsReceived = 0;
  @type('string') agency = '';
  @type(PKStateSchema) pk = new PKStateSchema();
}
