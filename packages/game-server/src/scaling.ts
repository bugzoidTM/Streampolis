import { RedisPresence } from '@colyseus/redis-presence';
import { RedisDriver } from '@colyseus/redis-driver';
import type { ServerOptions } from '@colyseus/core';

export interface ScalingConfig {
  redisUrl: string;
  publicAddress: string;
  distributed: boolean;
}

export function validateScaling(options: ScalingConfig): void {
  if (options.distributed && !options.redisUrl) {
    throw new Error('GAME_SERVER_DISTRIBUTED=1 requires REDIS_URL');
  }
  if (options.redisUrl && !options.publicAddress) {
    throw new Error('REDIS_URL requires a unique GAME_SERVER_PUBLIC_ADDRESS for this worker');
  }
  if (options.publicAddress) {
    if (/\s|:\/\/|[?#@]/.test(options.publicAddress)) {
      throw new Error('GAME_SERVER_PUBLIC_ADDRESS must be host[:port][/path], without scheme or credentials');
    }
    const address = new URL(`http://${options.publicAddress}`);
    if (!address.hostname) throw new Error('GAME_SERVER_PUBLIC_ADDRESS requires a hostname');
  }
  if (options.redisUrl) {
    const url = new URL(options.redisUrl);
    if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('REDIS_URL must use redis:// or rediss://');
    if (url.pathname && !/^\/\d*$/.test(url.pathname)) throw new Error('REDIS_URL database must be an integer');
  }
}

class HealthyRedisPresence extends RedisPresence {
  async check(): Promise<boolean> {
    if (this.pub.status !== 'ready' || this.sub.status !== 'ready') return false;
    await Promise.all([this.pub.ping(), this.sub.ping()]);
    return true;
  }
}

/** Redis is opt-in locally; a configured but unavailable Redis never falls back. */
export function createScaling(options: ScalingConfig): {
  serverOptions: Pick<ServerOptions, 'presence' | 'driver' | 'publicAddress'>;
  mode: 'local' | 'redis';
  ready: () => Promise<boolean>;
} {
  validateScaling(options);
  const publicAddress = options.publicAddress.replace(/\/$/, '') || undefined;
  if (!options.redisUrl) return { serverOptions: { publicAddress }, mode: 'local', ready: async () => true };

  const url = new URL(options.redisUrl);
  const redisOptions = {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: Number(url.pathname.slice(1) || 0),
    tls: url.protocol === 'rediss:' ? {} : undefined,
    connectTimeout: 5_000,
    commandTimeout: 1_500,
    maxRetriesPerRequest: 1,
  };
  const presence = new HealthyRedisPresence(redisOptions);
  const driver = new RedisDriver(redisOptions);
  return {
    serverOptions: { presence, driver, publicAddress },
    mode: 'redis',
    ready: async () => {
      try {
        const [connected] = await Promise.all([presence.check(), driver.has('__streampolis_health__')]);
        return connected;
      } catch {
        return false;
      }
    },
  };
}
