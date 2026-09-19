"""Three beak steps and a lower crown; all remaining pixels stay locked."""
from pathlib import Path
import sys
from PIL import Image, ImageSequence

sys.path.insert(0, str(Path.home() / '.agents/skills/pixel-art-studio/scripts'))
from pixelstudio import Sprite

OUT = Path(__file__).resolve().parent
SOURCE = OUT.parent / 'pelican-bike-final-details'
COLORS = ['#AA91F0', '#F4D56B', '#242132', '#FFF6DC']
sprite = Sprite(18, 16, palette=COLORS)
with Image.open(SOURCE / 'pedal-20x18.gif') as gif:
    frames = [frame.convert('RGBA') for frame in ImageSequence.Iterator(gif)]
assert len(frames) == 8
for i, frame in enumerate(frames):
    assert frame.getbbox() == (1, 1, 19, 17)
    if i:
        sprite.add_frame(copy=False)
    for y in range(16):
        for x in range(18):
            pixel = frame.getpixel((x + 1, y + 1))
            if pixel[3]:
                sprite.px(x, y, pixel)
    # Lower only the crown contour, leaving eye and cheeks unchanged.
    for x in range(5, 9):
        sprite.px(x, 0, None)
    for x, y in ((4, 1), (9, 1), (3, 2), (10, 2), (16, 4)):
        sprite.px(x, y, None)
    actual = sprite.composite(i + 1)
    expected = frame.crop((1, 1, 19, 17))
    allowed = {(x, 0) for x in range(5, 9)} | {(4, 1), (9, 1), (3, 2), (10, 2), (16, 4)}
    changed = {(x, y) for y in range(16) for x in range(18)
               if actual.getpixel((x, y)) != expected.getpixel((x, y)) and (actual.getpixel((x, y))[3] or expected.getpixel((x, y))[3])}
    assert changed == allowed
    assert [sum(actual.getpixel((x, y)) == (244, 213, 107, 255) for x in range(10, 18))
            for y in range(4, 8)] == [6, 6, 4, 2]
with Image.open(SOURCE / 'logo-20x18.png') as original:
    expected = original.convert('RGBA').crop((1, 1, 19, 17))
    assert expected.crop((0, 8, 18, 16)).tobytes() == sprite.composite(1).crop((0, 8, 18, 16)).tobytes()
sprite.set_duration(140, frames='all')
sprite.save_png(str(OUT / 'logo-18x16.png'))
sprite.save_png(str(OUT / 'preview.png'), scale=16, bg='#222733')
sprite.save_gif(str(OUT / 'pedal-18x16.gif'), scale=1)
sprite.preview(str(OUT / 'frames.png'), scale=8, bg='#222733', cols=4)
with Image.open(OUT / 'pedal-18x16.gif') as gif:
    assert gif.n_frames == 8 and gif.size == (18, 16)
    for i, frame in enumerate(ImageSequence.Iterator(gif)):
        assert frame.info['duration'] == 140
        for a, b in zip(frame.convert('RGBA').get_flattened_data(), sprite.composite(i + 1).get_flattened_data()):
            assert a[3] == b[3] and (not b[3] or a == b)
print('PASS: exactly nine contour pixels changed in each frame; feet/body/eye locked; 18x16, 140ms, exact GIF roundtrip.')
