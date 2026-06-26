// ================================================================
// RYDER CUP — rc.js
// UI controller. Imports rc-data.js (Supabase) and reuses
// game.js scoring engine from the main app.
// ================================================================

import {
  rcGetUser, rcGetProfile, rcLoadFriends,
  rcCreateTournament, rcLoadTournament, rcLoadMyTournaments,
  rcLoadPlayerTournaments, rcUpdateTournament,
  rcInvitePlayer, rcLoadPlayers, rcAcceptInvite, rcDeclineInvite,
  rcUpdatePlayerNotes, rcGetMyPlayerRecord, rcLoadPendingInvites,
  rcCreateRound, rcLoadRounds, rcLoadRound, rcUpdateRound,
  rcSubmitLineup,
  rcLoadMatches, rcLoadMatch, rcSaveMatchState, rcCompleteMatch,
  rcFinaliseTournament,
  rcSubscribeTournament, rcUnsubscribe,
  rcLoadCourses,
} from './rc-data.js?v=20260622a';

import {
  calcHandicaps, strokesOnHole, indivStrokesOnHole,
  stablefordPoints, matchPlayStatus, matchPlayIsOver,
  buildInitialState, processHole, undoHole,
  foursomedPairHandicap, greensomesPairHandicap,
  texasTeamHandicap,
} from '../game.js?v=20260622f';

// ================================================================
// STATE
// ================================================================
let currentUser    = null;
let currentProfile = null;
let allFriends     = [];
let allCourses     = [];

let activeTournament = null;
let activePlayers    = [];
let activeRounds     = [];
let myPlayerRecord   = null;
let myRole           = null; // 'admin' | 'red_captain' | 'blue_captain' | 'player'
let myTeam           = null; // 'red' | 'blue' | null
let realtimeCh       = null;

// In-game match state
let activeMatchId    = null;
let matchGameState   = null;

// ================================================================
// UTILITIES
// ================================================================
const $ = id => document.getElementById(id);
const show = el => { if (typeof el === 'string') el = $(el); el?.classList.remove('rc-hidden'); };
const hide = el => { if (typeof el === 'string') el = $(el); el?.classList.add('rc-hidden'); };
const fmtHcp = h => h != null ? parseFloat(h).toFixed(1) : '--';
const fmtPts = p => p != null ? String(p % 1 === 0 ? p : p.toFixed(1)) : '0';

const RC_FORMAT_LABELS = {
  match:      'Matchplay Singles',
  betterball: 'Best Ball Matchplay',
  csm:        'Combined Stableford Matchplay',
  greensomes: 'Greensomes Matchplay',
  foursomes:  'Foursomes Matchplay',
  texas:      'Texas Scramble',
};

const ROUND_LABELS = ['Opening Round','Second Round','Third Round','Fourth Round','Fifth Round','Final Round'];

