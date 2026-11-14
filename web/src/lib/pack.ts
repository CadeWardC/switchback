// Trail packs: one file per state or province (mirrors Switchback/Services/TrailPacks.swift).
//   "SBTP1", a 4-byte big-endian header length, the header JSON, then the body.
//   Header: {version, cell: 0.25, cells: {"<row>_<col>": [offset, length], "p:<row>_<col>": [offset, length]}}
//   Offsets count from the end of the header. Every block is raw DEFLATE around a JSON array.
import type { BBox } from './geo';
import { intersects } from './geo';

export interface Region {
  region: string;
  name?: string;
  country?: string;
  version: string;
  bbox: BBox;
  coverage?: string[];
  bytes?: number;
  trails?: number;
}

export interface PackHeader {
  version: string;
  cell: number;
  cells: Record<string, [number, number]>;
}

export interface Pack {
  header: PackHeader;
  bytes: Uint8Array;
  bodyStart: number;
}

const MAGIC = 'SBTP1';

export function openPack(buffer: ArrayBuffer | Uint8Array): Pack {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 9) throw new Error('Not a trail file: too short');
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC.charCodeAt(i)) throw new Error('Not a trail file: wrong start');
  }
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(5, false);
  if (length <= 0 || length > 50_000_000 || 9 + length > bytes.length) throw new Error('Not a trail file: bad header');
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(9, 9 + length))) as PackHeader;
  return { header, bytes, bodyStart: 9 + length };
}

export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** One block of a pack (a cell of trails, or "p:<cell>" highlights) as parsed JSON, or null if it has none. */
export async function readBlock<T = unknown>(pack: Pack, key: string): Promise<T | null> {
  const range = pack.header.cells[key];
  if (!range || range.length !== 2) return null;
  const start = pack.bodyStart + range[0];
  const raw = await inflateRaw(pack.bytes.subarray(start, start + range[1]));
  return JSON.parse(new TextDecoder().decode(raw)) as T;
}

/** The keys of the cells a box touches. */
export function cellKeys(box: BBox, size: number): string[] {
  const r0 = Math.floor(box[0] / size), r1 = Math.floor(box[2] / size);
  const c0 = Math.floor(box[1] / size), c1 = Math.floor(box[3] / size);
  const out: string[] = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push(`${r}_${c}`);
  return out;
}

export function cellKeyOf(lat: number, lon: number, size: number): string {
  return `${Math.floor(lat / size)}_${Math.floor(lon / size)}`;
}

/** Whether a region has trails in a box: its bounds touch it, and so does one of its 1° squares with trails. */
export function regionCovers(r: Region, box: BBox): boolean {
  if (!r.bbox || r.bbox.length !== 4) return false;
  const b: BBox = [r.bbox[0] - 0.05, r.bbox[1] - 0.05, r.bbox[2] + 0.05, r.bbox[3] + 0.05];
  if (!intersects(b, box)) return false;
  if (!r.coverage || r.coverage.length === 0) return true;
  const set = new Set(r.coverage);
  for (let lat = Math.floor(box[0]); lat <= Math.floor(box[2]); lat++) {
    for (let lon = Math.floor(box[1]); lon <= Math.floor(box[3]); lon++) {
      if (set.has(`${lat}_${lon}`)) return true;
    }
  }
  return false;
}
