// ================================================================
// RYDER CUP — rc-data.js
// Supabase data layer for Ryder Cup tables.
// Air-gapped from the main app's data.js — shares only the
// Supabase client connection.
// ================================================================

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.39.3/+esm';

const SUPABASE_URL  = 'https://fzknjqjnwnfuyfjrgacf.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ6a25qcWpud25mdXlmanJnYWNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAxODIxNjgsImV4cCI6MjA5NTc1ODE2OH0.Hy-eeXpw9yv_b3LpobYFrfEZ6OwW55dHIZc4G0pPA1k';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// ── Auth (delegates to Supabase auth, shared session) ───────────
export async function rcGetUser() {
  const { data } = await sb.auth.getUser();
  return data?.user ?? null;
}

export async function rcGetProfile(userId) {
  const { data, error } = await sb
    .from('profiles')
    .select('id, first_name, last_name, username, hcp, ryder_cup_points')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function rcFindProfileByUsername(username) {
  const { data, error } = await sb
    .from('profiles')
    .select('id, first_name, last_name, username, hcp')
    .ilike('username', username)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function rcLoadFriends(userId) {
  const { data, error } = await sb
    .from('friendships')
    .select(`
      id,
      requester:requester_id ( id, first_name, last_name, username, hcp ),
      addressee:addressee_id ( id, first_name, last_name, username, hcp )
    `)
    .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
    .eq('status', 'accepted');
  if (error) throw error;
  return (data ?? []).map(f => {
    const other = f.requester?.id === userId ? f.addressee : f.requester;
    return { profileId: other.id, name: `${other.first_name ?? ''} ${other.last_name ?? ''}`.trim(), hcp: other.hcp ?? 0 };
  });
}

// ── RC Tournaments ───────────────────────────────────────────────

export async function rcCreateTournament({ name, adminId, numRounds, hcpMode, hcpAllowancePct, redTeamName, blueTeamName, redCaptainId, blueCaptainId, playersPerTeam }) {
  const { data, error } = await sb.from('rc_tournaments').insert({
    name,
    admin_id:           adminId,
    second_admin_id:    null,
    num_rounds:         numRounds,
    hcp_mode:           hcpMode,           // 'index' | 'course' | 'playing'
    hcp_allowance_pct:  hcpAllowancePct,
    red_team_name:      redTeamName  || 'Red',
    blue_team_name:     blueTeamName || 'Blue',
    red_captain_id:     redCaptainId,
    blue_captain_id:    blueCaptainId,
    players_per_team:   playersPerTeam,
    status:             'setup',           // setup | active | completed
    red_points:         0,
    blue_points:        0,
  }).select().single();
  if (error) throw error;
  return data;
}

export async function rcLoadTournament(id) {
  const { data, error } = await sb
    .from('rc_tournaments')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

export async function rcLoadMyTournaments(userId) {
  // Tournaments where user is admin, second admin, or a captain
  const { data, error } = await sb
    .from('rc_tournaments')
    .select('*')
    .or(`admin_id.eq.${userId},second_admin_id.eq.${userId},red_captain_id.eq.${userId},blue_captain_id.eq.${userId}`)
    .neq('status', 'completed')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function rcLoadPlayerTournaments(userId) {
  // Tournaments where user is a player
  const { data, error } = await sb
    .from('rc_players')
    .select('tournament_id, rc_tournaments(*)')
    .eq('profile_id', userId)
    .eq('status', 'accepted');
  if (error) throw error;
  return (data ?? []).map(r => r.rc_tournaments).filter(Boolean);
}

export async function rcUpdateTournament(id, updates) {
  const { error } = await sb.from('rc_tournaments').update(updates).eq('id', id);
  if (error) throw error;
}

// ── RC Players ───────────────────────────────────────────────────

export async function rcInvitePlayer({ tournamentId, profileId, team, captainId, tournamentName, teamName }) {
  const { data, error } = await sb.from('rc_players').insert({
    tournament_id: tournamentId,
    profile_id:    profileId,
    team,                     // 'red' | 'blue'
    status:        'pending', // pending | accepted | declined
    invited_by:    captainId,
    points_this_tournament: 0,
    captain_notes: null,
  }).select().single();
  if (error) throw error;

  // Create in-app notification via existing sms_invites table
  // We reuse the same notification infrastructure
  await sb.from('sms_invites').insert({
    round_id:             null,
    inviter_id:           captainId,
    name:                 `${tournamentName} — ${teamName} Team`,
    recipient_profile_id: profileId,
    status:               'pending',
    rc_tournament_id:     tournamentId, // new column we'll add
    token:                crypto.randomUUID(),
  }).catch(() => {}); // non-fatal if notification fails

  return data;
}

export async function rcLoadPlayers(tournamentId) {
  const { data, error } = await sb
    .from('rc_players')
    .select(`
      id, team, status, points_this_tournament, captain_notes,
      profile:profile_id ( id, first_name, last_name, username, hcp, ryder_cup_points )
    `)
    .eq('tournament_id', tournamentId);
  if (error) throw error;
  return data ?? [];
}

export async function rcAcceptInvite(playerId) {
  const { error } = await sb.from('rc_players').update({ status: 'accepted' }).eq('id', playerId);
  if (error) throw error;
}

export async function rcDeclineInvite(playerId) {
  const { error } = await sb.from('rc_players').update({ status: 'declined' }).eq('id', playerId);
  if (error) throw error;
}

export async function rcUpdatePlayerNotes(playerId, notes) {
  const { error } = await sb.from('rc_players').update({ captain_notes: notes }).eq('id', playerId);
  if (error) throw error;
}

export async function rcGetMyPlayerRecord(tournamentId, profileId) {
  const { data, error } = await sb
    .from('rc_players')
    .select('*')
    .eq('tournament_id', tournamentId)
    .eq('profile_id', profileId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// ── RC Rounds ────────────────────────────────────────────────────

export async function rcCreateRound({ tournamentId, roundNumber, roundLabel, courseName, teeName, format, si, par, numHoles, ldHoles, ntpHoles }) {
  const { data, error } = await sb.from('rc_rounds').insert({
    tournament_id:  tournamentId,
    round_number:   roundNumber,
    round_label:    roundLabel,   // 'Opening Round', 'Second Round', etc.
    course_name:    courseName,
    tee_name:       teeName,
    round_format, // 'match'|'betterball'|'csm'|'greensomes'|'foursomes'|'texas'
    si:             si,
    par:            par,
    num_holes:      numHoles,
    ld_holes:       ldHoles  ?? [],
    ntp_holes:      ntpHoles ?? [],
    status:         'setup',      // setup | selection | active | completed
    red_lineup:     null,         // locked captain lineup [profileId, ...]
    blue_lineup:    null,
    red_locked:     false,
    blue_locked:    false,
  }).select().single();
  if (error) throw error;
  return data;
}

export async function rcLoadRounds(tournamentId) {
  const { data, error } = await sb
    .from('rc_rounds')
    .select('*')
    .eq('tournament_id', tournamentId)
    .order('round_number', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function rcLoadRound(roundId) {
  const { data, error } = await sb.from('rc_rounds').select('*').eq('id', roundId).single();
  if (error) throw error;
  return data;
}

export async function rcUpdateRound(roundId, updates) {
  const { error } = await sb.from('rc_rounds').update(updates).eq('id', roundId);
  if (error) throw error;
}

// Captain submits their sealed lineup — reveal happens when both are locked
export async function rcSubmitLineup(roundId, team, lineup) {
  // lineup = array of profileIds in order of play
  const updates = team === 'red'
    ? { red_lineup: lineup, red_locked: true }
    : { blue_lineup: lineup, blue_locked: true };
  const { data, error } = await sb
    .from('rc_rounds')
    .update(updates)
    .eq('id', roundId)
    .select()
    .single();
  if (error) throw error;

  // If both now locked → advance to active and generate matches
  if (data.red_locked && data.blue_locked) {
    await rcGenerateMatches(roundId, data.red_lineup, data.blue_lineup);
    await sb.from('rc_rounds').update({ status: 'active' }).eq('id', roundId);
  }
  return data;
}

// ── RC Matches ───────────────────────────────────────────────────

async function rcGenerateMatches(roundId, redLineup, blueLineup) {
  const count = Math.min(redLineup.length, blueLineup.length);
  const rows = Array.from({ length: count }, (_, i) => ({
    round_id:       roundId,
    match_number:   i + 1,
    red_player_id:  redLineup[i],
    blue_player_id: blueLineup[i],
    status:         'pending',  // pending | active | completed
    result:         null,       // 'red' | 'blue' | 'halved'
    red_points:     0,
    blue_points:    0,
    game_state:     null,
  }));
  const { error } = await sb.from('rc_matches').insert(rows);
  if (error) throw error;
}

export async function rcLoadMatches(roundId) {
  const { data, error } = await sb
    .from('rc_matches')
    .select(`
      *,
      red_player:red_player_id ( id, first_name, last_name, hcp ),
      blue_player:blue_player_id ( id, first_name, last_name, hcp )
    `)
    .eq('round_id', roundId)
    .order('match_number', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function rcLoadMatch(matchId) {
  const { data, error } = await sb
    .from('rc_matches')
    .select(`
      *,
      red_player:red_player_id ( id, first_name, last_name, hcp ),
      blue_player:blue_player_id ( id, first_name, last_name, hcp )
    `)
    .eq('id', matchId)
    .single();
  if (error) throw error;
  return data;
}

export async function rcSaveMatchState(matchId, gameState) {
  const { error } = await sb
    .from('rc_matches')
    .update({ game_state: gameState, status: 'active' })
    .eq('id', matchId);
  if (error) throw error;
}

export async function rcCompleteMatch(matchId, gameState, result) {
  // result: 'red' | 'blue' | 'halved'
  const redPts  = result === 'red'    ? 1 : result === 'halved' ? 0.5 : 0;
  const bluePts = result === 'blue'   ? 1 : result === 'halved' ? 0.5 : 0;

  const { data, error } = await sb
    .from('rc_matches')
    .update({ game_state: gameState, status: 'completed', result, red_points: redPts, blue_points: bluePts })
    .eq('id', matchId)
    .select()
    .single();
  if (error) throw error;

  // Recalculate and update round + tournament totals
  await rcRecalcTotals(data.round_id);
  return data;
}

async function rcRecalcTotals(roundId) {
  const round = await rcLoadRound(roundId);
  const matches = await rcLoadMatches(roundId);

  const roundRed  = matches.reduce((s, m) => s + (m.red_points  ?? 0), 0);
  const roundBlue = matches.reduce((s, m) => s + (m.blue_points ?? 0), 0);
  const allDone   = matches.every(m => m.status === 'completed');

  await sb.from('rc_rounds').update({
    red_points:  roundRed,
    blue_points: roundBlue,
    status:      allDone ? 'completed' : 'active',
  }).eq('id', roundId);

  // Recalc tournament totals from all rounds
  const allRounds = await rcLoadRounds(round.tournament_id);
  const totalRed  = allRounds.reduce((s, r) => s + (r.red_points  ?? 0), 0);
  const totalBlue = allRounds.reduce((s, r) => s + (r.blue_points ?? 0), 0);
  await sb.from('rc_tournaments').update({ red_points: totalRed, blue_points: totalBlue })
    .eq('id', round.tournament_id);
}

// ── Career stats ─────────────────────────────────────────────────

export async function rcAddCareerPoints(profileId, points) {
  // Increment the player's all-time ryder_cup_points on their profile
  const { data: profile } = await sb.from('profiles').select('ryder_cup_points').eq('id', profileId).single();
  const current = profile?.ryder_cup_points ?? 0;
  await sb.from('profiles').update({ ryder_cup_points: current + points }).eq('id', profileId);
}

export async function rcFinaliseTournament(tournamentId) {
  const rounds  = await rcLoadRounds(tournamentId);
  const players = await rcLoadPlayers(tournamentId);

  // Sum each player's points across all matches in this tournament
  for (const p of players.filter(pl => pl.status === 'accepted')) {
    let pts = 0;
    for (const round of rounds) {
      const matches = await rcLoadMatches(round.id);
      for (const m of matches) {
        const isRed  = m.red_player_id  === p.profile_id;
        const isBlue = m.blue_player_id === p.profile_id;
        if (isRed)  pts += m.red_points  ?? 0;
        if (isBlue) pts += m.blue_points ?? 0;
      }
    }
    // Update tournament player record
    await sb.from('rc_players').update({ points_this_tournament: pts }).eq('id', p.id);
    // Update career total
    await rcAddCareerPoints(p.profile_id, pts);
  }

  await sb.from('rc_tournaments').update({ status: 'completed' }).eq('id', tournamentId);
}

// ── Realtime ─────────────────────────────────────────────────────

export function rcSubscribeTournament(tournamentId, onUpdate) {
  return sb.channel(`rc_tournament_${tournamentId}`)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'rc_tournaments',
      filter: `id=eq.${tournamentId}`,
    }, payload => onUpdate('tournament', payload.new))
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'rc_rounds',
      filter: `tournament_id=eq.${tournamentId}`,
    }, payload => onUpdate('round', payload.new))
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'rc_matches',
    }, payload => onUpdate('match', payload.new))
    .subscribe();
}

export function rcUnsubscribe(channel) {
  if (channel) sb.removeChannel(channel);
}

// ── Courses (reuse main app courses table) ────────────────────────
export async function rcLoadCourses() {
  const { data, error } = await sb.from('courses').select('*').order('name');
  if (error) throw error;
  return data ?? [];
}

// ── Pending invites for a user ────────────────────────────────────
export async function rcLoadPendingInvites(profileId) {
  const { data, error } = await sb
    .from('rc_players')
    .select('id, team, tournament_id, rc_tournaments(name, red_team_name, blue_team_name)')
    .eq('profile_id', profileId)
    .eq('status', 'pending');
  if (error) throw error;
  return data ?? [];
}