function playerName(p) {
  if (!p) return 'Unknown';
  if (p.first_name || p.last_name) return `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim();
  return p.username ?? 'Unknown';
}

function playerFirstName(p) {
  return (p?.first_name || playerName(p).split(' ')[0]) ?? '?';
}

function teamColour(team) {
  return team === 'red' ? 'var(--rc-red-light)' : 'var(--rc-blue-light)';
}

// ================================================================
// SCREEN MANAGEMENT
// ================================================================
function showScreen(id) {
  document.querySelectorAll('.rc-screen').forEach(s => s.classList.remove('active'));
  $(id)?.classList.add('active');
  window.scrollTo(0, 0);
}

// ================================================================
// BOOT
// ================================================================
async function boot() {
  try {
    currentUser = await rcGetUser();
    if (!currentUser) {
      showScreen('rc-screen-auth');
      return;
    }
    currentProfile = await rcGetProfile(currentUser.id);
    allFriends     = await rcLoadFriends(currentUser.id);
    allCourses     = await rcLoadCourses();

    await loadHomeScreen();
  } catch (err) {
    console.error('[RC boot]', err);
    showScreen('rc-screen-auth');
  }
}

// ================================================================
// HOME
// ================================================================
async function loadHomeScreen() {
  showScreen('rc-screen-home');
  const name = playerName(currentProfile) || 'Player';
  $('rc-home-user-name').textContent = name;

  // Check for pending invites
  const pending = await rcLoadPendingInvites(currentUser.id).catch(() => []);
  if (pending.length) {
    show('rc-pending-invites-section');
    $('rc-pending-invites-list').innerHTML = pending.map(inv => {
      const t    = inv.rc_tournaments;
      const team = inv.team === 'red' ? (t?.red_team_name || 'Red') : (t?.blue_team_name || 'Blue');
      return `
        <div class="rc-card rc-mb-sm" style="cursor:pointer;" data-invite="${inv.id}" data-tourn="${inv.tournament_id}" data-team="${inv.team}">
          <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.1rem;">${t?.name ?? 'Tournament'}</div>
          <div class="rc-team-badge ${inv.team}" style="margin-top:6px;">
            <span class="rc-team-dot ${inv.team}"></span>${team} Team
          </div>
        </div>`;
    }).join('');
    $('rc-pending-invites-list').querySelectorAll('[data-invite]').forEach(el => {
      el.addEventListener('click', () => showInviteModal(el.dataset.invite, el.dataset.tourn, el.dataset.team));
    });
  } else {
    hide('rc-pending-invites-section');
  }

  // Check for an active tournament where user is admin/captain
  const myTournaments = await rcLoadMyTournaments(currentUser.id).catch(() => []);
  if (myTournaments.length > 0) {
    const t = myTournaments[0];
    show('rc-active-tournament-card');
    $('rc-active-tourn-name').textContent    = t.name;
    $('rc-home-red-name').textContent  = t.red_team_name  || 'Red';
    $('rc-home-blue-name').textContent = t.blue_team_name || 'Blue';
    $('rc-home-red-pts').textContent   = fmtPts(t.red_points);
    $('rc-home-blue-pts').textContent  = fmtPts(t.blue_points);
    $('rc-active-tourn-display').onclick = () => enterTournament(t.id);
  } else {
    // Check player tournaments
    const playerTourns = await rcLoadPlayerTournaments(currentUser.id).catch(() => []);
    if (playerTourns.length > 0) {
      const t = playerTourns[0];
      show('rc-active-tournament-card');
      $('rc-active-tourn-name').textContent  = t.name;
      $('rc-home-red-name').textContent      = t.red_team_name  || 'Red';
      $('rc-home-blue-name').textContent     = t.blue_team_name || 'Blue';
      $('rc-home-red-pts').textContent       = fmtPts(t.red_points);
      $('rc-home-blue-pts').textContent      = fmtPts(t.blue_points);
      $('rc-active-tourn-display').onclick   = () => enterTournament(t.id);
    }
  }
}

// ================================================================
// ENTER TOURNAMENT — determine role and route
// ================================================================
async function enterTournament(tournamentId) {
  try {
    activeTournament = await rcLoadTournament(tournamentId);
    activePlayers    = await rcLoadPlayers(tournamentId);
    activeRounds     = await rcLoadRounds(tournamentId);
    myPlayerRecord   = await rcGetMyPlayerRecord(tournamentId, currentUser.id).catch(() => null);

    const t = activeTournament;
    const uid = currentUser.id;

    // Determine role
    if (t.admin_id === uid || t.second_admin_id === uid) myRole = 'admin';
    if (t.red_captain_id  === uid) { myRole = myRole || 'captain'; myTeam = 'red'; }
    if (t.blue_captain_id === uid) { myRole = myRole || 'captain'; myTeam = 'blue'; }
    if (!myRole && myPlayerRecord) {
      myRole = 'player';
      myTeam = myPlayerRecord.team;
    }

    // Subscribe to realtime updates
    rcUnsubscribe(realtimeCh);
    realtimeCh = rcSubscribeTournament(tournamentId, onRealtimeUpdate);

    // Route to appropriate screen
    if (myRole === 'admin') {
      renderAdminDashboard();
    } else if (myRole === 'captain') {
      renderCaptainDashboard();
    } else {
      renderPlayerDashboard();
    }
  } catch (err) {
    console.error('[enterTournament]', err);
    alert('Could not load tournament: ' + err.message);
  }
}

function onRealtimeUpdate(type, data) {
  if (type === 'tournament') {
    activeTournament = { ...activeTournament, ...data };
    updateAllScoreBanners();
  } else if (type === 'round') {
    const idx = activeRounds.findIndex(r => r.id === data.id);
    if (idx >= 0) activeRounds[idx] = data; else activeRounds.push(data);
    if (myRole === 'admin')   renderAdminRoundsList();
    if (myRole === 'captain') renderCaptainRoundActions();
    // Check for envelope reveal
    if (data.status === 'active' && data.red_locked && data.blue_locked) {
      showEnvelopeReveal(data);
    }
  } else if (type === 'match') {
    if (myRole === 'player') renderPlayerDashboard();
    updateAllScoreBanners();
  }
}

// ================================================================
// SCORE BANNERS
// ================================================================
function updateAllScoreBanners() {
  if (!activeTournament) return;
  const t = activeTournament;
  const redName  = t.red_team_name  || 'Red';
  const blueName = t.blue_team_name || 'Blue';
  const redPts   = fmtPts(t.red_points);
  const bluePts  = fmtPts(t.blue_points);

  const banners = [
    ['rc-admin-red-name','rc-admin-blue-name','rc-admin-red-pts','rc-admin-blue-pts'],
    ['rc-captain-red-name','rc-captain-blue-name','rc-captain-red-pts','rc-captain-blue-pts'],
    ['rc-pl-red-name','rc-pl-blue-name','rc-pl-red-pts','rc-pl-blue-pts'],
    ['rc-ov-red-name','rc-ov-blue-name','rc-ov-red-pts','rc-ov-blue-pts'],
    ['rc-lb-red-name','rc-lb-blue-name','rc-lb-red-pts','rc-lb-blue-pts'],
    ['rc-sc-red-name','rc-sc-blue-name','rc-sc-red-pts','rc-sc-blue-pts'],
  ];
  banners.forEach(([rn,bn,rp,bp]) => {
    if ($(rn)) { $(rn).textContent = redName;  $(bn).textContent = blueName; }
    if ($(rp)) { $(rp).textContent = redPts;   $(bp).textContent = bluePts; }
  });
}

// ================================================================
// ADMIN DASHBOARD
// ================================================================
function renderAdminDashboard() {
  $('rc-admin-tourn-name').textContent = activeTournament.name;
  updateAllScoreBanners();
  renderAdminRoundsList();
  renderAdminPlayersList();
  showScreen('rc-screen-admin');
}

function renderAdminRoundsList() {
  const el = $('rc-admin-rounds-list');
  if (!el) return;
  const t = activeTournament;

  if (!activeRounds.length) {
    el.innerHTML = `<div class="rc-hint">No rounds set up yet. Add the first round below.</div>`;
    return;
  }

  el.innerHTML = activeRounds.map((r, i) => {
    const label  = r.round_label || ROUND_LABELS[i] || `Round ${i+1}`;
    const status = r.status === 'completed' ? '✓ Complete'
                 : r.status === 'active'    ? '● In Progress'
                 : r.status === 'selection' ? '🔒 Lineups Pending'
                 : '○ Setup';
    const statusColor = r.status === 'completed' ? 'var(--green)'
                      : r.status === 'active'    ? 'var(--rc-gold)'
                      : 'var(--muted)';
    return `
      <div class="rc-card rc-mb-sm" style="cursor:pointer;" data-round="${r.id}">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <div>
            <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.1rem;">${label}</div>
            <div style="font-size:0.8rem;color:var(--muted);margin-top:2px;">${RC_FORMAT_LABELS[r.round_format] ?? r.round_format} · ${r.course_name ?? '--'}</div>
          </div>
          <div style="font-size:0.78rem;font-weight:700;color:${statusColor};">${status}</div>
        </div>
        ${r.status !== 'setup' ? `
        <div style="display:flex;justify-content:space-between;margin-top:0.6rem;font-size:0.9rem;font-weight:800;">
          <span style="color:var(--rc-red-light);">${t.red_team_name||'Red'} ${fmtPts(r.red_points)}</span>
          <span style="color:var(--rc-blue-light);">${t.blue_team_name||'Blue'} ${fmtPts(r.blue_points)}</span>
        </div>` : ''}
      </div>`;
  }).join('');

  el.querySelectorAll('[data-round]').forEach(card => {
    card.addEventListener('click', () => showRoundOverview(card.dataset.round));
  });
}

function renderAdminPlayersList() {
  const el = $('rc-admin-players-list');
  if (!el) return;
  const t = activeTournament;

  const redPlayers  = activePlayers.filter(p => p.team === 'red'  && p.status === 'accepted');
  const bluePlayers = activePlayers.filter(p => p.team === 'blue' && p.status === 'accepted');

  const buildTeam = (players, team) => {
    if (!players.length) return `<div class="rc-hint">No ${team} team players yet.</div>`;
    return players.map(p => `
      <div class="rc-player-row">
        <div class="rc-player-dot ${team}"></div>
        <div class="rc-player-name">${playerName(p.profile)}</div>
        <div class="rc-player-stat">${fmtHcp(p.profile?.hcp)}</div>
      </div>`).join('');
  };

  el.innerHTML = `
    <div style="font-size:0.72rem;font-weight:800;text-transform:uppercase;letter-spacing:0.1em;
                color:var(--rc-red-light);margin-bottom:0.35rem;">${t.red_team_name || 'Red'} (${redPlayers.length})</div>
    ${buildTeam(redPlayers, 'red')}
    <div style="font-size:0.72rem;font-weight:800;text-transform:uppercase;letter-spacing:0.1em;
                color:var(--rc-blue-light);margin:0.85rem 0 0.35rem;">${t.blue_team_name || 'Blue'} (${bluePlayers.length})</div>
    ${buildTeam(bluePlayers, 'blue')}`;
}

// ================================================================
// CAPTAIN DASHBOARD
// ================================================================
function renderCaptainDashboard() {
  const t    = activeTournament;
  const team = myTeam;

  // Apply team colour to header
  const header = $('rc-captain-header');
  if (header) {
    header.style.background = team === 'red'
      ? 'linear-gradient(135deg, #8b0000 0%, var(--rc-red) 100%)'
      : 'linear-gradient(135deg, #0a2a5e 0%, var(--rc-blue) 100%)';
  }

  $('rc-captain-team-name').textContent  = team === 'red' ? (t.red_team_name || 'Red Team') : (t.blue_team_name || 'Blue Team');
  $('rc-captain-tourn-name').textContent = t.name;
  updateAllScoreBanners();
  renderCaptainTeamList();
  renderCaptainRoundActions();
  showScreen('rc-screen-captain');
}

function renderCaptainTeamList() {
  const el   = $('rc-captain-team-list');
  const team = myTeam;
  if (!el) return;

  const myPlayers = activePlayers.filter(p => p.team === team && p.status === 'accepted');
  if (!myPlayers.length) {
    el.innerHTML = `<div class="rc-hint">No players accepted yet. Invite your team below.</div>`;
    return;
  }

  el.innerHTML = myPlayers.map(p => `
    <div style="display:grid;grid-template-columns:1fr 3.5rem 4.5rem 5rem 2rem;
                align-items:center;gap:0.25rem;padding:0.65rem 0.1rem;
                border-bottom:1px solid var(--border);">
      <div style="display:flex;align-items:center;gap:8px;">
        <div class="rc-player-dot ${team}"></div>
        <span style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.05rem;">
          ${playerName(p.profile)}
        </span>
      </div>
      <div style="text-align:center;font-size:0.88rem;color:var(--muted2);">${fmtHcp(p.profile?.hcp)}</div>
      <div style="text-align:center;font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.05rem;">
        ${fmtPts(p.points_this_tournament)}
      </div>
      <div style="text-align:center;font-size:0.88rem;color:var(--muted2);">
        ${fmtPts(p.profile?.ryder_cup_points)}
      </div>
      <button class="rc-btn rc-btn-ghost" data-player-id="${p.id}" data-player-name="${playerName(p.profile)}"
        style="width:auto;padding:0.2rem 0.4rem;font-size:0.9rem;" title="Notes">📝</button>
    </div>`).join('');

  el.querySelectorAll('[data-player-id]').forEach(btn => {
    btn.addEventListener('click', () => openNotesModal(btn.dataset.playerId, btn.dataset.playerName));
  });
}

function renderCaptainRoundActions() {
  const el = $('rc-captain-round-actions');
  if (!el) return;

  // Find the current active/selection round
  const currentRound = activeRounds.find(r => r.status === 'selection' || r.status === 'active')
                    || activeRounds.find(r => r.status === 'setup');

  if (!currentRound) {
    el.innerHTML = `<div class="rc-hint">No rounds in progress. Waiting for admin to set up the next round.</div>`;
    return;
  }

  const myLocked = myTeam === 'red' ? currentRound.red_locked : currentRound.blue_locked;
  const otherLocked = myTeam === 'red' ? currentRound.blue_locked : currentRound.red_locked;
  const label = currentRound.round_label || 'Current Round';

  if (currentRound.status === 'setup') {
    el.innerHTML = `<div class="rc-hint">Waiting for admin to open lineup selection for ${label}.</div>`;
    return;
  }

  if (!myLocked) {
    el.innerHTML = `
      <div class="rc-card" style="text-align:center;">
        <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.1rem;margin-bottom:0.5rem;">${label}</div>
        <div class="rc-hint rc-mb-md">${RC_FORMAT_LABELS[currentRound.round_format]} · ${currentRound.course_name}</div>
        <button class="rc-btn rc-btn-primary" id="rc-btn-open-lineup">
          📋 Choose My ${currentRound.round_format === 'match' ? 'Player' : 'Pair'} Order
        </button>
      </div>`;
    $('rc-btn-open-lineup').onclick = () => openLineupScreen(currentRound);
  } else if (!otherLocked) {
    el.innerHTML = `
      <div class="rc-card">
        <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.05rem;margin-bottom:0.5rem;">${label}</div>
        <div class="rc-sealed-indicator submitted">✓ Your lineup is sealed</div>
        <div class="rc-sealed-indicator waiting" style="margin-top:0.5rem;">⏳ Waiting for the other captain…</div>
      </div>`;
  } else if (currentRound.status === 'active') {
    el.innerHTML = `
      <div class="rc-card">
        <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.05rem;margin-bottom:0.5rem;">${label}</div>
        <button class="rc-btn rc-btn-primary" id="rc-btn-view-draw">⛳ View Draw & Scores</button>
      </div>`;
    $('rc-btn-view-draw').onclick = () => showRoundOverview(currentRound.id);
  }
}

// ================================================================
// PLAYER DASHBOARD
// ================================================================
async function renderPlayerDashboard() {
  const t    = activeTournament;
  const team = myTeam ?? 'red';

  $('rc-player-name-header').textContent = playerFirstName(currentProfile);
  $('rc-player-team-header').textContent = team === 'red' ? (t.red_team_name || 'Red Team') : (t.blue_team_name || 'Blue Team');

  const header = $('rc-player-header');
  if (header) {
    header.style.background = team === 'red'
      ? 'linear-gradient(135deg, #8b0000 0%, var(--rc-red) 100%)'
      : 'linear-gradient(135deg, #0a2a5e 0%, var(--rc-blue) 100%)';
  }

  updateAllScoreBanners();

  // Find my upcoming match
  const activeRound = activeRounds.find(r => r.status === 'active');
  if (activeRound) {
    const matches = await rcLoadMatches(activeRound.id).catch(() => []);
    const myMatch = matches.find(m =>
      m.red_player_id  === currentUser.id ||
      m.blue_player_id === currentUser.id
    );
    if (myMatch && myMatch.status !== 'completed') {
      show('rc-player-next-match');
      const opponentProfile = myMatch.red_player_id === currentUser.id ? myMatch.blue_player : myMatch.red_player;
      $('rc-player-next-content').innerHTML = `
        <div style="font-size:0.72rem;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px;">
          Match ${myMatch.match_number} · ${RC_FORMAT_LABELS[activeRound.round_format]}
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;">
          <span style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.2rem;color:var(--rc-red-light);">
            ${playerFirstName(myMatch.red_player)}
          </span>
          <span style="font-size:0.72rem;color:var(--muted);">vs</span>
          <span style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.2rem;color:var(--rc-blue-light);">
            ${playerFirstName(myMatch.blue_player)}
          </span>
        </div>`;
      $('rc-btn-open-scoring').onclick = () => openMatchScoring(myMatch, activeRound);
    } else {
      hide('rc-player-next-match');
    }
  } else {
    hide('rc-player-next-match');
  }

  // Leaderboard
  renderPlayerLeaderboard();
  showScreen('rc-screen-player');
}

async function renderPlayerLeaderboard() {
  const el = $('rc-player-leaderboard');
  if (!el) return;
  const t = activeTournament;

  // Show all completed rounds and their match results
  const completedRounds = activeRounds.filter(r => r.status === 'completed');
  if (!completedRounds.length) {
    el.innerHTML = `<div class="rc-hint">No completed rounds yet.</div>`;
    return;
  }

  // Overall score
  el.innerHTML = `
    <div class="rc-card rc-mb-sm">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div style="text-align:center;flex:1;">
          <div style="font-family:'Barlow Condensed',sans-serif;font-weight:900;font-size:2.5rem;color:var(--rc-red-light);">${fmtPts(t.red_points)}</div>
          <div style="font-size:0.7rem;font-weight:800;text-transform:uppercase;color:var(--rc-red-light);">${t.red_team_name||'Red'}</div>
        </div>
        <div style="font-size:0.8rem;font-weight:700;color:var(--muted);">points</div>
        <div style="text-align:center;flex:1;">
          <div style="font-family:'Barlow Condensed',sans-serif;font-weight:900;font-size:2.5rem;color:var(--rc-blue-light);">${fmtPts(t.blue_points)}</div>
          <div style="font-size:0.7rem;font-weight:800;text-transform:uppercase;color:var(--rc-blue-light);">${t.blue_team_name||'Blue'}</div>
        </div>
      </div>
    </div>
    ${completedRounds.map(r => `
      <div style="font-size:0.7rem;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin:0.6rem 0 0.3rem;">${r.round_label}</div>
      <div class="rc-card rc-mb-sm" style="padding:0.6rem 0.85rem;">
        <div style="display:flex;justify-content:space-between;font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.1rem;">
          <span style="color:var(--rc-red-light);">${t.red_team_name||'Red'} ${fmtPts(r.red_points)}</span>
          <span style="color:var(--rc-blue-light);">${t.blue_team_name||'Blue'} ${fmtPts(r.blue_points)}</span>
        </div>
      </div>`).join('')}`;
}

// ================================================================
// LINEUP SCREEN
// ================================================================
async function openLineupScreen(round) {
  $('rc-lineup-title').textContent = round.round_label || 'Choose Your Order';
  $('rc-lineup-format-label').textContent = `Format: ${RC_FORMAT_LABELS[round.round_format] ?? round.round_format}`;

  const isPairs = ['betterball','csm','greensomes','foursomes','texas'].includes(round.round_format);
  $('rc-lineup-hint').textContent = isPairs
    ? `Drag your pairs into playing order. Once sealed, the other captain can't see your lineup until they also submit.`
    : `Drag your players into playing order (1st out at the top). Once sealed, the draw is revealed when the other captain also submits.`;

  // Build the list of eligible players for this team
  const teamPlayers = activePlayers.filter(p => p.team === myTeam && p.status === 'accepted');
  renderLineupSlots(teamPlayers, round, isPairs);

  // Store round on screen for submission
  $('rc-screen-lineup').dataset.roundId = round.id;

  showScreen('rc-screen-lineup');
}

