/** Preparation for separately authored wardrobe copies; not enabled by AvatarV2. */
export type WardrobeLodLevel = 0 | 1 | 2;
export type WardrobeLodSlot = 'top' | 'bottom' | 'shoes';

export interface WardrobeLodAsset {
  level: 1 | 2;
  file: string;
  triangles: number;
  sha256: string;
}

export interface WardrobeLodPart {
  slot: WardrobeLodSlot;
  sourceSha256: string;
  levels: WardrobeLodAsset[];
}

export interface WardrobeLodManifest {
  version: 1;
  parts: Record<string, WardrobeLodPart>;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Schema validation only. Asset/bind/skin validation belongs to the offline gate. */
export function parseWardrobeLodManifest(input: unknown): WardrobeLodManifest | null {
  if (!object(input) || input.version !== 1 || !object(input.parts)) return null;
  const parts: Record<string, WardrobeLodPart> = Object.create(null);
  for (const [id, value] of Object.entries(input.parts)) {
    if (!/^[mf]_[a-z0-9_]+_(top|bottom|shoes)$/.test(id) || !object(value)
      || !['top', 'bottom', 'shoes'].includes(value.slot as string)
      || !id.endsWith(`_${value.slot}`) || !hash(value.sourceSha256)
      || !Array.isArray(value.levels) || value.levels.length < 1 || value.levels.length > 2) return null;
    const levels: WardrobeLodAsset[] = [];
    for (const asset of value.levels) {
      if (!object(asset) || (asset.level !== 1 && asset.level !== 2)
        || asset.file !== `${id}.lod${asset.level}.glb` || !hash(asset.sha256)
        || !Number.isInteger(asset.triangles) || (asset.triangles as number) < 1
        || levels.some(previous => previous.level === asset.level)) return null;
      levels.push({ level: asset.level, file: asset.file, triangles: asset.triangles as number, sha256: asset.sha256 });
    }
    levels.sort((a, b) => a.level - b.level);
    if (levels.length === 2 && levels[1].triangles >= levels[0].triangles) return null;
    parts[id] = { slot: value.slot as WardrobeLodSlot, sourceSha256: value.sourceSha256, levels };
  }
  return { version: 1, parts };
}

/** Hysteresis prevents repeated downloads/swaps while hovering near a boundary. */
export function chooseWardrobeLod(distance: number, current: WardrobeLodLevel): WardrobeLodLevel {
  if (!Number.isFinite(distance) || distance < 0) return 0;
  if (current === 2 && distance >= 22) return 2;
  if (distance >= 26) return 2;
  if (current !== 0 && distance >= 10) return 1;
  return distance >= 14 ? 1 : 0;
}

/** Missing, failed, or unvalidated copies always fall back toward the original. */
export function selectWardrobeLod(
  id: string, distance: number, current: WardrobeLodLevel,
  manifest: WardrobeLodManifest | null, availableFiles: ReadonlySet<string>,
): { level: WardrobeLodLevel; file: string } {
  const original = { level: 0 as const, file: `${id}.glb` };
  // Heads and the generated under_body lining remain LOD0 until facial and
  // outfit-clearance gates can validate a separate implementation for them.
  if (id.endsWith('_head') || id === 'under_body') return original;
  const part = manifest?.parts[id];
  if (!part) return original;
  const wanted = chooseWardrobeLod(distance, current);
  const asset = [...part.levels].reverse().find(entry => entry.level <= wanted && availableFiles.has(entry.file));
  return asset ? { level: asset.level, file: asset.file } : original;
}
