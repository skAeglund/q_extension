"""Generate the extension's PNG icons. Pure stdlib - no Pillow needed.

Draws a rounded tile with a two-way arrow glyph, supersampled 4x and box-filtered
down to each target size.

    python make_icons.py
"""
import os
import struct
import zlib

TILE = (0x7a, 0xa2, 0xf7)   # accent blue
INK = (0x12, 0x15, 0x1e)    # near-black glyph
SIZES = (16, 32, 48, 128)
SS = 4                      # supersampling factor


def rounded_tile(x, y, s):
    """Coverage test for a rounded square filling the s x s canvas."""
    pad = s * 0.045
    r = s * 0.20
    x0, y0, x1, y1 = pad, pad, s - pad, s - pad
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def arrow(x, y, s, pointing_right, mid_y):
    """Coverage test for one arrow: a bar plus a triangular head."""
    bar_h = s * 0.070
    head_h = s * 0.115
    head_w = s * 0.125
    left, right = s * 0.215, s * 0.785

    if abs(y - mid_y) > head_h:
        return False

    if pointing_right:
        tip, base = right, right - head_w
        if x > tip or x < left:
            return False
        if x >= base:  # triangular head
            t = (tip - x) / head_w
            return abs(y - mid_y) <= head_h * t
        return abs(y - mid_y) <= bar_h
    else:
        tip, base = left, left + head_w
        if x < tip or x > right:
            return False
        if x <= base:
            t = (x - tip) / head_w
            return abs(y - mid_y) <= head_h * t
        return abs(y - mid_y) <= bar_h


def glyph(x, y, s):
    return (arrow(x, y, s, True, s * 0.395) or
            arrow(x, y, s, False, s * 0.605))


def render(size):
    big = size * SS
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            tr = tg = tb = ta = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = px * SS + sx + 0.5
                    y = py * SS + sy + 0.5
                    if not rounded_tile(x, y, big):
                        continue
                    col = INK if glyph(x, y, big) else TILE
                    tr += col[0]
                    tg += col[1]
                    tb += col[2]
                    ta += 255
            n = SS * SS
            if ta == 0:
                row += b'\x00\x00\x00\x00'
            else:
                # un-premultiply against covered samples only
                cov = ta // 255
                row += bytes((tr // cov, tg // cov, tb // cov, ta // n))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b''.join(b'\x00' + r for r in rows)

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    header = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    png = (b'\x89PNG\r\n\x1a\n' +
           chunk(b'IHDR', header) +
           chunk(b'IDAT', zlib.compress(raw, 9)) +
           chunk(b'IEND', b''))
    with open(path, 'wb') as fh:
        fh.write(png)


if __name__ == '__main__':
    here = os.path.dirname(os.path.abspath(__file__))
    for s in SIZES:
        out = os.path.join(here, 'icon%d.png' % s)
        write_png(out, s, render(s))
        print('wrote %s (%d bytes)' % (os.path.basename(out), os.path.getsize(out)))
