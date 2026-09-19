"""Eight-frame pedal loop, preserving the approved 20x18 logo silhouette."""
from pathlib import Path
import sys

from PIL import Image, ImageSequence

sys.path.insert(0, '/Users/jyxc-dz-0101518/.agents/skills/pixel-art-studio/scripts')
from pixelstudio import Sprite

OUT = Path(__file__).resolve().parent
COLORS = {'p': '#AA91F0', 'y': '#F4D56B', 'd': '#242132', 'w': '#FFF6DC'}
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
# Clockwise ankle orbit. Opposite points sum to (15,25), so the crank never drifts.
ORBIT = [(9,12),(9,13),(8,14),(7,14),(6,13),(6,12),(7,11),(8,11)]
RIM = [(-1,-3),(0,-3),(1,-3),(-2,-2),(2,-2),(-3,-1),(3,-1),(-3,0),(3,0),(-3,1),(3,1),(-2,2),(2,2),(-1,3),(0,3),(1,3)]
s = Sprite(20, 18, palette=list(COLORS.values()))
for frame in range(8):
    if frame:
        s.add_frame(copy=False)
    phase = (frame + 1) % 8
    for cx in (4, 15):
        for dx, dy in RIM:
            s.px(cx + dx, 13 + dy, COLORS['p'])
    s.line(4, 13, 16, 13, COLORS['p'])
    s.line(9, 10, 12, 10, COLORS['p'])
    s.line(12, 10, 15, 13, COLORS['p'])
    # Leg roots are hidden by the stationary body; foot contacts rotate continuously.
    for far, index in ((True, (phase + 4) % 8), (False, phase)):
        fx, fy = ORBIT[index]
        hip = (6, 10) if far else (8, 10)
        knee = (min(7, fx), 11) if far else (max(8, fx), 11)
        s.line(*hip, *knee, COLORS['y'])
        s.line(*knee, fx, fy, COLORS['y'])
        s.line(fx, fy, fx + 1, fy, COLORS['y'])
    for y, row in enumerate(ROWS):
        for x, cell in enumerate(row):
            if cell != '.':
                s.px(x + 1, y, COLORS[cell])
s.set_duration(140, frames='all')
s.tag('pedal', 1, 8)
s.preview(str(OUT / 'frames.png'), scale=12, bg='#171A23', cols=4)
s.save_png(str(OUT / 'logo-20x18.png'), frame=1)
s.save_gif(str(OUT / 'pedal-20x18.gif'), scale=1)
s.save_gif(str(OUT / 'pedal-160x144.gif'), scale=8)
s.save_gif(str(OUT / 'pedal-480x432.gif'), scale=24)
s.save_gif(str(OUT / 'preview.gif'), scale=24, bg='#171A23')
s.save_spritesheet(str(OUT / 'spritesheet.png'), layout='horizontal')

with Image.open(OUT.parent / 'pelican-bike-20x18-forward' / 'logo-20x18.png') as approved:
    assert approved.tobytes() == s.composite(1).tobytes()
    for frame in range(1, 9):
        assert approved.crop((0,0,20,10)).tobytes() == s.composite(frame).crop((0,0,20,10)).tobytes()
for index, point in enumerate(ORBIT):
    opposite = ORBIT[(index + 4) % 8]
    assert (point[0] + opposite[0], point[1] + opposite[1]) == (15,25)
    following = ORBIT[(index + 1) % 8]
    assert max(abs(point[0] - following[0]), abs(point[1] - following[1])) == 1
with Image.open(OUT / 'pedal-20x18.gif') as gif:
    assert gif.size == (20,18) and gif.n_frames == 8 and gif.info['loop'] == 0
    for index, decoded in enumerate(ImageSequence.Iterator(gif)):
        rgba = decoded.convert('RGBA')
        expected = s.composite(index + 1)
        assert decoded.info['duration'] == 140
        assert all(rgba.getpixel((x,y)) == expected.getpixel((x,y)) for y in range(18) for x in range(20) if expected.getpixel((x,y))[3])
        assert rgba.getchannel('A').tobytes() == expected.getchannel('A').tobytes()
print('PASS: approved first frame, locked body, opposing pedals, continuous seam, eight correctly decoded GIF frames.')

# A browser view animates the GIF; macOS Preview often displays GIFs as a frame list.
(OUT / 'preview.html').write_text('''<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>鹈鹕骑车 · 20×18</title>
<style>
html,body{margin:0;min-height:100%;background:#171a23;color:#b8bac6;font:14px system-ui}
main{min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:24px}
img{width:480px;max-width:90vw;height:auto;image-rendering:pixelated}
p{margin:0}a{color:#aa91f0;text-underline-offset:4px}
</style><main><img src="pedal-480x432.gif" alt="紫色鹈鹕交替蹬自行车的像素动画">
<p>20 × 18 · 8 帧循环 · 1.12 秒</p><p><a href="pedal-480x432.gif" download>下载透明底 GIF</a></p></main></html>''')
