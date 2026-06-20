// ================================================================
// LEADERBOARD — game.js
// Pure scoring engine. No UI, no DB calls.
// All functions are pure — given inputs, return outputs.
// ================================================================

// ================================================================
// CONSTANTS
// ================================================================

export const FORMAT_LABELS = {
  stroke:     'Stroke Play',
  stableford: 'Stableford',
  match:      'Match Play',
  skins:      'Skins',
  split6:     'Split 6',
  itc:        'In the Chair',
  betterball: 'Pairs — Better Ball',
  csm:        'Pairs — Combined Score',
  foursomes:  'Pairs — Foursomes',
  greensomes: 'Pairs — Greensomes',
  best2:      'Team — Best 2',
  texas:      'Texas Scramble',
};

export const FORMAT_DESCS = {
  stroke:     'Total net shots over the round',
  stableford: 'Points against par based on net score',
  match:      'Net scores · hole by hole · match play',
  skins:      'Win a hole outright to claim the skin · halved holes carry over',
  split6:     '6 points distributed per hole based on net scores',
  itc:        'Win a hole to sit in the chair · defend it to score a point',
  betterball: '2 pairs · best net score per pair competes · match play',
  csm:        '2 pairs · combined stableford scores · match play',
  foursomes:  '2 pairs · alternate shots · match play',
  greensomes: '2 pairs · both drive then alternate · match play',
  best2:      'Best 2 stableford scores per group · groups compete on leaderboard',
  texas:      'Team scramble · all play from the best drive · one team score per hole',
};

// Minimum players required for each format
export const FORMAT_MIN_PLAYERS = {
  stroke:     1,
  stableford: 1,
  match:      2,
  skins:      2,
  split6:     3,
  itc:        2,
  betterball: 4,
  csm:        4,
  foursomes:  4,
  greensomes: 4,
  best2:      3,
  texas:      2,
};

// Which formats are available for a given player count
export function formatsForPlayerCount(n) {
  const all = Object.keys(FORMAT_LABELS);
  return all.filter(f => {
    if (n < FORMAT_MIN_PLAYERS[f]) return false;
    if (f === 'split6' && n !== 3) return false;
    if ((f === 'betterball' || f === 'csm' || f === 'foursomes' || f === 'greensomes') && n !== 4) return false;
    return true;
  });
}

// ================================================================
// HANDICAP CALCULATIONS
// ================================================================

// How many extra shots a player receives on a given hole
// Uses match handicap (relative to lowest in group)
export function strokesOnHole(matchHandicap, strokeIndex) {
  let strokes = 0;
  if (matchHandicap >= strokeIndex)      strokes = 1;
  if (matchHandicap >= strokeIndex + 18) strokes = 2;
  return strokes;
}

// How many extra shots for individual play (uses full playing handicap)
export function indivStrokesOnHole(playingHandicap, strokeIndex) {
  let strokes = 0;
  if (playingHandicap >= strokeIndex)      strokes = 1;
  if (playingHandicap >= strokeIndex + 18) strokes = 2;
  return strokes;
}

// Calculate playing handicaps for all players in a round
// Returns array of { playingHandicap, matchHandicap } for each player
export function calcHandicaps(handicapIndexes, allowancePct) {
  const pct = allowancePct / 100;
  const playing = handicapIndexes.map(h => Math.round(h * pct));
  const min = Math.min(...playing);
  const match = playing.map(p => p - min);
  return handicapIndexes.map((_, i) => ({
    playingHandicap: playing[i],
    matchHandicap:   match[i],
  }));
}

// ================================================================
// STABLEFORD POINTS
// ================================================================

// Points scored on a hole given gross score, extra shots, and par
export function stablefordPoints(gross, extraShots, par) {
  const net  = gross - extraShots;
  const diff = net - par;
  if (diff >=  2) return 0;
  if (diff ===  1) return 1;
  if (diff ===  0) return 2;
  if (diff === -1) return 3;
  if (diff === -2) return 4;
  return 5; // albatross or better
}

// ================================================================
// STROKE PLAY
// ================================================================

export function calcStrokeHole(gross, extraShots) {
  return gross - extraShots; // net score
}

// ================================================================
// MATCH PLAY (2 players)
// ================================================================

// Returns 1 if player A wins hole, -1 if B wins, 0 if halved
export function matchPlayHoleResult(netA, netB) {
  if (netA < netB) return  1;
  if (netB < netA) return -1;
  return 0;
}

// Returns current match status as a display string
export function matchPlayStatus(matchScore, holesPlayed, totalHoles) {
  const holesLeft = totalHoles - holesPlayed;
  const up        = Math.abs(matchScore);

  if (matchScore === 0) {
    return { text: 'ALL SQ', detail: holesLeft > 0 ? `${holesLeft} to play` : 'All square', leader: null };
  }

  const leader = matchScore > 0 ? 'A' : 'B';

  if (holesLeft === 0) {
    return { text: `${up} UP`, detail: `Player ${leader} wins`, leader };
  }
  if (up > holesLeft) {
    return { text: `${up}&${holesLeft}`, detail: `Player ${leader} wins`, leader };
  }
  if (up === holesLeft) {
    return { text: `DORMIE ${up}`, detail: `${holesLeft} to play`, leader };
  }
  return { text: `${up} UP`, detail: `${holesLeft} to play`, leader };
}

