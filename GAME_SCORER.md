# Game Scorer — Reference

The "Game Scorer" is the modern inline hole-scoring card used in ldrbd.app.
All scoring modes should use this pattern. The old modal picker (flat "Score"
button that opens a scroll-picker) is retired.

---

## Visual anatomy

```
┌─────────────────────────────────────────────┐
│ ● Steve W  [1 shot]                         │
│ HCP 23 · 0 pts           This hole: Net 3   │
│ Net 3 (3 pts)                (3 pts)         │
│                                              │
│  [−]   ( 4 )   [+]   PICK UP               │
│        PAR   ↑ring disc                     │
└─────────────────────────────────────────────┘
```

Key elements:
- **`gi-card`** — outer card div with `data-extra`, `data-par`, `data-pi` attributes
- **`gi-top`** — top row: player ID section + "This hole" calc tile
- **`gi-id`** — name + colour dot + shot badge + HCP line + prev-hole line
- **`gi-calc`** / **`gi-calc-val`** — live "Net X (Y pts)" or "Net X" calc
- **`gi-score-ctrl`** — bottom row: minus button + disc wrap + plus button + pickup
- **`gi-score-disc`** — ring disc showing current gross; styled via `--sc` CSS var
- **`gi-rel`** — word below disc (Birdie / Par / Bogey etc.)
- **`gi-arr gi-arr-dn` / `gi-arr-up`** — minus / plus tap targets

---

## Individual player scoring (`makePlayerInputRow`)

Located at: `js/app.js` → `function makePlayerInputRow(pi, h, par)`

- One card per player index `pi`
- Disc id: `cv${pi}`
- Writes via: `setScoreValue(pi, h, par, value, isPickup)`
- Calc update: `_giUpdateCalc(pi, value, isPickup, rowEl)`
- Running total: `_giRunningTotal(pi)` — returns pts string or rel-to-par string

Formats using this: **stableford, stroke play, match play (1v1), best2, skins, ITC, split6, CSM**

---

## Pair scoring (`isFoursome` branch in `renderHolePanel`)

Located at: `js/app.js` → `renderHolePanel()` → `if (isFoursome)` → `forEach [A, B]`

- One card per pair (A = players [0,1], B = players [2,3])
- Disc id: `cv-pair-A` / `cv-pair-B`
- Writes via: `setPairScoreValue(label, h, par, value, isPickup)`
- Uses same `gi-card` / `gi-score-ctrl` / `gi-rel` / `gi-calc` markup as individual
- `_pairUpdateCalc(val)` — local closure updating `gi-pair-calc-${label}` and `gi-pair-rel-${label}`
- No pickup button for pairs (shared team score, pickup not tracked per pair)

Formats using this: **foursomes, greensomes, 2v2 Texas Scramble Match Play**

`isFoursome` is defined as:
```js
const isFoursome = fmt === 'foursomes' || fmt === 'greensomes'
  || (fmt === 'texas' && (gameState.texasScoringFmt ?? 'stableford') === 'match');
```

---

## Texas Scramble (non-match) — team scorer

Located at: `js/app.js` → `renderHolePanel()` → `if (isTexas && !isFoursome)`

- Single card for the whole team
- Disc id: `cv-texas`
- Writes via: `_texasSetScore(val)` (local closure, updates disc inline)
- Also shows **Tee shot used** driver buttons below the disc
- No `gi-card` class — uses custom `gi-row` with bespoke layout

Formats using this: **Texas Scramble (stableford / stroke)**

---

## Key helper functions

| Function | Purpose |
|---|---|
| `scoreColorForRelToPar(relToPar, value)` | Colour for a gross score relative to par |
| `_giRingColor(color)` | Converts a colour to the `--sc` ring var format |
| `_giRelWord(value, par, isPickup)` | "Birdie", "Par", "Bogey" etc. |
| `_giRunningTotal(pi)` | Running pts or rel-to-par string for a player |
| `_giUpdateCalc(pi, value, isPickup, rowEl)` | Updates "This hole" calc for individual player |
| `setScoreValue(pi, h, par, value, isPickup)` | Writes individual player score + re-renders |
| `setPairScoreValue(label, h, par, value, isPickup)` | Writes pair score, updates disc colour |

---

## Adding a new format — checklist

1. **`renderHolePanel`**: add `isFoursome`-style branch or reuse individual cards.
   - Team format with shared score → follow pair scoring pattern
   - Individual scores → call `makePlayerInputRow(pi, h, par)` per player
2. **`buildMatchLeaderboard`**: ensure `isPairs` includes the new format if it's team-vs-team.
3. **`_giRunningTotal`**: add any special running-total logic for the format.
4. **`startGame` → `isPairs`**: include format if `setup.pairs` should order players.
5. Bump `CACHE_NAME` in `sw.js` and `?v=` in `sw.js` + `index.html`.
