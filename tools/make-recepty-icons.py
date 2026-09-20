#!/usr/bin/env python3
"""Vygeneruje ikony aplikace Recepty (talíř s příborem na oranžovém pozadí) bez externích knihoven."""
import struct, zlib, os, math

def png(width, height, rows):
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    raw = b''.join(b'\x00' + bytes(r) for r in rows)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')

def color_at(u, v):
    """u, v v rozsahu 0..1. Vrací RGBA nebo None (průhledné)."""
    # zaoblený čtverec pozadí
    r = 0.22
    cx = min(max(u, r), 1 - r); cy = min(max(v, r), 1 - r)
    if (u - cx) ** 2 + (v - cy) ** 2 > r * r: return None
    bg = (194, 65, 12, 255)
    # talíř (bílý kruh) s vnitřním prstencem
    d = math.hypot(u - 0.5, v - 0.5)
    if d < 0.36:
        if 0.24 < d < 0.27: return (255, 237, 213, 255)
        col = (255, 251, 247, 255)
        # vidlička vlevo
        if 0.30 < u < 0.345 and 0.30 < v < 0.72: col = (194, 65, 12, 255)
        for x0 in (0.285, 0.315, 0.345):
            if abs(u - x0) < 0.012 and 0.22 < v < 0.40: col = (194, 65, 12, 255)
        if 0.28 < u < 0.36 and 0.36 < v < 0.42: col = (194, 65, 12, 255)
        # nůž vpravo
        if 0.655 < u < 0.70 and 0.30 < v < 0.72: col = (194, 65, 12, 255)
        if 0.64 < u < 0.715 and 0.22 < v < 0.42 and (u - 0.6775) ** 2 / 0.0014 + (v - 0.32) ** 2 / 0.01 < 1: col = (194, 65, 12, 255)
        return col
    return bg

def render(s):
    rows = []
    ss = 3
    for y in range(s):
        row = []
        for x in range(s):
            r = g = b = a = 0
            for sy in range(ss):
                for sx in range(ss):
                    c = color_at((x + (sx + 0.5) / ss) / s, (y + (sy + 0.5) / ss) / s)
                    if c: r += c[0]; g += c[1]; b += c[2]; a += c[3]
            n = ss * ss
            if a: row += [r * 255 // a, g * 255 // a, b * 255 // a, a // n]
            else: row += [0, 0, 0, 0]
        rows.append(row)
    return png(s, s, rows)

base = os.path.join(os.path.dirname(__file__), '..', 'recepty', 'app', 'src', 'main', 'res')
for name, s in (('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)):
    d = os.path.join(base, 'mipmap-' + name); os.makedirs(d, exist_ok=True)
    open(os.path.join(d, 'ic_launcher.png'), 'wb').write(render(s))
    print(d)