// Is the match mathematically over?
export function matchPlayIsOver(matchScore, holesPlayed, totalHoles) {
  const holesLeft = totalHoles - holesPlayed;
  return Math.abs(matchScore) > holesLeft;
}

// ================================================================
// SPLIT 6 (3 players)
// ================================================================

// Distribute 6 points across 3 players based on net scores
export function split6Points(nets) {
  const [a, b, c] = nets;
  const sorted = [...nets].sort((x, y) => x - y);

  // All tied
  if (a === b && b === c) return [2, 2, 2];

  // All different
  if (a !== b && b !== c && a !== c) {
    return nets.map(n => n === sorted[0] ? 4 : n === sorted[1] ? 2 : 0);
  }

  // Two tied for best
  if (sorted[0] === sorted[1] && sorted[1] < sorted[2]) {
    return nets.map(n => n === sorted[0] ? 3 : 0);
  }

  // Two tied for worst
  if (sorted[1] === sorted[2] && sorted[0] < sorted[1]) {
    return nets.map(n => n === sorted[0] ? 4 : 1);
  }

  // Fallback
  return [2, 2, 2];
}

// Running split 6 totals — always subtract minimum so lowest is 0
export function split6RunningTotals(log) {
  let raw = new Array(3).fill(0);
  for (const entry of log) {
    raw = raw.map((p, i) => p + (entry.holePts[i] ?? 0));
    const min = Math.min(...raw);
    raw = raw.map(p => p - min);
  }
  return raw;
}

// ================================================================
// BETTER BALL (4 players, 2 pairs)
// ================================================================

// Best net score in a pair
export function betterBallPairNet(pairIndexes, grosses, matchHandicaps, strokeIndexes, holeIndex) {
  let best = Infinity;
  let bestPi = pairIndexes[0];
  for (const pi of pairIndexes) {
    const extra = strokesOnHole(matchHandicaps[pi], strokeIndexes[holeIndex]);
    const net   = grosses[pi] - extra;
    if (net < best) { best = net; bestPi = pi; }
  }
  return { net: best, pi: bestPi };
}

// ================================================================
// COMBINED SCORE MATCHPLAY (4 players, 2 pairs)
// ================================================================

// Sum stableford points for a pair on a hole
export function csmPairPoints(pairIndexes, grosses, matchHandicaps, strokeIndexes, holeIndex, par) {
  let total = 0;
  for (const pi of pairIndexes) {
    const extra = strokesOnHole(matchHandicaps[pi], strokeIndexes[holeIndex]);
    total += stablefordPoints(grosses[pi], extra, par);
  }
  return total;
}

// ================================================================
// SKINS
// ================================================================

// Returns winner index (0-based) or -1 if halved
export function skinsHoleWinner(grosses, extras) {
  const nets    = grosses.map((g, i) => g - extras[i]);
  const minNet  = Math.min(...nets);
  const winners = nets.filter(n => n === minNet);
  return winners.length === 1 ? nets.indexOf(minNet) : -1;
}

// Process a skins hole — returns updated skins totals and pot
export function skinsProcessHole({ skins, pot, grosses, extras }) {
  const winner = skinsHoleWinner(grosses, extras);
  const potWon = pot;

  if (winner === -1) {
    return { skins: [...skins], pot: pot + 1, winner: -1, potWon };
  }

  const newSkins = [...skins];
  newSkins[winner] += pot;
  return { skins: newSkins, pot: 1, winner, potWon };
}

// ================================================================
// IN THE CHAIR
// ================================================================

// Returns winner index or -1 if halved
export function itcHoleWinner(grosses, extras) {
  const nets    = grosses.map((g, i) => g - extras[i]);
  const minNet  = Math.min(...nets);
  const winners = nets.filter(n => n === minNet);
  return winners.length === 1 ? nets.indexOf(minNet) : -1;
}

// Process an ITC hole
// Returns { winner, prevChair, newChair, pointScoredBy }
export function itcProcessHole({ chair, grosses, extras }) {
  const winner    = itcHoleWinner(grosses, extras);
  const prevChair = chair;

  if (winner === -1) {
    // Halved — chair emptied
    return { winner: -1, prevChair, newChair: null, pointScoredBy: null };
  }

  if (prevChair === winner) {
    // Defended the chair — score a point, stay in chair
    return { winner, prevChair, newChair: winner, pointScoredBy: winner };
  }

  // New player takes the chair
  return { winner, prevChair, newChair: winner, pointScoredBy: null };
}

// ================================================================
// FOURSOMES / GREENSOMES
// Same match play engine — one score per pair per hole
// The UI handles which player's turn it is to hit
// ================================================================

// Foursomes pair handicap: average of both players' match handicaps
export function foursomedPairHandicap(hcpA, hcpB) {
  return Math.round((hcpA + hcpB) / 2);
}