function renderLineupSlots(players, round, isPairs) {
  const el = $('rc-lineup-slots');
  if (!el) return;

  // Current order stored in a local array we'll mutate on drag
  const ordered = [...players];

  const render = () => {
    el.innerHTML = ordered.map((p, i) => `
      <div class="rc-lineup-slot" draggable="true" data-idx="${i}" data-pid="${p.profile?.id}">
        <span class="rc-lineup-num">${i + 1}</span>
        <div class="rc-player-dot ${myTeam}" style="flex-shrink:0;"></div>
        <div class="rc-lineup-name">${playerName(p.profile)}</div>
        <div style="font-size:0.8rem;color:var(--muted);">HCP ${fmtHcp(p.profile?.hcp)}</div>
        <div style="font-size:1rem;color:var(--muted);">⣿</div>
      </div>`).join('');

    // Wire drag-and-drop
    let dragSrc = null;
    el.querySelectorAll('.rc-lineup-slot').forEach(slot => {
      slot.addEventListener('dragstart', e => {
        dragSrc = parseInt(slot.dataset.idx);
        slot.style.opacity = '0.4';
        e.dataTransfer.effectAllowed = 'move';
      });
      slot.addEventListener('dragend', () => { slot.style.opacity = '1'; });
      slot.addEventListener('dragover', e => {
        e.preventDefault();
        slot.classList.add('drag-over');
      });
      slot.addEventListener('dragleave', () => slot.classList.remove('drag-over'));
      slot.addEventListener('drop', e => {
        e.preventDefault();
        slot.classList.remove('drag-over');
        const dest = parseInt(slot.dataset.idx);
        if (dragSrc === null || dragSrc === dest) return;
        const item = ordered.splice(dragSrc, 1)[0];
        ordered.splice(dest, 0, item);
        render();
      });
    });

    // Store the current order so submission can read it
    el.dataset.order = JSON.stringify(ordered.map(p => p.profile?.id));
  };

  render();
}

