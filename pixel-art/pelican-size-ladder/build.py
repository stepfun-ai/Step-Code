"""Hand-placed size studies; never overwrites the approved application artwork."""
from pathlib import Path
import sys

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path.home() / '.agents/skills/pixel-art-studio/scripts'))
from pixelstudio import Sprite

OUT = Path(__file__).resolve().parent
COLORS = {'p': '#AA91F0', 'y': '#F4D56B', 'd': '#242132', 'w': '#FFF6DC'}
BG = '#222733'
# Each row is a source-pixel row, not a terminal cell row.
STUDIES = {
    (18, 16): [
        '.....pppp',
        '....pppppp',
        '...pppppppp',
        '...ppddpppp',
        '...ppdwpppyyyyyyy',
        '.pppppppppyyyyyy',
        '.pppppppppyyyy',
        '..ppppppppyy',
        '...ppppppp',
        '....ppyyy.ppp',
        '..pp..y.y...p.pp',
        '.p..p.yy.y...p..p',
        'p..ppppppyppp....p',
        'p....p..yy..p....p',
        '.p..p........p..p',
        '..pp..........pp',
    ],
    (16, 14): [
        '....pppp',
        '...pppppp',
        '..ppddpppp',
        '..ppdwpppyyyyyyy',
        '.ppppppppyyyyyy',
        '.ppppppppyyyy',
        '..pppppppyy',
        '...ppppp',
        '....pyyyp.pp',
        '.ppp.y.y...pppp',
        'p...pyy.y..p...p',
        'p.ppppppypppp..p',
        'p...p..yy..p...p',
        '.ppp........ppp',
    ],
    (14, 12): [
        '...pppp',
        '..pppppp',
        '..ppddpp',
        '..ppdwppyyyyyy',
        '.pppppppyyyyy',
        '.pppppppyyy',
        '..pppppp',
        '...ppyy.pp',
        '.pp.yy.y.p.pp',
        'p..ppppyypp..p',
        'p..p......p..p',
        '.pp........pp',
    ],
    (12, 10): [
        '..pppp',
        '.ppddpp',
        '.ppdwppyyyyy',
        'pppppppyyyy',
        '.ppppppyy',
        '..pppy.pp',
        '.pp.yy.y.pp',
        'p..ppppyp..p',
        'p..p....p..p',
        '.pp......pp',
    ],
    (10, 8): [
        '..ppp',
        '.ppdpp',
        '.pppppyyyy',
        'ppppppyyy',
        '.pppy.pp',
        '.pp.yyp.pp',
        'p.pppppp.p',
        '.pp....pp',
    ],
    (8, 6): [
        '.ppp',
        '.pdppyyy',
        'pppppyy',
        '.ppy.pp',
        'p.pppp.p',
        '.p....p',
    ],
}

images = [Image.open(OUT.parent / 'pelican-bike-final-details/logo-20x18.png').convert('RGBA')]
for (width, height), rows in STUDIES.items():
    assert len(rows) == height
    sprite = Sprite(width, height, palette=list(COLORS.values()))
    for y, row in enumerate(rows):
        assert len(row) <= width, (width, y, row)
        for x, cell in enumerate(row):
            if cell != '.':
                sprite.px(x, y, COLORS[cell])
    sprite.save_png(str(OUT / f'logo-{width}x{height}.png'))
    sprite.save_png(str(OUT / f'preview-{width}x{height}.png'), scale=16, bg=BG)
    image = sprite.composite(1)
    assert set(image.getchannel('A').get_flattened_data()) <= {0, 255}
    assert len({p for p in image.get_flattened_data() if p[3]}) <= 4
    # Keep the approved 2x2 eye and its sole lower-right highlight until 12x10.
    highlights = [(x, y) for y, row in enumerate(rows) for x, cell in enumerate(row) if cell == 'w']
    if width >= 12:
        assert len(highlights) == 1
        hx, hy = highlights[0]
        assert rows[hy - 1][hx - 1:hx + 1] == 'dd'
        assert rows[hy][hx - 1] == 'd'
    else:
        assert not highlights
    images.append(image)

font_path = str(next(Path('/System/Library/AssetsV2').glob('com_apple_MobileAsset_Font*/*/AssetData/PingFang.ttc')))
font = ImageFont.truetype(font_path, 20)
small = ImageFont.truetype(font_path, 15)
large = ImageFont.truetype(font_path, 28)
# All source pixels use the exact same display size, including the original.
scale = 8
panel_width = 190
sheet = Image.new('RGB', (panel_width * len(images) + 48, 414), BG)
draw = ImageDraw.Draw(sheet)
draw.text((28, 22), '鹈鹕骑车 / 逐档减像素', font=large, fill='#FFF6DC')
draw.text((28, 66), '同一像素倍率 · 手工重画 · 当前欢迎页保持不变', font=small, fill='#A6ADBF')
notes = ['当前原版', '保留完整表情', '保留完整表情', '推荐的小尺寸', '勉强可辨下限', '高光与脚丢失', '仅剩符号']
for i, (image, note) in enumerate(zip(images, notes)):
    w, h = image.size
    x = 24 + i * panel_width + (panel_width - w * scale) // 2
    y = 270 - h * scale
    sheet.paste(image.resize((w * scale, h * scale), Image.Resampling.NEAREST), (x, y), image.resize((w * scale, h * scale), Image.Resampling.NEAREST))
    label = f'{w} × {h}'
    draw.text((24 + i * panel_width + 40, 294), label, font=font, fill='#FFF6DC')
    draw.text((24 + i * panel_width + 30, 328), note, font=small, fill='#A6ADBF')
    draw.text((24 + i * panel_width + 30, 356), f'终端 {w} 列 × {h // 2} 行', font=small, fill='#A6ADBF')
draw.text((28, 390), '下限按本轮造型判断；10×8、8×6 用于展示细节损失，不建议替换。', font=small, fill='#A6ADBF')
sheet.save(OUT / 'comparison.png')
print('PASS: six hand-drawn sizes, binary alpha, original palette, consistent 8x comparison.')