// Greensomes pair handicap: 0.6 × lower + 0.4 × higher (WHS official)
export function greensomesPairHandicap(hcpA, hcpB) {
  const lower  = Math.min(hcpA, hcpB);
  const higher = Math.max(hcpA, hcpB);
  return Math.round(0.6 * lower + 0.4 * higher);
}

// Better-ball style: each player uses their individual match handicap
// (used for Skins-pairs and ITC-pairs as well as Better Ball)
export function betterBallExtras(pairIndexes, matchHandicaps, si) {
  return pairIndexes.map(pi => strokesOnHole(matchHandicaps[pi], si));
}

// ================================================================
// BEST 2 SCORES (4 players, individual stableford, best 2 count)
// ================================================================

export function best2HolePoints(stablefordPtsArray) {
  const sorted = [...stablefordPtsArray].sort((a, b) => b - a);
  const best2  = sorted[0] + (sorted[1] ?? 0);
  // Which players' scores counted
  const used = new Set();
  let remaining = [...stablefordPtsArray];
  for (let take = 0; take < 2; take++) {
    const max = Math.max(...remaining);
    const idx = remaining.indexOf(max);
    used.add(stablefordPtsArray.indexOf(max, take === 0 ? 0 : stablefordPtsArray.indexOf(max) + 1));
    remaining[idx] = -Infinity;
  }
  return { points: best2, counted: [...used] };
}

// ================================================================
// TEXAS SCRAMBLE HANDICAP CALCULATION
// mode: 'average' = avg of all indexes (rounded up)
//       'weighted' = 25%/20%/15%/10% of sorted indexes
// ================================================================
export function texasTeamHandicap(indexes, mode = 'average', allowancePct = 100) {
  if (!indexes.length) return 0;
  const sorted = [...indexes].sort((a, b) => a - b); // ascending
  let raw;
  if (mode === 'weighted') {
    const weights = [0.25, 0.20, 0.15, 0.10];
    raw = sorted.reduce((sum, h, i) => sum + h * (weights[i] ?? 0.10), 0);
  } else {
    raw = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  }
  return Math.ceil(raw * (allowancePct / 100));
}

// ================================================================
// GAME STATE — initialise a fresh round
// ================================================================

export function buildInitialState({
  format,
  names,
  handicapIndexes,
  playingHandicaps,
  matchHandicaps,
  allowancePct,
  si,
  par,
  numHoles,
  holeOffset,
  courseName,
  teeName,
  tournamentId      = null,
  tournamentRoundId = null,
  groupNumber       = null,
  totalGroups       = null,
  organiserId       = null,
  longestDriveHoles = [],  // array of hole numbers (1-18), absolute not relative to offset
  nearestPinHoles   = [],  // array of hole numbers (1-18)
}) {
  const nPlayers = names.length;
  const base = {
    format,
    names,
    handicapIndexes,
    playingHandicaps,
    matchHandicaps,
    allowancePct,
    si,
    par,
    numHoles:         numHoles   ?? 18,
    holeOffset:       holeOffset ?? 0,
    courseName,
    teeName,
    tournamentId,
    tournamentRoundId,
    groupNumber,
    totalGroups,
    organiserId,
    hole: 0,
    log:  [],
    // Longest Drive / Nearest the Pin side-competitions — independent of format/scoring
    longestDriveHoles,
    nearestPinHoles,
    ldResults:  {}, // { [holeNumber]: { playerIdx, playerName, yards, lat, lng, accuracy, markedBy, ts } }
    ntpResults: {}, // { [holeNumber]: { playerIdx, playerName, cm, markedBy, ts } }
  };

  // Format-specific state
  switch (format) {
    case 'stableford':
    case 'stroke':
      return { ...base, totals: new Array(nPlayers).fill(0) };

    case 'match':
      return { ...base, matchScore: 0, matchDecided: false };

    case 'skins':
      return { ...base, skins: new Array(nPlayers).fill(0), pot: 1 };

    case 'split6':
      return { ...base, runningPts: new Array(3).fill(0) };

    case 'itc':
      return { ...base, pts: new Array(nPlayers).fill(0), chair: null };

    case 'betterball':
    case 'csm':
      return { ...base, matchScore: 0, matchDecided: false };

    case 'foursomes':
    case 'greensomes':
      return { ...base, matchScore: 0, matchDecided: false };

    case 'best2':
      return { ...base, totals: new Array(nPlayers).fill(0), groupTotal: 0 };

    case 'texas':
      return {
        ...base,
        grossTotal:      0,
        teamHcp:         0,   // set by caller after buildInitialState
        texasMode:       'average',
        texasScoringFmt: 'stableford',
        driverUsage:     { par3: [], par4: [], par5: [] },
        // pts / running totals for stableford scoring
        texasPts:        0,
      };

    default:
      return base;
  }
}

// ================================================================
// GAME STATE — process a hole and return updated state
// This is the main function called by the UI on each hole recording
// ================================================================

