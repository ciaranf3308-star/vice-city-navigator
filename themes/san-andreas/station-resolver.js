/* ============================================================
   WayStation — San Andreas station resolver (dashboard radio).
   SpotifyCore retrieves raw artist genre strings; THIS file owns
   the fictional GTA: San Andreas station logic. Weighted matching:
   each (term -> weight) contributes at most once per station, the
   highest score wins, ties break toward the canonical station order
   below. WCTR is never returned for music — only for episodes /
   spoken word, decided by the caller via stationForItem().
   Pure data + logic; no DOM, no auth, no fetches — unit-testable
   in node (module.exports) and in the browser (window).
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SAStationResolver = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  /* Canonical order doubles as the tie-break priority. */
  const STATIONS = {
    'radio-los-santos': {
      file: 'radio-los-santos.png', name: 'Radio Los Santos',
      terms: {
        'west coast hip hop': 10, 'g-funk': 10, 'gangsta rap': 9,
        'west coast rap': 8, 'hip hop': 4, 'rap': 3,
      },
    },
    'playback-fm': {
      file: 'playback-fm.png', name: 'Playback FM',
      terms: {
        'old school hip hop': 10, 'golden age hip hop': 10, 'boom bap': 9,
        'east coast hip hop': 7, 'conscious hip hop': 6, 'hip hop': 3,
      },
    },
    'bounce-fm': {
      file: 'bounce-fm.png', name: 'Bounce FM',
      terms: {
        'p-funk': 10, 'funk': 9, 'boogie': 8, 'electro funk': 8,
        'disco': 6, 'disco funk': 7,
      },
    },
    'csr-1039': {
      file: 'csr-1039.png', name: 'CSR 103.9',
      terms: {
        'new jack swing': 10, 'contemporary r&b': 10, 'urban contemporary': 8,
        'r&b': 8, 'rhythm and blues': 7, 'quiet storm': 7, 'soul': 4,
      },
    },
    'master-sounds-983': {
      file: 'master-sounds-983.png', name: 'Master Sounds 98.3',
      terms: {
        'rare groove': 10, 'jazz funk': 10, 'jazz-funk': 10, 'acid jazz': 9,
        'soul': 7, 'motown': 7, 'northern soul': 8, 'funk': 5,
        'classic soul': 8,
      },
    },
    'k-dst': {
      file: 'k-dst.png', name: 'K-DST',
      terms: {
        'classic rock': 10, 'album rock': 9, 'album oriented rock': 9,
        'southern rock': 8, 'blues rock': 7, 'hard rock': 6,
      },
    },
    'radio-x': {
      file: 'radio-x.png', name: 'Radio X',
      terms: {
        'alternative rock': 10, 'grunge': 10, 'post-grunge': 8,
        'indie rock': 7, 'punk': 7, 'punk rock': 7, 'alternative metal': 6,
        'nu metal': 5,
      },
    },
    'k-rose': {
      file: 'k-rose.png', name: 'K-Rose',
      terms: {
        'outlaw country': 10, 'classic country': 10, 'country': 10,
        'americana': 8, 'bluegrass': 8, 'country rock': 7,
        'honky tonk': 7,
      },
    },
    'k-jah-west': {
      file: 'k-jah-west.png', name: 'K-JAH West',
      terms: {
        'dub': 10, 'roots reggae': 10, 'reggae': 9, 'dancehall': 8,
        'ska': 6, 'rocksteady': 7,
      },
    },
    'sf-ur': {
      file: 'sf-ur.png', name: 'SF-UR',
      terms: {
        'deep house': 10, 'acid house': 10, 'garage house': 9,
        'house': 10, 'techno': 8, 'dance': 5, 'electronic': 4,
        'club': 4,
      },
    },
    'wctr': {
      file: 'wctr.png', name: 'WCTR',
      terms: {}, // music never resolves here; episodes only, via stationForItem()
    },
  };
  const ORDER = Object.keys(STATIONS);

  function normalizeGenre(g) {
    return String(g || '').toLowerCase().trim();
  }

  /* genres: string[] (raw artist genre tags). Returns the winning
     station id, or null when nothing matched (caller keeps the
     previous station / falls back to Radio Los Santos on first run). */
  function resolve(genres) {
    const tags = (Array.isArray(genres) ? genres : []).map(normalizeGenre).filter(Boolean);
    if (!tags.length) return null;
    let bestId = null, bestScore = 0;
    for (const id of ORDER) {
      if (id === 'wctr') continue;
      const terms = STATIONS[id].terms;
      let score = 0;
      for (const term in terms) {
        for (const tag of tags) {
          if (tag.indexOf(term) !== -1) { score += terms[term]; break; }
        }
      }
      if (score > bestScore) { bestScore = score; bestId = id; }
    }
    return bestId;
  }

  /* item: a Spotify currently-playing item (or episode object);
     genres: merged artist genre strings for music items.
     Episodes / spoken word -> WCTR. Music -> weighted resolve. */
  function stationForItem(item, genres) {
    if (!item) return null;
    const type = String(item.currently_playing_type || item.type || '').toLowerCase();
    if (type === 'episode' || type === 'ad' || item.show) return 'wctr';
    return resolve(genres);
  }

  return { STATIONS, ORDER, resolve, stationForItem };
});