// ================================================================
// SUBMIT LINEUP (sealed envelope)
// ================================================================
$('rc-btn-submit-lineup')?.addEventListener('click', async () => {
  const roundId = $('rc-screen-lineup').dataset.roundId;
  const orderJSON = $('rc-lineup-slots').dataset.order;
  if (!orderJSON) return;
  const lineup = JSON.parse(orderJSON).filter(Boolean);
  if (!lineup.length) { alert('Please arrange your players before submitting.'); return; }

  const btn = $('rc-btn-submit-lineup');
  btn.disabled = true; btn.textContent = 'Sealing…';

  try {
    const result = await rcSubmitLineup(roundId, myTeam, lineup);
    btn.textContent = '✓ Lineup Sealed';

    // Reload rounds
    activeRounds = await rcLoadRounds(activeTournament.id);
    const updatedRound = activeRounds.find(r => r.id === roundId);

    const otherLocked = myTeam === 'red' ? updatedRound?.blue_locked : updatedRound?.red_locked;
    if (otherLocked && updatedRound) {
      // Both sealed — show the reveal
      showEnvelopeReveal(updatedRound);
    } else {
      // Show waiting state
      show('rc-lineup-waiting');
    }
  } catch (err) {
    alert('Could not submit lineup: ' + err.message);
    btn.disabled = false;
    btn.textContent = '🔒 Seal My Lineup';
  }
});

// ================================================================
// ENVELOPE REVEAL
// ================================================================
async function showEnvelopeReveal(round) {
  const matches = await rcLoadMatches(round.id).catch(() => []);
  const t       = activeTournament;

  const matchesHtml = matches.map((m, i) => `
    <div class="rc-reveal-match" style="--i:${i}">
      <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.05rem;
                  color:var(--rc-red-light);text-align:left;">
        ${playerFirstName(m.red_player)}
      </div>
      <div style="font-size:0.72rem;font-weight:700;color:rgba(255,255,255,0.35);text-align:center;">vs</div>
      <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.05rem;
                  color:var(--rc-blue-light);text-align:right;">
        ${playerFirstName(m.blue_player)}
      </div>
    </div>`).join('');

  $('rc-envelope-round-label').textContent = round.round_label || 'The Draw';
  $('rc-envelope-matches').innerHTML = matchesHtml;
  $('rc-modal-envelope').classList.add('open');
}

$('rc-btn-envelope-close')?.addEventListener('click', () => {
  $('rc-modal-envelope').classList.remove('open');
  // Navigate to round overview
  const activeRound = activeRounds.find(r => r.status === 'active');
  if (activeRound) showRoundOverview(activeRound.id);
});