export function processHole(state, grosses) {
  const h      = state.hole;
  const si     = state.si[h];
  const par    = state.par[h];
  const format = state.format;

  // Build entry that will be pushed to state.log
  const entry = {
    h1:     h + 1 + (state.holeOffset ?? 0), // display hole number
    hIdx:   h,  // array index
    si,
    par,
    grosses: [...grosses],
  };

  // Mutate a copy of state
  const next = { ...state, log: [...state.log] };

  switch (format) {

    case 'stableford': {
      const extras = grosses.map((_, pi) => indivStrokesOnHole(state.playingHandicaps[pi], si));
      const pts    = grosses.map((g, pi) => stablefordPoints(g, extras[pi], par));
      const totals = (next.totals ?? []).map((t, i) => t + pts[i]);
      entry.extras      = extras;
      entry.holePts     = pts;
      entry.totalsAfter = totals;
      next.totals = totals;
      break;
    }

    case 'stroke': {
      const extras = grosses.map((_, pi) => indivStrokesOnHole(state.playingHandicaps[pi], si));
      const nets   = grosses.map((g, i) => g - extras[i]);
      const totals = (next.totals ?? []).map((t, i) => t + nets[i]);
      entry.extras      = extras;
      entry.nets        = nets;
      entry.totalsAfter = totals;
      next.totals = totals;
      break;
    }

    case 'match': {
      const extras = grosses.map((_, pi) => strokesOnHole(state.matchHandicaps[pi], si));
      const nets   = grosses.map((g, i) => g - extras[i]);
      const result = matchPlayHoleResult(nets[0], nets[1]);
      next.matchScore  = (next.matchScore ?? 0) + result;
      entry.extras     = extras;
      entry.nets       = nets;
      entry.result     = result;
      entry.matchAfter = next.matchScore;
      break;
    }

    case 'split6': {
      const extras   = grosses.map((_, pi) => indivStrokesOnHole(state.playingHandicaps[pi], si));
      const nets     = grosses.map((g, i) => g - extras[i]);
      const holePts  = split6Points(nets);
      entry.extras   = extras;
      entry.nets     = nets;
      entry.holePts  = holePts;
      // Recalculate running totals from scratch to keep things clean
      next.log.push(entry);
      next.runningPts = split6RunningTotals(next.log);
      next.hole = h + 1;
      return next; // early return since we already pushed entry
    }

    case 'itc': {
      const extras = grosses.map((_, pi) => strokesOnHole(state.matchHandicaps[pi], si));
      const { winner, prevChair, newChair, pointScoredBy } = itcProcessHole({
        chair:  next.chair,
        grosses,
        extras,
      });
      if (pointScoredBy !== null) {
        next.pts = [...(next.pts ?? [])];
        next.pts[pointScoredBy]++;
      }
      next.chair = newChair;
      entry.extras        = extras;
      entry.winner        = winner;
      entry.prevChair     = prevChair;
      entry.newChair      = newChair;
      entry.pointScoredBy = pointScoredBy;
      entry.ptsAfter      = [...(next.pts ?? [])];
      break;
    }

    case 'skins': {
      const extras  = grosses.map((_, pi) => strokesOnHole(state.matchHandicaps[pi], si));
      const result  = skinsProcessHole({ skins: next.skins, pot: next.pot, grosses, extras });
      next.skins    = result.skins;
      next.pot      = result.pot;
      entry.extras  = extras;
      entry.winner  = result.winner;
      entry.potWon  = result.potWon;
      entry.skinsAfter = [...result.skins];
      break;
    }

    case 'betterball': {
      const extras = grosses.map((_, pi) => strokesOnHole(state.matchHandicaps[pi], si));
      const bbA    = betterBallPairNet([0, 1], grosses, state.matchHandicaps, state.si, h);
      const bbB    = betterBallPairNet([2, 3], grosses, state.matchHandicaps, state.si, h);
      const result = matchPlayHoleResult(bbA.net, bbB.net);
      next.matchScore  = (next.matchScore ?? 0) + result;
      entry.extras     = extras;
      entry.nets       = grosses.map((g, i) => g - extras[i]);
      entry.bbA        = bbA;
      entry.bbB        = bbB;
      entry.result     = result;
      entry.matchAfter = next.matchScore;
      break;
    }

    case 'csm': {
      const extras  = grosses.map((_, pi) => strokesOnHole(state.matchHandicaps[pi], si));
      const totalA  = csmPairPoints([0, 1], grosses, state.matchHandicaps, state.si, h, par);
      const totalB  = csmPairPoints([2, 3], grosses, state.matchHandicaps, state.si, h, par);
      const sbPts   = grosses.map((g, pi) => stablefordPoints(g, extras[pi], par));
      const result  = totalA > totalB ? 1 : totalB > totalA ? -1 : 0;
      next.matchScore  = (next.matchScore ?? 0) + result;
      entry.extras     = extras;
      entry.nets       = grosses.map((g, i) => g - extras[i]);
      entry.sbPts      = sbPts;
      entry.totalA     = totalA;
      entry.totalB     = totalB;
      entry.result     = result;
      entry.matchAfter = next.matchScore;
      break;
    }

    case 'foursomes':
    case 'greensomes': {
      // grosses[0] = pair A score, grosses[1] = pair B score
      const pairAHcp = format === 'greensomes'
        ? greensomesPairHandicap(state.matchHandicaps[0], state.matchHandicaps[1])
        : foursomedPairHandicap(state.matchHandicaps[0], state.matchHandicaps[1]);
      const pairBHcp = format === 'greensomes'
        ? greensomesPairHandicap(state.matchHandicaps[2], state.matchHandicaps[3])
        : foursomedPairHandicap(state.matchHandicaps[2], state.matchHandicaps[3]);
      const extraA   = strokesOnHole(pairAHcp, si);
      const extraB   = strokesOnHole(pairBHcp, si);
      const netA     = grosses[0] - extraA;
      const netB     = grosses[1] - extraB;
      const result   = matchPlayHoleResult(netA, netB);
      next.matchScore  = (next.matchScore ?? 0) + result;
      entry.extras     = [extraA, extraB];
      entry.nets       = [netA, netB];
      entry.result     = result;
      entry.matchAfter = next.matchScore;
      break;
    }

    case 'best2': {
      const pts     = grosses.map((g, pi) => stablefordPoints(g, indivStrokesOnHole(state.playingHandicaps[pi], si), par));
      const { points: holeB2, counted } = best2HolePoints(pts);
      const totals  = (next.totals ?? []).map((t, i) => t + pts[i]);
      next.totals    = totals;
      next.groupTotal = (next.groupTotal ?? 0) + holeB2;
      entry.holePts        = pts;
      entry.holeB2         = holeB2;
      entry.counted        = counted;
      entry.totalsAfter    = totals;
      entry.groupTotalAfter = next.groupTotal;
      break;
    }

    case 'texas': {
      // grosses[0] = team gross score, grosses[1] = driver player index
      const gross      = grosses[0];
      const driverIdx  = grosses[1] ?? 0;
      const teamHcp    = next.teamHcp ?? 0;
      const teamExtra  = strokesOnHole(teamHcp, si);
      const net        = gross - teamExtra;

      // Stableford pts from net score
      const pts = Math.max(0, 2 + par - net);

      next.grossTotal  = (next.grossTotal ?? 0) + gross;
      next.texasPts    = (next.texasPts   ?? 0) + pts;

      // Track driver usage by par
      const parKey = par === 3 ? 'par3' : par === 4 ? 'par4' : 'par5';
      const usage  = { ...(next.driverUsage ?? { par3:[], par4:[], par5:[] }) };
      usage[parKey] = [...(usage[parKey] ?? []), driverIdx];
      next.driverUsage = usage;

      entry.gross          = gross;
      entry.net            = net;
      entry.teamExtra      = teamExtra;
      entry.pts            = pts;
      entry.driverIdx      = driverIdx;
      entry.grossTotalAfter = next.grossTotal;
      entry.texaPtsAfter   = next.texasPts;
      break;
    }

    default:
      break;
  }

  next.log.push(entry);
  next.hole = h + 1;
  return next;
}

