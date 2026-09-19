"""Generate apps/cli step-logo-sprite.generated.ts from this folder's art.

Source art renders as authored: hollow wheel rims and wire frame stay
transparent; only truly enclosed interior holes could be filled if ever
wanted (not wanted: the bike reads as line art).

Art is downscaled to TARGET_SIZE (LANCZOS, then snapped back to the source
palette) so the welcome mark sits one notch smaller than the raw 20x18 art.

Encode: each art pixel -> one half-cell; a cell row is one string of
COLUMNS*2 hex digits (upper pixel, lower pixel). 0 = transparent,
1..N = PALETTE index. Regenerate after editing the GIF/PNG.
"""
from PIL import Image, ImageSequence
from collections import Counter
from pathlib import Path

ART = Path(__file__).parent
OUT = ART.parents[1] / "apps/cli/src/ui/view/chrome/step-logo-sprite.generated.ts"
ALPHA_THRESHOLD = 128
TARGET_SIZE = (16, 14)  # terminal cells: 16 cols x 7 rows


def load_pixels(path, frame_index=None):
    img = Image.open(path)
    if frame_index is not None:
        for i, f in enumerate(ImageSequence.Iterator(img)):
            if i == frame_index:
                return f.convert("RGBA").load()
        raise IndexError(frame_index)
    return img.convert("RGBA").load()


def encode(pixels, palette, width, height):
    rows = []
    for y in range(0, height, 2):
        row = ""
        for x in range(width):
            for yy in (y, y + 1):
                if yy >= height:
                    row += "0"
                    continue
                px = pixels[x, yy]
                idx = "0" if px[3] <= ALPHA_THRESHOLD else str(palette.index(px[:3]) + 1)
                row += idx if len(idx) == 1 else "0"
        rows.append(row)
    return rows


gif = Image.open(ART / "pedal-20x18.gif")
src_frames = [f.convert("RGBA") for f in ImageSequence.Iterator(gif)]
src_static = Image.open(ART / "logo-20x18.png").convert("RGBA")
durations = [f.info.get("duration", 100) for f in ImageSequence.Iterator(gif)]

census = Counter()
for art in src_frames + [src_static]:
    for px in art.getdata():
        if px[3] > ALPHA_THRESHOLD:
            census[px[:3]] += 1
palette = [color for color, _ in census.most_common()]
assert len(palette) <= 15, f"palette too large: {len(palette)}"


def snap(color):
    return min(palette, key=lambda p: sum((a - b) ** 2 for a, b in zip(color, p)))


def downscale(art):
    """LANCZOS to TARGET_SIZE, then re-threshold alpha and snap to the source palette."""
    small = art.resize(TARGET_SIZE, Image.LANCZOS)
    out = Image.new("RGBA", TARGET_SIZE)
    for y in range(TARGET_SIZE[1]):
        for x in range(TARGET_SIZE[0]):
            r, g, b, a = small.getpixel((x, y))
            out.putpixel((x, y), snap((r, g, b)) + (255,) if a > 100 else (0, 0, 0, 0))
    return out


width, height = TARGET_SIZE
frames_pixels = [downscale(f).load() for f in src_frames]
static_pixels = downscale(src_static).load()

frames = [encode(p, palette, width, height) for p in frames_pixels]
static = encode(static_pixels, palette, width, height)
columns = width
cell_rows = (height + 1) // 2

def fmt_frames():
    out = []
    for frame in frames:
        body = ",\n\t\t".join(f'"{row}"' for row in frame)
        out.append(f"\t[\n\t\t{body},\n\t]")
    return ",\n".join(out)

content = f'''/**
 * GENERATED FILE — do not edit by hand.
 *
 * Riding-bird brand sprite, regenerated from pixel-art/pelican-bike-pedaling
 * (pedal-20x18.gif + logo-20x18.png) by gen-terminal-sprite.py in that folder.
 *
 * Encoding: each frame is BIRD_SPRITE_ROWS strings; each string is
 * BIRD_SPRITE_COLUMNS*2 lowercase hex digits — one per half-cell, in
 * (upper, lower) order. 0 means transparent; 1..N indexes
 * BIRD_SPRITE_PALETTE (one-based). logo.ts turns a cell's two indices
 * into a Braille dot cell colored through the theme handle (which applies
 * terminal color-depth downgrade).
 */

export const BIRD_SPRITE_COLUMNS = {columns};
export const BIRD_SPRITE_ROWS = {cell_rows};

/** Source-art colors, indexed one-based by the sprite's hex digits. */
export const BIRD_SPRITE_PALETTE: readonly string[] = [
{chr(10).join(f'\t"#{r:02x}{g:02x}{b:02x}",' for r, g, b in palette)}
];

/** Per-frame hold time in milliseconds, matching the source GIF. */
export const BIRD_SPRITE_FRAME_DURATIONS_MS: readonly number[] = [
\t{", ".join(str(d) for d in durations)},
];

/** Animation frames, played once at launch then dropped for the static frame. */
export const BIRD_SPRITE_FRAMES: readonly (readonly string[])[] = [
{fmt_frames()},
];

/** The settled frame shown after the launch animation. */
export const BIRD_SPRITE_STATIC: readonly string[] = [
{chr(10).join(f'\t"{row}",' for row in static)}
];
'''
OUT.write_text(content)
print(f"wrote {OUT}: {columns}x{cell_rows} cells, {len(frames)} frames, palette {len(palette)}")
