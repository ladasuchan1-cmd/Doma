#!/usr/bin/env python3
"""Vygeneruje PNG ikony (štít s vykřičníkem) bez externích knihoven."""
import struct, zlib, math, os

def png(width, height, rows):
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    raw = b''.join(b'\x00' + bytes(r) for r in rows)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')

def inside_shield(x, y, s):
    # normalizované souřadnice 0..1
    u, v = x / s, y / s
    if v < 0.08 or u < 0.1 or u > 0.9: return False
    if v < 0.55: return True
    # spodní špička
    cx = 0.5
    half = 0.4 * (1 - (v - 0.55) / 0.42)
    return abs(u - cx) <= max(half, 0) and v <= 0.97

def render(s):
    rows = []
    ss = 3  # supersampling
    for y in range(s):
        row = []
        for x in range(s):
            r = g = b = a = 0
            for sy in range(ss):
                for sx in range(ss):
                    px = x + (sx + 0.5) / ss; py = y + (sy + 0.5) / ss
                    if inside_shield(px, py, s):
                        u, v = px / s, py / s
                        col = (31, 41, 51)
                        # vykřičník
                        if abs(u - 0.5) < 0.08 and 0.24 < v < 0.58: col = (255, 200, 40)
                        if (u - 0.5) ** 2 + (v - 0.70) ** 2 < 0.075 ** 2: col = (255, 200, 40)
                        r += col[0]; g += col[1]; b += col[2]; a += 255
            n = ss * ss
            row += [r // n, g // n, b // n, a // n]
        rows.append(row)
    return png(s, s, rows)

os.makedirs('icons', exist_ok=True)
for s in (16, 32, 48, 128):
    open(f'icons/icon{s}.png', 'wb').write(render(s))
    print('icons/icon%d.png' % s)