// ================================================================
// GAME STATE — go back one hole (undo)
// ================================================================

export function undoHole(state) {
  if (!state.log.length) return state;

  const next = { ...state };
  next.log   = state.log.slice(0, -1);
  next.hole  = state.hole - 1;

  // Recalculate cumulative state from scratch
  return recalcState(next);
}

// Recalculate all cumulative state from the log
// Called after undo or after editing a hole
function recalcState(state) {
  const next = {
    ...state,
    // Reset cumulative fields
    totals:     state.totals     ? new Array(state.names.length).fill(0) : undefined,
    matchScore: state.matchScore !== undefined ? 0 : undefined,
    skins:      state.skins      ? new Array(state.skins.length).fill(0) : undefined,
    pot:        state.pot        !== undefined ? 1 : undefined,
    pts:        state.pts        ? new Array(state.names.length).fill(0) : undefined,
    chair:      state.chair      !== undefined ? null : undefined,
    groupTotal: state.groupTotal !== undefined ? 0 : undefined,
    runningPts: state.runningPts ? new Array(3).fill(0) : undefined,
  };

  // Replay log entries without re-processing grosses (entries already have computed values)
  for (const entry of next.log) {
    switch (state.format) {
      case 'stableford':
      case 'best2':
        next.totals = entry.totalsAfter ? [...entry.totalsAfter] : next.totals;
        if (state.format === 'best2') next.groupTotal = entry.groupTotalAfter ?? next.groupTotal;
        break;
      case 'stroke':
        next.totals = entry.totalsAfter ? [...entry.totalsAfter] : next.totals;
        break;
      case 'match':
      case 'betterball':
      case 'csm':
      case 'foursomes':
      case 'greensomes':
        next.matchScore = entry.matchAfter ?? next.matchScore;
        break;
      case 'skins':
        next.skins = entry.skinsAfter ? [...entry.skinsAfter] : next.skins;
        next.pot   = entry.pot ?? next.pot;
        break;
      case 'itc':
        next.pts   = entry.ptsAfter ? [...entry.ptsAfter] : next.pts;
        next.chair = entry.newChair ?? next.chair;
        break;
      case 'split6':
        next.runningPts = split6RunningTotals(next.log);
        break;
      case 'texas':
        next.grossTotal  = entry.grossTotalAfter ?? next.grossTotal;
        next.texasPts    = entry.texaPtsAfter    ?? next.texasPts;
        // Rebuild driver usage from scratch
        next.driverUsage = { par3: [], par4: [], par5: [] };
        for (const e of next.log) {
          if (e.driverIdx != null) {
            const pk = e.par === 3 ? 'par3' : e.par === 4 ? 'par4' : 'par5';
            next.driverUsage[pk].push(e.driverIdx);
          }
        }
        break;
    }
  }

  return next;
}