// ================================================================
// ROUND OVERVIEW
// ================================================================
async function showRoundOverview(roundId) {
  const round   = activeRounds.find(r => r.id === roundId) || await rcLoadRound(roundId);
  const matches = await rcLoadMatches(roundId).catch(() => []);
  const t       = activeTournament;

  $('rc-overview-title').textContent = round.round_label || 'Draw';
  $('rc-ov-red-name').textContent    = t.red_team_name  || 'Red';
  $('rc-ov-blue-name').textContent   = t.blue_team_name || 'Blue';
  $('rc-ov-red-pts').textContent     = fmtPts(t.red_points);
  $('rc-ov-blue-pts').textContent    = fmtPts(t.blue_points);
  $('rc-overview-format-label').textContent = RC_FORMAT_LABELS[round.round_format] ?? 'Matches';

  $('rc-overview-matches').innerHTML = matches.map(m => {
    const status = m.status === 'completed'
      ? (m.result === 'red'    ? `<div class="rc-match-result red-win">${t.red_team_name||'Red'} wins 1pt</div>`
        : m.result === 'blue'  ? `<div class="rc-match-result blue-win">${t.blue_team_name||'Blue'} wins 1pt</div>`
        :                        `<div class="rc-match-result halved">Halved — ½pt each</div>`)
      : m.status === 'active'
        ? `<div class="rc-match-result" style="color:var(--rc-gold);">In Progress</div>`
        : '';
    return `
      <div class="rc-match-row ${m.status === 'completed' ? 'completed' : ''}"
           data-match="${m.id}" style="cursor:${m.status !== 'setup' ? 'pointer' : 'default'};">
        <div class="rc-match-red">${playerFirstName(m.red_player)}</div>
        <div class="rc-match-vs">vs</div>
        <div class="rc-match-blue">${playerFirstName(m.blue_player)}</div>
        ${status}
      </div>`;
  }).join('');

  // Wire match rows — tap to open scoring
  $('rc-overview-matches').querySelectorAll('[data-match]').forEach(row => {
    row.addEventListener('click', async () => {
      const match = matches.find(m => m.id === row.dataset.match);
      if (match && match.status !== 'setup') openMatchScoring(match, round);
    });
  });

  // Actions
  const actionsEl = $('rc-overview-actions');
  const allComplete = matches.every(m => m.status === 'completed');
  actionsEl.innerHTML = '';

  if (round.status === 'active' && !allComplete) {
    // Show a "Start My Match" button if user has a match here
    const myMatch = matches.find(m =>
      (m.red_player_id === currentUser.id || m.blue_player_id === currentUser.id) &&
      m.status !== 'completed'
    );
    if (myMatch) {
      const btn = document.createElement('button');
      btn.className = 'rc-btn rc-btn-primary';
      btn.textContent = '⛳ Open My Match';
      btn.onclick = () => openMatchScoring(myMatch, round);
      actionsEl.appendChild(btn);
    }
  }

  showScreen('rc-screen-round-overview');
}

// ================================================================
// IN-GAME SCORING
// ================================================================
async function openMatchScoring(match, round) {
  activeMatchId = match.id;

  // Reload match to get latest game_state
  const freshMatch = await rcLoadMatch(match.id).catch(() => match);

  const t = activeTournament;
  $('rc-scoring-match-label').textContent = `Match ${freshMatch.match_number} · ${round.round_label}`;
  $('rc-scoring-red-name').textContent    = playerFirstName(freshMatch.red_player);
  $('rc-scoring-blue-name').textContent   = playerFirstName(freshMatch.blue_player);
  updateAllScoreBanners();

  // Build or restore game state
  if (freshMatch.game_state) {
    matchGameState = freshMatch.game_state;
  } else {
    // Build initial state from round config
    const redHcp  = freshMatch.red_player?.hcp  ?? 0;
    const blueHcp = freshMatch.blue_player?.hcp ?? 0;
    const hcpArr  = [redHcp, blueHcp];
    const hcpObj  = calcHandicaps(hcpArr, 100);

    matchGameState = buildInitialState({
      format:           round.round_format === 'texas' ? 'texas' : 'match',
      names:            [playerFirstName(freshMatch.red_player), playerFirstName(freshMatch.blue_player)],
      handicapIndexes:  hcpArr,
      playingHandicaps: hcpObj.map(h => h.playingHandicap),
      matchHandicaps:   hcpObj.map(h => h.matchHandicap),
      allowancePct:     100,
      si:               round.si,
      par:              round.par,
      numHoles:         round.num_holes ?? 18,
      holeOffset:       0,
      courseName:       round.course_name,
      teeName:          round.tee_name ?? '',
      longestDriveHoles: round.ld_holes  ?? [],
      nearestPinHoles:   round.ntp_holes ?? [],
    });
    // Tag with team colours for rendering
    matchGameState.playerTeams = ['red', 'blue'];
  }

  await rcSaveMatchState(activeMatchId, matchGameState).catch(() => {});

  renderScoringHole();
  showScreen('rc-screen-scoring');
}

function renderScoringHole() {
  if (!matchGameState) return;
  const gs  = matchGameState;
  const h   = gs.hole;
  const total = gs.numHoles ?? 18;

  if (h >= total) {
    finishMatch();
    return;
  }

  const par  = gs.par[h];
  const si   = gs.si[h];
  const disp = h + 1;

  // Update match status
  const ms   = gs.matchScore ?? 0;
  const left = total - (gs.log?.length ?? 0);
  const up   = Math.abs(ms);
  const statusTxt = ms === 0 ? 'All Square'
    : ms > 0 ? `${up} Up · ${left} to play`
    :           `${up} Down · ${left} to play`;
  $('rc-scoring-status').textContent = statusTxt;
  $('rc-scoring-status').style.color = ms === 0 ? 'rgba(255,255,255,0.4)'
    : ms > 0 ? 'var(--rc-red-light)' : 'var(--rc-blue-light)';

  const content = $('rc-scoring-content');
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:1rem;">
      <div style="font-family:'Barlow Condensed',sans-serif;font-weight:900;font-size:3rem;color:var(--rc-gold);line-height:1;">
        ${disp}
      </div>
      <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.4rem;color:var(--rc-gold);">
        SI ${si} · Par ${par}
      </div>
    </div>

    <div id="rc-player-inputs" style="display:grid;gap:0.75rem;margin-bottom:1.25rem;"></div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;margin-bottom:0.5rem;">
      <button class="rc-btn rc-btn-outline" id="rc-btn-back-hole" ${h === 0 ? 'disabled' : ''}>← Back</button>
      <button class="rc-btn rc-btn-primary" id="rc-btn-record-hole">RECORD HOLE →</button>
    </div>

    <div id="rc-hole-result" style="text-align:center;min-height:1.5rem;padding:0.4rem;
         font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.1rem;"></div>`;

  // Build player score inputs
  const inputsEl = $('rc-player-inputs');
  gs.names.forEach((name, pi) => {
    const team     = gs.playerTeams?.[pi] ?? (pi === 0 ? 'red' : 'blue');
    const extra    = strokesOnHole(gs.matchHandicaps[pi], si);
    const existing = gs.log?.[h]?.grosses?.[pi];
    const hasVal   = existing != null;
    const scoreStyle = hasVal
      ? `background:var(--rc-${team});border-color:var(--rc-${team});color:#fff;`
      : `background:var(--surface2);border:2px solid var(--border);color:var(--muted);`;

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:0.75rem;padding:0.75rem;background:var(--surface);border-radius:10px;';
    row.innerHTML = `
      <div class="rc-player-dot ${team}" style="width:12px;height:12px;flex-shrink:0;"></div>
      <div style="flex:1;">
        <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.15rem;color:${teamColour(team)};">${name}</div>
        <div style="font-size:0.78rem;color:var(--muted);">Match HCP ${gs.matchHandicaps[pi]}${extra > 0 ? ` · +${extra} stroke${extra>1?'s':''} this hole` : ''}</div>
      </div>
      <div id="rc-cv-${pi}" data-value="${hasVal ? existing : ''}"
        style="min-width:64px;min-height:52px;display:flex;align-items:center;justify-content:center;
               border-radius:10px;font-family:'Barlow Condensed',sans-serif;font-size:1.6rem;font-weight:800;
               cursor:pointer;user-select:none;${scoreStyle}">
        ${hasVal ? String(existing) : 'Score'}
      </div>`;
    row.querySelector(`#rc-cv-${pi}`).addEventListener('click', () => openRcScorePicker(pi, h, par, gs));
    inputsEl.appendChild(row);
  });

  $('rc-btn-record-hole').addEventListener('click', () => recordRcHole(h, par));
  $('rc-btn-back-hole').addEventListener('click', () => {
    if (matchGameState.hole > 0) { matchGameState.hole--; renderScoringHole(); }
  });
}

