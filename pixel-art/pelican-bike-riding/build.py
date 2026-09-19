"""24x22 pelican cyclist with saddle, crank and handlebar contact points."""
from pathlib import Path
import sys

from PIL import Image

sys.path.insert(0, '/Users/jyxc-dz-0101518/.agents/skills/pixel-art-studio/scripts')
from pixelstudio import Sprite

OUT = Path(__file__).resolve().parent
COLOR = {'bird': '#AA91F0', 'bike': '#8B75C4', 'gold': '#F4D56B', 'eye': '#242132', 'glint': '#FFF6DC'}
REAR = (4, 18)
FRONT = (19, 18)
SEAT_TUBE = (10, 14)
CRANK = (12, 18)
HEAD_TUBE = (18, 14)
s = Sprite(24, 22, palette=list(COLOR.values()))
# One frame triangle, a rear chain stay, and the front fork. No decorative spokes.
for cx, cy in (REAR, FRONT):
    for dx, dy in ((-1,-3),(0,-3),(1,-3),(-2,-2),(2,-2),(-3,-1),(3,-1),(-3,0),(3,0),(-3,1),(3,1),(-2,2),(2,2),(-1,3),(0,3),(1,3)):
        s.px(cx + dx, cy + dy, COLOR['bike'])
for start, end in ((SEAT_TUBE, CRANK), (CRANK, HEAD_TUBE), (HEAD_TUBE, SEAT_TUBE), (REAR, CRANK), ((17,12), FRONT)):
    s.line(*start, *end, COLOR['bike'])
s.line(8, 13, 11, 13, COLOR['bike'])
s.line(16, 12, 17, 12, COLOR['bike'])
BODY = {
    1: [(8,11)], 2: [(7,12)], 3: [(6,13)], 4: [(6,13)],
    5: [(6,12)], 6: [(5,12)], 7: [(3,3),(5,12)],
    8: [(3,12)], 9: [(4,12)], 10: [(5,11)], 11: [(7,10)],
}
for y, spans in BODY.items():
    for x0, x1 in spans:
        s.line(x0 + 1, y + 1, x1 + 1, y + 1, COLOR['bird'])
for y, right in ((5,20),(6,19),(7,16),(8,14)):
    s.line(14, y + 1, right + 1, y + 1, COLOR['gold'])
s.rect(10, 5, 11, 6, COLOR['eye'])
s.px(11, 6, COLOR['glint'])
# Forward-reaching wing rests against the handlebar.
s.line(12, 11, 14, 12, COLOR['bird'])
s.line(14, 12, 16, 12, COLOR['bird'])
# Near leg folds back; its lower pedal opposes the raised far pedal.
s.line(10, 13, 9, 14, COLOR['gold'])
s.line(9, 14, 9, 16, COLOR['gold'])
s.line(9, 16, 10, 17, COLOR['gold'])
s.line(10, 17, 11, 19, COLOR['gold'])
s.line(11, 19, 12, 19, COLOR['gold'])
s.line(11, 13, 13, 15, COLOR['gold'])
s.line(13, 15, 13, 17, COLOR['gold'])
s.line(13, 17, 14, 17, COLOR['gold'])

s.save_png(str(OUT / 'logo-24x22.png'))
s.save_png(str(OUT / 'logo-192x176.png'), scale=8)
s.save_png(str(OUT / 'logo-768x704.png'), scale=32)
s.save_png(str(OUT / 'preview.png'), scale=24, bg='#171A23')
s.save_png(str(OUT / 'small-preview.png'), scale=4, bg='#171A23')
s.save_silhouette(str(OUT / 'silhouette.png'))
s.stats()

# Verify the visible contact points, not just the intended coordinates.
with Image.open(OUT / 'logo-24x22.png') as master:
    assert master.size == (24, 22)
    rgb = {name: tuple(bytes.fromhex(value[1:])) for name, value in COLOR.items()}
    for x in (8, 9):
        assert master.getpixel((x, 12))[:3] == rgb['bird']
        assert master.getpixel((x, 13))[:3] == rgb['bike']
    assert master.getpixel(CRANK)[:3] == rgb['bike']
    for point in ((11, 19), (13, 17)):
        assert master.getpixel(point)[:3] == rgb['gold']
    assert ((11 + 13) // 2, (19 + 17) // 2) == CRANK
    assert REAR[0] < SEAT_TUBE[0] < CRANK[0] < HEAD_TUBE[0] < FRONT[0]
    assert master.getpixel((16, 12))[:3] == rgb['bird']
    assert master.getpixel((17, 12))[:3] == rgb['bike']
    # Open triangular interior remains visible behind the far leg.
    assert all(master.getpixel(point)[3] == 0 for point in ((14,15),(15,15),(14,16)))
    assert {master.getpixel((x,y))[3] for y in range(22) for x in range(24)} == {0,255}
print('PASS: saddle contact, opposite pedals centred on crank, forward grip, open frame triangle, hard alpha.')