// ================================================================
// GAME STATE — edit a recorded hole
// ================================================================

export function editHole(state, holeIdx, newGrosses) {
  const entry = state.log[holeIdx];
  if (!entry) return state;

  // Rebuild the entry with new grosses by re-processing just that hole
  // We need a temporary state at the point just before that hole
  const stateBefore = { ...state, log: state.log.slice(0, holeIdx), hole: holeIdx };
  const processed   = processHole(stateBefore, newGrosses);
  const newEntry     = processed.log[processed.log.length - 1];

  // Replace the entry in the log
  const newLog = [...state.log];
  newLog[holeIdx] = newEntry;

  // Recalculate everything from the new log
  return recalcState({ ...state, log: newLog });
}

// ================================================================
// RESULT SUMMARY — for end screen and history
// ================================================================

export function getResultSummary(state) {
  const { format, names, log, numHoles } = state;
  const holesPlayed = log.length;

  switch (format) {
    case 'stableford': {
      const sorted = names
        .map((nm, i) => ({ nm, score: state.totals[i] }))
        .sort((a, b) => b.score - a.score);
      return {
        winner:  sorted[0].nm,
        summary: `${sorted[0].nm} — ${sorted[0].score} pts`,
        scores:  sorted,
      };
    }

    case 'stroke': {
      const sorted = names
        .map((nm, i) => ({ nm, score: state.totals[i] }))
        .sort((a, b) => a.score - b.score);
      return {
        winner:  sorted[0].nm,
        summary: `${sorted[0].nm} — ${sorted[0].score} shots (net)`,
        scores:  sorted,
      };
    }

    case 'match': {
      const ms   = state.matchScore ?? 0;
      const left = numHoles - holesPlayed;
      const up   = Math.abs(ms);
      if (ms === 0) return { winner: null, summary: 'All Square' };
      const w = ms > 0 ? names[0] : names[1];
      return { winner: w, summary: `${w} — ${up}&${left}` };
    }

    case 'split6': {
      const sorted = names
        .map((nm, i) => ({ nm, score: state.runningPts[i] }))
        .sort((a, b) => b.score - a.score);
      return {
        winner:  sorted[0].nm,
        summary: `${sorted[0].nm} — ${sorted[0].score} pts`,
        scores:  sorted,
      };
    }

    case 'skins': {
      const sorted = names
        .map((nm, i) => ({ nm, score: state.skins[i] }))
        .sort((a, b) => b.score - a.score);
      return {
        winner:  sorted[0].nm,
        summary: `${sorted[0].nm} — ${sorted[0].score} skin${sorted[0].score !== 1 ? 's' : ''}`,
        scores:  sorted,
      };
    }

    case 'itc': {
      const sorted = names
        .map((nm, i) => ({ nm, score: state.pts[i] }))
        .sort((a, b) => b.score - a.score);
      return {
        winner:  sorted[0].nm,
        summary: `${sorted[0].nm} — ${sorted[0].score} pts`,
        scores:  sorted,
      };
    }

    case 'betterball':
    case 'csm': {
      const ms   = state.matchScore ?? 0;
      const left = numHoles - holesPlayed;
      const up   = Math.abs(ms);
      const pairA = `${names[0]} & ${names[1]}`;
      const pairB = `${names[2]} & ${names[3]}`;
      if (ms === 0) return { winner: null, summary: 'All Square' };
      const w = ms > 0 ? pairA : pairB;
      return { winner: w, summary: `${w} — ${up}&${left}` };
    }

    case 'foursomes':
    case 'greensomes': {
      const ms   = state.matchScore ?? 0;
      const left = numHoles - holesPlayed;
      const up   = Math.abs(ms);
      const pairA = `${names[0]} & ${names[1]}`;
      const pairB = `${names[2]} & ${names[3]}`;
      if (ms === 0) return { winner: null, summary: 'All Square' };
      const w = ms > 0 ? pairA : pairB;
      return { winner: w, summary: `${w} — ${up}&${left}` };
    }

    case 'best2': {
      return {
        winner:  'Group',
        summary: `Group total — ${state.groupTotal} pts`,
      };
    }

    case 'texas': {
      const teamName = state.teamName ?? state.names.join(' & ');
      const isSbFmt  = (state.texasScoringFmt ?? 'stableford') === 'stableford';
      const score    = isSbFmt ? (state.texasPts ?? 0) : (state.grossTotal ?? 0);
      const label    = isSbFmt ? `${score} pts` : `${score} gross`;
      return { winner: teamName, summary: `${teamName} — ${label}` };
    }

    default:
      return { winner: null, summary: '—' };
  }
}

