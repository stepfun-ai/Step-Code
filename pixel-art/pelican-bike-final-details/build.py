"""One-pixel tail connection on the approved animation; no other artwork changes."""
from pathlib import Path
import sys

from PIL import Image, ImageSequence

sys.path.insert(0, str(Path.home() / '.agents/skills/pixel-art-studio/scripts'))
from pixelstudio import Sprite

OUT = Path(__file__).resolve().parent
SOURCE = OUT.parent / 'pelican-bike-pedaling/pedal-20x18.gif'
PURPLE = '#AA91F0'
COLORS = [PURPLE, '#F4D56B', '#242132', '#FFF6DC']
s = Sprite(20, 18, palette=COLORS)
with Image.open(SOURCE) as gif:
    frames = [frame.convert('RGBA') for frame in ImageSequence.Iterator(gif)]
assert len(frames) == 8
for index, image in enumerate(frames):
    if index:
        s.add_frame(copy=False)
    for y in range(18):
        for x in range(20):
            pixel = image.getpixel((x, y))
            if pixel[3]:
                s.px(x, y, pixel)
    # Close the one-pixel notch between the raised tail and the body.
    s.px(3, 6, PURPLE)
    actual = s.composite(index + 1)
    changes = [(x, y) for y in range(18) for x in range(20)
               if actual.getpixel((x, y)) != image.getpixel((x, y))
               and (actual.getpixel((x, y))[3] or image.getpixel((x, y))[3])]
    assert changes == [(3, 6)], changes
    # The sole eye highlight is lower-right. The former top white line was
    # terminal background bleed, not a second white pixel in the source.
    assert actual.getpixel((7, 4)) == (36, 33, 50, 255)
    assert actual.getpixel((7, 5)) == (255, 246, 220, 255)
s.set_duration(140, frames='all')
s.save_png(str(OUT / 'logo-20x18.png'), frame=1)
s.save_png(str(OUT / 'preview.png'), frame=1, scale=24, bg='#222733')
s.save_gif(str(OUT / 'pedal-20x18.gif'), scale=1)
s.save_gif(str(OUT / 'preview.gif'), scale=24, bg='#222733')
s.preview(str(OUT / 'frames.png'), scale=12, bg='#222733', cols=4)
with Image.open(OUT / 'pedal-20x18.gif') as gif:
    assert gif.n_frames == 8 and gif.size == (20, 18)
    for index, decoded in enumerate(ImageSequence.Iterator(gif)):
        assert decoded.info['duration'] == 140
        actual = decoded.convert('RGBA')
        expected = s.composite(index + 1)
        for y in range(18):
            for x in range(20):
                a, b = actual.getpixel((x,y)), expected.getpixel((x,y))
                assert a[3] == b[3] and (not b[3] or a == b)
print('PASS: exactly one tail pixel changed in each of 8 frames; single lower-right eye highlight; GIF roundtrip exact.')
