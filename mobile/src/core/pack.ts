// The website's trail-pack reader (web/src/lib/pack.ts), with the one part that needs a browser replaced:
// cells are raw DEFLATE, which the website unpacks with DecompressionStream; Hermes has none, so fflate does
// it here. Metro hands this file to everything that imports web/src/lib/pack.ts (see metro.config.js).
import { inflateSync, strFromU8 } from 'fflate';
import type { Pack } from '../../../web/src/lib/pack';

export * from '../../../web/src/lib/pack';

export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return inflateSync(data);
}

/** One block of a pack (a cell of trails, or "p:<cell>" highlights) as parsed JSON, or null if it has none. */
export async function readBlock<T = unknown>(pack: Pack, key: string): Promise<T | null> {
  const range = pack.header.cells[key];
  if (!range || range.length !== 2) return null;
  const start = pack.bodyStart + range[0];
  return JSON.parse(strFromU8(inflateSync(pack.bytes.subarray(start, start + range[1])))) as T;
}
