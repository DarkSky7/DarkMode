#!/usr/bin/env python3
"""Generate DarkMode icons (amber crescent on transparent) — pure stdlib PNG
writer, no Pillow. Sizes 16/32/48/128 per store requirements."""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "icons"
SIZES = [16, 32, 48, 128]
AMBER = (255, 176, 0)
DARK = (11, 15, 23)  # crescent inner (drawn opaque so it reads on any toolbar)


def png_bytes(size: int, pixels) -> bytes:
    """pixels: list of rows, each row list of (r,g,b,a)."""
    raw = b""
    for row in pixels:
        raw += b"\x00" + b"".join(struct.pack("4B", *px) for px in row)
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def make(size: int):
    # crescent: full amber disc at (0.58,0.50) minus dark disc at (0.42,0.42)
    cx1, cy1, r1 = 0.58 * size, 0.50 * size, 0.50 * size
    cx2, cy2, r2 = 0.44 * size, 0.42 * size, 0.46 * size
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            d1 = (x - cx1) ** 2 + (y - cy1) ** 2
            d2 = (x - cx2) ** 2 + (y - cy2) ** 2
            if d1 <= r1 * r1 and d2 > r2 * r2:
                # antialias edge lightly
                edge = min(r1 * r1 - d1, d2 - r2 * r2)
                a = 255 if edge > 1.5 else int(255 * max(0.0, edge / 1.5))
                row.append((AMBER[0], AMBER[1], AMBER[2], a))
            else:
                row.append((0, 0, 0, 0))
        rows.append(row)
    return png_bytes(size, rows)


def main():
    OUT.mkdir(exist_ok=True)
    for s in SIZES:
        p = OUT / f"icon{s}.png"
        p.write_bytes(make(s))
        print(f"wrote {p} ({p.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
