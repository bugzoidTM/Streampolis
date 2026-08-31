/**
 * Remote avatar smoothing (SPECs §20).
 *
 * Patches arrive at ~20 Hz and the browser draws at 60. Moving a remote avatar
 * straight to each packet is the classic jitter bug: the avatar teleports a
 * few centimetres every 50 ms and any camera near it shakes. So every remote
 * pose goes into a small buffer and the renderer reads the world slightly in
 * the past, where two samples always bracket the moment being drawn.
 */

/** How far behind the newest packet the renderer draws. Two patch intervals. */
export const INTERP_DELAY_MS = 100;

/** Beyond this the buffer is treated as a fresh start, not a long lerp. */
const TELEPORT_DISTANCE = 6;
const BUFFER_MS = 1_000;

export interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Shortest-arc interpolation; without it a turn across ±π spins the long way. */
export function lerpAngle(a: number, b: number, k: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

export class RemoteBuffer {
  private samples: Sample[] = [];

  push(sample: Sample): void {
    const last = this.samples[this.samples.length - 1];
    if (last) {
      // Out-of-order or duplicate patch: keep the buffer monotonic in time.
      if (sample.t <= last.t) return;
      const jump = Math.hypot(sample.x - last.x, sample.z - last.z);
      if (jump > TELEPORT_DISTANCE) {
        // A scene change or a server correction. Interpolating across it would
        // drag the avatar through walls for a whole second.
        this.samples = [sample];
        return;
      }
    }
    this.samples.push(sample);
    const cutoff = sample.t - BUFFER_MS;
    while (this.samples.length > 2 && (this.samples[0] as Sample).t < cutoff) this.samples.shift();
  }

  get latest(): Sample | undefined {
    return this.samples[this.samples.length - 1];
  }

  /** Pose at `now`, rendered INTERP_DELAY_MS in the past. */
  sample(now: number): Sample | null {
    if (this.samples.length === 0) return null;
    const target = now - INTERP_DELAY_MS;
    const first = this.samples[0] as Sample;
    const last = this.samples[this.samples.length - 1] as Sample;

    // Not enough history yet, or the sender went quiet: hold the last known
    // pose. Extrapolating here is what produces avatars that walk into walls.
    if (target <= first.t) return { ...first, t: target };
    if (target >= last.t) return { ...last, t: target };

    for (let i = this.samples.length - 1; i > 0; i--) {
      const b = this.samples[i] as Sample;
      const a = this.samples[i - 1] as Sample;
      if (target >= a.t && target <= b.t) {
        const span = b.t - a.t;
        const k = span > 0 ? (target - a.t) / span : 1;
        return {
          t: target,
          x: a.x + (b.x - a.x) * k,
          y: a.y + (b.y - a.y) * k,
          z: a.z + (b.z - a.z) * k,
          yaw: lerpAngle(a.yaw, b.yaw, k),
        };
      }
    }
    return { ...last, t: target };
  }

  clear(): void {
    this.samples = [];
  }
}
