"""Regenerate a hand-drawn 20x20 pelican bicycle logo."""
from pathlib import Path
import sys

sys.path.insert(0, '/Users/jyxc-dz-0101518/.agents/skills/pixel-art-studio/scripts')
from pixelstudio import Sprite

OUT = Path(__file__).resolve().parent
COLORS = {'w': '#F5E8CE', 'o': '#E58A61', 'd': '#292A30', 's': '#CDBD9E'}
s = Sprite(20, 20, palette=list(COLORS.values()))
# Bicycle: equal-size open wheels, a compact diamond frame and raised handlebar.
for cx in (5, 15):
    for dx, dy in ((-1,-3),(0,-3),(1,-3),(-2,-2),(2,-2),(-3,-1),(3,-1),(-3,0),(3,0),(-3,1),(3,1),(-2,2),(2,2),(-1,3),(0,3),(1,3)):
        s.px(cx + dx, 15 + dy, COLORS['o'])
s.line(5, 15, 8, 11, COLORS['o'])
s.line(8, 11, 10, 15, COLORS['o'])
s.line(5, 15, 10, 15, COLORS['o'])
s.line(10, 15, 13, 11, COLORS['o'])
s.line(8, 11, 13, 11, COLORS['o'])
s.line(13, 9, 15, 15, COLORS['o'])
s.line(12, 9, 14, 9, COLORS['o'])
# Large head, long low bill and hanging throat pouch distinguish a pelican.
rows = [
    '....................',
    '.........www........',
    '........wwwww.......',
    '........wwwdw.......',
    '........wwwwooooooo.',
    '........wwwooooooo..',
    '........wwwoooooo...',
    '...wwwwwww..oooo....',
    '..wwwwwwww..........',
    '...wwwssswww........',
    '....wwwwww..........',
    '.....wwww...........',
]
for y, row in enumerate(rows):
    assert len(row) == 20
    for x, key in enumerate(row):
        if key != '.':
            s.px(x, y, COLORS[key])
s.line(8, 12, 9, 13, COLORS['w'])
s.line(9, 13, 9, 14, COLORS['w'])
s.px(10, 14, COLORS['w'])
s.save_png(str(OUT / 'pelican-bike-20.png'))
s.save_png(str(OUT / 'pelican-bike-160.png'), scale=8)
s.save_png(str(OUT / 'pelican-bike-640.png'), scale=32)
s.save_png(str(OUT / 'preview.png'), scale=24, bg='#292A30')
s.save_silhouette(str(OUT / 'silhouette.png'))
s.stats()
