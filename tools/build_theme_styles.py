#!/usr/bin/env python3
"""WayStation theme style generator.

Builds themes/san-andreas/style.json, themes/gta-v/style.json and
themes/rdr2/style.json directly from the OpenMapTiles vector source
(same source as the Vice City style). Each theme gets a REAL
independent style — not a hue-shift of another theme.

Palettes are original interpretations of each game's pause-map /
radar language, built for real-world OpenMapTiles geometry.

Usage: python3 tools/build_theme_styles.py
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SOURCE = {"openmaptiles": {"type": "vector", "url": "https://tiles.openfreemap.org/planet"}}
GLYPHS = "fonts/{fontstack}/{range}.pbf"

NAME_FIELD = ["coalesce", ["get", "name:en"], ["get", "name:latin"], ["get", "name"]]

# ---------------------------------------------------------------- palettes
# Every key below is consumed by build_layers(); each theme is a full,
# independent visual system.
SAN_ANDREAS = {
    "name": "San Andreas",
    "description": "San Andreas pause-map style: tan ground, black road network, restrained greens. Built from OpenMapTiles.",
    "font": "san-andreas",
    "background": "#d9c9a8",
    "water": "#5b8fc4", "waterway": "#5b8fc4",
    "beach": "#e8dcc0",
    "grass": "#9aa45e", "park": "#8a9a4e", "golf": "#93a355",
    "garden": "#8a9a4e", "recreation": "#9aa45e", "wood": "#75853f",
    "park_area": "#8a9a4e", "field": "#9aa45e", "cemetery": "#a8a878",
    "urban": "#c9b58c", "aeroway": "#bfae8c", "building": "#c2ad84",
    "road_minor_core": "#3d3d3d", "road_minor_casing": "#161616",
    "road_primary_core": "#333333", "road_primary_casing": "#141414",
    "road_motor_core": "#2b2b2b", "road_motor_casing": "#0e0e0e",
    "rail": "#454545",
    "label_place": "#26221a", "label_place_halo": "#e8dcc0",
    "label_road": "#1c1a16", "label_road_halo": "#e8dcc0",
    "label_water": "#2a5a8a", "label_water_halo": "#d9c9a8",
    "place_transform": "uppercase",
    "road_dash_tunnel": [2, 2],
}

GTA_V = {
    "name": "Grand Theft Auto V",
    "description": "GTA V Atlas style: pale monochrome urban map, clean white road hierarchy. Built from OpenMapTiles.",
    "font": "gta-v",
    "background": "#e9e9e7",
    "water": "#a9c3d3", "waterway": "#a9c3d3",
    "beach": "#e2dac6",
    "grass": "#c3cfa6", "park": "#b3c397", "golf": "#bcc99f",
    "garden": "#b3c397", "recreation": "#c3cfa6", "wood": "#98ad86",
    "park_area": "#b3c397", "field": "#c3cfa6", "cemetery": "#bfc7ae",
    "urban": "#dcdcdc", "aeroway": "#d2d2d2", "building": "#cdcdcd",
    "road_minor_core": "#ffffff", "road_minor_casing": "#b5b5b5",
    "road_primary_core": "#ffffff", "road_primary_casing": "#a8a8a8",
    "road_motor_core": "#ffffff", "road_motor_casing": "#989898",
    "rail": "#8c8c8c",
    "label_place": "#3c3c3c", "label_place_halo": "#f2f2f0",
    "label_road": "#5a5a5a", "label_road_halo": "#f2f2f0",
    "label_water": "#5c7c8c", "label_water_halo": "#e9e9e7",
    "place_transform": "none",
    "road_dash_tunnel": [3, 3],
    # GTA V renders street names in the SignPainter script on the pause
    # map; place/water labels stay in Chalet London.
    "road_font": "SignPainter",
}

RDR2 = {
    "name": "Frontier",
    "description": "Frontier paper-map style: warm parchment, hand-inked roads, strong railways, restrained water. Built from OpenMapTiles.",
    "font": "frontier",
    "background": "#e7dab9",
    "water": "#a9bab2", "waterway": "#8b9c95",
    "beach": "#e2d2a8",
    "grass": "#d6ca9c", "park": "#c6ba86", "golf": "#cfc294",
    "garden": "#c6ba86", "recreation": "#d6ca9c", "wood": "#a59468",
    "park_area": "#c6ba86", "field": "#d8ce9e", "cemetery": "#cabb90",
    "urban": "#d3bd8b", "aeroway": "#cdb87f", "building": "#c8b183",
    "road_minor_core": "#6d5c40", "road_minor_casing": "#6d5c40",
    "road_primary_core": "#584832", "road_primary_casing": "#584832",
    "road_motor_core": "#4c3d2a", "road_motor_casing": "#4c3d2a",
    "rail": "#463723",
    "label_place": "#3a2d1c", "label_place_halo": "#e7dab9",
    "label_road": "#5c4b33", "label_road_halo": "#e7dab9",
    "label_water": "#4c6c72", "label_water_halo": "#e7dab9",
    "place_transform": "none",
    "road_dash_tunnel": [1.5, 2.5],
    # RDR2's map sets place names in widely-tracked capitals.
    "place_letter_spacing": 0.18,
}

# ---------------------------------------------------------------- builders
def line_width(stops):
    return ["interpolate", ["exponential", 1.5], ["zoom"]] + [x for s in stops for x in s]

def build_layers(p, pal):
    L = []
    add = L.append
    # background
    add({"id": f"{p}-land", "type": "background",
         "paint": {"background-color": pal["background"]}})
    # water
    add({"id": f"{p}-water", "type": "fill", "source": "openmaptiles", "source-layer": "water",
         "paint": {"fill-color": pal["water"]}})
    add({"id": f"{p}-waterway", "type": "line", "source": "openmaptiles", "source-layer": "waterway",
         "paint": {"line-color": pal["waterway"],
                    "line-width": line_width([[8, 0.6], [14, 2.5], [18, 8]])}})
    # landcover
    add({"id": f"{p}-beach", "type": "fill", "source": "openmaptiles", "source-layer": "landcover",
         "filter": ["==", ["get", "class"], "sand"],
         "paint": {"fill-color": pal["beach"]}})
    add({"id": f"{p}-grass", "type": "fill", "source": "openmaptiles", "source-layer": "landcover",
         "filter": ["all", ["==", ["get", "class"], "grass"],
                    ["!", ["match", ["get", "subclass"],
                            ["park", "village_green", "golf_course", "garden", "recreation_ground"],
                            True, False]]],
         "paint": {"fill-color": pal["grass"]}})
    add({"id": f"{p}-parks", "type": "fill", "source": "openmaptiles", "source-layer": "landcover",
         "filter": ["match", ["get", "subclass"], ["park", "village_green"], True, False],
         "paint": {"fill-color": pal["park"]}})
    add({"id": f"{p}-golf", "type": "fill", "source": "openmaptiles", "source-layer": "landcover",
         "filter": ["==", ["get", "subclass"], "golf_course"],
         "paint": {"fill-color": pal["golf"]}})
    add({"id": f"{p}-gardens", "type": "fill", "source": "openmaptiles", "source-layer": "landcover",
         "filter": ["==", ["get", "subclass"], "garden"],
         "paint": {"fill-color": pal["garden"]}})
    add({"id": f"{p}-recreation", "type": "fill", "source": "openmaptiles", "source-layer": "landcover",
         "filter": ["==", ["get", "subclass"], "recreation_ground"],
         "paint": {"fill-color": pal["recreation"]}})
    add({"id": f"{p}-woods", "type": "fill", "source": "openmaptiles", "source-layer": "landcover",
         "filter": ["==", ["get", "class"], "wood"],
         "paint": {"fill-color": pal["wood"]}})
    add({"id": f"{p}-park-areas", "type": "fill", "source": "openmaptiles", "source-layer": "park",
         "paint": {"fill-color": pal["park_area"]}})
    add({"id": f"{p}-playing-fields", "type": "fill", "source": "openmaptiles", "source-layer": "landuse",
         "filter": ["match", ["get", "class"], ["pitch", "playground", "stadium"], True, False],
         "paint": {"fill-color": pal["field"]}})
    add({"id": f"{p}-cemeteries", "type": "fill", "source": "openmaptiles", "source-layer": "landuse",
         "filter": ["==", ["get", "class"], "cemetery"],
         "paint": {"fill-color": pal["cemetery"]}})
    add({"id": f"{p}-urban", "type": "fill", "source": "openmaptiles", "source-layer": "landuse",
         "filter": ["match", ["get", "class"],
                    ["residential", "commercial", "industrial", "retail"], True, False],
         "paint": {"fill-color": pal["urban"]}})
    add({"id": f"{p}-aeroway", "type": "fill", "source": "openmaptiles", "source-layer": "aeroway",
         "paint": {"fill-color": pal["aeroway"]}})
    add({"id": f"{p}-buildings", "type": "fill", "source": "openmaptiles", "source-layer": "building",
         "paint": {"fill-color": pal["building"]}})
    # roads: casing then core, minor -> primary -> motorway
    road_filter = lambda classes: [
        "all",
        ["match", ["get", "class"], classes, True, False],
        ["!=", ["get", "brunnel"], "bridge"],
        ["!=", ["get", "brunnel"], "tunnel"],
    ]
    def road_pair(kind, classes, core, casing, core_stops, minzoom):
        add({"id": f"{p}-road-{kind}-casing", "type": "line",
             "source": "openmaptiles", "source-layer": "transportation",
             "minzoom": minzoom, "filter": road_filter(classes),
             "layout": {"line-cap": "round", "line-join": "round"},
             "paint": {"line-color": casing,
                       "line-width": line_width([(z, w + 1.6) for z, w in core_stops])}})
        add({"id": f"{p}-road-{kind}", "type": "line",
             "source": "openmaptiles", "source-layer": "transportation",
             "minzoom": minzoom, "filter": road_filter(classes),
             "layout": {"line-cap": "round", "line-join": "round"},
             "paint": {"line-color": core, "line-width": line_width(core_stops)}})
    road_pair("minor", ["minor", "service", "track"],
              pal["road_minor_core"], pal["road_minor_casing"],
              [[10, 0.8], [14, 3], [18, 10]], 10)
    road_pair("primary", ["primary", "secondary", "tertiary"],
              pal["road_primary_core"], pal["road_primary_casing"],
              [[8, 1.2], [12, 5], [16, 14]], 6)
    road_pair("motorway", ["motorway", "trunk"],
              pal["road_motor_core"], pal["road_motor_casing"],
              [[6, 2.4], [10, 7.5], [14, 18]], 5)
    # bridges
    add({"id": f"{p}-bridges", "type": "line",
         "source": "openmaptiles", "source-layer": "transportation",
         "filter": ["all", ["==", ["get", "brunnel"], "bridge"],
                    ["match", ["get", "class"],
                     ["motorway", "trunk", "primary", "secondary", "tertiary"],
                     True, False]],
         "layout": {"line-cap": "round", "line-join": "round"},
         "paint": {"line-color": pal["road_primary_core"],
                   "line-width": line_width([[8, 1.4], [12, 5.5], [16, 15]])}})
    # tunnels (dashed, subdued)
    add({"id": f"{p}-tunnels", "type": "line",
         "source": "openmaptiles", "source-layer": "transportation",
         "filter": ["all", ["==", ["get", "brunnel"], "tunnel"],
                    ["match", ["get", "class"],
                     ["motorway", "trunk", "primary", "secondary", "tertiary",
                      "minor", "service"], True, False]],
         "layout": {"line-cap": "round", "line-join": "round"},
         "paint": {"line-color": pal["road_primary_casing"], "line-opacity": 0.7,
                   "line-dasharray": pal["road_dash_tunnel"],
                   "line-width": line_width([[8, 1], [12, 4], [16, 12]])}})
    # railway — strong treatment in every theme, strongest on the frontier
    add({"id": f"{p}-railway", "type": "line",
         "source": "openmaptiles", "source-layer": "transportation",
         "filter": ["==", ["get", "class"], "rail"],
         "layout": {"line-cap": "round", "line-join": "round"},
         "paint": {"line-color": pal["rail"],
                   "line-width": line_width([[8, 1], [12, 2.5], [16, 6]])}})
    # labels
    font = [pal["font"]]
    road_font = [pal.get("road_font", pal["font"])]
    place_extra = ({"text-letter-spacing": pal["place_letter_spacing"]}
                   if pal.get("place_letter_spacing") else {})
    add({"id": f"{p}-label-water", "type": "symbol",
         "source": "openmaptiles", "source-layer": "water_name",
         "layout": {"text-field": NAME_FIELD, "text-font": font,
                    "text-size": 11, "text-max-width": 8},
         "paint": {"text-color": pal["label_water"],
                   "text-halo-color": pal["label_water_halo"],
                   "text-halo-width": 1.5}})
    place_size = ["match", ["get", "class"],
                  "country", 13, "state", 12, "city", 18, "town", 14,
                  "village", 11, "suburb", 11, "hamlet", 10, 10]
    add({"id": f"{p}-label-place", "type": "symbol",
         "source": "openmaptiles", "source-layer": "place",
         "filter": ["match", ["get", "class"],
                    ["country", "state", "city", "town", "village",
                     "suburb", "hamlet"], True, False],
         "layout": {"text-field": NAME_FIELD, "text-font": font,
                    "text-max-width": 8, "text-size": place_size,
                    **place_extra,
                    **({"text-transform": "uppercase"}
                       if pal["place_transform"] == "uppercase" else {})},
         "paint": {"text-color": pal["label_place"],
                   "text-halo-color": pal["label_place_halo"],
                   "text-halo-width": 2}})
    add({"id": f"{p}-label-road-major", "type": "symbol",
         "source": "openmaptiles", "source-layer": "transportation_name",
         "minzoom": 11,
         "filter": ["in", ["get", "class"],
                    ["literal", ["motorway", "trunk", "primary",
                                 "secondary", "tertiary"]]],
         "layout": {"symbol-placement": "line", "text-field": NAME_FIELD,
                    "text-font": road_font, "text-max-width": 8,
                    "text-size": ["interpolate", ["linear"], ["zoom"],
                                  11, 10, 14, 11.5, 17, 13]},
         "paint": {"text-color": pal["label_road"],
                   "text-halo-color": pal["label_road_halo"],
                   "text-halo-width": 1.5}})
    add({"id": f"{p}-label-road-minor", "type": "symbol",
         "source": "openmaptiles", "source-layer": "transportation_name",
         "minzoom": 13.5,
         "filter": ["!", ["in", ["get", "class"],
                           ["literal", ["motorway", "trunk", "primary",
                                        "secondary", "tertiary"]]]],
         "layout": {"symbol-placement": "line", "text-field": NAME_FIELD,
                    "text-font": road_font, "text-max-width": 8,
                    "text-size": ["interpolate", ["linear"], ["zoom"],
                                  13.5, 9.5, 16, 11, 18, 12.5]},
         "paint": {"text-color": pal["label_road"],
                   "text-halo-color": pal["label_road_halo"],
                   "text-halo-width": 1.25}})
    return L

def build(name, slug, prefix, pal):
    style = {
        "version": 8,
        "name": name,
        "metadata": {"description": pal["description"]},
        "sources": SOURCE,
        "glyphs": GLYPHS,
        "layers": build_layers(prefix, pal),
    }
    out = os.path.join(REPO, "themes", slug, "style.json")
    with open(out, "w") as f:
        json.dump(style, f, indent=2)
        f.write("\n")
    print(f"wrote {out} ({len(style['layers'])} layers)")

if __name__ == "__main__":
    build("San Andreas", "san-andreas", "sa", SAN_ANDREAS)
    build("Grand Theft Auto V", "gta-v", "v", GTA_V)
    build("Frontier", "rdr2", "rdr", RDR2)
