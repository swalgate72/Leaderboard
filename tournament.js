// ================================================================
// LEADERBOARD — tournament.js
// Tournament logic: standings, handicap adjustment, group ordering
// No UI, no Supabase — pure logic only.
// ================================================================

// ================================================================
// TOURNAMENT SCORING MODES
// 'cumulative'  — add up all Stableford points across rounds
// 'stroke'      — add up all net shots across rounds (lowest wins)
// 'points_game' — each round awards ranking points; accumulated
// ================================================================

/**
 * Award ranking points for one round (Points per Game system).
 * numPlayers = total players in tournament (not just this round).
 * Tied players share the higher points value; next rank skips.
 *
 * Example: 12 players, scores 32, 30, 29, 29, 27
 *   1st (32) → 12pts
 *   2nd (30) → 11pts
 *   3rd= (29) → 10pts each
 *   5th (27) → 7pts  (skips 4th because tie took positions 3+4)
 */
export function awardRoundPoints(playerScores, numPlayers, isStroke) {
  // playerScores: [{playerId, score}] where score = pts (stableford) or net (stroke)
  // Sort: stableford descending, stroke ascending
  const sorted = [...playerScores].sort((a, b) =>
    isStroke ? a.score - b.score : b.score - a.score
  );

  const result = {};
  let rank = 1;
  let i = 0;
  while (i < sorted.length) {
    // Find all tied at this position
    const tiedScore = sorted[i].score;
    const tied = [];
    while (i < sorted.length && sorted[i].score === tiedScore) {
      tied.push(sorted[i]);
      i++;
    }
    // Points for this rank = numPlayers - rank + 1
    const pts = Math.max(0, numPlayers - rank + 1);
    tied.forEach(p => { result[p.playerId] = pts; });
    rank += tied.length; // skip positions used by tie
  }
  return result; // {playerId: tournamentPoints}
}

// ================================================================
// STANDINGS CALCULATION
// ================================================================

/**
 * Build tournament standings.
 * @param {Array}  players      — tournament_players rows
 * @param {Array}  rounds       — tournament_rounds rows (ordered by round_number)
 * @param {Array}  allScores    — tournament_round_scores rows
 * @param {string} format       — 'stableford' | 'stroke'
 * @param {string} scoringMode  — 'cumulative' | 'stroke' | 'points_game'
 * @returns {Array} standings rows sorted by position
 */
export function buildStandings(players, rounds, allScores, format, scoringMode = 'cumulative') {
  const isStroke      = format === 'stroke';
  const completedRnds = rounds.filter(r => r.status === 'completed');
  const numPlayers    = players.filter(p => !p.excluded).length;

  // Pre-calculate ranking points per round for points_game mode
  const roundPointsMap = {}; // {roundId: {playerId: pts}}
  if (scoringMode === 'points_game') {
    completedRnds.forEach(r => {
      const rScores = allScores.filter(s => s.tournament_round_id === r.id && !s.absent);
      const playerScores = rScores.map(s => ({
        playerId: s.tournament_player_id,
        score:    isStroke ? (s.net_score ?? 0) : (s.points ?? 0),
      }));
      roundPointsMap[r.id] = awardRoundPoints(playerScores, numPlayers, isStroke);
    });
  }

  const rows = players
    .filter(p => !p.excluded)
    .map(p => {
      const roundResults = rounds.map(r => {
        const score = allScores.find(
          s => s.tournament_round_id === r.id && s.tournament_player_id === p.id
        );
        const tournPts = scoringMode === 'points_game'
          ? (roundPointsMap[r.id]?.[p.id] ?? null)
          : null;
        return {
          roundId:     r.id,
          roundNumber: r.round_number,
          courseName:  r.course_name,
          date:        r.date,
          gross:       score?.gross_score ?? null,
          net:         score?.net_score   ?? null,
          pts:         score?.points      ?? null,
          tournPts,
          hcpUsed:     score?.hcp_used    ?? null,
          absent:      score?.absent      ?? false,
          played:      !!score && !score.absent,
        };
      });

      const playedRounds = roundResults.filter(r => r.played);
      let total = 0, totalGross = 0;

      if (scoringMode === 'stroke') {
        total      = playedRounds.reduce((s, r) => s + (r.net   ?? 0), 0);
        totalGross = playedRounds.reduce((s, r) => s + (r.gross ?? 0), 0);
      } else if (scoringMode === 'cumulative') {
        total = playedRounds.reduce((s, r) => s + (r.pts ?? 0), 0);
      } else if (scoringMode === 'points_game') {
        total = playedRounds.reduce((s, r) => s + (r.tournPts ?? 0), 0);
      }

      return {
        playerId:     p.id,
        name:         p.name,
        currentHcp:   p.current_hcp,
        roundResults,
        total,
        totalGross,
        roundsPlayed: playedRounds.length,
      };
    });

  // Sort
  rows.sort((a, b) => {
    if (a.roundsPlayed !== b.roundsPlayed) return b.roundsPlayed - a.roundsPlayed;
    return scoringMode === 'stroke' ? a.total - b.total : b.total - a.total;
  });

  // Assign positions with ties
  let pos = 1;
  rows.forEach((r, i) => {
    if (i > 0 && r.total === rows[i - 1].total) {
      r.position = rows[i - 1].position; // tied
    } else {
      r.position = pos;
    }
    pos++;
  });

  return rows;
}

