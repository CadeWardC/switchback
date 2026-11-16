// Google encoded polylines at 1e-5 precision, and plain integers in the same alphabet
// (mirrors Switchback/Model/Compact.swift).

export type Coord = [lat: number, lon: number];

/** Signed integers written as polyline varints. */
export function decodeInts(s: string): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < s.length) {
    let result = 0, shift = 0;
    while (i < s.length) {
      const b = s.charCodeAt(i++) - 63;
      // multiplication instead of << so values past 31 bits stay right
      result += (b & 0x1f) * 2 ** shift;
      shift += 5;
      if (b < 0x20) break;
    }
    out.push(result % 2 ? -(result + 1) / 2 : result / 2);
  }
  return out;
}

export function decodePolyline(s: string): Coord[] {
  const ints = decodeInts(s);
  const out: Coord[] = [];
  let lat = 0, lon = 0;
  for (let i = 0; i + 1 < ints.length; i += 2) {
    lat += ints[i];
    lon += ints[i + 1];
    out.push([lat / 1e5, lon / 1e5]);
  }
  return out;
}

export function encodePolyline(coords: Coord[]): string {
  let out = '';
  let pLat = 0, pLon = 0;
  const put = (v: number) => {
    let x = v < 0 ? -2 * v - 1 : 2 * v;
    while (x >= 0x20) {
      out += String.fromCharCode((0x20 | (x % 32)) + 63);
      x = Math.floor(x / 32);
    }
    out += String.fromCharCode(x + 63);
  };
  for (const [la, lo] of coords) {
    const lat = Math.round(la * 1e5), lon = Math.round(lo * 1e5);
    put(lat - pLat);
    put(lon - pLon);
    pLat = lat;
    pLon = lon;
  }
  return out;
}
