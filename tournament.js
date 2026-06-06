// ================================================================
// LEADERBOARD — tournament.js
// Tournament logic: standings, handicap adjustment, group ordering
// No UI, no Supabase — pure logic only.
// ================================================================

// ================================================================
// STANDINGS CALCULATION
// ================================================================

/**
 * Build tournament standings from rounds and scores.
 * @param {Array} players    — tournament_players rows
 * @param {Array} rounds     — tournament_rounds rows (ordered by round_number)
 * @param {Array} allScores  — tournament_round_scores rows (all rounds)
 * @param {string} format    — 'stableford' | 'stroke'
 * @returns {Array} standings rows sorted by position
 */
export function buildStandings(players, rounds, allScores, format) {
  const isStroke = format === 'stroke';

  const rows = players
    .filter(p => !p.excluded)
    .map(p => {
      const roundResults = rounds.map(r => {
        const score = allScores.find(
          s => s.tournament_round_id === r.id &&
               s.tournament_player_id === p.id
        );
        return {
          roundId:     r.id,
          roundNumber: r.round_number,
          courseName:  r.course_name,
          date:        r.date,
          gross:       score?.gross_score ?? null,
          net:         score?.net_score   ?? null,
          pts:         score?.points      ?? null,
          hcpUsed:     score?.hcp_used    ?? null,
          absent:      score?.absent      ?? false,
          played:      !!score && !score.absent,
        };
      });

      const playedRounds = roundResults.filter(r => r.played);

      let total = 0;
      let totalGross = 0;
      if (isStroke) {
        total      = playedRounds.reduce((s, r) => s + (r.net   ?? 0), 0);
        totalGross = playedRounds.reduce((s, r) => s + (r.gross ?? 0), 0);
      } else {
        total = playedRounds.reduce((s, r) => s + (r.pts ?? 0), 0);
      }

      return {
        playerId:    p.id,
        name:        p.name,
        currentHcp:  p.current_hcp,
        roundResults,
        total,
        totalGross,
        roundsPlayed: playedRounds.length,
      };
    });

  // Sort: stroke = lowest net total first, stableford = highest pts first
  rows.sort((a, b) => {
    if (a.roundsPlayed !== b.roundsPlayed) return b.roundsPlayed - a.roundsPlayed;
    return isStroke ? a.total - b.total : b.total - a.total;
  });

  // Assign positions (handle ties)
  let pos = 1;
  rows.forEach((r, i) => {
    if (i > 0) {
      const prev = rows[i - 1];
      const tied = isStroke ? r.total === prev.total : r.total === prev.total;
      if (!tied) pos = i + 1;
    }
    r.position = pos;
  });

  return rows;
}

// ================================================================
// AUTO HANDICAP ADJUSTMENT
// ================================================================

/**
 * Calculate new handicaps after a round.
 * Stableford & Stroke use same formula:
 *   Above field average: −0.5 per unit above
 *   Below field average: +0.25 per unit below
 *
 * @param {Array}  players   — tournament_players with current_hcp
 * @param {Array}  scores    — tournament_round_scores for this round
 * @param {string} format    — 'stableford' | 'stroke'
 * @returns {Array} [{playerId, oldHcp, newHcp, delta}]
 */
export function calcHandicapAdjustments(players, scores, format) {
  const isStroke = format === 'stroke';

  // Only include players who played (not absent)
  const played = scores.filter(s => !s.absent);
  if (played.length === 0) return [];

  // Get the relevant score per player
  const scoreValues = played.map(s => isStroke ? s.net_score : s.points);
  const avg = scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length;

  return played.map(s => {
    const player = players.find(p => p.id === s.tournament_player_id);
    if (!player) return null;

    const val   = isStroke ? s.net_score : s.points;
    const diff  = val - avg;
    let delta   = 0;

    if (isStroke) {
      // Lower net score = better = reduce handicap
      // Higher net score = worse = increase handicap
      if (diff < 0) delta = Math.abs(diff) * -0.5;  // better than avg: reduce hcp
      else          delta = diff * 0.25;              // worse than avg: increase hcp
    } else {
      // Higher pts = better = reduce handicap
      if (diff > 0) delta = diff * -0.5;  // better than avg: reduce hcp
      else          delta = diff * 0.25;  // worse than avg: increase hcp (diff is negative so * 0.25 reduces)
    }

    // Round to 1 decimal, clamp to 0–54
    const newHcp = Math.max(0, Math.min(54, Math.round((player.current_hcp + delta) * 10) / 10));

    return {
      playerId: player.id,
      name:     player.name,
      oldHcp:   player.current_hcp,
      delta:    Math.round(delta * 10) / 10,
      newHcp,
    };
  }).filter(Boolean);
}

// ================================================================
// DEFAULT GROUP ORDERING
// ================================================================

/**
 * Default group order for next round:
 * Losers (lowest scorers) → Group 1, Winners → last group
 *
 * @param {Array}  standings  — output of buildStandings(), already sorted
 * @param {number} numGroups  — how many groups
 * @param {number} groupSize  — players per group
 * @returns {Array} groups — [{groupNumber, players: [playerIds]}]
 */
export function buildDefaultGroups(standings, numGroups, groupSize) {
  // standings is sorted: best first for stableford, worst-net first for stroke
  // We want losers in group 1, winners in last group
  // So reverse the standings for group assignment
  const reversed = [...standings].reverse();

  const groups = Array.from({ length: numGroups }, (_, i) => ({
    groupNumber: i + 1,
    players: [],
  }));

  reversed.forEach((player, idx) => {
    const groupIdx = Math.min(Math.floor(idx / groupSize), numGroups - 1);
    groups[groupIdx].players.push(player.playerId);
  });

  return groups;
}

// ================================================================
// ABSENT SCORE CALCULATION
// ================================================================

/**
 * Score for an absent player in a stroke play round.
 * Returns the highest gross score in the field for that round.
 *
 * @param {Array} scores — tournament_round_scores for the round
 * @returns {number} highest gross score, or 90 if no scores yet
 */
export function absentStrokeScore(scores) {
  const played = scores.filter(s => !s.absent && s.gross_score != null);
  if (!played.length) return 90;
  return Math.max(...played.map(s => s.gross_score));
}

// ================================================================
// ROUND SUMMARY
// ================================================================

/**
 * Summary string for a completed round.
 */
export function roundSummary(scores, players, format) {
  const isStroke = format === 'stroke';
  const played   = scores.filter(s => !s.absent);
  if (!played.length) return 'No scores';

  const sorted = [...played].sort((a, b) =>
    isStroke ? a.net_score - b.net_score : b.points - a.points
  );

  const winner = players.find(p => p.id === sorted[0]?.tournament_player_id);
  if (!winner) return '—';

  const score = isStroke
    ? `${sorted[0].net_score} net`
    : `${sorted[0].points} pts`;

  return `${winner.name} — ${score}`;
}

// ================================================================
// INVITE LINK
// ================================================================

/**
 * Build a read-only tournament view URL.
 */
export function buildTournamentViewUrl(appUrl, tournamentId) {
  return `${appUrl}?tournament=${tournamentId}`;
}