// ================================================================
// SCORECARD DATA — structured data for rendering a scorecard table
// ================================================================

export function buildScorecardRows(state) {
  const { format, names, log, si, par, playingHandicaps, matchHandicaps, holeOffset } = state;
  const rows = [];

  for (const entry of log) {
    const h = entry.hIdx;
    const row = {
      holeDisplay: entry.h1,
      par:         entry.par,
      si:          entry.si,
      players:     [],
      matchStr:    null,
      extra:       null,
    };

    switch (format) {
      case 'stableford':
        row.players = names.map((_, pi) => ({
          gross:  entry.grosses[pi],
          extras: indivStrokesOnHole(playingHandicaps[pi], entry.si),
          net:    entry.grosses[pi] - indivStrokesOnHole(playingHandicaps[pi], entry.si),
          pts:    entry.holePts?.[pi],
        }));
        break;

      case 'stroke':
        row.players = names.map((_, pi) => ({
          gross:  entry.grosses[pi],
          extras: indivStrokesOnHole(playingHandicaps[pi], entry.si),
          net:    entry.nets?.[pi],
        }));
        break;

      case 'match':
        row.players = [0, 1].map(pi => ({
          gross:  entry.grosses[pi],
          extras: entry.extras?.[pi],
          net:    entry.nets?.[pi],
          won:    (pi === 0 && entry.result > 0) || (pi === 1 && entry.result < 0),
        }));
        row.matchStr = formatMatchStr(entry.matchAfter, names[0], names[1]);
        break;

      case 'split6':
        row.players = names.map((_, pi) => ({
          gross:  entry.grosses[pi],
          extras: entry.extras?.[pi],
          net:    entry.nets?.[pi],
          pts:    entry.holePts?.[pi],
        }));
        break;

      case 'betterball':
        row.players = names.map((_, pi) => ({
          gross:  entry.grosses[pi],
          extras: entry.extras?.[pi],
          net:    entry.nets?.[pi],
          isBest: entry.bbA?.pi === pi || entry.bbB?.pi === pi,
        }));
        row.matchStr = formatMatchStr(entry.matchAfter, 'Pair A', 'Pair B');
        break;

      case 'csm':
        row.players = names.map((_, pi) => ({
          gross: entry.grosses[pi],
          pts:   entry.sbPts?.[pi],
        }));
        row.extra    = `A: ${entry.totalA}  B: ${entry.totalB}`;
        row.matchStr = formatMatchStr(entry.matchAfter, 'Pair A', 'Pair B');
        break;

      case 'skins':
        row.players = names.map((_, pi) => ({
          gross:  entry.grosses[pi],
          extras: entry.extras?.[pi],
          net:    entry.grosses[pi] - (entry.extras?.[pi] ?? 0),
          won:    entry.winner === pi,
        }));
        row.extra = entry.winner === -1 ? `Carry (pot: ${entry.potWon})` : `Won ${entry.potWon} skin${entry.potWon !== 1 ? 's' : ''}`;
        break;

      case 'itc':
        row.players = names.map((_, pi) => ({
          gross:   entry.grosses[pi],
          extras:  entry.extras?.[pi],
          scored:  entry.pointScoredBy === pi,
          inChair: entry.newChair === pi,
        }));
        row.extra = entry.newChair !== null ? `Chair: ${names[entry.newChair]}` : 'Chair empty';
        break;

      case 'foursomes':
      case 'greensomes':
        row.players = [
          { gross: entry.grosses[0], extras: entry.extras?.[0], net: entry.nets?.[0] },
          { gross: entry.grosses[1], extras: entry.extras?.[1], net: entry.nets?.[1] },
        ];
        row.matchStr = formatMatchStr(entry.matchAfter, `${names[0]} & ${names[1]}`, `${names[2]} & ${names[3]}`);
        break;

      case 'best2':
        row.players = names.map((_, pi) => ({
          gross:    entry.grosses[pi],
          extras:   indivStrokesOnHole(playingHandicaps[pi], entry.si),
          net:      entry.grosses[pi] - indivStrokesOnHole(playingHandicaps[pi], entry.si),
          pts:      entry.holePts?.[pi],
          counted:  entry.counted?.includes(pi),
        }));
        row.extra = `Best 2: ${entry.holeB2} pts`;
        break;

      case 'texas':
        // Single team entry
        row.players = [{
          gross: entry.gross,
          net:   entry.net,
          pts:   entry.pts,
          driverName: names[entry.driverIdx ?? 0],
        }];
        row.extra = `Driver: ${names[entry.driverIdx ?? 0]}`;
        break;
    }

    rows.push(row);
  }

  return rows;
}