function openRcScorePicker(pi, h, par, gs) {
  const extra = strokesOnHole(gs.matchHandicaps[pi], gs.si[h]);
  const team  = gs.playerTeams?.[pi] ?? (pi === 0 ? 'red' : 'blue');
  const cvEl  = $(`rc-cv-${pi}`);
  const current = cvEl?.dataset.value ? parseInt(cvEl.dataset.value) : null;

  $('rc-sp-player-name').textContent = gs.names[pi];
  $('rc-sp-player-name').style.color = teamColour(team);
  $('rc-sp-context').textContent     = `Hole ${h+1} · Par ${par} · Match HCP ${gs.matchHandicaps[pi]}`;

  let min = 1, max = par <= 3 ? 9 : par === 4 ? 10 : 11;

  const grid = $('rc-sp-grid');
  grid.innerHTML = Array.from({ length: max - min + 1 }, (_, i) => {
    const v      = min + i;
    const net    = v - extra;
    const relPar = v - par;
    const isCur  = current === v;
    const bg = v === 1 ? 'var(--rc-gold)'
             : relPar === 0 ? 'var(--green)'
             : relPar < 0   ? '#d64545'
             : relPar <= 2  ? '#3a7bd5'
             : '#2a2a2a';
    return `<button class="rc-sp-btn" data-val="${v}" data-pi="${pi}"
      style="display:grid;grid-template-columns:1fr 2fr 1fr;align-items:center;
             padding:0.55rem 0.5rem;border-radius:12px;border:none;cursor:pointer;
             background:var(--surface2);${isCur ? 'box-shadow:0 0 0 3px var(--rc-gold);' : ''}">
      <span style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.3rem;
                   color:${relPar < 0 ? '#d64545' : 'var(--white)'};">${net}</span>
      <span style="display:flex;align-items:center;justify-content:center;width:52px;height:52px;margin:0 auto;
                   border-radius:50%;background:${bg};color:${v===1?'#000':'#fff'};
                   font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.6rem;">${v}</span>
      <span style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.1rem;color:var(--muted2);">
        ${stablefordPoints(v, extra, par) > 0 ? stablefordPoints(v, extra, par) : '-'}
      </span>
    </button>`;
  }).join('') + `<button id="rc-sp-pickup" class="rc-btn rc-btn-primary"
    style="width:100%;margin-top:0.25rem;font-size:0.95rem;">🏌️ Pick Up / Concede Hole</button>`;

  grid.querySelectorAll('.rc-sp-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const val   = parseInt(btn.dataset.val);
      const piNum = parseInt(btn.dataset.pi);
      setRcScoreValue(piNum, val, par, false);
      $('rc-modal-score-picker').classList.remove('open');
    });
  });
  $('rc-sp-pickup').onclick = () => {
    setRcScoreValue(pi, par + extra + 1, par, true);
    $('rc-modal-score-picker').classList.remove('open');
  };
  $('rc-sp-cancel').onclick = () => $('rc-modal-score-picker').classList.remove('open');

  // Scroll to par-1
  $('rc-modal-score-picker').classList.add('open');
  const targetBtn = grid.querySelector(`.rc-sp-btn[data-val="${Math.max(min, (current ?? par) - 1)}"]`);
  if (targetBtn) {
    requestAnimationFrame(() => {
      const gr = grid.getBoundingClientRect();
      const br = targetBtn.getBoundingClientRect();
      grid.scrollTop = Math.max(0, grid.scrollTop + (br.top - gr.top) - 6);
    });
  }
}

function setRcScoreValue(pi, value, par, isPickup) {
  const el = $(`rc-cv-${pi}`);
  if (!el) return;
  el.dataset.value = String(value);
  const relPar = value - par;
  const color  = value === 1 ? 'var(--rc-gold)'
               : relPar === 0 ? 'var(--green)'
               : relPar < 0   ? '#d64545'
               : relPar <= 2  ? '#3a7bd5'
               : '#2a2a2a';
  el.style.background  = isPickup ? 'var(--rc-gold)' : color;
  el.style.borderColor = isPickup ? 'var(--rc-gold)' : color;
  el.style.color       = (value === 1 || isPickup) ? '#000' : '#fff';
  el.innerHTML         = isPickup
    ? `${value}<span style="font-size:0.55rem;display:block;font-weight:600;">PICKUP</span>`
    : String(value);
}

async function recordRcHole(h, par) {
  const grosses = [];
  for (let i = 0; i < matchGameState.names.length; i++) {
    const val = parseInt($(`rc-cv-${i}`)?.dataset?.value);
    if (!val || val < 1) { alert(`Please enter a score for ${matchGameState.names[i]}.`); return; }
    grosses.push(val);
  }

  matchGameState = processHole(matchGameState, grosses);

  // Show result flash
  const entry  = matchGameState.log[h];
  const ms     = matchGameState.matchScore ?? 0;
  const result = $('rc-hole-result');
  if (result) {
    const up   = Math.abs(ms);
    const left = (matchGameState.numHoles ?? 18) - matchGameState.log.length;
    if (ms === 0) {
      result.textContent = 'Hole halved — All Square';
      result.style.color = 'var(--green)';
    } else {
      const winner = ms > 0 ? matchGameState.names[0] : matchGameState.names[1];
      result.textContent = `${winner} wins · ${up} Up · ${left} to play`;
      result.style.color = ms > 0 ? 'var(--rc-red-light)' : 'var(--rc-blue-light)';
    }
  }

  // Check if match is decided
  const played = matchGameState.log.length;
  const total  = matchGameState.numHoles ?? 18;
  if (matchPlayIsOver(matchGameState.matchScore, played, total)) {
    await rcSaveMatchState(activeMatchId, matchGameState).catch(() => {});
    setTimeout(() => finishMatch(), 800);
    return;
  }

  await rcSaveMatchState(activeMatchId, matchGameState).catch(() => {});

  if (matchGameState.hole >= total) {
    finishMatch();
    return;
  }

  setTimeout(() => renderScoringHole(), 600);
}

