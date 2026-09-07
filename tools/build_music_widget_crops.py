#!/usr/bin/env python3
"""Crop the three music-widget concept arts into portrait-pane pieces.

Sources: user's supplied concept images (workspace/user/media_library).
Outputs: themes/<id>/spotify/{header,album,stage}.png at 2x for retina.
Album-frame interior openings were measured off grid overlays; the
fractions below are consumed by each theme's spotify-skin.js so live
album art sits exactly inside the art's frame.

RDR2 (1254x1254): album opening (195,350)-(560,710)
GTA V (1155x1362): album opening (75,485)-(385,795)
SA   (1254x1254): album opening (65,385)-(575,875)
"""
from PIL import Image
import os

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.path.expanduser('~/workspace/user/media_library/image')

JOBS = {
    'rdr2': {
        'src': f'{LIB}/31/31dd4b29908afc388d318c4a0b727f97eb4e59ff8bdf4060cf8599a4965e2287.png',
        'crops': {
            'header.png': ((400, 190, 1254, 440), 960),
            'album.png': ((0, 280, 640, 780), 640),  # full brass frame + strap; old box cut the frame's right/bottom
            'stage.png': ((180, 680, 1150, 950), 960),
        },
        # fractions of album.png
        'frame': (0.3047, 0.14, 0.875, 0.86),  # measured: opening (195,350)-(560,710) of the 640x500 crop
    },
    'gta-v': {
        'src': f'{LIB}/4e/4ea2940e0dbca559d705dc88fa4b800a62a84d3b8dde10e55181ff60dc216b1d.png',
        'crops': {
            'header.png': ((0, 0, 1155, 345), 960),
            'album.png': ((30, 440, 430, 840), 560),
            'stage.png': ((60, 830, 1100, 1340), 960),
        },
        'frame': (0.1125, 0.1125, 0.8875, 0.8875),
    },
    'san-andreas': {
        'src': f'{LIB}/30/30452108ab6c4336b5cc1cc94f26b72552bb82445cc446159283b22f49e0daa0.png',
        'crops': {
            'header.png': ((0, 0, 1254, 345), 960),
            'album.png': ((20, 340, 620, 920), 560),
            'stage.png': ((20, 880, 1230, 1230), 960),
        },
        'frame': (0.07, 0.028, 0.97, 0.905),  # measured off the 560x541 crop (art goes UNDER)
    },
}

for theme_id, job in JOBS.items():
    out = os.path.join(REPO, 'themes', theme_id, 'spotify')
    os.makedirs(out, exist_ok=True)
    im = Image.open(job['src']).convert('RGBA')
    print(theme_id, im.size)
    for name, (box, w) in job['crops'].items():
        crop = im.crop(box)
        h = round(crop.size[1] * w / crop.size[0])
        p = os.path.join(out, name)
        crop.resize((w, h), Image.LANCZOS).save(p)
        print(f'  {name}: crop{box} -> {w}x{h}')
    print('  FRAME fractions x0=%.4f y0=%.4f x1=%.4f y1=%.4f' % job['frame'])