// ================================================================
// AUTO HANDICAP ADJUSTMENT
// ================================================================

export function calcHandicapAdjustments(players, scores, format) {
  const isStroke = format === 'stroke';
  const played = scores.filter(s => !s.absent);
  if (!played.length) return [];

  const scoreValues = played.map(s => isStroke ? s.net_score : s.points);
  const avg = scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length;

  return played.map(s => {
    const player = players.find(p => p.id === s.tournament_player_id);
    if (!player) return null;
    const val  = isStroke ? s.net_score : s.points;
    const diff = val - avg;
    let delta  = 0;
    if (isStroke) {
      delta = diff < 0 ? Math.abs(diff) * -0.5 : diff * 0.25;
    } else {
      delta = diff > 0 ? diff * -0.5 : diff * 0.25;
    }
    const newHcp = Math.max(0, Math.min(54, Math.round((player.current_hcp + delta) * 10) / 10));
    return { playerId: player.id, name: player.name, oldHcp: player.current_hcp, delta: Math.round(delta * 10) / 10, newHcp };
  }).filter(Boolean);
}

// ================================================================
// DEFAULT GROUP ORDERING
// ================================================================

export function buildDefaultGroups(standings, numGroups, groupSize) {
  const reversed = [...standings].reverse();
  const groups = Array.from({ length: numGroups }, (_, i) => ({ groupNumber: i + 1, players: [] }));
  reversed.forEach((player, idx) => {
    const groupIdx = Math.min(Math.floor(idx / groupSize), numGroups - 1);
    groups[groupIdx].players.push(player.playerId);
  });
  return groups;
}

// ================================================================
// ABSENT SCORE / ROUND SUMMARY / INVITE LINK
// ================================================================

export function absentStrokeScore(scores) {
  const played = scores.filter(s => !s.absent && s.gross_score != null);
  if (!played.length) return 90;
  return Math.max(...played.map(s => s.gross_score));
}

export function roundSummary(scores, players, format) {
  const isStroke = format === 'stroke';
  const played   = scores.filter(s => !s.absent);
  if (!played.length) return 'No scores';
  const sorted = [...played].sort((a, b) =>
    isStroke ? a.net_score - b.net_score : b.points - a.points
  );
  const winner = players.find(p => p.id === sorted[0]?.tournament_player_id);
  if (!winner) return '--';
  const score = isStroke ? `${sorted[0].net_score} net` : `${sorted[0].points} pts`;
  return `${winner.name} -- ${score}`;
}

export function buildTournamentViewUrl(appUrl, tournamentId) {
  return `${appUrl}?tournament=${tournamentId}`;
}

// ================================================================
// MULTI-GROUP LEADERBOARD (live round)
// ================================================================

export function buildMultiGroupLeaderboard(groupStates) {
  const rows = [];
  groupStates.forEach((state, gi) => {
    if (!state || !state.names) return;
    const holesPlayed = state.log?.length ?? 0;
    const fmt = state.format;
    state.names.forEach((name, pi) => {
      const gross = (state.log ?? []).reduce((sum, e) => sum + (e.grosses?.[pi] ?? 0), 0);
      const net   = fmt === 'stroke'     ? (state.totals?.[pi] ?? null) : null;
      const pts   = fmt === 'stableford' ? (state.totals?.[pi] ?? null) : null;
      rows.push({ name, group: gi + 1, gross, net, pts, holesPlayed, hcp: state.handicapIndexes?.[pi] ?? 0, playingHcp: state.playingHandicaps?.[pi] ?? 0 });
    });
  });
  const fmt = groupStates.find(s => s?.format)?.format;
  if (fmt === 'stableford') rows.sort((a, b) => b.pts - a.pts || b.holesPlayed - a.holesPlayed);
  else rows.sort((a, b) => { if (a.holesPlayed !== b.holesPlayed) return b.holesPlayed - a.holesPlayed; return a.net - b.net; });
  return rows;
}