async function finishMatch() {
  const gs  = matchGameState;
  const ms  = gs.matchScore ?? 0;
  let result;
  if (ms > 0)      result = 'red';
  else if (ms < 0) result = 'blue';
  else             result = 'halved';

  await rcCompleteMatch(activeMatchId, gs, result);

  // Reload tournament totals
  activeTournament = await rcLoadTournament(activeTournament.id);
  updateAllScoreBanners();

  const t   = activeTournament;
  const msg = result === 'red'    ? `${t.red_team_name||'Red'} wins the match! +1 point`
            : result === 'blue'   ? `${t.blue_team_name||'Blue'} wins the match! +1 point`
            : 'Match halved — ½ point each!';
  alert(msg);

  // Navigate back
  const activeRound = activeRounds.find(r => r.status === 'active');
  if (activeRound) showRoundOverview(activeRound.id);
  else if (myRole === 'player') renderPlayerDashboard();
  else renderCaptainDashboard();
}

// ================================================================
// ADMIN — TOURNAMENT & ROUND CREATION
// ================================================================
$('rc-btn-create-tournament')?.addEventListener('click', () => showScreen('rc-screen-admin-setup'));
$('rc-admin-setup-back')?.addEventListener('click', () => showScreen('rc-screen-home'));

// HCP allowance pct toggle
$('rc-tourn-hcp-mode')?.addEventListener('change', e => {
  $('rc-hcp-pct-field').style.display = e.target.value === 'playing' ? '' : 'none';
});

// Captain pickers
let _pickingCaptain = null;
$('rc-pick-red-captain')?.addEventListener('click', () => {
  _pickingCaptain = 'red';
  openFriendPickerModal('Pick Red Captain');
});
$('rc-pick-blue-captain')?.addEventListener('click', () => {
  _pickingCaptain = 'blue';
  openFriendPickerModal('Pick Blue Captain');
});

let _selectedRedCaptain  = null;
let _selectedBlueCaptain = null;

function openFriendPickerModal(title) {
  $('rc-fp-title').textContent = title;
  const list = $('rc-fp-list');
  list.innerHTML = allFriends.map(f => `
    <div class="rc-player-row" style="cursor:pointer;" data-friend-id="${f.profileId}" data-friend-name="${f.name}">
      <div class="rc-player-name">${f.name}</div>
      <div class="rc-player-stat">HCP ${fmtHcp(f.hcp)}</div>
    </div>`).join('');
  list.querySelectorAll('[data-friend-id]').forEach(row => {
    row.addEventListener('click', () => {
      if (_pickingCaptain === 'red') {
        _selectedRedCaptain = { id: row.dataset.friendId, name: row.dataset.friendName };
        $('rc-red-captain-name').textContent = row.dataset.friendName;
      } else {
        _selectedBlueCaptain = { id: row.dataset.friendId, name: row.dataset.friendName };
        $('rc-blue-captain-name').textContent = row.dataset.friendName;
      }
      $('rc-modal-friend-picker').classList.remove('open');
    });
  });
  $('rc-modal-friend-picker').classList.add('open');
}
$('rc-fp-close')?.addEventListener('click', () => $('rc-modal-friend-picker').classList.remove('open'));

$('rc-btn-create-tourn')?.addEventListener('click', async () => {
  const name = $('rc-tourn-name').value.trim();
  if (!name) { $('rc-setup-error').textContent = 'Please enter a tournament name.'; show('rc-setup-error'); return; }
  if (!_selectedRedCaptain)  { $('rc-setup-error').textContent = 'Please choose a Red captain.';  show('rc-setup-error'); return; }
  if (!_selectedBlueCaptain) { $('rc-setup-error').textContent = 'Please choose a Blue captain.'; show('rc-setup-error'); return; }

  const btn = $('rc-btn-create-tourn');
  btn.disabled = true; btn.textContent = 'Creating…';
  hide('rc-setup-error');

  try {
    const t = await rcCreateTournament({
      name,
      adminId:         currentUser.id,
      numRounds:       parseInt($('rc-tourn-rounds').value),
      hcpMode:         $('rc-tourn-hcp-mode').value,
      hcpAllowancePct: parseInt($('rc-tourn-hcp-pct').value) || 100,
      redTeamName:     $('rc-red-team-name').value.trim() || 'Red',
      blueTeamName:    $('rc-blue-team-name').value.trim() || 'Blue',
      redCaptainId:    _selectedRedCaptain.id,
      blueCaptainId:   _selectedBlueCaptain.id,
      playersPerTeam:  parseInt($('rc-tourn-players').value),
    });
    await enterTournament(t.id);
  } catch (err) {
    $('rc-setup-error').textContent = err.message || 'Could not create tournament.';
    show('rc-setup-error');
    btn.disabled = false;
    btn.textContent = 'Create Tournament →';
  }
});

// Add round
$('rc-btn-add-round')?.addEventListener('click', () => {
  populateCourseSelect();
  const nextNum   = activeRounds.length;
  const nextLabel = ROUND_LABELS[nextNum] || `Round ${nextNum + 1}`;
  $('rc-round-setup-title').textContent = nextLabel;
  $('rc-screen-round-setup').dataset.roundLabel = nextLabel;
  $('rc-screen-round-setup').dataset.roundNum   = String(nextNum + 1);
  showScreen('rc-screen-round-setup');
});
$('rc-round-setup-back')?.addEventListener('click', () => renderAdminDashboard());

function populateCourseSelect() {
  const sel = $('rc-round-course');
  sel.innerHTML = '<option value="">— Select course —</option>';
  allCourses.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id; opt.textContent = c.name;
    sel.appendChild(opt);
  });
  sel.onchange = () => {
    const course = allCourses.find(c => c.id === sel.value);
    const teeField = $('rc-round-tee-field');
    const teeSel   = $('rc-round-tee');
    if (course?.tees?.length) {
      teeSel.innerHTML = course.tees.map(t => `<option value="${t.name}">${t.name}</option>`).join('');
      teeField.classList.remove('rc-hidden');
    } else {
      teeField.classList.add('rc-hidden');
    }
  };
}

$('rc-btn-save-round')?.addEventListener('click', async () => {
  const courseId = $('rc-round-course').value;
  if (!courseId) { $('rc-round-error').textContent = 'Please select a course.'; show('rc-round-error'); return; }
  const course   = allCourses.find(c => c.id === courseId);
  const teeName  = $('rc-round-tee').value || course?.tees?.[0]?.name;
  const tee      = course?.tees?.find(t => t.name === teeName) ?? course?.tees?.[0];
  if (!tee) { $('rc-round-error').textContent = 'Please select a tee.'; show('rc-round-error'); return; }

  const btn = $('rc-btn-save-round');
  btn.disabled = true; btn.textContent = 'Saving…';
  hide('rc-round-error');

  try {
    const round = await rcCreateRound({
      tournamentId: activeTournament.id,
      roundNumber:  parseInt($('rc-screen-round-setup').dataset.roundNum),
      roundLabel:   $('rc-screen-round-setup').dataset.roundLabel,
      courseName:   course.name,
      teeName:      tee.name,
      format:       $('rc-round-format').value,
      si:           tee.si,
      par:          tee.par,
      numHoles:     18,
      ldHoles:      $('rc-ld-enabled').checked ? [7] : [],  // placeholder — full hole picker can be added later
      ntpHoles:     $('rc-ntp-enabled').checked ? [3] : [],
    });

    // Update round status to 'selection' so captains can submit lineups
    await rcUpdateRound(round.id, { status: 'selection' });

    activeRounds = await rcLoadRounds(activeTournament.id);
    renderAdminDashboard();
  } catch (err) {
    $('rc-round-error').textContent = err.message || 'Could not save round.';
    show('rc-round-error');
    btn.disabled = false;
    btn.textContent = 'Save & Invite Captains →';
  }
});

