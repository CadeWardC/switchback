#!/usr/bin/env python3
"""Where the bytes of a base-map file go: by zoom and by layer.

    measure_base_map.py <map.pmtiles> [more.pmtiles …]

For each file (PMTiles of vector tiles, as Planetiler writes them): its size, the bytes at each zoom, and each
layer's share. A layer's share is its bytes compressed on its own, which adds up to a little more than the tiles do
(layers in one tile compress slightly better together), so read the shares as proportions. A tile stored once and
used in many places (open water) is counted once. Needs `pip install pmtiles`.
"""
import gzip, hashlib, os, sys, zlib
from collections import defaultdict

from pmtiles.reader import MmapSource, all_tiles

def varint(b, i):
    v = shift = 0
    while True:
        c = b[i]
        i += 1
        v |= (c & 0x7F) << shift
        if c < 0x80:
            return v, i
        shift += 7

def fields(b):
    """(field number, value) for each field of a protobuf message; length-delimited values as bytes."""
    i = 0
    while i < len(b):
        key, i = varint(b, i)
        kind = key & 7
        if kind == 0:
            v, i = varint(b, i)
        elif kind == 2:
            n, i = varint(b, i)
            v, i = b[i:i + n], i + n
        elif kind == 5:
            v, i = b[i:i + 4], i + 4
        elif kind == 1:
            v, i = b[i:i + 8], i + 8
        else:
            raise ValueError("not a vector tile")
        yield key >> 3, v

def layers(tile):
    """(layer name, the layer's bytes) for each layer of a vector tile."""
    for number, layer in fields(tile):
        if number == 3:
            name = next((v for n, v in fields(layer) if n == 1), b"?")
            yield name.decode("utf-8", "replace"), layer

def measure(path):
    by_zoom, by_layer, tiles_at = defaultdict(int), defaultdict(int), defaultdict(int)
    seen = set()
    with open(path, "rb") as f:
        for (z, _x, _y), data in all_tiles(MmapSource(f)):
            mark = hashlib.blake2b(data, digest_size=12).digest()
            if mark in seen:
                continue
            seen.add(mark)
            by_zoom[z] += len(data)
            tiles_at[z] += 1
            raw = gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data
            for name, layer in layers(raw):
                by_layer[name] += len(zlib.compress(layer, 6))
    return os.path.getsize(path), by_zoom, tiles_at, by_layer

def mb(n):
    return f"{n / 1e6:8.2f} MB"

def main():
    for path in sys.argv[1:]:
        size, by_zoom, tiles_at, by_layer = measure(path)
        print(f"{path}: {mb(size).strip()}")
        tiles = sum(by_zoom.values()) or 1
        print("  by zoom")
        for z in sorted(by_zoom):
            print(f"    z{z:<3}{mb(by_zoom[z])} {100 * by_zoom[z] / tiles:5.1f}%  {tiles_at[z]} tiles")
        total = sum(by_layer.values()) or 1
        print("  by layer")
        for name, n in sorted(by_layer.items(), key=lambda kv: -kv[1]):
            print(f"    {name:<20}{mb(n)} {100 * n / total:5.1f}%")
        print()

if __name__ == "__main__":
    main()
