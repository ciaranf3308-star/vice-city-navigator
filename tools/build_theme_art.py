#!/usr/bin/env python3
"""WayStation theme artwork generator.

Original 16x16 pixel-art POI blips + 32x32 player markers for the
San Andreas, GTA V and Frontier themes, drawn programmatically with PIL.

These are ORIGINAL artworks in each game's visual language — not
extracted game assets. (An asset-extraction helper was blocked by a
safety policy, so the themes ship with hand-made art instead. If real
extracted PNGs become available, drop them into
assets/themes/<theme>/blips/ named <semantic>.png and they just work.)

Blip file stems == WayStation semantic category names; each theme's
semanticIconMap is {} so no mapping table is needed. waypoint.png and
qmark.png are also generated (destination marker + fallback icon).

Usage: python3 tools/build_theme_art.py
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

SEMANTICS = [
    'airport', 'atm', 'bank', 'bar', 'burger', 'cafe', 'car_wash',
    'chicken', 'cinema', 'ev_charger', 'fast_food', 'fuel', 'garage',
    'gym', 'hospital', 'hotel', 'mall', 'nightlife', 'parking',
    'pharmacy', 'pizza', 'police', 'qmark', 'restaurant', 'shop',
    'stadium', 'supermarket', 'train', 'waypoint',
]

# ---------------------------------------------------------------- icons
# Each draws a bold pictogram in color `fg` on a 16x16 ImageDraw.
# Keep strokes >= 2px; stay inside 2..13.
def i_airport(d, f, bg):
    d.line([(7, 2), (7, 13)], fill=f, width=2)
    d.polygon([(2, 6), (13, 6), (11, 9), (4, 9)], fill=f)
    d.polygon([(5, 10), (10, 10), (9, 12), (6, 12)], fill=f)

def i_atm(d, f, bg):
    d.rectangle([4, 4, 11, 11], outline=f, width=2)
    d.line([(4, 7), (11, 7)], fill=f, width=2)
    d.line([(6, 10), (9, 10)], fill=f, width=1)

def i_bank(d, f, bg):
    d.polygon([(2, 7), (13, 7), (7.5, 2.5)], fill=f)
    for x in (4, 7, 10):
        d.rectangle([x - 1, 8, x + 1, 11], fill=f)
    d.line([(3, 12.5), (12, 12.5)], fill=f, width=2)

def i_bar(d, f, bg):
    d.polygon([(5, 2), (10, 2), (7.5, 7)], fill=f)
    d.line([(7.5, 7), (7.5, 12)], fill=f, width=2)
    d.line([(5, 13), (10, 13)], fill=f, width=2)

def i_burger(d, f, bg):
    d.rectangle([3, 3, 12, 6], fill=f)
    d.rectangle([3, 7, 12, 9], fill=f)
    d.rectangle([3, 10, 12, 12], fill=f)

def i_cafe(d, f, bg):
    d.rectangle([4, 5, 9, 11], fill=f)
    d.arc([8, 6, 12, 10], start=270, end=90, fill=f, width=2)
    d.line([(3, 13), (11, 13)], fill=f, width=2)

def i_car_wash(d, f, bg):
    d.rectangle([2, 8, 12, 11], fill=f)
    d.rectangle([5, 5, 10, 8], fill=f)
    d.ellipse([3, 10, 5, 12], fill=f)
    d.ellipse([10, 10, 12, 12], fill=f)
    d.line([(4, 2), (4, 4)], fill=f, width=1)
    d.line([(8, 2), (8, 4)], fill=f, width=1)
    d.line([(12, 2), (12, 4)], fill=f, width=1)

def i_chicken(d, f, bg):
    d.ellipse([3, 3, 9, 9], fill=f)
    d.line([(7, 7), (12, 12)], fill=f, width=2)
    d.ellipse([10, 10, 13, 13], outline=f, width=2)

def i_cinema(d, f, bg):
    d.rectangle([3, 4, 12, 11], outline=f, width=2)
    for x in (5, 8, 11):
        d.point([(x, 5), (x, 10)], fill=f)

def i_ev_charger(d, f, bg):
    d.polygon([(9, 2), (4, 9), (7, 9), (6, 13), (11, 6), (8, 6)], fill=f)

def i_fast_food(d, f, bg):
    d.polygon([(5, 7), (10, 7), (9, 13), (6, 13)], fill=f)
    for x in (6, 7.5, 9):
        d.line([(x, 7), (x, 3)], fill=f, width=2)

def i_fuel(d, f, bg):
    d.rectangle([4, 4, 9, 12], outline=f, width=2)
    d.rectangle([5, 5, 8, 7], fill=f)
    d.line([(9, 6), (12, 6), (12, 9)], fill=f, width=2)
    d.line([(3, 13), (10, 13)], fill=f, width=2)

def i_garage(d, f, bg):
    d.line([(4, 12), (11, 5)], fill=f, width=2)
    d.arc([8, 2, 13, 7], start=300, end=240, fill=f, width=2)

def i_gym(d, f, bg):
    d.line([(2, 7), (13, 7)], fill=f, width=2)
    d.rectangle([3, 4, 4, 10], fill=f)
    d.rectangle([11, 4, 12, 10], fill=f)
    d.rectangle([5, 5, 6, 9], fill=f)
    d.rectangle([9, 5, 10, 9], fill=f)

def i_hospital(d, f, bg):
    d.rectangle([6, 2, 9, 13], fill=f)
    d.rectangle([2, 6, 13, 9], fill=f)

def i_hotel(d, f, bg):
    d.rectangle([2, 4, 4, 12], fill=f)
    d.rectangle([4, 8, 12, 11], fill=f)
    d.rectangle([5, 6, 8, 8], fill=f)

def i_mall(d, f, bg):
    d.rectangle([4, 6, 11, 12], outline=f, width=2)
    d.arc([6, 3, 9, 8], start=180, end=0, fill=f, width=2)

def i_nightlife(d, f, bg):
    d.line([(10, 2), (10, 10)], fill=f, width=2)
    d.line([(10, 2), (6, 4)], fill=f, width=2)
    d.ellipse([3, 9, 7, 12], fill=f)

def i_parking(d, f, bg):
    d.rectangle([4, 2, 6, 13], fill=f)
    d.rectangle([6, 2, 11, 7], outline=f, width=2)

def i_pharmacy(d, f, bg):
    d.rectangle([3, 6, 12, 10], outline=f, width=2)
    d.line([(7.5, 6), (7.5, 10)], fill=f, width=2)

def i_pizza(d, f, bg):
    d.polygon([(7.5, 2), (3, 13), (12, 13)], fill=f)
    for cx, cy in ((7, 7), (6, 10), (8.5, 10.5)):
        d.ellipse([cx - 1, cy - 1, cx + 1, cy + 1], fill=bg)

def i_police(d, f, bg):
    d.polygon([(7.5, 2), (11, 4), (11, 8), (7.5, 13), (4, 8), (4, 4)], fill=f)
    d.ellipse([6, 6, 9, 9], fill=bg)

def i_qmark(d, f, bg):
    d.line([(5, 3), (10, 3)], fill=f, width=2)
    d.line([(10, 3), (10, 7)], fill=f, width=2)
    d.line([(10, 7), (7, 9)], fill=f, width=2)
    d.line([(7, 10), (7, 11)], fill=f, width=2)
    d.point([(7, 13)], fill=f)

def i_restaurant(d, f, bg):
    for x in (4, 5.5, 7):
        d.line([(x, 2), (x, 5)], fill=f, width=1)
    d.line([(5.5, 5), (5.5, 13)], fill=f, width=2)
    d.polygon([(10, 2), (11, 2), (11, 8), (10.5, 13), (9.5, 13), (10, 8)], fill=f)

def i_shop(d, f, bg):
    for i, x in enumerate((3, 6, 9)):
        d.rectangle([x, 3, x + 2, 6], fill=f)
    d.rectangle([3, 6, 12, 12], outline=f, width=2)
    d.rectangle([6.5, 8, 9, 12], fill=f)

def i_stadium(d, f, bg):
    d.polygon([(5, 3), (10, 3), (9, 8), (6, 8)], fill=f)
    d.arc([2, 4, 6, 8], start=90, end=270, fill=f, width=2)
    d.arc([9, 4, 13, 8], start=270, end=90, fill=f, width=2)
    d.line([(7.5, 8), (7.5, 11)], fill=f, width=2)
    d.line([(5, 12), (10, 12)], fill=f, width=2)

def i_supermarket(d, f, bg):
    d.polygon([(4, 5), (12, 5), (10, 10), (5, 10)], outline=f, width=2)
    d.line([(4, 5), (2, 2)], fill=f, width=2)
    d.point([(6, 12), (10, 12)], fill=f)

def i_train(d, f, bg):
    d.rectangle([4, 2, 11, 11], outline=f, width=2)
    d.rectangle([5, 4, 10, 7], fill=f)
    d.point([(5.5, 9.5), (9.5, 9.5)], fill=f)
    d.line([(4, 12.5), (11, 12.5)], fill=f, width=2)

def i_waypoint(d, f, bg):
    d.polygon([(7.5, 2), (13, 7.5), (7.5, 13), (2, 7.5)], fill=f)
    d.ellipse([6, 6, 9, 9], fill=bg)

ICONS = {name[2:]: fn for name, fn in list(globals().items()) if name.startswith('i_')}
assert set(ICONS) == set(SEMANTICS), set(SEMANTICS) ^ set(ICONS)

# ---------------------------------------------------------------- themes
# backing factories: backing_x(sem) -> draw(d) -> (fg, bg) colors
SA_BG = (18, 18, 18, 255)
SA_FG = (255, 255, 255, 255)

def backing_sa(sem):
    def draw(d):
        d.rounded_rectangle([1, 1, 14, 14], radius=4, fill=SA_BG)
        return SA_FG, SA_BG
    return draw

V_COLORS = {
    'airport': (122, 122, 122), 'atm': (46, 160, 67), 'bank': (30, 142, 62),
    'bar': (155, 89, 182), 'burger': (230, 126, 34), 'cafe': (138, 90, 43),
    'car_wash': (74, 144, 217), 'chicken': (241, 196, 15), 'cinema': (192, 57, 43),
    'ev_charger': (168, 198, 43), 'fast_food': (211, 84, 0), 'fuel': (217, 123, 43),
    'garage': (122, 122, 122), 'gym': (192, 57, 43), 'hospital': (220, 60, 60),
    'hotel': (142, 68, 173), 'mall': (155, 89, 182), 'nightlife': (232, 67, 147),
    'parking': (43, 108, 176), 'pharmacy': (39, 174, 96), 'pizza': (211, 84, 0),
    'police': (43, 108, 176), 'qmark': (122, 122, 122), 'restaurant': (230, 126, 34),
    'shop': (230, 126, 34), 'stadium': (39, 174, 96), 'supermarket': (245, 208, 32),
    'train': (122, 122, 122), 'waypoint': (232, 67, 147),
}

def backing_v(sem):
    def draw(d):
        c = V_COLORS[sem] + (255,)
        d.ellipse([1, 1, 14, 14], fill=c)
        d.ellipse([1, 1, 14, 14], outline=(255, 255, 255, 255), width=1)
        return (255, 255, 255, 255), c
    return draw

INK = (58, 45, 28, 255)
PARCHMENT = (231, 218, 185, 255)

def backing_rdr(sem):
    def draw(d):
        d.ellipse([1, 1, 14, 14], fill=PARCHMENT)
        d.ellipse([1, 1, 14, 14], outline=INK, width=1)
        return INK, PARCHMENT
    return draw

def make_blips(slug, backing_factory):
    outdir = os.path.join(REPO, 'assets', 'themes', slug, 'blips')
    os.makedirs(outdir, exist_ok=True)
    for sem in SEMANTICS:
        im = Image.new('RGBA', (16, 16), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        fg, bg = backing_factory(sem)(d)
        ICONS[sem](d, fg, bg)
        im.save(os.path.join(outdir, sem + '.png'))
    print(f'{slug}: {len(SEMANTICS)} blips')

# ---------------------------------------------------------------- players
def make_player(slug, kind):
    out = os.path.join(REPO, 'assets', 'themes', slug, 'player.png')
    im = Image.new('RGBA', (32, 32), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if kind == 'sa':
        d.polygon([(16, 2), (28, 28), (16, 22), (4, 28)], fill=(255, 255, 255, 255),
                  outline=(0, 0, 0, 255))
    elif kind == 'v':
        d.polygon([(16, 3), (27, 27), (16, 21), (5, 27)], fill=(255, 255, 255, 255))
        d.polygon([(16, 3), (27, 27), (16, 21), (5, 27)], outline=(120, 120, 120, 255))
    elif kind == 'rdr':
        d.ellipse([2, 2, 29, 29], fill=PARCHMENT, outline=INK)
        d.polygon([(16, 7), (24, 24), (16, 20), (8, 24)], fill=INK)
    im.save(out)
    print(f'{slug}: player.png')

if __name__ == '__main__':
    make_blips('san-andreas', backing_sa)
    make_blips('gta-v', backing_v)
    make_blips('rdr2', backing_rdr)
    make_player('san-andreas', 'sa')
    make_player('gta-v', 'v')
    make_player('rdr2', 'rdr')
