"""A squat, single-color 16x16 pelican riding a tiny bicycle."""
from pathlib import Path
import sys

sys.path.insert(0, '/Users/jyxc-dz-0101518/.agents/skills/pixel-art-studio/scripts')
from pixelstudio import Sprite

OUT = Path(__file__).resolve().parent
INK = '#E58A6B'
ROWS = [
    '................',
    '................',
    '......####......',
    '.....######.....',
    '....####.######.',
    '....##########..',
    '..###########...',
    '...#######.##...',
    '...#######......',
    '....######......',
    '.....###...#....',
    '....########....',
    '...###.....###..',
    '...#.#.....#.#..',
    '...###.....###..',
    '................',
]
s = Sprite(16, 16, palette=[INK])
for y, row in enumerate(ROWS):
    assert len(row) == 16
    for x, cell in enumerate(row):
        if cell == '#':
            s.px(x, y, INK)
s.save_png(str(OUT / 'logo-16.png'))
s.save_png(str(OUT / 'logo-128.png'), scale=8)
s.save_png(str(OUT / 'logo-640.png'), scale=40)
s.save_png(str(OUT / 'preview.png'), scale=24, bg='#292A30')
s.stats()
