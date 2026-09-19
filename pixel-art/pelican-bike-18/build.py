"""18x18 refinement of the approved purple pelican bicycle mark."""
from pathlib import Path
import sys

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, '/Users/jyxc-dz-0101518/.agents/skills/pixel-art-studio/scripts')
from pixelstudio import Sprite

OUT = Path(__file__).resolve().parent
COLORS = {'p': '#AA91F0', 'y': '#F4D56B', 'd': '#242132', 'w': '#FFF6DC'}
s = Sprite(18, 18, palette=list(COLORS.values()))
for cx in (4, 13):
    for dx, dy in ((-1,-3),(0,-3),(1,-3),(-2,-2),(2,-2),(-3,-1),(3,-1),(-3,0),(3,0),(-3,1),(3,1),(-2,2),(2,2),(-1,3),(0,3),(1,3)):
        s.px(cx + dx, 13 + dy, COLORS['p'])
s.line(4, 13, 14, 13, COLORS['p'])
s.line(5, 10, 7, 13, COLORS['p'])
s.line(9, 10, 11, 10, COLORS['p'])
s.line(11, 10, 13, 13, COLORS['p'])
ROWS = [
    '..................',
    '.....pppp.........',
    '....pppppp........',
    '...pppppppp.......',
    '...ppddpppp.......',
    '...ppdwpppyyyyyyy.',
    '.p.pppppppyyyyyy..',
    '.pppppppppyyyy....',
    '..ppppppppyy......',
    '...ppppppp........',
    '.....ppp..........',
]
for y, row in enumerate(ROWS):
    assert len(row) == 18
    for x, cell in enumerate(row):
        if cell != '.':
            s.px(x, y, COLORS[cell])
s.px(6, 11, COLORS['y'])
s.px(7, 12, COLORS['y'])
s.line(9, 11, 9, 13, COLORS['y'])
s.line(8, 13, 10, 13, COLORS['y'])
s.save_png(str(OUT / 'logo-18.png'))
s.save_png(str(OUT / 'logo-144.png'), scale=8)
s.save_png(str(OUT / 'logo-576.png'), scale=32)
s.save_png(str(OUT / 'preview.png'), scale=24, bg='#171A23')
s.stats()

# Same pixel scale, so the comparison does not hide the actual reduction.
comparison = Image.new('RGB', (400, 208), '#171A23')
draw = ImageDraw.Draw(comparison)
font = ImageFont.load_default(size=14)
for source, x, label in (
    (OUT.parent / 'pelican-bike-compressed' / 'logo-20.png', 20, '20 x 20 / previous'),
    (OUT / 'logo-18.png', 228, '18 x 18 / refined'),
):
    with Image.open(source) as original:
        scaled = original.resize((original.width * 8, original.height * 8), Image.Resampling.NEAREST)
        comparison.paste(scaled, (x, 180 - scaled.height), scaled)
    draw.text((x, 187), label, fill='#C6CAD6', font=font)
comparison.save(OUT / 'comparison.png')
