"""Generate the extension icons (a faceless head behind a censor bar) without image libraries."""
import math, struct, zlib, os

BG = (91, 33, 182)       # violet-800
BG2 = (124, 58, 237)     # violet-600
FG = (255, 255, 255)
BAR = (17, 24, 39)

def png(path, size):
    ss = 4  # supersampling
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    u = (x + (sx + .5) / ss) / size
                    v = (y + (sy + .5) / ss) / size
                    c = pixel(u, v)
                    for i in range(4): acc[i] += c[i]
            n = ss * ss
            row += bytes(int(a / n) for a in acc)
        rows.append(bytes(row))
    raw = b''.join(rows)
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    open(path, 'wb').write(data)

def inside_round_rect(u, v, r=0.22):
    cx = min(max(u, r), 1 - r); cy = min(max(v, r), 1 - r)
    return (u - cx) ** 2 + (v - cy) ** 2 <= r * r

def pixel(u, v):
    if not inside_round_rect(u, v): return (0, 0, 0, 0)
    t = v
    col = tuple(int(BG2[i] * (1 - t) + BG[i] * t) for i in range(3))
    # head + shoulders
    if (u - .5) ** 2 + (v - .40) ** 2 <= .17 ** 2: col = FG
    if (u - .5) ** 2 / .30 ** 2 + (v - .95) ** 2 / .30 ** 2 <= 1 and v <= .86: col = FG
    # censor bar across the eyes
    if .22 <= u <= .78 and .33 <= v <= .45: col = BAR
    return (*col, 255)

out = os.path.join(os.path.dirname(__file__), '..', 'public', 'icon')
os.makedirs(out, exist_ok=True)
for s in (16, 32, 48, 128):
    png(os.path.join(out, f'{s}.png'), s)
print('icons written to', os.path.abspath(out))