// ================================================================
// TEAM TOURNAMENT STANDINGS
// ================================================================

/**
 * Build team standings for a fixed-team tournament.
 * Teams accumulate scores across rounds.
 */
export function buildTeamStandings(teams, players, rounds, allScores, format, scoringMode) {
  const isStroke     = format === 'stroke';
  const completedRnds = rounds.filter(r => r.status === 'completed');

  const rows = teams.map(team => {
    const teamPlayers = players.filter(p => p.team_id === team.id);
    const roundResults = completedRnds.map(r => {
      const memberScores = teamPlayers.map(p => {
        return allScores.find(s => s.tournament_round_id === r.id && s.tournament_player_id === p.id);
      }).filter(s => s && !s.absent);  // exclude absent players

      // A team only earns a round score if at least 2 of their own members played.
      // This prevents a cross-team scorer's points bleeding into the wrong team's total.
      if (memberScores.length < 2) return { roundId: r.id, score: null, played: false };

      let roundScore = null;
      if (isStroke) {
        roundScore = Math.min(...memberScores.map(s => s.net_score ?? 999));
      } else {
        // For best2/betterball: the team score is already stored on each member's row
        // (all share the same group total), so just take the value from the first member.
        roundScore = memberScores[0].points ?? 0;
      }
      return { roundId: r.id, score: roundScore, played: true };
    });

    const total = roundResults.reduce((s, r) => s + (r.score ?? 0), 0);
    return { teamId: team.id, name: team.name, teamPlayers, roundResults, total };
  });

  rows.sort((a, b) => isStroke ? a.total - b.total : b.total - a.total);

  let pos = 1;
  rows.forEach((r, i) => {
    if (i > 0 && r.total === rows[i-1].total) r.position = rows[i-1].position;
    else r.position = pos;
    pos++;
  });

  return rows;
}

/**
 * Build individual standings for a rotating-team tournament.
 * Each player accumulates points from each round (shared with their group that round).
 */
export function buildRotatingStandings(players, rounds, allScores, scoringMode) {
  const completedRnds = rounds.filter(r => r.status === 'completed');
  const numPlayers    = players.filter(p => !p.excluded).length;

  const roundPointsMap = {};
  if (scoringMode === 'points_game') {
    completedRnds.forEach(r => {
      const rScores = allScores.filter(s => s.tournament_round_id === r.id && !s.absent);
      const playerScores = rScores.map(s => ({
        playerId: s.tournament_player_id,
        score:    s.points ?? 0,
      }));
      roundPointsMap[r.id] = awardRoundPoints(playerScores, numPlayers, false);
    });
  }

  const rows = players.filter(p => !p.excluded).map(p => {
    const roundResults = completedRnds.map(r => {
      const score = allScores.find(s => s.tournament_round_id === r.id && s.tournament_player_id === p.id);
      const tournPts = scoringMode === 'points_game' ? (roundPointsMap[r.id]?.[p.id] ?? 0) : null;
      return {
        roundId: r.id,
        pts:     score?.points    ?? null,
        net:     score?.net_score ?? null,
        tournPts,
        played:  !!score && !score.absent,
      };
    });

    const playedRounds = roundResults.filter(r => r.played);
    let total = 0;
    if (scoringMode === 'stroke')       total = playedRounds.reduce((s, r) => s + (r.net   ?? 0), 0);
    else if (scoringMode === 'cumulative') total = playedRounds.reduce((s, r) => s + (r.pts  ?? 0), 0);
    else                                total = playedRounds.reduce((s, r) => s + (r.tournPts ?? 0), 0);

    return { playerId: p.id, name: p.name, currentHcp: p.current_hcp, roundResults, total, roundsPlayed: playedRounds.length };
  });

  const isStroke = scoringMode === 'stroke';
  rows.sort((a, b) => {
    if (a.roundsPlayed !== b.roundsPlayed) return b.roundsPlayed - a.roundsPlayed;
    return isStroke ? a.total - b.total : b.total - a.total;
  });

  let pos = 1;
  rows.forEach((r, i) => {
    if (i > 0 && r.total === rows[i-1].total) r.position = rows[i-1].position;
    else r.position = pos;
    pos++;
  });

  return rows;
}

/**
 * Generate default team name from player surnames
 */
export function defaultTeamName(playerNames) {
  return playerNames.map(n => n.split(' ').pop()).join(' & ');
}