function formatMatchStr(matchScore, nameA, nameB) {
  if (matchScore === 0) return 'AS';
  const up = Math.abs(matchScore);
  return matchScore > 0 ? `${nameA.split(' ')[0]} ${up}↑` : `${nameB.split(' ')[0]} ${up}↑`;
}

// ================================================================
// MULTI-GROUP LEADERBOARD
// Combines states from multiple groups into a single ranked table
// Used for Stableford and Stroke Play multi-group rounds
// ================================================================

export function buildMultiGroupLeaderboard(groupStates) {
  const rows = [];

  groupStates.forEach((state, gi) => {
    if (!state || !state.names) return;
    const holesPlayed = state.log?.length ?? 0;
    const fmt = state.format;

    // Pair/match formats: one row per pair, not per player
    if (['betterball','csm','foursomes','greensomes'].includes(fmt)) {
      const ms  = state.matchScore ?? 0;
      const pairAName = `${state.names[0]?.split(' ')[0] ?? ''} & ${state.names[1]?.split(' ')[0] ?? ''}`;
      const pairBName = `${state.names[2]?.split(' ')[0] ?? ''} & ${state.names[3]?.split(' ')[0] ?? ''}`;
      const up  = Math.abs(ms);
      const aUp = ms > 0, bUp = ms < 0;
      rows.push({ name: pairAName, group: gi+1, pts: aUp ? up : bUp ? -up : 0, gross: null, net: null, holesPlayed, hcp: 0, playingHcp: 0, isPair: true, matchScore: ms });
      rows.push({ name: pairBName, group: gi+1, pts: bUp ? up : aUp ? -up : 0, gross: null, net: null, holesPlayed, hcp: 0, playingHcp: 0, isPair: true, matchScore: -ms });
      return;
    }

    state.names.forEach((name, pi) => {
      const gross = (state.log ?? []).reduce((sum, e) => sum + (e.grosses?.[pi] ?? 0), 0);

      let pts = null, net = null;

      if (fmt === 'stableford' || fmt === 'best2') {
        pts = state.totals?.[pi] ?? 0;
      } else if (fmt === 'stroke') {
        net = state.totals?.[pi] ?? 0;
      } else if (fmt === 'split6') {
        pts = state.runningPts?.[pi] ?? 0;
      } else if (fmt === 'itc') {
        pts = state.pts?.[pi] ?? 0;
      } else if (fmt === 'skins') {
        pts = state.skins?.[pi] ?? 0;
      } else if (fmt === 'match') {
        // match: player 0 positive = player 0 up
        pts = pi === 0 ? (state.matchScore ?? 0) : -(state.matchScore ?? 0);
      } else if (fmt === 'texas') {
        const isSbFmt = (state.texasScoringFmt ?? 'stableford') === 'stableford';
        pts   = isSbFmt ? (state.texasPts ?? 0) : null;
        net   = !isSbFmt ? (state.grossTotal ?? 0) : null;
      }

      rows.push({ name, group: gi+1, gross, net, pts, holesPlayed,
        hcp: state.handicapIndexes?.[pi] ?? 0,
        playingHcp: state.playingHandicaps?.[pi] ?? 0 });
    });
  });

  // Sort by format
  const fmt = groupStates.find(s => s?.format)?.format;
  if (fmt === 'stroke') {
    rows.sort((a, b) => b.holesPlayed - a.holesPlayed || (a.net ?? 999) - (b.net ?? 999));
  } else {
    rows.sort((a, b) => b.holesPlayed - a.holesPlayed || (b.pts ?? 0) - (a.pts ?? 0));
  }

  return rows;
}

// ================================================================
// LONGEST DRIVE / NEAREST THE PIN — distance calculation
// ================================================================

// Haversine distance between two lat/lng points, returned in yards.
export function gpsDistanceYards(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth radius in metres
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const metres = R * c;
  return Math.round(metres * 1.09361); // metres -> yards
}

// Merge LD/NTP results across all groups in a round into a single
// sorted leaderboard per competition hole. Used by both the in-game
// leaderboard and tournament aggregation.
export function buildSideCompResults(groupStates, kind) {
  // kind: 'ld' (longest drive, higher wins) or 'ntp' (nearest pin, lower wins)
  const resultsKey = kind === 'ld' ? 'ldResults' : 'ntpResults';
  const holesKey   = kind === 'ld' ? 'longestDriveHoles' : 'nearestPinHoles';
  const valueKey   = kind === 'ld' ? 'yards' : 'cm';

  const holes = groupStates.find(s => s?.[holesKey]?.length)?.[holesKey] ?? [];
  const byHole = {};

  holes.forEach(holeNum => {
    let best = null;
    groupStates.forEach(gs => {
      const r = gs?.[resultsKey]?.[holeNum];
      if (!r) return;
      if (!best) { best = r; return; }
      if (kind === 'ld' ? r[valueKey] > best[valueKey] : r[valueKey] < best[valueKey]) {
        best = r;
      }
    });
    byHole[holeNum] = best;
  });

  return { holes, byHole };
}
