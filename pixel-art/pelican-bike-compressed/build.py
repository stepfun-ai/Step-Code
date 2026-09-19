"""Hand-pixelled 20x20 reduction of the user's purple pelican cyclist."""
from pathlib import Path
import sys

sys.path.insert(0, '/Users/jyxc-dz-0101518/.agents/skills/pixel-art-studio/scripts')
from pixelstudio import Sprite

OUT = Path(__file__).resolve().parent
COLORS = {'p': '#AA91F0', 'y': '#F4D56B', 'd': '#242132', 'w': '#FFF6DC'}
s = Sprite(20, 20, palette=list(COLORS.values()))
# Preserve the reference's large, fine-rimmed wheels and long low bicycle frame.
for cx in (4, 15):
    for dx, dy in ((-1,-3),(0,-3),(1,-3),(-2,-2),(2,-2),(-3,-1),(3,-1),(-3,0),(3,0),(-3,1),(3,1),(-2,2),(2,2),(-1,3),(0,3),(1,3)):
        s.px(cx + dx, 15 + dy, COLORS['p'])
s.line(4, 15, 16, 15, COLORS['p'])
s.line(6, 12, 7, 15, COLORS['p'])
s.line(10, 11, 12, 11, COLORS['p'])
s.line(13, 12, 15, 15, COLORS['p'])
ROWS = [
    '....................',
    '......pppp..........',
    '.....pppppp.........',
    '....ppppppp.........',
    '....ppddppp.........',
    '....ppdwpppyyyyyyyy.',
    '....pppppppyyyyyyy..',
    '.p.ppppppppyyyyy....',
    '.ppppppppppyy.......',
    '..pppppppppp........',
    '....ppppppp.........',
    '.....pppp...........',
]
for y, row in enumerate(ROWS):
    assert len(row) == 20
    for x, cell in enumerate(row):
        if cell != '.':
            s.px(x, y, COLORS[cell])
# Two tiny yellow strokes suggest pedalling without fine mechanics.
s.px(7, 12, COLORS['y'])
s.px(8, 13, COLORS['y'])
s.line(10, 12, 10, 15, COLORS['y'])
s.line(9, 15, 11, 15, COLORS['y'])
s.save_png(str(OUT / 'logo-20.png'))
s.save_png(str(OUT / 'logo-160.png'), scale=8)
s.save_png(str(OUT / 'logo-640.png'), scale=32)
s.save_png(str(OUT / 'preview.png'), scale=24, bg='#171A23')
s.stats()