// Finalise tournament
$('rc-btn-finalise-tourn')?.addEventListener('click', async () => {
  if (!confirm('Finalise this tournament? This will update all career points and mark the cup complete.')) return;
  try {
    await rcFinaliseTournament(activeTournament.id);
    alert('Tournament complete! Career points have been updated.');
    loadHomeScreen();
  } catch (err) {
    alert('Error: ' + err.message);
  }
});

// ================================================================
// NOTES MODAL
// ================================================================
let _editingPlayerId = null;

function openNotesModal(playerId, playerNameStr) {
  _editingPlayerId = playerId;
  $('rc-notes-player-name').textContent = playerNameStr;
  const player = activePlayers.find(p => p.id === playerId);
  $('rc-notes-input').value = player?.captain_notes ?? '';
  $('rc-modal-notes').classList.add('open');
}
$('rc-notes-close')?.addEventListener('click', () => $('rc-modal-notes').classList.remove('open'));
$('rc-btn-save-notes')?.addEventListener('click', async () => {
  if (!_editingPlayerId) return;
  const notes = $('rc-notes-input').value.trim();
  await rcUpdatePlayerNotes(_editingPlayerId, notes).catch(() => {});
  const p = activePlayers.find(pl => pl.id === _editingPlayerId);
  if (p) p.captain_notes = notes;
  $('rc-modal-notes').classList.remove('open');
});

// ================================================================
// INVITE PLAYERS (captain)
// ================================================================
$('rc-btn-invite-players')?.addEventListener('click', () => {
  _pickingCaptain = null; // reuse friend picker for invites
  $('rc-fp-title').textContent = `Invite to ${myTeam === 'red' ? (activeTournament?.red_team_name||'Red') : (activeTournament?.blue_team_name||'Blue')} Team`;
  const list = $('rc-fp-list');
  // Exclude already-invited players
  const alreadyInvited = new Set(activePlayers.map(p => p.profile?.id).filter(Boolean));
  const eligible = allFriends.filter(f => !alreadyInvited.has(f.profileId));

  if (!eligible.length) {
    list.innerHTML = `<div class="rc-hint" style="padding:1rem;">All your friends are already in this tournament, or you have no friends to invite.</div>`;
  } else {
    list.innerHTML = eligible.map(f => `
      <div class="rc-player-row" style="cursor:pointer;" data-invite-id="${f.profileId}" data-invite-name="${f.name}">
        <div class="rc-player-name">${f.name}</div>
        <div class="rc-player-stat">HCP ${fmtHcp(f.hcp)}</div>
        <div style="color:var(--muted);font-size:1.2rem;">›</div>
      </div>`).join('');
    list.querySelectorAll('[data-invite-id]').forEach(row => {
      row.addEventListener('click', async () => {
        $('rc-modal-friend-picker').classList.remove('open');
        const t    = activeTournament;
        const team = myTeam;
        const teamName = team === 'red' ? (t.red_team_name||'Red') : (t.blue_team_name||'Blue');
        try {
          await rcInvitePlayer({
            tournamentId:   t.id,
            profileId:      row.dataset.inviteId,
            team,
            captainId:      currentUser.id,
            tournamentName: t.name,
            teamName,
          });
          activePlayers = await rcLoadPlayers(t.id);
          renderCaptainTeamList();
          alert(`Invite sent to ${row.dataset.inviteName}!`);
        } catch (err) {
          alert('Could not send invite: ' + err.message);
        }
      });
    });
  }
  $('rc-modal-friend-picker').classList.add('open');
});

// ================================================================
// ACCEPT/DECLINE INVITE MODAL
// ================================================================
let _pendingInviteId = null;

function showInviteModal(inviteId, tournamentId, team) {
  _pendingInviteId = inviteId;
  rcLoadTournament(tournamentId).then(t => {
    const teamName = team === 'red' ? (t.red_team_name||'Red') : (t.blue_team_name||'Blue');
    $('rc-invite-text').innerHTML = `
      Congratulations! You have been invited to play in<br>
      <strong>${t.name}</strong><br>
      for the <span class="rc-team-badge ${team}" style="display:inline-flex;margin-top:4px;">
        <span class="rc-team-dot ${team}"></span>${teamName} Team
      </span>`;
    $('rc-modal-invite').classList.add('open');
  });
}

$('rc-btn-accept-invite')?.addEventListener('click', async () => {
  if (!_pendingInviteId) return;
  await rcAcceptInvite(_pendingInviteId).catch(() => {});
  $('rc-modal-invite').classList.remove('open');
  await loadHomeScreen();
});
$('rc-btn-decline-invite')?.addEventListener('click', async () => {
  if (!_pendingInviteId) return;
  await rcDeclineInvite(_pendingInviteId).catch(() => {});
  $('rc-modal-invite').classList.remove('open');
});

// ================================================================
// NAVIGATION
// ================================================================
$('rc-scoring-home')?.addEventListener('click', async () => {
  // Save state and go back
  if (matchGameState && activeMatchId) {
    await rcSaveMatchState(activeMatchId, matchGameState).catch(() => {});
  }
  if (myRole === 'admin')   renderAdminDashboard();
  else if (myRole === 'captain') renderCaptainDashboard();
  else renderPlayerDashboard();
});

$('rc-overview-back')?.addEventListener('click', () => {
  if (myRole === 'admin')        renderAdminDashboard();
  else if (myRole === 'captain') renderCaptainDashboard();
  else                           renderPlayerDashboard();
});

$('rc-lb-back')?.addEventListener('click', () => {
  if (myRole === 'admin') renderAdminDashboard();
  else renderPlayerDashboard();
});

$('rc-lineup-back')?.addEventListener('click', () => renderCaptainDashboard());

// Admin/Captain bottom nav routing
document.querySelectorAll('[data-nav]').forEach(btn => {
  btn.addEventListener('click', () => {
    const nav = btn.dataset.nav;
    if (nav === 'admin')   renderAdminDashboard();
    if (nav === 'captain') renderCaptainDashboard();
    if (nav === 'games')   renderPlayerDashboard();
  });
});

$('rc-btn-name-team')?.addEventListener('click', () => {
  const team = myTeam;
  const current = team === 'red' ? activeTournament.red_team_name : activeTournament.blue_team_name;
  const newName = prompt('Enter new team name:', current || (team === 'red' ? 'Red' : 'Blue'));
  if (!newName) return;
  const update = team === 'red' ? { red_team_name: newName } : { blue_team_name: newName };
  rcUpdateTournament(activeTournament.id, update).then(() => {
    Object.assign(activeTournament, update);
    renderCaptainDashboard();
  }).catch(err => alert('Could not update team name: ' + err.message));
});

$('rc-btn-view-all-tournaments')?.addEventListener('click', async () => {
  // Simple list of all tournaments — navigate to most recent active one
  const all = [
    ...await rcLoadMyTournaments(currentUser.id).catch(() => []),
    ...await rcLoadPlayerTournaments(currentUser.id).catch(() => []),
  ];
  if (!all.length) { alert('No tournaments found.'); return; }
  // For now, navigate to the first one — a full list screen can be added later
  await enterTournament(all[0].id);
});

// ================================================================
// KICK OFF
// ================================================================
document.addEventListener('DOMContentLoaded', boot);
