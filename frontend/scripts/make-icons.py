"""Generate the Outis extension icons (the eye: navy outline, bronze iris, on an ivory tile) without image libraries."""
import math, struct, zlib, os

IVORY = (247, 244, 238)
EDGE = (224, 216, 202)   # Line
NAVY = (19, 35, 58)      # logo outline
BRONZE = (169, 108, 50)  # logo iris

# The eye in a 48-unit box (same geometry as LOGO in lib/brand.ts): two circular arcs from
# (5.5, 24) to (42.5, 24) through (24, 13) and (24, 35), and an iris ring of radius 6.4.
HALF_CHORD, SAGITTA = 18.5, 11.0
R = (HALF_CHORD ** 2 + SAGITTA ** 2) / (2 * SAGITTA)
TOP_C, BOTTOM_C = (24.0, 13.0 + R), (24.0, 35.0 - R)

def png(path, size):
    ss = 6  # supersampling
    stroke = max(2.6, 1.45 * 48 / size)  # keep lines visible at 16 px
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    u = (x + (sx + .5) / ss) / size
                    v = (y + (sy + .5) / ss) / size
                    c = pixel(u, v, stroke, size)
                    for i in range(4): acc[i] += c[i]
            n = ss * ss
            row += bytes(int(a / n) for a in acc)
        rows.append(bytes(row))
    raw = b''.join(rows)
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    open(path, 'wb').write(data)

def round_rect_sdf(u, v, r=0.22):
    cx = min(max(u, r), 1 - r); cy = min(max(v, r), 1 - r)
    return math.hypot(u - cx, v - cy) - r if (u < r or u > 1 - r) and (v < r or v > 1 - r) else max(-u, u - 1, -v, v - 1)

def pixel(u, v, stroke, size):
    tile = round_rect_sdf(u, v)
    if tile > 0: return (0, 0, 0, 0)
    col = IVORY
    if tile > -1.0 / size: col = EDGE  # hairline edge so the tile reads on light toolbars
    # Eye drawn slightly larger on small icons.
    scale = 48 if size >= 48 else 44
    px, py = 24 + (u - .5) * scale, 24 + (v - .5) * scale
    almond = max(math.hypot(px - TOP_C[0], py - TOP_C[1]) - R, math.hypot(px - BOTTOM_C[0], py - BOTTOM_C[1]) - R)
    if abs(almond) <= stroke / 2 and 3.5 <= px <= 44.5: col = NAVY
    if abs(math.hypot(px - 24, py - 24) - 6.4) <= stroke / 2: col = BRONZE
    return (*col, 255)

out = os.path.join(os.path.dirname(__file__), '..', 'public', 'icon')
os.makedirs(out, exist_ok=True)
for s in (16, 32, 48, 128):
    png(os.path.join(out, f'{s}.png'), s)
print('icons written to', os.path.abspath(out))
