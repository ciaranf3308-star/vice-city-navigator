#!/usr/bin/env python3
"""Crop the VC Spotify widget art (1448x1086 RGBA) into portrait-pane pieces.
2x resolution for sharpness; CSS displays at half size.
Also measures the pink album-frame opening for album-art placement."""
from PIL import Image
import os

SRC = 'assets/spotify/vice_city_synthwave_music_widget.png'
OUT = 'themes/vice-city/spotify'
os.makedirs(OUT, exist_ok=True)
im = Image.open(SRC).convert('RGBA')
W, H = im.size
print('source', W, H)

# ---- measure the pink neon frame around the album window ----
# sample region containing the frame
alb = im.crop((90, 355, 590, 950))
px = alb.load()
aw, ah = alb.size
pink = []
for y in range(ah):
    for x in range(aw):
        r, g, b, a = px[x, y]
        if a > 128 and r > 190 and g < 150 and b > 140 and r > b:
            pink.append((x, y))
xs = [p[0] for p in pink]; ys = [p[1] for p in pink]
fx0, fy0, fx1, fy1 = min(xs), min(ys), max(xs), max(ys)
print(f'pink frame bbox in album-crop coords: ({fx0},{fy0})-({fx1},{fy1})')
# interior opening: inset by border thickness (~16px at source res)
IN = 18
ix0, iy0, ix1, iy1 = fx0 + IN, fy0 + IN, fx1 - IN, fy1 - IN
print(f'interior opening in album-crop coords: ({ix0},{iy0})-({ix1},{iy1}) size {ix1-ix0}x{iy1-iy0}')
# as fractions of the album crop (resolution independent)
print('FRACTIONS ix0=%.4f iy0=%.4f ix1=%.4f iy1=%.4f' % (ix0/aw, iy0/ah, ix1/aw, iy1/ah))

S = 2  # 2x for retina
def save(name, box, scale_w):
    crop = im.crop(box)
    w = scale_w * S
    h = round(crop.size[1] * w / crop.size[0])
    crop.resize((w, h), Image.LANCZOS).save(os.path.join(OUT, name))
    print(f'{name}: crop{box} -> {w}x{h}')

# header: logo + sun + skyline + neon tube
save('header.png', (0, 0, 1000, 360), 480)
# album zone: pink frame + dark navy band below (title/artist/progress live here)
save('album.png', (90, 355, 590, 950), 280)
# lyric stage: right sunset panel
save('stage.png', (590, 400, 1410, 1010), 480)
# bottom neon tube strip
save('tube.png', (0, 1040, 1448, 1086), 480)
