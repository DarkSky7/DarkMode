#!/usr/bin/env python3
"""Generate DarkMode action icons — pure stdlib PNG writer, no Pillow.

Two glyphs, amber (#FFB000) on transparent, 2x supersampled for clean edges:
  icon{size}.png  = crescent moon  (dark mode ACTIVE)
  sun{size}.png   = sun w/ rays    (disabled / nothing darkened)
Sizes 16/32/48/128 per store requirements.
"""
import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "icons"
SIZES = [16, 32, 48, 128]
AMBER = (255, 176, 0)


def png_bytes(size: int, pixels) -> bytes:
    """pixels: list of rows, each row list of (r,g,b,a)."""
    raw = b""
    for row in pixels:
        raw += b"\x00" + b"".join(struct.pack("4B", *px) for px in row)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def sample(S: int, x: float, y: float, sun: bool) -> tuple:
    """Return RGBA at pixel-center coords in a 0..S canvas."""
    if sun:
        cx = cy = 0.5 * S
        r = 0.30 * S          # disc radius
        dx, dy = x - cx, y - cy
        d = math.hypot(dx, dy)
        if d <= r:
            return AMBER + (255,)
        ri, ro = 0.36 * S, 0.48 * S          # rays span
        if ri <= d <= ro:
            ang = math.atan2(dy, dx)
            # 8 rays, first pointing up
            k = round((ang + math.pi / 2) / (math.pi / 4))
            ca = -math.pi / 2 + k * math.pi / 4
            diff = abs((ang - ca + math.pi) % (2 * math.pi) - math.pi)
            if diff <= 0.105:                 # angular half-width
                return AMBER + (255,)
        return (0, 0, 0, 0)
    # crescent: amber disc minus offset cutout
    S = float(S)
    cx1, cy1, r1 = 0.58 * S, 0.50 * S, 0.50 * S
    cx2, cy2, r2 = 0.44 * S, 0.42 * S, 0.46 * S
    d1 = (x - cx1) ** 2 + (y - cy1) ** 2
    d2 = (x - cx2) ** 2 + (y - cy2) ** 2
    if d1 <= r1 * r1 and d2 > r2 * r2:
        return AMBER + (255,)
    return (0, 0, 0, 0)


def make(size: int, sun: bool):
    S2 = size * 2                      # supersample
    rows = []
    for oy in range(size):
        row = []
        for ox in range(size):
            acc = [0, 0, 0, 0]
            for sy in (0, 1):
                for sx in (0, 1):
                    px = sample(S2, (ox * 2 + sx) + 0.5, (oy * 2 + sy) + 0.5, sun)
                    for i in range(4):
                        acc[i] += px[i]
            row.append(tuple(v // 4 for v in acc))
        rows.append(row)
    return png_bytes(size, rows)


def main():
    OUT.mkdir(exist_ok=True)
    for s in SIZES:
        for name, sun in (("icon", False), ("sun", True)):
            p = OUT / f"{name}{s}.png"
            p.write_bytes(make(s, sun))
            print(f"wrote {p} ({p.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
