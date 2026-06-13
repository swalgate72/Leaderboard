// ================================================================
// LEADERBOARD - app.js  (v3.1 · build 20260604-02)
// UI controller. Imports data.js (Supabase) and game.js (engine).
// ================================================================

import {
  authSignIn, authSignUp, authSignOut, authSignInWithGoogle,
  authForgotPassword, authOnStateChange, authGetUser,
  profileLoad, profileSave, profileFindByEmail, profileFindByUsername,
  coursesLoadAll, courseLoadById, courseSave, courseDelete, coursesEnsureDefaults,
  roundCreate, roundSaveState, roundComplete, roundAbandon, roundDelete,
  roundsLoadActive, roundLoadById, roundsLoadHistory,
  roundPlayersSave, roundPlayersLoad,
  friendsLoad, friendRequestsLoadPending,
  friendRequestSend, friendRequestAccept, friendRequestDecline, friendRemove,
  smsInviteCreate, gameInviteLoad, gameInvitesPollPending, smsInviteLookup, smsInviteAccept,
  smsBuildInviteLink, smsBuildMessage,
  realtimeSubscribeRound, realtimeBroadcastRound, realtimeSubscribeFriendRequests, realtimeSubscribeGameInvites, realtimeUnsubscribe,
  tournamentCreate, tournamentsLoad, tournamentLoadById, tournamentUpdate, tournamentDelete,
  tournamentPlayersAdd, tournamentPlayersLoad, tournamentPlayerUpdate,
  tournamentRoundsLoad, tournamentRoundLoadById, tournamentRoundCreate, tournamentRoundUpdate,
  tournamentScoresLoad, tournamentAllScoresLoad, tournamentScoresSave,
  realtimeSubscribeTournament,
  challengeCreate, challengeUpdate, challengesLoadPending, realtimeSubscribeChallenges,
  tournamentTeamsCreate, tournamentTeamsLoad, tournamentTeamUpdate,
  roundTeamsCreate, roundTeamsLoad, roundTeamUpdate,
} from '../data.js';

import {
  FORMAT_LABELS, FORMAT_DESCS, FORMAT_MIN_PLAYERS, formatsForPlayerCount,
  calcHandicaps, strokesOnHole, indivStrokesOnHole,
  stablefordPoints, matchPlayStatus, matchPlayIsOver,
  buildInitialState, processHole, undoHole, editHole,
  getResultSummary, buildScorecardRows,
  greensomesPairHandicap, foursomedPairHandicap,
  buildMultiGroupLeaderboard,
} from '../game.js';

import {
  buildStandings, calcHandicapAdjustments, buildDefaultGroups,
  absentStrokeScore, roundSummary, buildTournamentViewUrl,
  buildTeamStandings, buildRotatingStandings, defaultTeamName,
} from '../tournament.js';

// ================================================================
// PLAYER COLOURS
// ================================================================
const P_HEX = ['#d4a843','#5ba3d9','#d96b4a','#e8c96a'];
const P_CSS = ['var(--p0)','var(--p1)','var(--p2)','var(--p3)'];

function pCol(i) { return P_CSS[i] ?? P_CSS[0]; }
function pHex(i) { return P_HEX[i] ?? P_HEX[0]; }

// ================================================================
// APP STATE
// ================================================================
let currentUser    = null;
let currentProfile = null;
let allCourses     = [];
let allFriends     = [];

const setup = {
  category:        null,
  scoring:         null,
  get format() { return this.scoring; },
  courseId:        null,
  teeIdx:          0,
  holes:           18,
  numPlayers:      2,
  numGroups:       1,
  playersPerGroup: null,  // used for Best 2
  hcpPct:          100,
  players:         [],
};

let roundId    = null;
let gameState  = null;
let realtimeCh = null;
let abandonSource = null;

const cwiz = {
  courseId: null, name: '', location: '', tees: [], holes: [],
  holeIdx: 0, returnTo: null,
};

let fpCallback    = null;
let historyFilter = 'all';
let theme = localStorage.getItem('lb-theme') || localStorage.getItem('lb_theme') || 'dark';

// ================================================================
// UTILITIES
// ================================================================
function show(id)  { document.getElementById(id)?.classList.remove('hidden'); }
function hide(id)  { document.getElementById(id)?.classList.add('hidden'); }
function toggle(id, on) { on ? show(id) : hide(id); }

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) { el.classList.add('active'); window.scrollTo(0, 0); }
}

function setMsg(id, msg, isError = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}
function clearMsg(id) { setMsg(id, ''); }

function fmtHandicap(h) {
  if (h == null || h === '') return '--';
  return parseFloat(h).toFixed(1);
}

function pluralHoles(n) { return n === 1 ? '1 hole' : `${n} holes`; }

function holeRange(holes) {
  if (holes === 'front9') return { offset: 0,  count: 9  };
  if (holes === 'back9')  return { offset: 9,  count: 9  };
  return                         { offset: 0,  count: 18 };
}

function fmtLabel(fmt) { return FORMAT_LABELS[fmt] ?? fmt; }

function applyTheme(t) {
  theme = t;
  if (t === 'light') document.documentElement.classList.add('light');
  else               document.documentElement.classList.remove('light');
  // Store under both keys for compatibility
  try { localStorage.setItem('lb-theme', t); localStorage.setItem('lb_theme', t); } catch {}
  ['btn-theme-dark','btn-theme-light'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', id === `btn-theme-${t}`);
  });
}

// ================================================================
// PENCIL LOGO SVG
// ================================================================
const PENCIL_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 60" width="100%" style="max-width:280px;display:block;">
  <polygon points="8,30 32,18 32,42" fill="#c8956a"/>
  <polygon points="8,30 22,24 22,36" fill="#4a4a4a"/>
  <polygon points="8,30 18,26 16,28" fill="#8a8a8a" opacity="0.6"/>
  <rect x="32" y="18" width="230" height="24" fill="#1a3a2a"/>
  <rect x="32" y="18" width="230" height="4" fill="#2a5a40" opacity="0.6"/>
  <rect x="32" y="38" width="230" height="4" fill="#0e1f16" opacity="0.5"/>
  <rect x="262" y="16" width="18" height="28" fill="#c8a020"/>
  <line x1="262" y1="22" x2="280" y2="22" stroke="#8a6010" stroke-width="1"/>
  <line x1="262" y1="27" x2="280" y2="27" stroke="#f0c040" stroke-width="0.75" opacity="0.6"/>
  <line x1="262" y1="32" x2="280" y2="32" stroke="#8a6010" stroke-width="1"/>
  <line x1="262" y1="38" x2="280" y2="38" stroke="#f0c040" stroke-width="0.75" opacity="0.6"/>
  <rect x="280" y="18" width="32" height="24" rx="3" ry="3" fill="#e8e0d8"/>
  <rect x="280" y="18" width="32" height="5" rx="2" fill="#f5f0ec"/>
  <rect x="280" y="37" width="32" height="5" rx="2" fill="#c8c0b8"/>
  <text x="147" y="30" font-family="Arial Narrow, Arial, sans-serif" font-size="15"
    font-weight="700" letter-spacing="3.5" fill="#d4a843"
    text-anchor="middle" dominant-baseline="middle">LEADERBOARD</text>
  <line x1="32" y1="21" x2="262" y2="21" stroke="white" stroke-width="0.75" opacity="0.08"/>
</svg>`;

const PENCIL_SVG_MINI = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 60" style="width:110px;height:auto;display:block;">
  <polygon points="8,30 32,18 32,42" fill="#c8956a"/>
  <polygon points="8,30 22,24 22,36" fill="#4a4a4a"/>
  <rect x="32" y="18" width="230" height="24" fill="#1a3a2a"/>
  <rect x="262" y="16" width="18" height="28" fill="#c8a020"/>
  <rect x="280" y="18" width="32" height="24" rx="3" fill="#e8e0d8"/>
  <text x="147" y="30" font-family="Arial Narrow, Arial, sans-serif" font-size="15"
    font-weight="700" letter-spacing="3.5" fill="#d4a843"
    text-anchor="middle" dominant-baseline="middle">LEADERBOARD</text>
</svg>`;

function renderLogos() {
  document.querySelectorAll('.logo-wrap').forEach(el => { el.innerHTML = PENCIL_SVG; });
  const mini = document.getElementById('game-logo-mini');
  if (mini) mini.innerHTML = PENCIL_SVG_MINI;
}

// ================================================================
// BOOT
// ================================================================
async function boot() {
  applyTheme(theme);
  renderLogos();

  const params      = new URLSearchParams(window.location.search);
  const joinToken   = params.get('join');
  const tournViewId = params.get('tournament');
  const troundParam = params.get('tround');
  const groupParam  = params.get('group');

  if (tournViewId) {
    await handleTournamentViewLink(tournViewId);
    return;
  }

  if (joinToken) { await handleJoinFlow(joinToken, troundParam, groupParam); return; }

  authOnStateChange(async (event, user) => {
    if (user) await onSignedIn(user);
    else       onSignedOut();
  });
}

// ================================================================
// AUTH
// ================================================================
function onSignedOut() {
  currentUser = null; currentProfile = null; roundId = null; gameState = null;
  showScreen('screen-auth');
}

let _joiningViaInvite = false;

async function onSignedIn(user) {
  currentUser = user;
  try {
    await coursesEnsureDefaults(user.id);
    currentProfile = await profileLoad(user.id);
    allCourses     = await coursesLoadAll();
    allFriends     = await friendsLoad(user.id);
    subscribeToFriendRequests();
    subscribeToGameInvites();

    // Check for a pending tournament round join (from auth redirect)
    const joinToken  = sessionStorage.getItem('lb-join-token');
    const joinTround = sessionStorage.getItem('lb-join-tround');
    const joinGroup  = sessionStorage.getItem('lb-join-group');
    if (joinToken) {
      sessionStorage.removeItem('lb-join-token');
      sessionStorage.removeItem('lb-join-tround');
      sessionStorage.removeItem('lb-join-group');
      if (joinTround && joinGroup) {
        await joinTournamentRoundAsScorer(user, joinTround, parseInt(joinGroup));
        return;
      }
    }

    // Skip auto-resume if we're in the middle of joining via in-app invite
    if (_joiningViaInvite) return;

    // Auto-resume if there's an active round in progress
    const actives = await roundsLoadActive(user.id);

    // Also check localStorage for a round joined as group scorer/watcher
    let storedRoundId = null;
    try { storedRoundId = localStorage.getItem('lb-active-round'); } catch {}
    if (storedRoundId && !actives.some(r => r.id === storedRoundId)) {
      const stored = await roundLoadById(storedRoundId);
      if (stored?.status === 'active') actives.unshift(stored);
      else try { localStorage.removeItem('lb-active-round'); } catch {}
    }

    if (actives.length > 0) {
      await resumeRound(actives[0].id);
    } else {
      await showHome();
    }
  } catch (err) {
    console.error('onSignedIn error', err);
    showScreen('screen-home');
  }
}

document.getElementById('tab-signin')?.addEventListener('click', () => {
  document.getElementById('tab-signin').classList.add('active');
  document.getElementById('tab-signup').classList.remove('active');
  show('form-signin'); hide('form-signup');
  clearMsg('auth-error'); clearMsg('auth-success');
});
document.getElementById('tab-signup')?.addEventListener('click', () => {
  document.getElementById('tab-signup').classList.add('active');
  document.getElementById('tab-signin').classList.remove('active');
  hide('form-signin'); show('form-signup');
  clearMsg('auth-error'); clearMsg('auth-success');
});

document.getElementById('btn-signin')?.addEventListener('click', async () => {
  let identifier = document.getElementById('si-email').value.trim();
  const pw       = document.getElementById('si-password').value;
  clearMsg('auth-error'); clearMsg('auth-success');
  if (!identifier || !pw) { setMsg('auth-error', 'Please enter your username/email and password.'); return; }
  const btn = document.getElementById('btn-signin');
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    // If not an email address, treat as username — look up the associated email
    if (!identifier.includes('@') || identifier.startsWith('@')) {
      const username = identifier.replace(/^@/, '').toLowerCase();
      const user = await profileFindByUsername(username);
      if (!user?.email) throw new Error('No account found with that username.');
      identifier = user.email;
    }
    await authSignIn(identifier, pw);
  } catch (err) {
    setMsg('auth-error', err.message || 'Sign in failed.');
    btn.disabled = false; btn.textContent = 'SIGN IN →';
  }
});

document.getElementById('btn-signup')?.addEventListener('click', async () => {
  const fname = document.getElementById('su-fname').value.trim();
  const lname = document.getElementById('su-lname').value.trim();
  const email = document.getElementById('su-email').value.trim();
  const pw    = document.getElementById('su-password').value;
  clearMsg('auth-error'); clearMsg('auth-success');
  if (!fname || !email || !pw) { setMsg('auth-error', 'Please fill in all fields.'); return; }
  if (pw.length < 8) { setMsg('auth-error', 'Password must be at least 8 characters.'); return; }
  const btn = document.getElementById('btn-signup');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    await authSignUp(email, pw, fname, lname);
    setMsg('auth-success', 'Account created! Check your email to confirm, then sign in.');
  } catch (err) {
    setMsg('auth-error', err.message || 'Sign up failed.');
  } finally {
    btn.disabled = false; btn.textContent = 'CREATE ACCOUNT →';
  }
});

document.getElementById('btn-forgot')?.addEventListener('click', async () => {
  const email = document.getElementById('si-email').value.trim();
  if (!email) { setMsg('auth-error', 'Enter your email first.'); return; }
  try { await authForgotPassword(email); setMsg('auth-success', 'Password reset email sent.'); }
  catch (err) { setMsg('auth-error', err.message || 'Could not send reset email.'); }
});

document.getElementById('btn-google')?.addEventListener('click', async () => {
  try { await authSignInWithGoogle(); }
  catch (err) { setMsg('auth-error', err.message || 'Google sign-in failed.'); }
});

document.getElementById('btn-sign-out')?.addEventListener('click', async () => {
  realtimeUnsubscribe(realtimeCh); realtimeCh = null;
  await authSignOut();
});

// ================================================================
// HOME SCREEN
// ================================================================
async function showHome() {
  showScreen('screen-home');
  renderLogos();
  try {
    const actives = await roundsLoadActive(currentUser.id);

    // Also check localStorage for a round the user joined (e.g. as group 2 scorer)
    let storedRoundId = null;
    try { storedRoundId = localStorage.getItem('lb-active-round'); } catch {}
    if (storedRoundId && !actives.some(r => r.id === storedRoundId)) {
      const stored = await roundLoadById(storedRoundId);
      if (stored?.status === 'active') actives.unshift(stored);
      else try { localStorage.removeItem('lb-active-round'); } catch {}
    }

    if (actives.length > 0) {
      const r = actives[0];
      document.getElementById('resume-title').textContent = `${r.course_name} · ${r.tee_name} Tees`;
      document.getElementById('resume-sub').textContent   = `${fmtLabel(r.game_format)} · ${r.player_names?.join(', ') ?? ''}`;
      roundId = r.id;
      show('home-resume-banner');
    } else {
      hide('home-resume-banner'); roundId = null;
    }
  } catch { hide('home-resume-banner'); }
}

// Home screen three-button handlers
document.getElementById('btn-solo-scoring')?.addEventListener('click', () => {
  setup.category = 'solo';
  showFormatPicker('solo');
});
document.getElementById('btn-team-scoring')?.addEventListener('click', () => {
  setup.category = 'team';
  showFormatPicker('team');
});
document.getElementById('btn-tournament-mode')?.addEventListener('click', () => show('modal-coming-soon'));

document.getElementById('nav-profile')?.addEventListener('click', () => showProfile());
document.getElementById('nav-friends')?.addEventListener('click', () => showFriends());
document.getElementById('nav-history')?.addEventListener('click', () => showHistory());
document.getElementById('nav-course') ?.addEventListener('click', () => { cwiz.returnTo = 'home'; openCourseWizard(null); });
document.getElementById('nav-theme')  ?.addEventListener('click', () => showProfile());

document.getElementById('coming-soon-close')?.addEventListener('click', () => hide('modal-coming-soon'));
document.getElementById('btn-resume')?.addEventListener('click', async () => { if (roundId) await resumeRound(roundId); });
document.getElementById('btn-abandon-home')?.addEventListener('click', () => { abandonSource = 'home'; document.getElementById('modal-abandon').classList.add('open'); });

// ================================================================
// FORMAT PICKER SCREEN
// ================================================================
const SOLO_FORMATS = [
  { key: 'stableford', icon: '⭐', label: 'Stableford',   desc: 'Points against par · handicap adjusted' },
  { key: 'stroke',     icon: '📋', label: 'Stroke Play',  desc: 'Total net shots over the round' },
  { key: 'match',      icon: '⚔️', label: 'Match Play',   desc: 'Hole by hole · net scores · 1v1' },
  { key: 'skins',      icon: '🏆', label: 'Skins',        desc: 'Win a hole outright · halved holes carry over' },
  { key: 'itc',        icon: '🪑', label: 'In the Chair', desc: 'Win the hole · defend the chair to score' },
  { key: 'split6',     icon: '🎯', label: 'Split 6',      desc: '3 players · 6 points distributed per hole' },
];

const TEAM_FORMATS = [
  { key: 'betterball', icon: '⛳', label: 'Better Ball',    desc: 'Pairs · best net score per pair competes' },
  { key: 'csm',        icon: '📊', label: 'Combined Score', desc: 'Pairs · combined stableford · match play' },
  { key: 'foursomes',  icon: '🤝', label: 'Foursomes',      desc: 'Pairs · alternate shots · WHS handicap' },
  { key: 'greensomes', icon: '🤝', label: 'Greensomes',     desc: 'Pairs · both drive then alternate · WHS handicap' },
  { key: 'best2',      icon: '🥇', label: 'Best 2',         desc: 'Best 2 stableford scores per group · groups vs groups' },
];

function showFormatPicker(category) {
  const formats = category === 'solo' ? SOLO_FORMATS : TEAM_FORMATS;
  document.getElementById('setup-format-screen-title').textContent =
    category === 'solo' ? 'Single Player Scoring' : 'Pairs / Team Scoring';

  const list = document.getElementById('setup-format-list');
  list.innerHTML = formats.map(f => `
    <div class="format-option-card" data-fmt="${f.key}"
      style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
             padding:1rem 1.25rem;margin-bottom:0.5rem;cursor:pointer;transition:border-color 0.15s;
             display:flex;align-items:center;gap:0.75rem;">
      <div style="font-size:1.8rem;flex-shrink:0;">${f.icon}</div>
      <div>
        <div style="font-family:'Barlow Condensed',sans-serif;font-size:1.2rem;font-weight:700;
                    letter-spacing:0.06em;color:var(--gold);">${f.label}</div>
        <div style="font-size:0.72rem;color:var(--muted);margin-top:1px;">${f.desc}</div>
      </div>
    </div>`).join('');

  list.querySelectorAll('.format-option-card').forEach(card => {
    card.addEventListener('mouseenter', () => card.style.borderColor = 'var(--gold-border)');
    card.addEventListener('mouseleave', () => card.style.borderColor = 'var(--border)');
    card.addEventListener('click', () => {
      const fmt = card.dataset.fmt;
      setup.scoring  = fmt;
      setup.courseId = null; setup.teeIdx = 0; setup.holes = 18;
      setup.hcpPct   = 100; setup.players = [];
      if (fmt === 'split6')                                                { setup.numPlayers = 3; setup.numGroups = 1; setup.playersPerGroup = null; }
      else if (['betterball','csm','foursomes','greensomes'].includes(fmt)){ setup.numPlayers = 4; setup.numGroups = 1; setup.playersPerGroup = null; }
      else if (fmt === 'best2')                                            { setup.numPlayers = 8; setup.numGroups = 2; setup.playersPerGroup = 4; }
      else if (fmt === 'match')                                            { setup.numPlayers = 2; setup.numGroups = 1; setup.playersPerGroup = null; }
      else                                                                 { setup.numPlayers = 3; setup.numGroups = 1; setup.playersPerGroup = null; }
      startSetup();
    });
  });

  showScreen('screen-setup-format');
}

document.getElementById('setup-format-back')?.addEventListener('click', () => showHome());

// ================================================================
// SETUP -- STEP 1: COURSE
// ================================================================
function startSetup() {
  const fmt = setup.scoring;
  document.getElementById('setup-course-format-label').textContent = FORMAT_LABELS[fmt] ?? fmt;
  populateCourseSelect();
  populateNumPlayerSelect();
  populateNumGroupSelect();
  document.getElementById('setup-hcp-pct').value = 100;
  hide('setup-tee-wrap');
  showScreen('screen-setup-course');
}

function populateCourseSelect() {
  const sel = document.getElementById('setup-course-select');
  sel.innerHTML = '<option value="">-- Select course --</option>';
  allCourses.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name + (c.location ? ` (${c.location})` : '');
    if (c.is_default) opt.selected = true;
    sel.appendChild(opt);
  });
  onCourseSelectChange();
}

function onCourseSelectChange() {
  const sel      = document.getElementById('setup-course-select');
  const courseId = sel.value;
  setup.courseId = courseId || null;
  if (!courseId) { hide('setup-tee-wrap'); return; }
  const course = allCourses.find(c => c.id === courseId);
  if (!course) return;
  const teeSel = document.getElementById('setup-tee-select');
  teeSel.innerHTML = '';
  (course.tees ?? []).forEach((t, i) => {
    const opt = document.createElement('option');
    opt.value = i; opt.textContent = t.name; teeSel.appendChild(opt);
  });

  // Default to last used tee for this course, otherwise first tee
  const lastTee  = localStorage.getItem(`lb-last-tee-${courseId}`);
  const lastIdx  = lastTee ? (course.tees ?? []).findIndex(t => t.name === lastTee) : -1;
  setup.teeIdx   = lastIdx >= 0 ? lastIdx : 0;
  teeSel.value   = String(setup.teeIdx);

  show('setup-tee-wrap');
  renderSIPreview(course, setup.teeIdx);
}

document.getElementById('setup-course-select')?.addEventListener('change', onCourseSelectChange);
document.getElementById('setup-tee-select')?.addEventListener('change', e => {
  setup.teeIdx = parseInt(e.target.value, 10);
  const course = allCourses.find(c => c.id === setup.courseId);
  if (course) renderSIPreview(course, setup.teeIdx);
});

function renderSIPreview(course, teeIdx) {
  const tee  = course.tees?.[teeIdx]; if (!tee) return;
  const grid = document.getElementById('setup-si-grid');
  if (!grid) return;
  const { offset, count } = holeRange(setup.holes);
  const siSlice  = tee.si.slice(offset, offset + count);
  const parSlice = tee.par.slice(offset, offset + count);
  grid.innerHTML = siSlice.map((si, i) => `
    <div style="background:var(--surface2);border-radius:3px;padding:3px 1px;text-align:center;">
      <div style="font-size:0.48rem;color:var(--muted);">${offset+i+1}</div>
      <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.1rem;color:var(--white);line-height:1;">${si}</div>
      <div style="font-size:0.48rem;color:var(--muted);">P${parSlice[i]}</div>
    </div>`).join('');
  show('setup-si-preview');
}

document.querySelectorAll('.holes-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.holes-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    setup.holes = btn.dataset.holes === '18' ? 18 : btn.dataset.holes;
    const course = allCourses.find(c => c.id === setup.courseId);
    if (course) renderSIPreview(course, setup.teeIdx);
  });
});

function populateNumPlayerSelect() {
  const sel     = document.getElementById('setup-num-players');
  const fmt     = setup.scoring;
  const isPairs = ['betterball','csm','foursomes','greensomes'].includes(fmt);
  const label   = document.getElementById('setup-num-players-label');
  if (label) label.textContent = isPairs ? 'Number of Pairs' : fmt === 'best2' ? 'Players per Group' : 'Number of Players';

  sel.innerHTML = '';
  let min = 1, max = 12;
  if (fmt === 'split6')                                                { min = 3; max = 3; }
  else if (['betterball','csm','foursomes','greensomes'].includes(fmt)){ min = 2; max = 6; }
  else if (fmt === 'match')                                            { min = 2; max = 2; }
  else if (fmt === 'best2')                                            { min = 3; max = 4; }
  else if (['stableford','stroke'].includes(fmt))                      { min = 1; max = 12; }
  else                                                                 { min = 2; max = 12; }

  for (let n = min; n <= max; n++) {
    const opt = document.createElement('option');
    opt.value = n;
    if (isPairs) opt.textContent = `${n} pair${n !== 1 ? 's' : ''} (${n * 2} players)`;
    else         opt.textContent = `${n}`;
    if (n === (isPairs ? setup.numPlayers / 2 : setup.numPlayers)) opt.selected = true;
    sel.appendChild(opt);
  }
}

function populateNumGroupSelect() {
  const sel = document.getElementById('setup-num-groups');
  sel.innerHTML = '';
  for (let g = 1; g <= 20; g++) {
    const opt = document.createElement('option');
    opt.value = g; opt.textContent = g;
    if (g === setup.numGroups) opt.selected = true;
    sel.appendChild(opt);
  }
}

document.getElementById('setup-num-players')?.addEventListener('change', e => {
  const val     = parseInt(e.target.value, 10);
  const isPairs = ['betterball','csm','foursomes','greensomes'].includes(setup.scoring);
  setup.numPlayers = isPairs ? val * 2 : val;
  populateNumGroupSelect();
});
document.getElementById('setup-num-groups')?.addEventListener('change', e => {
  setup.numGroups = parseInt(e.target.value, 10);
  if (setup.scoring === 'best2' && setup.playersPerGroup) {
    setup.numPlayers = setup.playersPerGroup * setup.numGroups;
  }
});
document.getElementById('setup-add-course-btn')?.addEventListener('click', () => { cwiz.returnTo = 'setup'; openCourseWizard(null); });
document.getElementById('setup-course-back')?.addEventListener('click', () => {
  showFormatPicker(setup.category ?? 'solo');
});
document.getElementById('setup-abandon-1')  ?.addEventListener('click', () => { abandonSource = 'setup'; document.getElementById('modal-abandon').classList.add('open'); });

document.getElementById('btn-setup-course-next')?.addEventListener('click', () => {
  if (!setup.courseId) { alert('Please select a course.'); return; }
  setup.hcpPct     = parseInt(document.getElementById('setup-hcp-pct').value, 10) || 100;
  const rawVal  = parseInt(document.getElementById('setup-num-players').value, 10);
  const isPairsFormat = ['betterball','csm','foursomes','greensomes'].includes(setup.scoring);
  const isBest2Format = setup.scoring === 'best2';
  if (isBest2Format) {
    // rawVal = players per group, numGroups set separately
    setup.playersPerGroup = rawVal;
    setup.numPlayers = rawVal * setup.numGroups;
  } else if (isPairsFormat) {
    setup.numPlayers = rawVal * 2;
  } else {
    setup.numPlayers = rawVal;
  }
  setup.numGroups  = parseInt(document.getElementById('setup-num-groups').value, 10);
  buildPlayerForms();
  showScreen('screen-setup-players');
});

// ================================================================
// SETUP -- STEP 2: PLAYERS
// ================================================================
function buildPlayerForms() {
  const container = document.getElementById('setup-player-groups');
  container.innerHTML = ''; setup.players = [];
  const myName = currentProfile ? `${currentProfile.first_name ?? ''} ${currentProfile.last_name ?? ''}`.trim() : '';
  const myHcp  = currentProfile?.hcp ?? '';
  const isPairs = ['betterball','csm','foursomes','greensomes'].includes(setup.scoring);
  const isBest2 = setup.scoring === 'best2';

  // How many players per group
  const playersPerGroup = Math.ceil(setup.numPlayers / setup.numGroups);

  // Initialise all player slots
  for (let i = 0; i < setup.numPlayers; i++) {
    setup.players[i] = {
      name:        i === 0 ? myName  : '',
      hcpIndex:    i === 0 ? myHcp   : '',
      groupNumber: Math.floor(i / playersPerGroup) + 1,
      profileId:   i === 0 ? currentUser?.id : null,
      mobile:      i === 0 ? currentProfile?.mobile ?? '' : '',
      isScorer:    i === 0,
    };
  }

  for (let g = 1; g <= setup.numGroups; g++) {
    const start = (g - 1) * playersPerGroup;
    const end   = Math.min(g * playersPerGroup, setup.numPlayers);

    const groupEl = document.createElement('div');
    groupEl.className = 'group-block';
    if (setup.numGroups > 1) groupEl.innerHTML = `<div class="group-label">Group ${g}</div>`;

    if (isPairs) {
      // Render as pair blocks
      const numPairsInGroup = Math.ceil((end - start) / 2);
      for (let pair = 0; pair < numPairsInGroup; pair++) {
        const p0 = start + pair * 2;
        const p1 = start + pair * 2 + 1;
        const pairLabel = String.fromCharCode(65 + pair); // A, B, C...

        const pairBlock = document.createElement('div');
        pairBlock.className = 'pair-block pair-block-a';
        pairBlock.innerHTML = `<div class="pair-label pair-label-a" style="margin-bottom:0.5rem;">Pair ${pairLabel}</div>`;

        [p0, p1].forEach((pi, pairPos) => {
          if (pi >= setup.numPlayers) return;
          pairBlock.appendChild(makePlayerInputEl(pi, pairPos === 0 && pi === 0));
        });
        groupEl.appendChild(pairBlock);
      }
    } else {
      for (let p = start; p < end; p++) {
        groupEl.appendChild(makePlayerInputEl(p, p === 0));
      }
    }

    // Scorer selection removed — players claim scorer role via the in-app invite banner
    container.appendChild(groupEl);
  }

  // Build scorer radio buttons after all players are in DOM
  for (let g = 1; g <= setup.numGroups; g++) {
    const start = (g - 1) * playersPerGroup;
    const end   = Math.min(g * playersPerGroup, setup.numPlayers);
    const radios = document.getElementById(`scorer-radios-g${g}`);
    if (!radios) continue;

    // Ensure exactly one scorer per group — default to first in group
    const hasScorer = setup.players.slice(start, end).some(p => p.isScorer);
    if (!hasScorer) setup.players[start].isScorer = true;

    for (let pi = start; pi < end; pi++) {
      const btn = document.createElement('button');
      btn.className = `btn ${setup.players[pi].isScorer ? 'btn-primary' : 'btn-outline'}`;
      btn.style.cssText = 'padding:0.3rem 0.75rem;font-size:0.82rem;width:auto;';
      btn.dataset.pi = pi;
      btn.textContent = setup.players[pi].name || `Player ${pi - start + 1}`;
      btn.addEventListener('click', () => {
        // Clear scorer for this group, set new one
        for (let p = start; p < end; p++) setup.players[p].isScorer = false;
        setup.players[pi].isScorer = true;
        radios.querySelectorAll('button').forEach((b, bi) => {
          b.className = `btn ${pi === start + bi ? 'btn-primary' : 'btn-outline'}`;
          b.style.cssText = 'padding:0.3rem 0.75rem;font-size:0.82rem;width:auto;';
        });
      });
      radios.appendChild(btn);
    }
  }
}

function makePlayerInputEl(pi, isMe) {
  const row = document.createElement('div');
  row.className = 'player-slot';
  const courseHcp = setup.players[pi].courseHandicap ?? setup.players[pi].hcpIndex ?? '';
  row.innerHTML = `
    <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.4rem;">
      <span class="dot" style="background:${pHex(pi % 8)};"></span>
      <input id="pname-${pi}" type="text" placeholder="Player ${pi+1}"
        value="${setup.players[pi].name}" style="flex:1;background:none;border:none;
        color:var(--white);font-size:0.88rem;outline:none;
        border-bottom:1px solid var(--border);" autocomplete="off">
      ${!isMe ? `<button class="btn btn-ghost" style="padding:0.25rem 0.6rem;font-size:0.8rem;" data-pick="${pi}">👤</button>` : ''}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;">
      <div class="field" style="margin:0;">
        <label>HCP Index</label>
        <input id="phcp-${pi}" type="number" step="0.1" min="0" max="54"
          placeholder="0.0" value="${setup.players[pi].hcpIndex}">
      </div>
      <div class="field" style="margin:0;">
        <label>Course HCP</label>
        <input id="pchcp-${pi}" type="number" step="1" min="0" max="54"
          placeholder="0" value="${courseHcp}"
          style="border-color:var(--gold-border);">
      </div>
    </div>
    <div style="font-size:0.62rem;color:var(--muted);margin-top:3px;">
      Course HCP may differ from index (slope/rating adjustment)
    </div>`;

  row.querySelector(`#pname-${pi}`)?.addEventListener('input', e => {
    setup.players[pi].name = e.target.value.trim();
    const g = setup.players[pi].groupNumber;
    const radios = document.getElementById(`scorer-radios-g${g}`);
    if (radios) {
      const btn = radios.querySelectorAll('button')[pi - ((g-1) * Math.ceil(setup.numPlayers / setup.numGroups))];
      if (btn) btn.textContent = e.target.value.trim() || `Player ${pi+1}`;
    }
  });
  row.querySelector(`#phcp-${pi}`)?.addEventListener('input', e => {
    setup.players[pi].hcpIndex = parseFloat(e.target.value) || 0;
    // Auto-update course hcp if not manually set
    const cEl = document.getElementById(`pchcp-${pi}`);
    if (cEl && !setup.players[pi].courseHcpManual) {
      cEl.value = Math.round(parseFloat(e.target.value) || 0);
      setup.players[pi].courseHandicap = Math.round(parseFloat(e.target.value) || 0);
    }
  });
  row.querySelector(`#pchcp-${pi}`)?.addEventListener('input', e => {
    setup.players[pi].courseHandicap = parseInt(e.target.value) || 0;
    setup.players[pi].courseHcpManual = true; // user has overridden
  });
  const pickBtn = row.querySelector(`[data-pick="${pi}"]`);
  if (pickBtn) pickBtn.addEventListener('click', () => openFriendPicker(pi));
  return row;
}

function openFriendPicker(playerIdx, customCallback = null) {
  fpCallback = customCallback ?? (({ name, hcp, profileId }) => {
    if (playerIdx < 0 || playerIdx >= setup.players.length) return;
    setup.players[playerIdx].name      = name;
    setup.players[playerIdx].hcpIndex  = hcp;
    setup.players[playerIdx].profileId = profileId;
    const nameEl = document.getElementById(`pname-${playerIdx}`);
    const hcpEl  = document.getElementById(`phcp-${playerIdx}`);
    if (nameEl) { nameEl.value = name; nameEl.dispatchEvent(new Event('input')); }
    if (hcpEl)  hcpEl.value  = hcp;
  });
  document.getElementById('fp-title').textContent = `Pick Player ${playerIdx + 1}`;
  hide('fp-confirm'); show('fp-chips');
  const chips = document.getElementById('fp-chips');
  chips.innerHTML = '';
  if (!allFriends.length) { show('fp-empty'); document.getElementById('modal-friend-picker').classList.add('open'); return; }
  hide('fp-empty');
  allFriends.forEach(f => {
    const chip = document.createElement('div');
    chip.className = 'friend-chip';
    chip.innerHTML = `<span class="fc-dot"></span><span>${f.name}</span><span class="fc-hcp">${fmtHandicap(f.hcp)}</span>`;
    chip.addEventListener('click', () => {
      document.getElementById('fp-selected-name').textContent = `${f.name} · HCP ${fmtHandicap(f.hcp)}`;
      document.getElementById('fp-hcp').value = f.hcp ?? '';
      show('fp-confirm'); hide('fp-chips');
      document.getElementById('fp-confirm-btn').onclick = () => {
        fpCallback({ name: f.name, hcp: parseFloat(document.getElementById('fp-hcp').value) || 0, profileId: f.profileId });
        document.getElementById('modal-friend-picker').classList.remove('open');
      };
    });
    chips.appendChild(chip);
  });
  document.getElementById('modal-friend-picker').classList.add('open');
}

document.getElementById('fp-close')    ?.addEventListener('click', () => document.getElementById('modal-friend-picker').classList.remove('open'));
document.getElementById('fp-back-btn') ?.addEventListener('click', () => { show('fp-chips'); hide('fp-confirm'); });
document.getElementById('setup-players-back')     ?.addEventListener('click', () => showScreen('screen-setup-course'));
document.getElementById('btn-setup-players-back') ?.addEventListener('click', () => showScreen('screen-setup-course'));
document.getElementById('setup-abandon-2')        ?.addEventListener('click', () => { abandonSource = 'setup'; document.getElementById('modal-abandon').classList.add('open'); });

document.getElementById('btn-setup-players-next')?.addEventListener('click', () => {
  for (let i = 0; i < setup.numPlayers; i++) {
    setup.players[i].name          = document.getElementById(`pname-${i}`)?.value.trim() || `Player ${i+1}`;
    setup.players[i].hcpIndex      = parseFloat(document.getElementById(`phcp-${i}`)?.value) || 0;
    setup.players[i].courseHandicap = parseInt(document.getElementById(`pchcp-${i}`)?.value) || setup.players[i].hcpIndex || 0;
  }
  buildSetupReview(); showScreen('screen-setup-review');
});

// ================================================================
// SETUP -- STEP 3: REVIEW
// ================================================================
function buildSetupReview() {
  const course = allCourses.find(c => c.id === setup.courseId);
  const tee    = course?.tees?.[setup.teeIdx];
  const { offset, count } = holeRange(setup.holes);
  const hcpObj = calcHandicaps(setup.players.map(p => p.hcpIndex || 0), setup.hcpPct);

  let html = `
    <div style="display:grid;gap:0.35rem;font-size:0.82rem;margin-bottom:0.75rem;">
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Format</span><span>${fmtLabel(setup.scoring)}</span></div>
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Course</span><span>${course?.name ?? '--'}</span></div>
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Tees</span><span>${tee?.name ?? '--'}</span></div>
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Holes</span><span>${count === 18 ? '18' : count === 9 && offset === 0 ? 'Front 9' : 'Back 9'}</span></div>
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">HCP Allowance</span><span>${setup.hcpPct}%</span></div>
    </div>
    <div style="border-top:1px solid var(--border);padding-top:0.6rem;">`;

  setup.players.forEach((p, i) => {
    html += `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:0.35rem 0;border-bottom:1px solid rgba(255,255,255,0.04);">
        <span style="display:flex;align-items:center;gap:6px;">
          <span class="dot" style="background:${pHex(i)};"></span>
          ${p.name || `Player ${i+1}`}
        </span>
        <span style="color:var(--muted);font-size:0.75rem;">
          HCP ${fmtHandicap(p.hcpIndex)} · Course ${fmtHandicap(p.courseHandicap ?? p.hcpIndex)} · Playing ${hcpObj[i]?.playingHandicap ?? 0}
        </span>
      </div>`;
  });
  html += '</div>';
  document.getElementById('review-content').innerHTML = html;
}

document.getElementById('setup-review-back') ?.addEventListener('click', () => showScreen('screen-setup-players'));
document.getElementById('btn-review-back')   ?.addEventListener('click', () => showScreen('screen-setup-players'));
document.getElementById('setup-abandon-3')   ?.addEventListener('click', () => { abandonSource = 'setup'; document.getElementById('modal-abandon').classList.add('open'); });
document.getElementById('btn-tee-off')       ?.addEventListener('click', async () => await teeOff());

async function teeOff() {
  const course = allCourses.find(c => c.id === setup.courseId);
  const tee    = course?.tees?.[setup.teeIdx];
  if (!course || !tee) return;
  const { offset, count } = holeRange(setup.holes);
  const siSlice  = tee.si.slice(offset, offset + count);
  const parSlice = tee.par.slice(offset, offset + count);
  const fmt      = setup.scoring;
  const isPairs  = ['betterball','csm','foursomes','greensomes'].includes(fmt);

  // Remember last used tee for this course
  try { localStorage.setItem(`lb-last-tee-${setup.courseId}`, tee.name); } catch {}

  // Use Course Handicap if set, otherwise fall back to HCP Index
  const hcpArr = setup.players.map(p => (p.courseHandicap != null ? p.courseHandicap : p.hcpIndex) || 0);
  const hcpObj = calcHandicaps(hcpArr, setup.hcpPct);

  // For foursomes/greensomes override pair handicaps using official rules
  // We still store individual handicaps but the processHole function handles the pair calculation
  const playingHcps = hcpObj.map(h => h.playingHandicap);
  const matchHcps   = hcpObj.map(h => h.matchHandicap);

  const playersPerGroup = Math.ceil(setup.numPlayers / setup.numGroups);
  screenLog('teeOff numGroups:' + setup.numGroups + ' numPlayers:' + setup.numPlayers + ' ppg:' + playersPerGroup);

  // Build one game state per group
  const groupStates = [];
  for (let g = 0; g < setup.numGroups; g++) {
    const start   = g * playersPerGroup;
    const end     = Math.min(start + playersPerGroup, setup.numPlayers);
    const gNames  = setup.players.slice(start, end).map(p => p.name || `Player ${start + setup.players.indexOf(p) + 1}`);
    const gHcpArr = hcpArr.slice(start, end);
    const gHcpObj = calcHandicaps(gHcpArr, setup.hcpPct);

    const gs = buildInitialState({
      format:          fmt,
      names:           gNames,
      handicapIndexes: gHcpArr,
      playingHandicaps: gHcpObj.map(h => h.playingHandicap),
      matchHandicaps:   gHcpObj.map(h => h.matchHandicap),
      allowancePct:    setup.hcpPct,
      si:              siSlice,
      par:             parSlice,
      numHoles:        count,
      holeOffset:      offset,
      courseName:      course.name,
      teeName:         tee.name,
      groupNumber:     g + 1,
      totalGroups:     setup.numGroups,
    });
    groupStates.push(gs);
  }

  // Active state is always group 0 (the scorer's group)
  gameState = groupStates[0];
  gameState.allGroupStates = groupStates;

  // Store profileIds per group. scorerProfileId starts as '__unclaimed__' —
  // first person to tap Score in the invite banner claims it.
  for (let g = 0; g < setup.numGroups; g++) {
    const groupNum     = g + 1;
    const groupPlayers = setup.players.filter(p => p.groupNumber === groupNum);
    groupStates[g].playerProfileIds = groupPlayers
      .map(p => p.profileId ?? null)
      .filter(id => id !== null);
    groupStates[g].scorerProfileId = '__unclaimed__';
    groupStates[g].groupNumber     = groupNum;
    groupStates[g].organiserId     = currentUser.id;
  }

  gameState.organiserId      = currentUser.id;
  // Organiser is scorer for group 1 (their own group)
  gameState.scorerProfileId  = currentUser.id;
  gameState.playerProfileIds = setup.players
    .filter(p => p.groupNumber === 1)
    .map(p => p.profileId ?? null)
    .filter(Boolean);

  const btn = document.getElementById('btn-tee-off');
  btn.disabled = true; btn.textContent = 'Starting…';
  try {
    const { allGroupStates, ...stateToSave } = gameState;
    // Include group states so resumeRound can identify each user's group
    if (allGroupStates?.length > 1) {
      stateToSave.allGroupStates = allGroupStates.map(gs => {
        const { allGroupStates: _, ...stripped } = gs;
        return stripped;
      });
    }
    roundId = await roundCreate({
      organiserId:  currentUser.id,
      courseName:   course.name,
      teeName:      tee.name,
      gameFormat:   fmt,
      scoringMethod: setup.scoring,
      hcpAllowance: setup.hcpPct,
      si:           siSlice,
      par:          parSlice,
      numHoles:     count,
      holeOffset:   offset,
      numGroups:    setup.numGroups,
      playerNames:  setup.players.map(p => p.name || 'Player'),
      gameState:    stateToSave,
    });
    await roundPlayersSave(roundId, setup.players.map((p, i) => ({
      profileId:       p.profileId ?? null,
      name:            p.name || `Player ${i+1}`,
      handicapIndex:   p.hcpIndex || 0,
      playingHandicap: hcpObj[i].playingHandicap,
      groupNumber:     p.groupNumber,
      isScorer:        p.isScorer ?? false,
      mobile:          p.mobile ?? null,
    })));
    subscribeToRound(roundId);

    const myName = currentProfile
      ? `${currentProfile.first_name ?? ''} ${currentProfile.last_name ?? ''}`.trim()
      : 'Your organiser';

    if (setup.numGroups > 1) {
      // Multi-group: invite modal for other groups (shows friend picker per group)
      const ppg = Math.ceil(setup.numPlayers / setup.numGroups);
      const otherGroupPlayers = [];
      for (let g = 1; g < setup.numGroups; g++) {
        const start   = g * ppg;
        const end     = Math.min(start + ppg, setup.numPlayers);
        const members = setup.players.slice(start, end).filter(p => p.profileId && p.profileId !== currentUser.id);
        members.forEach(p => otherGroupPlayers.push({ groupNumber: g + 1, scorer: p }));
      }
      if (otherGroupPlayers.length > 0) {
        await showRegularGameInviteModal(otherGroupPlayers, course, tee, fmt);
        return;
      }
    } else {
      // Single group: notify all players who have the app (profileId set) except the organiser
      const playersToNotify = setup.players.filter(
        p => p.profileId && p.profileId !== currentUser.id
      );
      for (const p of playersToNotify) {
        try {
          await smsInviteCreate({
            roundId, inviterId: currentUser.id, name: myName,
            mobile: null, recipientProfileId: p.profileId,
            tournamentRoundId: null, groupNumber: 1,
          });
        } catch (e) { console.error('[invite] notify failed for', p.name, e); }
      }
    }

    enterGameScreen();
  } catch (err) {
    alert('Could not start round: ' + (err.message ?? err));
  } finally {
    btn.disabled = false; btn.textContent = '⛳ TEE OFF →';
  }
}

// ================================================================
// RESUME
// ================================================================
function screenLog(msg) {
  console.log(msg);
  let el = document.getElementById('screen-log');
  if (!el) {
    el = document.createElement('div');
    el.id = 'screen-log';
    el.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:rgba(0,0,0,0.9);' +
      'color:#0f0;font-size:10px;font-family:monospace;padding:4px;z-index:99999;' +
      'max-height:80px;overflow-y:auto;';
    el.title = 'Tap to hide';
    el.addEventListener('click', () => el.style.display = 'none');
    document.body.appendChild(el);
  }
  el.style.display = '';
  el.innerHTML += '<div>' + new Date().toISOString().slice(11,19) + ' ' + msg + '</div>';
  el.scrollTop = el.scrollHeight;
}

async function resumeRound(id) {
  try {
    const round = await roundLoadById(id);
    if (!round) return;
    roundId = id;
    let gs = round.game_state;
    screenLog('resuming:' + id.slice(0,8) + ' groups:' + (gs?.allGroupStates?.length ?? 'none'));
    screenLog('myId:' + currentUser?.id?.slice(0,8));
    screenLog('topScorer:' + (gs?.scorerProfileId?.slice(0,8) ?? 'null'));
    if (gs?.allGroupStates) {
      gs.allGroupStates.forEach((s, i) => {
        screenLog('g' + i + ' pids:' + (s.playerProfileIds ?? []).map(p => p?.slice(0,6) ?? 'null').join(','));
        screenLog('g' + i + ' scorer:' + (s.scorerProfileId?.slice(0,8) ?? 'null'));
      });
    }

    if (gs?.allGroupStates?.length > 1 && currentUser) {
      const myGroup = gs.allGroupStates.find(s =>
        s.playerProfileIds?.some(pid => pid && pid === currentUser.id)
      );
      screenLog('myGroup:' + (myGroup ? 'found scorer:' + myGroup.scorerProfileId?.slice(0,8) : 'NOT FOUND'));
      if (myGroup) {
        gs = { ...myGroup, allGroupStates: gs.allGroupStates };
        screenLog('allGS after resume: ' + gs.allGroupStates.map(s => 'g'+s.groupNumber+'='+s.names?.[0]).join('|'));
      }
    }
    gameState = gs;
    screenLog('finalScorer:' + (gameState?.scorerProfileId?.slice(0,8) ?? 'null'));
    // If this is a tournament round, reload tournament globals so
    // saveTournamentScores has activeTournPlayers when the round ends.
    if (gameState?.tournamentId) {
      try {
        const tId = gameState.tournamentId;
        activeTournament     = await tournamentLoadById(tId);
        activeTournPlayers   = await tournamentPlayersLoad(tId);
        activeTournRounds    = await tournamentRoundsLoad(tId);
        activeTournAllScores = await tournamentAllScoresLoad(tId);
        activeTournRound     = activeTournRounds.find(r => r.id === gameState.tournamentRoundId) ?? null;
        if (activeTournament?.tournament_type === 'team') {
          activeTournTeams = await tournamentTeamsLoad(tId);
        }
      } catch (e) { console.error('resumeRound: failed to reload tournament globals', e); }
    }
    subscribeToRound(id);
    enterGameScreen();
  } catch (err) { console.error('resumeRound error', err); }
}

// ================================================================
// GAME SCREEN
// ================================================================
function enterGameScreen() {
  showScreen('screen-game');
  renderGameTopBar();
  renderScoreHeader();
  renderHolePanel();
  document.getElementById('scorecard-overlay')?.classList.remove('open');
  subscribeChallenges();
}

function renderGameTopBar() {
  document.getElementById('game-course-name').textContent = gameState.courseName ?? '';
  document.getElementById('game-sub').textContent =
    `${gameState.teeName ?? ''} Tees · ${fmtLabel(gameState.format)}`;
  const mini = document.getElementById('game-logo-mini');
  if (mini) mini.innerHTML = PENCIL_SVG_MINI;
}

// ----------------------------------------------------------------
// SCORE HEADER
// ----------------------------------------------------------------
function renderScoreHeader() {
  ['game-totals-bar','game-match-bar','game-skins-bar','game-itc-bar'].forEach(id => {
    document.getElementById(id)?.classList.add('hidden');
  });

  const fmt = gameState.format;

  if (['stableford','stroke','split6','best2'].includes(fmt)) {
    renderTotalsBar();
  } else if (['match','betterball','csm','foursomes','greensomes'].includes(fmt)) {
    renderMatchBar();
  } else if (fmt === 'skins') {
    renderSkinsBar();
  } else if (fmt === 'itc') {
    renderITCBar();
  }

  // Pot banner
  const potBanner = document.getElementById('game-pot-banner');
  if (fmt === 'skins' && (gameState.pot ?? 1) > 1) {
    document.getElementById('game-pot-text').textContent = `🏆 ${gameState.pot} SKINS AT STAKE`;
    potBanner.classList.add('show');
  } else {
    potBanner.classList.remove('show');
  }
}

function renderTotalsBar() {
  const bar  = document.getElementById('game-totals-bar');
  const fmt  = gameState.format;
  const n    = gameState.names.length;

  // Best 2 — show single team score prominently
  if (fmt === 'best2') {
    const groupTotal = gameState.groupTotal ?? 0;
    const holesPlayed = gameState.log?.length ?? 0;
    bar.style.gridTemplateColumns = '1fr';
    bar.innerHTML = `
      <div class="total-cell" style="grid-column:1/-1;">
        <div class="tc-name" style="font-size:0.7rem;letter-spacing:0.12em;">TEAM TOTAL</div>
        <div style="display:flex;align-items:baseline;justify-content:center;gap:4px;">
          <div class="tc-pts" style="color:var(--gold);font-size:3rem;">${groupTotal}</div>
          <span style="font-size:1rem;font-weight:600;color:var(--gold);">pts</span>
        </div>
        <div style="font-size:0.72rem;color:var(--muted);margin-top:2px;">${holesPlayed} hole${holesPlayed!==1?'s':''} played · best 2 scores</div>
      </div>`;
    bar.classList.remove('hidden');
    // Hide group banner — score is already shown above
    const groupBanner = document.getElementById('game-group-total-banner');
    if (groupBanner) groupBanner.classList.add('hidden');
    return;
  }

  bar.style.gridTemplateColumns = `repeat(${Math.min(n, 4)}, 1fr)`;

  bar.innerHTML = gameState.names.map((nm, i) => {
    const score = fmt === 'split6'
      ? (gameState.runningPts?.[i] ?? 0)
      : (gameState.totals?.[i] ?? 0);
    const label = fmt === 'stroke' ? 'shots' : 'pts';

    let rawLabel = '';
    if (fmt === 'split6' && gameState.log?.length > 0) {
      const rawTotal = gameState.log.reduce((sum, e) => sum + (e.holePts?.[i] ?? 0), 0);
      rawLabel = `<div style="font-family:'Barlow Condensed',sans-serif;font-size:1.1rem;font-weight:700;color:${pCol(i)};margin-top:1px;">(${rawTotal})</div>`;
    }

    return `
      <div class="total-cell">
        <div class="tc-name">
          <span class="dot" style="background:${pHex(i)};"></span>
          ${nm.split(' ')[0].toUpperCase()}
        </div>
        <div style="display:flex;align-items:baseline;justify-content:center;gap:2px;">
          <div class="tc-pts" style="color:${pCol(i)};">${score}</div>
          <span style="font-size:0.9rem;font-weight:600;color:${pCol(i)};margin-left:3px;vertical-align:middle;">${label}</span>
        </div>
        ${rawLabel}
      </div>`;
  }).join('');

  bar.classList.remove('hidden');

  // Hide group banner for non-best2 formats
  const groupBanner = document.getElementById('game-group-total-banner');
  if (groupBanner) groupBanner.classList.add('hidden');
}

function renderMatchBar() {
  const bar = document.getElementById('game-match-bar');
  const fmt = gameState.format;
  const ms  = gameState.matchScore ?? 0;
  const played   = gameState.log?.length ?? 0;
  const total    = gameState.numHoles ?? 18;
  const holesLeft = total - played;

  const isPairs = ['betterball','csm','foursomes','greensomes'].includes(fmt);
  const nameA = isPairs
    ? `${gameState.names[0].split(' ')[0]} & ${gameState.names[1].split(' ')[0]}`
    : gameState.names[0].split(' ')[0];
  const nameB = isPairs
    ? `${(gameState.names[2]??'').split(' ')[0]} & ${(gameState.names[3]??'').split(' ')[0]}`
    : (gameState.names[1]??'').split(' ')[0];

  document.getElementById('mb-names-a').textContent = nameA;
  document.getElementById('mb-names-b').textContent = nameB;

  const up = Math.abs(ms);
  document.getElementById('mb-score-a').textContent = ms > 0 ? up : '';
  document.getElementById('mb-score-b').textContent = ms < 0 ? up : '';

  const statusEl = document.getElementById('mb-status');
  if (ms === 0) {
    statusEl.textContent = 'ALL SQ';
    statusEl.className   = 'mb-status all-sq';
  } else {
    const ldr = ms > 0 ? nameA : nameB;
    statusEl.textContent = up > holesLeft ? `${up}&${holesLeft}` : `${up} UP`;
    statusEl.className   = `mb-status ${ms > 0 ? 'lead-a' : 'lead-b'}`;
  }
  document.getElementById('mb-holes-left').textContent = `${holesLeft} to play`;
  bar.classList.remove('hidden');
}

function renderSkinsBar() {
  const bar = document.getElementById('game-skins-bar');
  bar.innerHTML = gameState.names.map((nm, i) => `
    <div class="skins-cell">
      <div class="sk-name" style="color:${pCol(i)};">${nm.split(' ')[0].toUpperCase()}</div>
      <div class="sk-pts" style="color:${pCol(i)};">${gameState.skins?.[i] ?? 0}</div>
      <div class="sk-label">skin${(gameState.skins?.[i] ?? 0) !== 1 ? 's' : ''}</div>
    </div>`).join('');
  bar.classList.remove('hidden');
}

function renderITCBar() {
  const bar = document.getElementById('game-itc-bar');
  bar.innerHTML = gameState.names.map((nm, i) => {
    const inChair = gameState.chair === i;
    return `
      <div class="itc-cell${inChair ? ' in-chair' : ''}">
        <div class="itc-pname" style="color:${pCol(i)};">${nm.split(' ')[0].toUpperCase()}</div>
        <div class="itc-pts" style="color:${pCol(i)};">${gameState.pts?.[i] ?? 0}</div>
        ${inChair ? `<div class="itc-chair-badge">🪑 Chair</div>` : ''}
      </div>`;
  }).join('');
  bar.classList.remove('hidden');
}

// ----------------------------------------------------------------
// HOLE PANEL
// ----------------------------------------------------------------
function renderHolePanel() {
  const h     = gameState.hole;
  const total = gameState.numHoles ?? 18;

  if (h >= total) { showEndRound(); return; }

  const si     = gameState.si[h];
  const par    = gameState.par[h];
  const dispH  = h + 1 + (gameState.holeOffset ?? 0);
  const fmt    = gameState.format;

  document.getElementById('game-hole-num').textContent = dispH;
  document.getElementById('game-hole-si').innerHTML =
    `<span class="si-big">SI ${si} · Par ${par}</span>`;

  const backBtn = document.getElementById('btn-back-hole');
  if (backBtn) backBtn.disabled = (gameState.log?.length ?? 0) === 0;

  // scorerProfileId === undefined  → legacy round, fall back to organiser check
  // scorerProfileId === null        → guest scorer, no logged-in user gets scorer UI  
  // scorerProfileId === '__unclaimed__' → nobody claimed yet, show "Become Scorer" button
  // scorerProfileId === string      → only that profile gets scorer UI
  const scorerPid    = gameState?.scorerProfileId;
  const userIsScorer = scorerPid === undefined
    ? (!gameState?.organiserId || gameState.organiserId === currentUser?.id)
    : (scorerPid !== '__unclaimed__' && scorerPid !== null && scorerPid === currentUser?.id);

  const inputsEl = document.getElementById('game-inputs');
  inputsEl.innerHTML = '';

  const recordBtn  = document.getElementById('btn-record-hole');
  const backHoleBtn = document.getElementById('btn-back-hole');

  if (!userIsScorer) {
    const isUnclaimed = scorerPid === '__unclaimed__' || !scorerPid;
    const iClaimed    = false; // current user is watcher

    inputsEl.innerHTML = `
      <div style="text-align:center;padding:1.5rem 1rem 1rem;">
        <div style="font-size:2rem;margin-bottom:0.4rem;">👁</div>
        <div style="font-size:0.9rem;font-weight:600;color:var(--text);margin-bottom:0.75rem;">Watching</div>
        <div id="btn-scorer-claim-wrap">
          ${isUnclaimed
            ? `<button id="btn-claim-scorer" class="btn btn-outline"
                style="width:100%;font-size:0.9rem;padding:0.65rem;border-color:var(--green);color:var(--green);">
                ✏️ I am the scorer
              </button>`
            : `<button class="btn btn-outline" disabled
                style="width:100%;font-size:0.85rem;padding:0.6rem;opacity:0.4;cursor:not-allowed;">
                ✏️ Scorer already claimed
              </button>`
          }
        </div>
      </div>`;

    document.getElementById('btn-claim-scorer')?.addEventListener('click', async () => {
      gameState.scorerProfileId = currentUser.id;
      if (gameState.allGroupStates?.length > 1) {
        const idx = gameState.allGroupStates.findIndex(s => s.groupNumber === gameState.groupNumber);
        if (idx >= 0) gameState.allGroupStates[idx].scorerProfileId = currentUser.id;
      }
      await saveRoundState();
      renderHolePanel(); // re-render into scorer mode
    });

    if (recordBtn)   recordBtn.style.display   = 'none';
    if (backHoleBtn) backHoleBtn.style.display  = 'none';
    toggle('btn-finish-early', false);
    return;
  }

  // ── Scorer mode — show Pass scoring button ───────────────────────
  // Restore buttons
  if (recordBtn)   recordBtn.style.display   = '';
  if (backHoleBtn) backHoleBtn.style.display  = '';

  // Add Pass scoring button below inputs (injected after makePlayerInputRow calls)
  // We'll add it at the end after inputs are rendered

  const isFoursome = fmt === 'foursomes' || fmt === 'greensomes';
  const isPairs    = ['betterball','csm','foursomes','greensomes'].includes(fmt);

  if (isFoursome) {
    [['A', 0, 1], ['B', 2, 3]].forEach(([label, p0, p1]) => {
      const pairName = `${gameState.names[p0]} & ${gameState.names[p1]}`;
      const row = document.createElement('div');
      row.className = 'gi-row';
      row.innerHTML = `
        <div>
          <div class="gi-name">
            <span class="dot" style="background:${pHex(p0)};"></span>
            Pair ${label}: ${pairName}
          </div>
          <div class="gi-hcp">Match HCP ${gameState.matchHandicaps?.[p0] ?? 0} & ${gameState.matchHandicaps?.[p1] ?? 0}</div>
        </div>
        <div class="counter">
          <button class="c-btn" data-pair="${label}" data-dir="-1">−</button>
          <div class="c-val" id="cv-pair-${label}">${par}</div>
          <button class="c-btn" data-pair="${label}" data-dir="1">＋</button>
        </div>`;
      inputsEl.appendChild(row);
      row.querySelectorAll('.c-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const valEl = document.getElementById(`cv-pair-${label}`);
          let v = parseInt(valEl.textContent) + parseInt(btn.dataset.dir);
          valEl.textContent = Math.max(1, Math.min(15, v));
        });
      });
    });
  } else if (isPairs) {
    // Better ball / CSM -- show pair groupings
    [[[0,1],'A','psl-a'], [[2,3],'B','psl-b']].forEach(([pis, label, cls]) => {
      const pairHeader = document.createElement('div');
      pairHeader.className = 'pair-section';
      pairHeader.innerHTML = `<span class="pair-section-label ${cls}">▲ Pair ${label}</span>`;
      inputsEl.appendChild(pairHeader);
      pis.forEach(pi => {
        if (!gameState.names[pi]) return;
        inputsEl.appendChild(makePlayerInputRow(pi, h, par));
      });
    });
  } else {
    gameState.names.forEach((_, pi) => {
      inputsEl.appendChild(makePlayerInputRow(pi, h, par));
    });
  }

  toggle('btn-finish-early', (gameState.log?.length ?? 0) > 0);

  // Add Pass scoring button for scorer so they can hand off
  const passWrap = document.createElement('div');
  passWrap.style.cssText = 'margin-top:0.75rem;text-align:center;';
  passWrap.innerHTML = `<button id="btn-pass-scoring" class="btn btn-ghost"
    style="font-size:0.75rem;color:var(--muted);padding:0.3rem 0.75rem;border:1px solid var(--border);border-radius:6px;">
    ↩ Pass scoring to another player
  </button>`;
  inputsEl.appendChild(passWrap);

  document.getElementById('btn-pass-scoring')?.addEventListener('click', async () => {
    gameState.scorerProfileId = '__unclaimed__';
    if (gameState.allGroupStates?.length > 1) {
      const idx = gameState.allGroupStates.findIndex(s => s.groupNumber === gameState.groupNumber);
      if (idx >= 0) gameState.allGroupStates[idx].scorerProfileId = '__unclaimed__';
    }
    await saveRoundState();
    renderHolePanel(); // re-render into watcher mode
  });
}

function makePlayerInputRow(pi, h, par) {
  const fmt     = gameState.format;
  const isIndiv = ['stableford','stroke'].includes(fmt);
  const extra   = isIndiv
    ? indivStrokesOnHole(gameState.playingHandicaps[pi], gameState.si[h])
    : strokesOnHole(gameState.matchHandicaps[pi], gameState.si[h]);
  const badge   = extra > 0 ? `<span class="stroke-badge">+${extra}</span>` : '';
  const hcpLine = isIndiv
    ? `Playing HCP ${gameState.playingHandicaps[pi]}`
    : `Match HCP ${gameState.matchHandicaps[pi]}`;
  const inChair = fmt === 'itc' && gameState.chair === pi;

  // Look up previous hole score for this player if available
  const prevEntry = gameState.log?.length > 0 ? gameState.log[gameState.log.length - 1] : null;
  const prevGross = prevEntry?.grosses?.[pi];
  const prevPts   = prevEntry?.holePts?.[pi];
  const prevNet   = prevEntry?.nets?.[pi];
  let prevLabel = '';
  if (prevEntry && prevGross != null) {
    const prevH = prevEntry.h1 ?? (gameState.log.length);
    if (fmt === 'stableford' && prevPts != null) prevLabel = `H${prevH}: ${prevGross} gross · ${prevPts}pts`;
    else if (fmt === 'stroke' && prevNet != null) prevLabel = `H${prevH}: ${prevGross} gross · ${prevNet} net`;
    else if (fmt === 'split6' && prevEntry.holePts?.[pi] != null) prevLabel = `H${prevH}: ${prevGross} gross · ${prevEntry.holePts[pi]}pts`;
    else prevLabel = `H${prevH}: ${prevGross}`;
  }

  const row = document.createElement('div');
  row.className = `gi-row${inChair ? ' in-chair' : ''}`;
  row.innerHTML = `
    <div style="flex:1;">
      <div class="gi-name">
        <span class="dot" style="background:${pHex(pi)};"></span>
        ${gameState.names[pi]} ${badge}
        ${inChair ? '<span style="font-size:1rem;margin-left:4px;">🪑</span>' : ''}
      </div>
      <div class="gi-hcp">${hcpLine}</div>
      <div class="gi-prev" id="gi-prev-${pi}" style="font-size:0.58rem;color:var(--muted);min-height:1em;margin-top:2px;letter-spacing:0.03em;">${prevLabel}</div>
    </div>
    <div>
      <div class="counter">
        <button class="c-btn" data-pi="${pi}" data-dir="-1">−</button>
        <div class="c-val" id="cv${pi}">${par}</div>
        <button class="c-btn" data-pi="${pi}" data-dir="1">＋</button>
      </div>
    </div>`;

  row.querySelectorAll('.c-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const valEl = document.getElementById(`cv${pi}`);
      let v = parseInt(valEl.textContent) + parseInt(btn.dataset.dir);
      valEl.textContent = Math.max(1, Math.min(15, v));
    });
  });
  return row;
}

// ----------------------------------------------------------------
// RECORD HOLE
// ----------------------------------------------------------------
document.getElementById('btn-record-hole')?.addEventListener('click', () => recordHole());

function recordHole() {
  const fmt = gameState.format;
  const h   = gameState.hole;
  const par = gameState.par[h];
  let grosses = [];

  const isFoursome = fmt === 'foursomes' || fmt === 'greensomes';
  if (isFoursome) {
    const vA = parseInt(document.getElementById('cv-pair-A')?.textContent, 10);
    const vB = parseInt(document.getElementById('cv-pair-B')?.textContent, 10);
    if (!vA || !vB) { alert('Please enter scores for both pairs.'); return; }
    grosses = [vA, vB];
  } else {
    for (let i = 0; i < gameState.names.length; i++) {
      const v = parseInt(document.getElementById(`cv${i}`)?.textContent, 10);
      if (!v || v < 1) { alert(`Please enter a score for ${gameState.names[i]}.`); return; }
      grosses.push(v);
    }
  }

  const prevGroupStates = gameState.allGroupStates;
  gameState = processHole(gameState, grosses);
  if (prevGroupStates) {
    gameState.allGroupStates = prevGroupStates;
    gameState.allGroupStates[0] = gameState;
  }
  flashHoleResult(h);

  const matchFmts = ['match','betterball','csm','foursomes','greensomes'];
  if (matchFmts.includes(fmt)) {
    const played = gameState.log.length;
    const total  = gameState.numHoles ?? 18;
    if (matchPlayIsOver(gameState.matchScore, played, total) && !gameState.matchDecided) {
      gameState.matchDecided = true;
      showMatchWonModal();
      saveRoundState();
      return;
    }
  }

  saveRoundState();
  if (gameState.hole >= (gameState.numHoles ?? 18)) { showEndRound(); return; }
  renderScoreHeader();
  renderHolePanel();
}

document.getElementById('btn-back-hole')?.addEventListener('click', () => {
  if ((gameState.log?.length ?? 0) === 0) return;
  const prevGS = gameState.allGroupStates;
  gameState = undoHole(gameState);
  if (prevGS) gameState.allGroupStates = prevGS;
  renderScoreHeader(); renderHolePanel(); saveRoundState();
});

document.getElementById('btn-finish-early')?.addEventListener('click', () => showEndRound());
document.getElementById('btn-game-abandon')?.addEventListener('click', () => { abandonSource = 'game'; document.getElementById('modal-abandon').classList.add('open'); });

document.getElementById('btn-game-leaderboard')?.addEventListener('click', () => showLeaderboard());
document.getElementById('leaderboard-back')   ?.addEventListener('click', () => showScreen('screen-game'));

let leaderboardChannel = null;

function showLeaderboard() {
  showScreen('screen-leaderboard');
  renderLeaderboard();
  // Subscribe to all group states for live updates
  if (leaderboardChannel) realtimeUnsubscribe(leaderboardChannel);
  leaderboardChannel = realtimeSubscribeRound(roundId, remote => {
    if (remote?.game_state) {
      // Merge updated group state
      const gi = (remote.game_state.groupNumber ?? 1) - 1;
      if (gameState.allGroupStates) {
        gameState.allGroupStates[gi] = remote.game_state;
      }
      renderLeaderboard();
    }
  });
}

function renderLeaderboard() {
  const fmt     = gameState.format;
  const states  = gameState.allGroupStates ?? [gameState];
  const metaEl  = document.getElementById('leaderboard-meta');
  const tableEl = document.getElementById('leaderboard-table');

  metaEl.textContent = `${gameState.courseName} · ${gameState.teeName} Tees · ${fmtLabel(fmt)}`;

  const rows = buildMultiGroupLeaderboard(states);
  if (!rows.length) {
    tableEl.innerHTML = '<div class="history-empty">No scores recorded yet.</div>';
    return;
  }

  const isStableford = fmt === 'stableford';
  const isStroke     = fmt === 'stroke';

  let html = `<table class="sc-table" style="width:100%;">
    <thead><tr>
      <th style="text-align:left;">Player</th>
      <th>Grp</th>
      <th>Holes</th>
      <th>Gross</th>
      ${isStroke     ? '<th>Net</th>' : ''}
      ${isStableford ? '<th style="color:var(--gold);">Pts</th>' : ''}
      <th>HCP</th>
    </tr></thead><tbody>`;

  rows.forEach((row, rank) => {
    const isLead = rank === 0;
    html += `<tr${isLead ? ' style="background:rgba(212,168,67,0.06);"' : ''}>
      <td style="font-weight:${isLead?'700':'500'};color:${isLead?'var(--gold)':''};text-align:left;">
        ${rank + 1}. ${row.name}
      </td>
      <td>${row.group}</td>
      <td>${row.holesPlayed}</td>
      <td>${row.gross || '--'}</td>
      ${isStroke     ? `<td style="color:var(--green);font-weight:600;">${row.net ?? '--'}</td>` : ''}
      ${isStableford ? `<td style="color:var(--gold);font-weight:700;">${row.pts ?? '--'}</td>` : ''}
      <td style="color:var(--muted);font-size:0.75rem;">${row.hcp}</td>
    </tr>`;
  });

  html += '</tbody></table>';
  tableEl.innerHTML = html;
}

document.getElementById('btn-game-scorecard')?.addEventListener('click', () => {
  renderScorecardOverlay();
  document.getElementById('scorecard-overlay')?.classList.add('open');
});
document.getElementById('btn-close-scorecard')?.addEventListener('click', () => {
  document.getElementById('scorecard-overlay')?.classList.remove('open');
});

// ----------------------------------------------------------------
// RESULT FLASH
// ----------------------------------------------------------------
function flashHoleResult(holeIdx) {
  const entry = gameState.log[holeIdx]; if (!entry) return;
  const fmt   = gameState.format;
  let msg = '', bg = 'rgba(76,175,118,0.07)', border = 'rgba(76,175,118,0.2)';

  if (fmt === 'stableford') {
    const pts = entry.holePts;
    if (pts) {
      msg = pts.map((p, i) =>
        `<span style="color:${pHex(i)};font-weight:600;">${gameState.names[i].split(' ')[0]}: ${p}pt</span>`
      ).join('  ·  ');
    }
  } else if (fmt === 'stroke') {
    const nets = entry.nets;
    if (nets) msg = nets.map((n, i) =>
      `<span style="color:${pHex(i)};font-weight:600;">${gameState.names[i].split(' ')[0]}: ${n}</span>`
    ).join('  ·  ');
  } else if (['match','betterball','csm','foursomes','greensomes'].includes(fmt)) {
    const ms = gameState.matchScore ?? 0;
    if (ms === 0) { msg = `<span style="color:var(--green);font-weight:600;">Hole halved -- All Square</span>`; }
    else {
      const up    = Math.abs(ms);
      const ldrName = ms > 0
        ? (['betterball','csm','foursomes','greensomes'].includes(fmt)
            ? `${gameState.names[0].split(' ')[0]} & ${gameState.names[1].split(' ')[0]}`
            : gameState.names[0].split(' ')[0])
        : (['betterball','csm','foursomes','greensomes'].includes(fmt)
            ? `${(gameState.names[2]??'').split(' ')[0]} & ${(gameState.names[3]??'').split(' ')[0]}`
            : (gameState.names[1]??'').split(' ')[0]);
      const col = ms > 0 ? pHex(0) : pHex(1);
      msg = `<span style="color:${col};font-weight:600;">${ldrName} wins</span><span style="font-size:0.68rem;color:var(--muted);display:block;margin-top:2px;">${up} UP · ${(gameState.numHoles ?? 18) - gameState.log.length} to play</span>`;
      bg = ms > 0 ? 'rgba(212,168,67,0.07)' : 'rgba(91,163,217,0.07)';
      border = ms > 0 ? 'rgba(212,168,67,0.25)' : 'rgba(91,163,217,0.25)';
    }
  } else if (fmt === 'skins') {
    if (entry.winner === -1) {
      msg = `<span style="color:var(--green);font-weight:600;">Halved -- skins carry</span><span style="font-size:0.68rem;color:var(--muted);display:block;margin-top:2px;">Next hole worth <b style="color:var(--gold)">${gameState.pot}</b> skins</span>`;
    } else {
      const w = entry.winner;
      msg = `<span style="color:${pHex(w)};font-weight:600;">${gameState.names[w]} wins ${entry.potWon} skin${entry.potWon !== 1 ? 's' : ''}! 🏆</span>`;
      bg = 'rgba(212,168,67,0.07)'; border = 'rgba(212,168,67,0.25)';
    }
  } else if (fmt === 'itc') {
    if (entry.pointScoredBy !== null) {
      msg = `<span style="color:${pHex(entry.pointScoredBy)};font-weight:600;">${gameState.names[entry.pointScoredBy]} scores! 🪑 +1</span><span style="font-size:0.68rem;color:var(--muted);display:block;margin-top:2px;">Defended the chair</span>`;
      bg = 'rgba(212,168,67,0.07)'; border = 'rgba(212,168,67,0.25)';
    } else if (entry.newChair !== null) {
      msg = `<span style="color:${pHex(entry.newChair)};font-weight:600;">${gameState.names[entry.newChair]} takes the chair 🪑</span><span style="font-size:0.68rem;color:var(--muted);display:block;margin-top:2px;">Win again to score</span>`;
      bg = 'rgba(91,163,217,0.07)'; border = 'rgba(91,163,217,0.25)';
    } else {
      msg = `<span style="color:var(--green);font-weight:600;">Halved -- chair empty</span>`;
    }
  } else if (fmt === 'split6') {
    const pts = entry.holePts;
    if (pts) {
      const maxP = Math.max(...pts);
      msg = pts.map((p, i) =>
        `<span style="color:${pHex(i)};font-weight:${p === maxP ? '700' : '400'};">${gameState.names[i].split(' ')[0]}: ${p}</span>`
      ).join('  ·  ');
    }
  }

  const el = document.getElementById('result-flash');
  if (!el) return;
  el.innerHTML = msg || '&nbsp;';
  el.style.background = msg ? bg     : 'transparent';
  el.style.borderTop  = msg ? `1px solid ${border}` : 'none';
  el.style.color      = msg ? ''     : 'transparent';
}
// ----------------------------------------------------------------
function renderScorecardOverlay() {
  document.getElementById('sc-overlay-title').textContent =
    `${gameState.courseName} -- ${gameState.teeName}`;
  document.getElementById('sc-overlay-sub').textContent =
    `${fmtLabel(gameState.format)} · ${gameState.log?.length ?? 0} holes played`;
  const scorerPid = gameState?.scorerProfileId;
  const isScorer  = scorerPid === undefined
    ? (!gameState?.organiserId || gameState.organiserId === currentUser?.id)
    : (scorerPid !== '__unclaimed__' && scorerPid !== null && scorerPid === currentUser?.id);

  // Merge all group states for a full-round view
  const allStates = gameState.allGroupStates ?? [gameState];
  const displayState = mergeGroupStates(allStates);

  document.getElementById('sc-overlay-body').innerHTML = buildLandscapeScorecard(displayState, {
    showEdit:      isScorer,
    showChallenge: !isScorer,
  });
  if (!isScorer) attachChallengeBtnListeners();
}

// ----------------------------------------------------------------
// MATCH WON MODAL
// ----------------------------------------------------------------
function showMatchWonModal() {
  const ms   = gameState.matchScore ?? 0;
  const up   = Math.abs(ms);
  const left = (gameState.numHoles ?? 18) - gameState.log.length;
  const fmt  = gameState.format;
  const isPairs = ['betterball','csm','foursomes','greensomes'].includes(fmt);
  const winner = ms > 0
    ? (isPairs ? `${gameState.names[0]} & ${gameState.names[1]}` : gameState.names[0])
    : (isPairs ? `${gameState.names[2]} & ${gameState.names[3]}` : gameState.names[1]);
  document.getElementById('mw-winner').textContent = winner;
  document.getElementById('mw-score').textContent  = `${up}&${left}`;
  show('modal-match-won');
}

document.getElementById('mw-keep-playing')?.addEventListener('click', () => {
  hide('modal-match-won'); renderScoreHeader(); renderHolePanel();
});
document.getElementById('mw-end-match')?.addEventListener('click', () => {
  hide('modal-match-won'); showEndRound();
});

// ----------------------------------------------------------------
// SAVE / REALTIME
// ----------------------------------------------------------------
async function saveRoundState() {
  if (!roundId || !gameState) return;
  const badge = document.getElementById('game-sync-badge');
  badge?.classList.remove('hidden');
  try {
    const { allGroupStates, ...stateToSave } = gameState;
    // Persist allGroupStates (stripped of their own nested references) so
    // resumeRound can find the correct group state for each user
    if (allGroupStates?.length > 1) {
      stateToSave.allGroupStates = allGroupStates.map(gs => {
        const { allGroupStates: _, ...stripped } = gs;
        return stripped;
      });
    }
    await roundSaveState(roundId, stateToSave, stateToSave.names);
    await realtimeBroadcastRound(realtimeCh, stateToSave);
  }
  catch (err) { console.error('saveRoundState error', err); }
  finally { badge?.classList.add('hidden'); }
}

function subscribeToRound(id) {
  try { localStorage.setItem('lb-active-round', id); } catch {}
  realtimeUnsubscribe(realtimeCh);
  realtimeCh = realtimeSubscribeRound(id, remote => {
    if (!remote?.game_state) return;
    const incoming = remote.game_state;

    // Don't process our own broadcasts
    if (incoming.organiserId === currentUser?.id &&
        incoming.groupNumber === gameState?.groupNumber) return;

    const scorerPid = gameState?.scorerProfileId;
    const iAmScorer = scorerPid === undefined
      ? (!gameState?.organiserId || gameState.organiserId === currentUser?.id)
      : (scorerPid !== '__unclaimed__' && scorerPid !== null && scorerPid === currentUser?.id);

    screenLog('recv g:' + incoming.groupNumber + ' mine:' + gameState?.groupNumber + ' scorer:' + iAmScorer);

    // Always update other groups in allGroupStates (scorers need this for the scorecard)
    if (gameState?.allGroupStates?.length > 1 && incoming.groupNumber &&
        incoming.groupNumber !== gameState.groupNumber) {
      const idx = gameState.allGroupStates.findIndex(s => s.groupNumber === incoming.groupNumber);
      if (idx >= 0) gameState.allGroupStates[idx] = { ...incoming, allGroupStates: undefined };
    }

    // Scorers don't replace their own gameState
    if (iAmScorer) return;

    // Watchers/other-group scorers update gameState for their own group updates
    if (gameState?.allGroupStates?.length > 1) {
      if (incoming.groupNumber === gameState.groupNumber) {
        // Update to latest version of our group, preserving allGroupStates
        gameState = { ...incoming, allGroupStates: gameState.allGroupStates };
      }
      // Other group updates already handled above — just re-render
    } else {
      // Single group — replace entirely, preserving allGroupStates if we have it
      const saved = gameState?.allGroupStates;
      gameState = incoming;
      if (saved?.length > 1 && !gameState.allGroupStates) gameState.allGroupStates = saved;
    }

    renderScoreHeader();
    renderHolePanel();
  });
}

// screenLog defined above

function subscribeToFriendRequests() {
  realtimeSubscribeFriendRequests(currentUser.id, async () => {
    const pending = await friendRequestsLoadPending(currentUser.id);
    const badge   = document.getElementById('friend-req-badge');
    if (badge) {
      badge.textContent = pending.length;
      toggle('friend-req-badge', pending.length > 0);
    }
  });
}

let _pendingGameInvite = null;

let _gameInviteChannel = null;
let _gameInvitePollTimer = null;
let _lastInviteCheck = null;

function subscribeToGameInvites() {
  if (_gameInviteChannel) {
    try { _gameInviteChannel.unsubscribe(); } catch {}
  }

  _gameInviteChannel = realtimeSubscribeGameInvites(currentUser.id, async (row) => {
    console.log('[invite] realtime fired', row);
    try {
      const invite = await gameInviteLoad(row.id);
      if (!invite || invite.status === 'accepted') return;
      showGameInviteBanner(invite);
    } catch (e) { console.error('[invite] load error', e); }
  });

  // Log subscription status after 2s
  setTimeout(() => {
    const state = _gameInviteChannel?.state;
    console.log('[invite] channel state:', state);
    if (state !== 'joined' && state !== 'SUBSCRIBED') {
      console.warn('[invite] realtime not connected, starting poll fallback');
      startInvitePoll();
    }
  }, 2000);
}

async function startInvitePoll() {
  if (_gameInvitePollTimer) return;
  _lastInviteCheck = new Date().toISOString();
  _gameInvitePollTimer = setInterval(async () => {
    try {
      const rows = await gameInvitesPollPending(currentUser.id, _lastInviteCheck);
      if (rows.length) {
        _lastInviteCheck = new Date().toISOString();
        for (const row of rows) showGameInviteBanner(row);
      }
    } catch {}
  }, 5000);
}

function showGameInviteBanner(invite) {
  _pendingGameInvite = invite;
  const banner  = document.getElementById('game-invite-banner');
  const titleEl = document.getElementById('game-invite-banner-title');
  const subEl   = document.getElementById('game-invite-banner-sub');
  const isScorer = invite.is_scorer ?? false; // set per recipient when created
  titleEl.textContent = `${invite.name ?? 'Someone'} started a round`;
  subEl.textContent   = invite.group_number
    ? `Group ${invite.group_number} · Tap to join`
    : 'Tap to join';
  banner.style.display = '';
  setTimeout(() => { if (_pendingGameInvite?.id === invite.id) hideGameInviteBanner(); }, 60000);
}

function hideGameInviteBanner() {
  _pendingGameInvite = null;
  document.getElementById('game-invite-banner').style.display = 'none';
}

document.getElementById('btn-game-invite-dismiss')?.addEventListener('click', hideGameInviteBanner);

document.getElementById('btn-game-invite-join')?.addEventListener('click', async () => {
  const invite = _pendingGameInvite;
  if (!invite) return;
  hideGameInviteBanner();
  if (_gameInvitePollTimer) { clearInterval(_gameInvitePollTimer); _gameInvitePollTimer = null; }
  _joiningViaInvite = true;
  try {
    await smsInviteAccept(invite.id);
    if (invite.tournament_round_id && invite.group_number) {
      await joinTournamentRoundAsScorer(currentUser, invite.tournament_round_id, invite.group_number);
    } else if (invite.round_id) {
      // Always join as watcher — scorer is claimed via "I am the scorer" button
      await _joinRoundWithRole(invite.round_id, invite.group_number ?? 1, false);
    }
  } catch (err) { alert('Could not join: ' + err.message); }
  finally { _joiningViaInvite = false; }
});

async function _joinRoundWithRole(roundId, groupNumber, asScorer) {
  const round = await roundLoadById(roundId);
  if (!round) return;

  let gs = round.game_state;

  // Find this user's group state
  let myGroupState = null;
  if (gs?.allGroupStates?.length > 1) {
    myGroupState = gs.allGroupStates.find(s => s.groupNumber === groupNumber)
      ?? gs.allGroupStates[groupNumber - 1];
  } else {
    myGroupState = gs;
  }

  if (!myGroupState) return;

  // Check if scorer already claimed for this group
  const scorerAlreadyClaimed = myGroupState.scorerProfileId &&
    myGroupState.scorerProfileId !== '__unclaimed__';

  if (asScorer && scorerAlreadyClaimed && myGroupState.scorerProfileId !== currentUser.id) {
    // Someone else already claimed scorer — demote to watcher silently
    asScorer = false;
  }

  // Set scorerProfileId on this group's state and save to DB
  if (asScorer) {
    if (gs?.allGroupStates?.length > 1) {
      const idx = gs.allGroupStates.findIndex(s => s.groupNumber === groupNumber);
      if (idx >= 0) gs.allGroupStates[idx].scorerProfileId = currentUser.id;
    } else {
      gs.scorerProfileId = currentUser.id;
    }
    // Save the updated top-level state back to DB
    const { allGroupStates, ...topState } = gs;
    topState.allGroupStates = (allGroupStates ?? []).map(s => {
      const { allGroupStates: _, ...stripped } = s;
      return stripped;
    });
    await roundSaveState(roundId, topState, topState.names);
  }

  // Now resume into the correct group state
  window._roundId = roundId;
  await resumeRound(roundId);
}

// ----------------------------------------------------------------
// ABANDON
// ----------------------------------------------------------------
document.getElementById('abandon-cancel')?.addEventListener('click', () => document.getElementById('modal-abandon').classList.remove('open'));
document.getElementById('abandon-confirm')?.addEventListener('click', async () => {
  document.getElementById('modal-abandon').classList.remove('open');
  if (roundId) { try { await roundAbandon(roundId); } catch {} }
  realtimeUnsubscribe(realtimeCh); realtimeCh = null;
  roundId = null; gameState = null;
  try { localStorage.removeItem('lb-active-round'); } catch {}
  await showHome();
});

// ================================================================
// END ROUND SCREEN
// ================================================================
async function showEndRound() {
  // Fetch latest state from DB to ensure we have all groups' data
  if (roundId && gameState?.allGroupStates?.length > 1) {
    try {
      const latest = await roundLoadById(roundId);
      if (latest?.game_state?.allGroupStates?.length > 1) {
        gameState.allGroupStates = latest.game_state.allGroupStates;
      }
    } catch {}
  }

  showScreen('screen-end-round');

  // Merge all group states for full-round results
  const allStates   = gameState.allGroupStates?.length > 1
    ? gameState.allGroupStates : [gameState];
  const merged      = mergeGroupStates(allStates);
  const fmt         = merged.format;
  const summary     = getResultSummary(merged);

  document.getElementById('er-format').textContent = fmtLabel(fmt);
  document.getElementById('er-result').textContent = summary.winner ?? 'Completed';
  document.getElementById('er-sub').textContent    = `${merged.courseName} · ${merged.teeName} Tees · ${merged.log?.length ?? 0} holes`;

  // Podium
  const podiumEl = document.getElementById('er-podium');
  podiumEl.innerHTML = '';
  if (summary.scores?.length) {
    summary.scores.forEach((s, rank) => {
      const orig = merged.names.indexOf(s.nm);
      const col  = pHex(orig >= 0 ? orig : rank);
      const card = document.createElement('div');
      card.className = `podium-card rank-${rank + 1}`;
      card.innerHTML = `
        <div class="podium-rank">${rank + 1}</div>
        <div class="podium-info">
          <div class="podium-name">
            <span class="dot" style="background:${col};"></span>
            ${s.nm}
          </div>
          <div class="podium-detail">${fmt === 'stroke' ? 'net shots' : 'pts'}</div>
        </div>
        <div class="podium-score" style="color:${col};">${s.score}</div>`;
      podiumEl.appendChild(card);
    });
  } else if (summary.winner) {
    const card = document.createElement('div');
    card.className = 'result-card win-a';
    card.innerHTML = `
      <div class="rc-label">${fmtLabel(fmt)} Result</div>
      <div class="rc-winner" style="color:var(--gold);">${summary.winner}</div>
      <div class="rc-score">${summary.summary}</div>`;
    podiumEl.appendChild(card);
  }

  document.getElementById('er-scorecard').innerHTML = buildEndRoundScorecard(merged);
}

document.getElementById('btn-back-to-game')?.addEventListener('click', () => {
  showScreen('screen-game'); renderScoreHeader(); renderHolePanel();
});

document.getElementById('btn-confirm-end')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-confirm-end');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    // Save merged state so history shows all players across all groups
    const allStates = gameState.allGroupStates?.length > 1
      ? gameState.allGroupStates : [gameState];
    const merged = mergeGroupStates(allStates);
    // Keep allGroupStates in the completed record for future reference
    const { allGroupStates, ...baseState } = gameState;
    merged.allGroupStates = allStates.map(s => {
      const { allGroupStates: _, ...stripped } = s; return stripped;
    });
    await roundComplete(roundId, merged);
    // If this was a tournament round, save tournament scores too
    if (gameState.tournamentId) {
      await saveTournamentScores();
    }
    realtimeUnsubscribe(realtimeCh); realtimeCh = null;
    roundId = null;
    const wasTournament = !!gameState.tournamentId;
    const tournId = gameState.tournamentId;
    gameState = null;
    if (wasTournament) {
      await showTournamentRoundComplete(tournId);
    } else {
      await showHome();
    }
  } catch (err) {
    alert('Could not save round: ' + err.message);
    btn.disabled = false; btn.textContent = '✓ SAVE & FINISH';
  }
});

// ================================================================
// SCORECARD TABLE BUILDER
// ================================================================
// ----------------------------------------------------------------
// TEAM SCORECARD — groups players by team, shows team pts per hole
// Used for Best 2 of 3/4 formats
// ----------------------------------------------------------------
function buildTeamScorecard(state, { isFull18, log, par, si, holeOffset, numHoles }) {
  const names = state.names;
  const n     = names.length;

  // Per player data
  const playerData = names.map((name, pi) => {
    const grosses = log.map(e => e.grosses?.[pi] ?? null);
    const nets    = log.map((e, hi) => {
      const g = e.grosses?.[pi];
      if (g == null) return null;
      let extra = e.extras?.[pi];
      if (extra == null) {
        const hcp    = state.playingHandicaps?.[pi] ?? 0;
        const holeSI = state.si?.[hi] ?? 18;
        extra = hcp >= holeSI ? 1 : 0;
        if (hcp >= holeSI + 18) extra = 2;
      }
      return g - extra;
    });
    const pts = log.map(e => e.holePts?.[pi] ?? null);
    return { pi, name, grosses, nets, pts };
  });

  // Team points per hole (best 2 combined)
  const teamPtsPerHole = log.map(e => e.holeB2 ?? null);
  const teamTotal      = state.groupTotal ?? 0;
  const front9Team     = teamPtsPerHole.slice(0, 9).reduce((s, v) => s + (v ?? 0), 0);
  const back9Team      = teamPtsPerHole.slice(9).reduce((s, v)  => s + (v ?? 0), 0);

  const front9Par = par.slice(0, 9).reduce((s, v) => s + v, 0);
  const back9Par  = par.slice(9).reduce((s, v)   => s + v, 0);
  const totalPar  = par.reduce((s, v) => s + v, 0);

  // Build one section
  function buildTeamSection(holeStart, holeEnd, label) {
    const holes      = Array.from({ length: holeEnd - holeStart }, (_, i) => holeStart + i);
    const sectionPar = holes.reduce((s, i) => s + (par[i] ?? 0), 0);

    let t = `<table style="border-collapse:collapse;width:100%;font-size:0.75rem;">`;

    // Header row
    t += `<thead><tr>
      <td style="padding:0.35rem 0.5rem;font-size:0.68rem;color:var(--muted);font-weight:600;min-width:100px;">${label}</td>`;
    holes.forEach(i => {
      t += `<td style="text-align:center;padding:0.3rem 0.2rem;color:var(--muted);font-weight:700;font-size:0.68rem;min-width:26px;">${holeOffset + i + 1}</td>`;
    });
    t += `<td style="text-align:center;padding:0.3rem 0.4rem;color:var(--muted);font-weight:700;font-size:0.68rem;background:var(--surface);">Tot</td>
    </tr>`;

    // Par row
    t += `<tr style="border-bottom:1px solid var(--border);">
      <td style="padding:0.25rem 0.5rem;font-size:0.68rem;color:var(--muted);">Par</td>`;
    holes.forEach(i => {
      t += `<td style="text-align:center;padding:0.25rem 0.2rem;color:var(--muted);font-size:0.72rem;">${par[i] ?? ''}</td>`;
    });
    t += `<td style="text-align:center;padding:0.25rem 0.4rem;color:var(--muted);font-weight:600;background:var(--surface);">${sectionPar}</td>
    </tr></thead><tbody>`;

    // Team total row
    const sectionTeam = holes.reduce((s, i) => s + (teamPtsPerHole[i] ?? 0), 0);
    t += `<tr style="background:rgba(212,168,67,0.08);border-top:2px solid var(--gold);">
      <td style="padding:0.4rem 0.5rem;font-weight:700;color:var(--gold);font-size:0.78rem;">TEAM</td>`;
    holes.forEach(i => {
      const v = teamPtsPerHole[i];
      t += `<td style="text-align:center;padding:0.35rem 0.2rem;font-weight:700;color:var(--gold);font-size:0.82rem;">${v ?? ''}</td>`;
    });
    t += `<td style="text-align:center;padding:0.35rem 0.4rem;font-weight:700;color:var(--gold);font-size:0.88rem;background:var(--surface);">${sectionTeam || ''}</td>
    </tr>`;

    // Player rows
    const teamBgs = ['rgba(144,196,255,0.07)', 'rgba(144,255,144,0.07)', 'rgba(255,200,100,0.07)', 'rgba(200,144,255,0.07)'];
    playerData.forEach((p, idx) => {
      const bg = teamBgs[idx % teamBgs.length];

      // Shots row
      t += `<tr style="background:${bg};border-top:1px solid var(--border);">
        <td style="padding:0.3rem 0.5rem 0.1rem 0.5rem;font-weight:600;color:${pHex(p.pi)};font-size:0.78rem;white-space:nowrap;">
          ${p.name.split(' ')[0]}
        </td>`;
      holes.forEach(i => {
        const g = p.grosses[i] ?? null;
        const pv = par[i] ?? 0;
        const d  = g != null ? g - pv : null;
        const col = d == null ? '' : d < 0 ? 'var(--green)' : d > 1 ? 'var(--red)' : '';
        t += `<td style="text-align:center;padding:0.3rem 0.2rem;font-size:0.78rem;color:${col};font-weight:600;">${g ?? ''}</td>`;
      });
      const sectionGross = holes.reduce((s, i) => s + (p.grosses[i] ?? 0), 0);
      t += `<td style="text-align:center;padding:0.3rem 0.4rem;font-weight:700;background:var(--surface);font-size:0.75rem;">${sectionGross || ''}</td>
      </tr>`;

      // Points row
      t += `<tr style="background:${bg};">
        <td style="padding:0.1rem 0.5rem 0.3rem 1rem;font-size:0.62rem;color:var(--muted);">pts</td>`;
      holes.forEach(i => {
        const counted = log[i]?.counted ?? [];
        const isCountedPlayer = counted.includes(p.pi);
        const v = p.pts[i];
        t += `<td style="text-align:center;padding:0.1rem 0.2rem;font-size:0.72rem;
          color:${isCountedPlayer ? 'var(--gold)' : 'var(--muted)'};
          font-weight:${isCountedPlayer ? '700' : '400'};">${v ?? ''}</td>`;
      });
      const sectionPts = holes.reduce((s, i) => s + (p.pts[i] ?? 0), 0);
      t += `<td style="text-align:center;padding:0.1rem 0.4rem;font-size:0.72rem;color:var(--gold);font-weight:600;background:var(--surface);">${sectionPts || ''}</td>
      </tr>`;
    });

    t += '</tbody></table>';
    return t;
  }

  // Build summary
  function buildTeamSummary() {
    let t = `<table style="border-collapse:collapse;width:100%;font-size:0.82rem;margin-top:0.5rem;">
      <thead><tr>
        <td style="padding:0.4rem 0.5rem;font-size:0.7rem;color:var(--muted);font-weight:600;">Summary</td>
        ${isFull18 ? '<td style="text-align:center;color:var(--muted);font-size:0.7rem;padding:0.35rem 0.3rem;">Out</td><td style="text-align:center;color:var(--muted);font-size:0.7rem;padding:0.35rem 0.3rem;">In</td>' : ''}
        <td style="text-align:center;color:var(--gold);font-size:0.7rem;font-weight:700;padding:0.35rem 0.5rem;">Total</td>
      </tr></thead><tbody>`;

    // Team total row
    t += `<tr style="background:rgba(212,168,67,0.08);border-top:2px solid var(--gold);">
      <td style="padding:0.45rem 0.5rem;font-weight:700;color:var(--gold);">TEAM</td>
      ${isFull18 ? `<td style="text-align:center;font-weight:600;padding:0.4rem 0.3rem;">${front9Team}</td><td style="text-align:center;font-weight:600;padding:0.4rem 0.3rem;">${back9Team}</td>` : ''}
      <td style="text-align:center;font-weight:700;color:var(--gold);font-size:1rem;padding:0.4rem 0.5rem;">${teamTotal}</td>
    </tr>`;

    // Individual players
    playerData.forEach(p => {
      const ptsTotal = p.pts.reduce((s, v) => s + (v ?? 0), 0);
      const f9pts    = p.pts.slice(0, 9).reduce((s, v) => s + (v ?? 0), 0);
      const b9pts    = p.pts.slice(9).reduce((s, v) => s + (v ?? 0), 0);
      t += `<tr style="border-top:1px solid var(--border);">
        <td style="padding:0.4rem 0.5rem;font-weight:600;color:${pHex(p.pi)};font-size:0.78rem;">${p.name.split(' ')[0]}</td>
        ${isFull18 ? `<td style="text-align:center;color:var(--muted);padding:0.35rem 0.3rem;">${f9pts || ''}</td><td style="text-align:center;color:var(--muted);padding:0.35rem 0.3rem;">${b9pts || ''}</td>` : ''}
        <td style="text-align:center;color:var(--muted);padding:0.35rem 0.5rem;">${ptsTotal || ''}</td>
      </tr>`;
    });

    t += '</tbody></table>';
    return t;
  }

  const sections = isFull18
    ? [
        { id: 'sc-f9',  label: 'Front 9', html: buildTeamSection(0, 9,  'Front 9') },
        { id: 'sc-b9',  label: 'Back 9',  html: buildTeamSection(9, 18, 'Back 9')  },
        { id: 'sc-tot', label: 'Total',   html: buildTeamSummary() },
      ]
    : [
        { id: 'sc-all', label: '9 Holes', html: buildTeamSection(0, numHoles, '9 Holes') },
        { id: 'sc-tot', label: 'Total',   html: buildTeamSummary() },
      ];

  const tabs = sections.map((s, i) =>
    `<button class="sc-tab-btn ${i === 0 ? 'active' : ''}" data-target="${s.id}"
      style="flex:1;padding:0.6rem 0.4rem;font-size:0.82rem;font-weight:600;
             background:${i === 0 ? 'var(--surface)' : 'transparent'};
             border:none;border-bottom:2px solid ${i === 0 ? 'var(--gold)' : 'transparent'};
             color:${i === 0 ? 'var(--gold)' : 'var(--muted)'};cursor:pointer;">
      ${s.label}
    </button>`
  ).join('');

  const panels = sections.map((s, i) =>
    `<div id="${s.id}" class="sc-panel" style="display:${i === 0 ? 'block' : 'none'};
      overflow-x:auto;-webkit-overflow-scrolling:touch;touch-action:pan-x pan-y pinch-zoom;">
      ${s.html}
    </div>`
  ).join('');

  return `
    <div style="position:sticky;top:0;z-index:10;background:var(--bg);
                display:flex;border-bottom:1px solid var(--border);margin-bottom:0.5rem;">
      ${tabs}
    </div>
    ${panels}`;
}

// ----------------------------------------------------------------
// STANDARD SCORECARD — players as rows, holes as columns
// ----------------------------------------------------------------
// Merge multiple group states into one combined state for full-round scorecard display
function mergeGroupStates(states) {
  if (!states?.length) return null;
  if (states.length === 1) return states[0];
  screenLog('merge g0#' + states[0]?.groupNumber + '=' + states[0]?.names?.slice(0,2).join(','));
  screenLog('merge g1#' + states[1]?.groupNumber + '=' + states[1]?.names?.slice(0,2).join(','));
  const base = states[0];
  return {
    ...base,
    names:           states.flatMap(s => s.names ?? []),
    playingHandicaps:states.flatMap(s => s.playingHandicaps ?? []),
    matchHandicaps:  states.flatMap(s => s.matchHandicaps ?? []),
    totals:          states.flatMap(s => s.totals ?? []),
    log: base.log?.map((_, hi) => {
      // Merge each hole entry across groups
      const merged = { grosses: [], extras: [], holePts: [], pars: [] };
      states.forEach(s => {
        const entry = s.log?.[hi] ?? {};
        const n = (s.names ?? []).length;
        for (let pi = 0; pi < n; pi++) {
          merged.grosses.push(entry.grosses?.[pi] ?? null);
          merged.extras.push(entry.extras?.[pi] ?? null);
          merged.holePts.push(entry.holePts?.[pi] ?? null);
        }
      });
      return { ...base.log[hi], ...merged };
    }) ?? [],
  };
}

function buildLandscapeScorecard(state, opts = {}) {
  const fmt        = state.format;
  const names      = state.names;
  const log        = state.log ?? [];
  const par        = state.par ?? [];
  const si         = state.si  ?? [];
  const holeOffset = state.holeOffset ?? 0;
  const numHoles   = state.numHoles ?? 18;
  const isFull18   = numHoles === 18;

  const isStableford = fmt === 'stableford';
  const isStroke     = fmt === 'stroke';
  const isBest2      = fmt === 'best2';
  const showPts      = isStableford || isBest2;

  // For Best2 — use team layout
  if (isBest2) return buildTeamScorecard(state, { isFull18, log, par, si, holeOffset, numHoles });

  // Build per-player data
  const playerRows = names.map((name, pi) => {
    const grosses = log.map(e => e.grosses?.[pi] ?? null);
    const nets    = log.map((e, hi) => {
      const g = e.grosses?.[pi];
      if (g == null) return null;
      // Use stored extras if available, otherwise calculate from playing handicap + SI
      let extra = e.extras?.[pi];
      if (extra == null) {
        // Fallback: calculate strokes received using playing handicap and hole SI
        const hcp = state.playingHandicaps?.[pi] ?? 0;
        const holeSI = state.si?.[hi] ?? 18;
        extra = hcp >= holeSI ? 1 : 0;
        if (hcp >= holeSI + 18) extra = 2; // double shots
      }
      return g - extra;
    });
    const pts = log.map(e => e.holePts?.[pi] ?? null);

    const grossTotal  = grosses.reduce((s, v) => s + (v ?? 0), 0);
    const netTotal    = nets.reduce((s, v) => s + (v ?? 0), 0);
    const ptsTotal    = isStableford ? (state.totals?.[pi] ?? 0) : null;
    const front9Gross = grosses.slice(0, 9).reduce((s, v) => s + (v ?? 0), 0);
    const back9Gross  = grosses.slice(9).reduce((s, v)   => s + (v ?? 0), 0);
    const front9Net   = nets.slice(0, 9).reduce((s, v)   => s + (v ?? 0), 0);
    const back9Net    = nets.slice(9).reduce((s, v)      => s + (v ?? 0), 0);
    const front9Pts   = isStableford ? pts.slice(0, 9).reduce((s, v) => s + (v ?? 0), 0) : null;
    const back9Pts    = isStableford ? pts.slice(9).reduce((s, v)   => s + (v ?? 0), 0) : null;

    return {
      pi, name, grosses, nets, pts,
      grossTotal, netTotal, ptsTotal,
      front9Gross, back9Gross, front9Net, back9Net, front9Pts, back9Pts,
      score: isStroke ? netTotal : (isStableford ? ptsTotal : grossTotal),
    };
  });

  const sorted = [...playerRows].sort((a, b) =>
    isStroke ? a.netTotal - b.netTotal : b.score - a.score
  );

  const front9Par = par.slice(0, 9).reduce((s, v) => s + v, 0);
  const back9Par  = par.slice(9).reduce((s, v) => s + v, 0);
  const totalPar  = par.reduce((s, v) => s + v, 0);

  // Build one table per section (F9, B9, Total)
  function buildSection(holeStart, holeEnd, label) {
    const holes = Array.from({ length: holeEnd - holeStart }, (_, i) => holeStart + i);
    const sectionPar = holes.reduce((s, i) => s + (par[i] ?? 0), 0);

    let t = `<table style="border-collapse:collapse;width:100%;font-size:0.82rem;">`;

    // Hole numbers header
    t += `<thead><tr>
      <td style="padding:0.4rem 0.5rem;font-size:0.7rem;color:var(--muted);min-width:90px;font-weight:600;">${label}</td>`;
    holes.forEach(i => {
      t += `<td style="text-align:center;padding:0.35rem 0.2rem;font-weight:700;color:var(--muted);font-size:0.7rem;min-width:28px;">${holeOffset + i + 1}</td>`;
    });
    t += `<td style="text-align:center;padding:0.35rem 0.5rem;font-weight:700;color:var(--muted);font-size:0.7rem;background:var(--surface);">Tot</td>`;
    t += '</tr>';

    // Par row
    t += `<tr style="border-bottom:1px solid var(--border);">
      <td style="padding:0.3rem 0.5rem;font-size:0.7rem;color:var(--muted);">Par</td>`;
    holes.forEach(i => {
      t += `<td style="text-align:center;padding:0.3rem 0.2rem;color:var(--muted);font-size:0.78rem;">${par[i] ?? ''}</td>`;
    });
    t += `<td style="text-align:center;padding:0.3rem 0.5rem;color:var(--muted);font-weight:600;background:var(--surface);">${sectionPar}</td>`;
    t += '</tr></thead><tbody>';

    // Player rows
    sorted.forEach((row, rank) => {
      const isLead = rank === 0 && log.length > 0;
      const bg = isLead ? 'rgba(212,168,67,0.07)' : '';
      const nameCol = pHex(row.pi);

      // Gross row
      t += `<tr style="background:${bg};border-top:1px solid var(--border);">
        <td style="padding:0.45rem 0.5rem;font-weight:700;color:${nameCol};font-size:0.82rem;white-space:nowrap;">
          ${rank + 1}. ${row.name.split(' ')[0]}
        </td>`;
      holes.forEach(i => {
        const g = row.grosses[i] ?? null;
        const p = par[i] ?? 0;
        const d = g != null ? g - p : null;
        const col = d == null ? '' : d < 0 ? 'var(--green)' : d > 1 ? 'var(--red)' : '';
        t += `<td style="text-align:center;padding:0.4rem 0.2rem;font-weight:600;color:${col};font-size:0.88rem;">${g ?? ''}</td>`;
      });
      // Section subtotal (gross)
      const sectionGross = holes.reduce((s, i) => s + (row.grosses[i] ?? 0), 0);
      t += `<td style="text-align:center;padding:0.4rem 0.5rem;font-weight:700;color:${nameCol};background:var(--surface);">${sectionGross || ''}</td>`;
      t += '</tr>';

      // Net row
      const hasNets = holes.some(i => row.nets[i] != null);
      if (hasNets) {
        t += `<tr style="background:${bg};">
          <td style="padding:0.2rem 0.5rem;font-size:0.65rem;color:var(--muted);padding-left:1.2rem;">net</td>`;
        holes.forEach(i => {
          t += `<td style="text-align:center;padding:0.2rem;font-size:0.72rem;color:var(--muted);">${row.nets[i] ?? ''}</td>`;
        });
        const sectionNet = holes.reduce((s, i) => s + (row.nets[i] ?? 0), 0);
        t += `<td style="text-align:center;padding:0.2rem 0.5rem;font-size:0.72rem;color:var(--green);font-weight:600;background:var(--surface);">${sectionNet || ''}</td>`;
        t += '</tr>';
      }

      // Points row (stableford)
      if (showPts) {
        const hasPts = holes.some(i => row.pts[i] != null);
        if (hasPts) {
          t += `<tr style="background:${bg};">
            <td style="padding:0.2rem 0.5rem;font-size:0.65rem;color:var(--muted);padding-left:1.2rem;">pts</td>`;
          holes.forEach(i => {
            t += `<td style="text-align:center;padding:0.2rem;font-size:0.72rem;color:var(--gold);font-weight:600;">${row.pts[i] ?? ''}</td>`;
          });
          const sectionPts = holes.reduce((s, i) => s + (row.pts[i] ?? 0), 0);
          t += `<td style="text-align:center;padding:0.2rem 0.5rem;font-size:0.72rem;color:var(--gold);font-weight:700;background:var(--surface);">${sectionPts || ''}</td>`;
          t += '</tr>';
        }
      }
    });

    t += '</tbody></table>';
    return t;
  }

  // Build total summary table
  function buildTotals() {
    let t = `<table style="border-collapse:collapse;width:100%;font-size:0.82rem;margin-top:0.5rem;">
      <thead><tr>
        <td style="padding:0.4rem 0.5rem;font-size:0.7rem;color:var(--muted);font-weight:600;min-width:90px;">Summary</td>
        ${isFull18 ? '<td style="text-align:center;padding:0.35rem 0.3rem;color:var(--muted);font-size:0.7rem;">Out</td><td style="text-align:center;padding:0.35rem 0.3rem;color:var(--muted);font-size:0.7rem;">In</td>' : ''}
        <td style="text-align:center;padding:0.35rem 0.5rem;color:var(--gold);font-size:0.7rem;font-weight:700;">Total</td>
        ${isStroke ? '<td style="text-align:center;padding:0.35rem 0.3rem;color:var(--green);font-size:0.7rem;">Net</td>' : ''}
        ${showPts  ? '<td style="text-align:center;padding:0.35rem 0.3rem;color:var(--gold);font-size:0.7rem;">Pts</td>' : ''}
      </tr></thead><tbody>`;

    sorted.forEach((row, rank) => {
      const isLead = rank === 0 && log.length > 0;
      const bg = isLead ? 'rgba(212,168,67,0.07)' : '';
      const nameCol = pHex(row.pi);
      t += `<tr style="background:${bg};border-top:1px solid var(--border);">
        <td style="padding:0.45rem 0.5rem;font-weight:700;color:${nameCol};font-size:0.82rem;">
          ${rank + 1}. ${row.name.split(' ')[0]}
        </td>
        ${isFull18 ? `<td style="text-align:center;padding:0.4rem 0.3rem;font-weight:600;">${row.front9Gross||''}</td><td style="text-align:center;padding:0.4rem 0.3rem;font-weight:600;">${row.back9Gross||''}</td>` : ''}
        <td style="text-align:center;padding:0.4rem 0.5rem;font-weight:700;color:${nameCol};">${row.grossTotal||''}</td>
        ${isStroke ? `<td style="text-align:center;padding:0.4rem 0.3rem;font-weight:700;color:var(--green);">${row.netTotal||''}</td>` : ''}
        ${showPts  ? `<td style="text-align:center;padding:0.4rem 0.3rem;font-weight:700;color:var(--gold);">${row.ptsTotal??''}</td>` : ''}
      </tr>`;
    });

    // For best2 add a team total row after all players
    if (isBest2) {
      const teamTotal = state.groupTotal ?? 0;
      t += `<tr style="background:rgba(212,168,67,0.1);border-top:2px solid var(--gold);">
        <td style="padding:0.45rem 0.5rem;font-weight:700;color:var(--gold);font-size:0.82rem;" colspan="${isFull18 ? 3 : 1}">TEAM TOTAL</td>
        ${isFull18 ? '<td></td><td></td>' : ''}
        <td style="text-align:center;padding:0.4rem 0.5rem;font-weight:700;color:var(--gold);font-size:1rem;">${teamTotal}</td>
        ${isStroke ? '<td></td>' : ''}
        ${showPts  ? '<td></td>' : ''}
      </tr>`;
    }

    t += '</tbody></table>';
    return t;
  }

  // Paginated sections with tab buttons
  const sections = isFull18
    ? [
        { id: 'sc-f9',  label: 'Front 9', html: buildSection(0, 9,  'Front 9') },
        { id: 'sc-b9',  label: 'Back 9',  html: buildSection(9, 18, 'Back 9')  },
        { id: 'sc-tot', label: 'Total',   html: buildTotals() },
      ]
    : [
        { id: 'sc-all', label: '9 Holes', html: buildSection(0, numHoles, '9 Holes') },
        { id: 'sc-tot', label: 'Total',   html: buildTotals() },
      ];

  const tabs = sections.map((s, i) =>
    `<button class="sc-tab-btn ${i === 0 ? 'active' : ''}" data-target="${s.id}"
      style="flex:1;padding:0.6rem 0.4rem;font-size:0.82rem;font-weight:600;
             background:${i === 0 ? 'var(--surface)' : 'transparent'};
             border:none;border-bottom:2px solid ${i === 0 ? 'var(--gold)' : 'transparent'};
             color:${i === 0 ? 'var(--gold)' : 'var(--muted)'};cursor:pointer;">
      ${s.label}
    </button>`
  ).join('');

  const panels = sections.map((s, i) =>
    `<div id="${s.id}" class="sc-panel" style="display:${i === 0 ? 'block' : 'none'};
      overflow-x:auto;-webkit-overflow-scrolling:touch;
      touch-action:pan-x pan-y pinch-zoom;">
      ${s.html}
    </div>`
  ).join('');

  return `
    <div style="position:sticky;top:0;z-index:10;background:var(--bg);
                display:flex;border-bottom:1px solid var(--border);margin-bottom:0.5rem;">
      ${tabs}
    </div>
    ${panels}`;
}

function buildEndRoundScorecard(state) {
  return buildLandscapeScorecard(state);
}

function buildScorecardHTML(state, opts = {}) {
  const rows = buildScorecardRows(state);
  if (!rows.length) return '<p style="padding:0.5rem;color:var(--muted);">No holes recorded yet.</p>';

  const fmt        = state.format;
  const names      = state.names;
  const isPairs    = ['foursomes','greensomes'].includes(fmt);
  const dispNames  = isPairs
    ? [`${names[0]} & ${names[1]}`, `${names[2] ?? ''} & ${names[3] ?? ''}`]
    : names;
  const showEdit   = opts.showEdit ?? false;   // scorer can edit
  const showChallenge = opts.showChallenge ?? false; // observer can challenge

  let html = '<table class="sc-table"><thead><tr>';
  html += '<th style="font-size:0.62rem;">H</th><th style="font-size:0.62rem;">Par</th><th style="font-size:0.62rem;">SI</th>';
  dispNames.forEach((nm, i) => {
    html += `<th style="color:${pHex(i)};font-size:0.7rem;">${nm.split(' ')[0]}</th>`;
    if (fmt === 'stableford') html += `<th class="sc-pts" style="color:${pHex(i)};font-size:0.7rem;">Pts</th>`;
    if (fmt === 'stroke')     html += `<th class="sc-net" style="color:${pHex(i)};font-size:0.7rem;">Net</th>`;
  });
  if (['match','betterball','csm','foursomes','greensomes'].includes(fmt)) html += '<th style="font-size:0.62rem;">Match</th>';
  if (['skins','itc','split6'].includes(fmt)) html += '<th style="font-size:0.62rem;">Result</th>';
  if (showEdit || showChallenge) html += '<th style="font-size:0.62rem;width:28px;"></th>';
  html += '</tr></thead><tbody>';

  const holeOffset = state.holeOffset ?? 0;
  let runMatch = 0;
  rows.forEach((row, ri) => {
    const holeNum = holeOffset + ri + 1;
    html += `<tr><td style="color:var(--muted);font-size:0.72rem;">${row.holeDisplay}</td><td style="font-size:0.72rem;">${row.par}</td><td style="font-size:0.72rem;color:var(--muted);">${row.si}</td>`;
    row.players.forEach((p, pi) => {
      const won = p.won || p.isBest;
      html += `<td style="font-size:0.85rem;font-weight:${won ? '700' : '500'};color:${won ? pHex(pi) : ''};">${p.gross ?? '--'}</td>`;
      if (fmt === 'stableford') html += `<td class="sc-pts" style="font-size:0.85rem;font-weight:600;">${p.pts ?? '--'}</td>`;
      if (fmt === 'stroke')     html += `<td class="sc-net" style="font-size:0.85rem;font-weight:600;">${p.net ?? '--'}</td>`;
    });
    if (row.matchStr) { runMatch += (row.result ?? 0); html += `<td class="sc-match">${row.matchStr}</td>`; }
    if (row.extra)    html += `<td style="color:var(--gold);font-size:0.7rem;">${row.extra}</td>`;
    if (showEdit) {
      html += `<td><button class="sc-edit-btn btn btn-ghost" data-hole="${holeNum}"
        style="padding:0.1rem 0.3rem;font-size:0.7rem;" title="Edit hole ${holeNum}">✏️</button></td>`;
    } else if (showChallenge) {
      html += `<td><button class="challenge-hole-btn btn btn-ghost" data-hole="${holeNum}"
        style="padding:0.1rem 0.3rem;font-size:0.65rem;color:var(--muted);" title="Challenge hole ${holeNum}">⚠️</button></td>`;
    }
    html += '</tr>';
  });

  // Totals footer
  html += '<tr style="border-top:2px solid var(--border);font-weight:700;color:var(--gold);"><td colspan="3">Total</td>';
  if (fmt === 'stableford') {
    state.totals?.forEach(t => { html += `<td></td><td class="sc-pts">${t}</td>`; });
  } else if (fmt === 'stroke') {
    state.totals?.forEach(t => { html += `<td></td><td class="sc-net">${t}</td>`; });
  } else if (fmt === 'split6') {
    state.runningPts?.forEach(p => { html += `<td>${p}</td>`; });
  } else if (fmt === 'skins') {
    state.skins?.forEach(s => { html += `<td>${s}</td>`; });
    html += '<td></td>';
  } else if (fmt === 'itc') {
    state.pts?.forEach(p => { html += `<td>${p}</td>`; });
    html += '<td></td><td></td>';
  } else {
    dispNames.forEach(() => { html += '<td></td>'; });
    if (['match','betterball','csm','foursomes','greensomes'].includes(fmt)) html += '<td></td>';
  }
  if (showEdit || showChallenge) html += '<td></td>';
  html += '</tr></tbody></table>';
  return html;
}

// ================================================================
// PROFILE SCREEN
// ================================================================
function showProfile() {
  const p = currentProfile ?? {};
  document.getElementById('prof-username').value  = p.username      ?? '';
  document.getElementById('prof-fname').value     = p.first_name    ?? '';
  document.getElementById('prof-lname').value     = p.last_name     ?? '';
  document.getElementById('prof-email').value     = currentUser?.email ?? '';
  document.getElementById('prof-mobile').value    = p.mobile        ?? '';
  document.getElementById('prof-hcp').value       = p.hcp           ?? '';
  document.getElementById('prof-whs').value       = p.whs           ?? '';

  // Privacy toggle buttons
  const privacyDefaults = {
    'prof-share-name-search':    p.share_name           ?? true,
    'prof-share-name-friends':   p.friends_see_name     ?? true,
    'prof-share-hcp-search':     p.share_hcp            ?? true,
    'prof-share-hcp-friends':    p.friends_see_hcp      ?? true,
    'prof-share-mobile-search':  p.share_mobile         ?? false,
    'prof-share-mobile-friends': p.friends_see_mobile   ?? false,
    'prof-share-email-search':   p.share_email          ?? false,
    'prof-share-email-friends':  p.friends_see_email    ?? false,
  };
  Object.entries(privacyDefaults).forEach(([id, val]) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.dataset.checked = val ? 'true' : 'false';
    btn.classList.toggle('active', val);
    btn.onclick = () => {
      const isNowActive = btn.dataset.checked !== 'true';
      btn.dataset.checked = isNowActive ? 'true' : 'false';
      btn.classList.toggle('active', isNowActive);
    };
  });

  const initials = `${(p.first_name ?? '?')[0]}${(p.last_name ?? '')[0] ?? ''}`.toUpperCase();
  document.getElementById('profile-avatar').textContent = initials;
  document.getElementById('profile-name').textContent   =
    `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || 'Welcome';
  document.getElementById('profile-email-display').textContent = currentUser?.email ?? '';

  const hcpEl = document.getElementById('profile-hcp');
  if (p.hcp != null) { hcpEl.textContent = `HCP ${fmtHandicap(p.hcp)}`; hcpEl.classList.remove('hidden'); }
  else hcpEl.classList.add('hidden');

  populateProfileCourseSelect();
  renderLogos();
  showScreen('screen-profile');
}

function populateProfileCourseSelect() {
  const sel = document.getElementById('prof-course-select');
  sel.innerHTML = '<option value="">-- None --</option>';
  allCourses.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id; opt.textContent = c.name;
    if (c.id === currentProfile?.home_course_id) opt.selected = true;
    sel.appendChild(opt);
  });
}

document.getElementById('btn-save-profile')?.addEventListener('click', async () => {
  const profile = {
    id: currentUser.id,
    username:           document.getElementById('prof-username').value.trim().toLowerCase().replace(/\s+/g,'') || null,
    first_name:         document.getElementById('prof-fname').value.trim(),
    last_name:          document.getElementById('prof-lname').value.trim(),
    mobile:             document.getElementById('prof-mobile').value.trim(),
    hcp:                parseFloat(document.getElementById('prof-hcp').value) || null,
    whs:                document.getElementById('prof-whs').value.trim(),
    share_name:         document.getElementById('prof-share-name-search')?.dataset.checked   === 'true',
    friends_see_name:   document.getElementById('prof-share-name-friends')?.dataset.checked  === 'true',
    share_hcp:          document.getElementById('prof-share-hcp-search')?.dataset.checked    === 'true',
    friends_see_hcp:    document.getElementById('prof-share-hcp-friends')?.dataset.checked   === 'true',
    share_mobile:       document.getElementById('prof-share-mobile-search')?.dataset.checked === 'true',
    friends_see_mobile: document.getElementById('prof-share-mobile-friends')?.dataset.checked=== 'true',
    share_email:        document.getElementById('prof-share-email-search')?.dataset.checked  === 'true',
    friends_see_email:  document.getElementById('prof-share-email-friends')?.dataset.checked === 'true',
    home_course_id: document.getElementById('prof-course-select').value || null,
    email:          currentUser?.email ?? null,
  };
  const btn = document.getElementById('btn-save-profile');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await profileSave(profile);
    currentProfile = { ...currentProfile, ...profile };
    const syncEl = document.getElementById('profile-sync-text');
    if (syncEl) syncEl.textContent = 'Saved ✓';
    setTimeout(() => { if (syncEl) syncEl.textContent = 'Synced'; }, 2000);
  } catch (err) { alert('Could not save profile: ' + err.message); }
  finally { btn.disabled = false; btn.textContent = 'SAVE PROFILE'; }
});

document.getElementById('btn-profile-home')?.addEventListener('click', () => showHome());
document.getElementById('prof-add-course-btn')?.addEventListener('click', () => { cwiz.returnTo = 'profile'; openCourseWizard(null); });
document.getElementById('btn-theme-dark') ?.addEventListener('click', () => applyTheme('dark'));
document.getElementById('btn-theme-light')?.addEventListener('click', () => applyTheme('light'));

// ================================================================
// FRIENDS
// ================================================================
async function showFriends() {
  showScreen('screen-friends');
  await loadFriendRequests();
  await renderFriendsList();
}

async function loadFriendRequests() {
  try {
    const pending  = await friendRequestsLoadPending(currentUser.id);
    const badge    = document.getElementById('friend-req-badge');
    if (pending.length) {
      show('friend-requests-section');
      if (badge) { badge.textContent = pending.length; badge.classList.remove('hidden'); }
      const list = document.getElementById('friend-requests-list');
      list.innerHTML = pending.map(r => `
        <div class="fr-card">
          <div style="font-size:0.88rem;margin-bottom:2px;">${r.name}</div>
          <div style="font-size:0.62rem;color:var(--muted);margin-bottom:0.5rem;">HCP ${fmtHandicap(r.hcp)} · sent you a friend request</div>
          <div style="display:flex;gap:0.4rem;">
            <button class="btn btn-primary" style="flex:1;padding:0.4rem;" data-accept="${r.friendshipId}">✓ Accept</button>
            <button class="btn btn-outline" style="flex:1;padding:0.4rem;" data-decline="${r.friendshipId}">✕ Decline</button>
          </div>
        </div>`).join('');
      list.querySelectorAll('[data-accept]').forEach(btn => {
        btn.addEventListener('click', async () => {
          await friendRequestAccept(btn.dataset.accept);
          allFriends = await friendsLoad(currentUser.id);
          await showFriends();
        });
      });
      list.querySelectorAll('[data-decline]').forEach(btn => {
        btn.addEventListener('click', async () => {
          await friendRequestDecline(btn.dataset.decline);
          await loadFriendRequests();
        });
      });
    } else {
      hide('friend-requests-section');
      if (badge) badge.classList.add('hidden');
    }
  } catch {}
}

async function renderFriendsList() {
  const listEl = document.getElementById('friends-list');
  if (!allFriends.length) {
    listEl.innerHTML = '<div class="history-empty">No friends yet -- add one above.</div>';
    return;
  }
  listEl.innerHTML = allFriends.map(f => {
    const displayName = f.name || f.username || 'Unknown';
    const init = displayName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    // Show only fields the friend has chosen to share with friends
    const details = [];
    if (f.hcp != null && f.friends_see_hcp !== false) details.push(`HCP ${fmtHandicap(f.hcp)}`);
    if (f.mobile && f.friends_see_mobile)  details.push(f.mobile);
    if (f.email && f.friends_see_email)    details.push(f.email);
    if (f.username) details.unshift(`@${f.username}`);
    return `
      <div class="friend-item">
        <div class="friend-avatar">${init}</div>
        <div class="friend-info">
          <div class="friend-name">${displayName}</div>
          <div class="friend-sub" style="line-height:1.5;">${details.join(' · ')}</div>
        </div>
        <button class="btn btn-ghost" style="font-size:0.72rem;border-color:var(--red-border);color:var(--red);"
          data-remove="${f.friendshipId}">Remove</button>
      </div>`;
  }).join('');
  listEl.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this friend?')) return;
      await friendRemove(btn.dataset.remove);
      allFriends = await friendsLoad(currentUser.id);
      await renderFriendsList();
    });
  });
}

document.getElementById('btn-search-friend')?.addEventListener('click', async () => {
  const query = document.getElementById('friend-search-email').value.trim();
  if (!query) return;
  hide('friend-search-result'); hide('friend-search-empty');
  try {
    // Try username first, then email
    let user = null;
    if (query.startsWith('@') || !query.includes('@')) {
      const username = query.replace(/^@/, '').toLowerCase();
      user = await profileFindByUsername(username);
    }
    if (!user) user = await profileFindByEmail(query);

    if (!user || user.id === currentUser.id) {
      document.getElementById('friend-search-empty').textContent = 'No user found with that username or email.';
      show('friend-search-empty'); return;
    }
    // Show only searchable info
    const nameStr = user.share_name !== false
      ? `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim()
      : user.username ? `@${user.username}` : 'Player';
    const hcpStr  = user.share_hcp !== false && user.hcp != null ? ` · HCP ${fmtHandicap(user.hcp)}` : '';
    document.getElementById('friend-found-name').textContent = nameStr + hcpStr;
    show('friend-search-result');
    document.getElementById('btn-send-request').onclick = async () => {
      await friendRequestSend(currentUser.id, user.id);
      hide('friend-search-result');
      document.getElementById('friend-search-empty').textContent = 'Friend request sent!';
      show('friend-search-empty');
    };
  } catch (err) {
    document.getElementById('friend-search-empty').textContent = err.message ?? 'Search failed.';
    show('friend-search-empty');
  }
});

document.getElementById('friends-back')?.addEventListener('click', () => showHome());

// ----------------------------------------------------------------
// INVITE MODAL
// ----------------------------------------------------------------
const APP_URL = 'https://leaderboard-ten-wheat.vercel.app';

function buildInviteMessage() {
  const myName = currentProfile?.username
    ? `@${currentProfile.username}`
    : currentProfile
      ? `${currentProfile.first_name ?? ''} ${currentProfile.last_name ?? ''}`.trim() || 'A friend'
      : 'A friend';
  return `You have been invited to the Leaderboard Golf Score App by ${myName}.\n\n` +
    `Download it here: ${APP_URL}\n\n` +
    `📱 To install as an app:\n` +
    `iPhone: Open in Safari → tap Share → Add to Home Screen\n` +
    `Android: Open in Chrome → tap ⋮ → Add to Home Screen`;
}

document.getElementById('btn-open-invite')?.addEventListener('click', () => {
  document.getElementById('invite-mobile').value = '';
  document.getElementById('invite-email').value  = '';
  // Populate the text box with the invite message
  const textBox = document.getElementById('invite-text-box');
  if (textBox) textBox.value = buildInviteMessage();
  document.getElementById('modal-invite').classList.add('open');
});

document.getElementById('invite-copy-btn')?.addEventListener('click', () => {
  const msg = buildInviteMessage();
  navigator.clipboard.writeText(msg).then(() => {
    const btn = document.getElementById('invite-copy-btn');
    btn.textContent = '✅ Copied!';
    setTimeout(() => { btn.textContent = '📋 Copy Message'; }, 2000);
  }).catch(() => {
    // Fallback: select the textarea
    const tb = document.getElementById('invite-text-box');
    if (tb) { tb.select(); document.execCommand('copy'); }
  });
});

document.getElementById('invite-sms-btn')?.addEventListener('click', () => {
  const mobile = document.getElementById('invite-mobile').value.trim();
  if (!mobile) { alert('Please enter a mobile number.'); return; }
  const msg = buildInviteMessage();
  window.open(`sms:${mobile}?body=${encodeURIComponent(msg)}`);
  document.getElementById('modal-invite').classList.remove('open');
});

document.getElementById('invite-email-btn')?.addEventListener('click', () => {
  const email = document.getElementById('invite-email').value.trim();
  if (!email) { alert('Please enter an email address.'); return; }
  const msg     = buildInviteMessage();
  const subject = encodeURIComponent('You\'ve been invited to Leaderboard ⛳');
  window.open(`mailto:${email}?subject=${subject}&body=${encodeURIComponent(msg)}`);
  document.getElementById('modal-invite').classList.remove('open');
});

document.getElementById('invite-whatsapp-btn')?.addEventListener('click', () => {
  const mobile = document.getElementById('invite-mobile').value.trim();
  const msg    = buildInviteMessage();
  const enc    = encodeURIComponent(msg);
  const url    = mobile
    ? `https://wa.me/${mobile.replace(/\D/g,'')}?text=${enc}`
    : `https://wa.me/?text=${enc}`;
  window.open(url, '_blank');
  document.getElementById('modal-invite').classList.remove('open');
});

document.getElementById('invite-close')?.addEventListener('click', () => {
  document.getElementById('modal-invite').classList.remove('open');
});

// ================================================================
// HISTORY
// ================================================================
async function showHistory() {
  showScreen('screen-history');
  historyFilter = 'all';
  const sel = document.getElementById('history-format-select');
  if (sel) sel.value = 'all';
  await loadHistory();
}

async function loadHistory() {
  const listEl  = document.getElementById('history-list');
  const countEl = document.getElementById('history-count');
  listEl.innerHTML = '<div class="history-empty">Loading…</div>';
  try {
    const rounds   = await roundsLoadHistory(currentUser.id);
    const filtered = historyFilter === 'all' ? rounds : rounds.filter(r => r.game_format === historyFilter);
    countEl.textContent = `${filtered.length} round${filtered.length !== 1 ? 's' : ''}`;
    if (!filtered.length) { listEl.innerHTML = '<div class="history-empty">No rounds found.</div>'; return; }
    listEl.innerHTML = filtered.map(r => {
      const date = r.completed_at
        ? new Date(r.completed_at).toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short', year:'numeric' })
        : '--';
      const state   = r.game_state;
      const summary = state ? getResultSummary(state) : null;
      return `
        <div class="history-item" data-rid="${r.id}">
          <div class="hi-icon">⛳</div>
          <div class="hi-body">
            <div class="hi-date">${date} · ${r.course_name ?? '--'}</div>
            <div class="hi-title">${fmtLabel(r.game_format)} · ${r.tee_name ?? ''} Tees</div>
            ${summary?.winner ? `<div class="hi-winner">🏆 ${summary.winner}</div>` : ''}
          </div>
          <div class="hi-arrow">›</div>
        </div>`;
    }).join('');
    listEl.querySelectorAll('.history-item').forEach(item => {
      item.addEventListener('click', () => showHistoryDetail(item.dataset.rid, filtered));
    });
  } catch (err) { listEl.innerHTML = `<div class="history-empty">${err.message}</div>`; }
}

document.getElementById('history-format-select')?.addEventListener('change', e => {
  historyFilter = e.target.value;
  loadHistory();
});
document.getElementById('history-back')?.addEventListener('click', () => showHome());

function showHistoryDetail(rid, rounds) {
  const r = rounds.find(x => x.id === rid); if (!r) return;
  const state = r.game_state;
  document.getElementById('hd-title').textContent = `${r.course_name ?? '--'} · ${fmtLabel(r.game_format)}`;
  if (state) {
    const summary = getResultSummary(state);
    document.getElementById('hd-result').innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1rem;margin-bottom:1rem;">
        <div style="font-size:0.58rem;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted);margin-bottom:0.3rem;">${fmtLabel(r.game_format)} · ${r.tee_name} Tees</div>
        <div style="font-family:'Barlow Condensed',sans-serif;font-size:1.4rem;font-weight:700;color:var(--gold);">${summary.winner ?? 'Completed'}</div>
        <div style="font-size:0.72rem;color:var(--muted);margin-top:2px;">${summary.summary ?? ''}</div>
      </div>`;
    const allStates = state.allGroupStates ?? [state];
    document.getElementById('hd-scorecard').innerHTML = buildLandscapeScorecard(mergeGroupStates(allStates));
  }

  // Wire up delete button
  const delBtn = document.getElementById('btn-delete-round');
  if (delBtn) {
    // Reset button state every time detail screen opens
    delBtn.disabled = false; delBtn.textContent = '🗑 Delete Round';
    delBtn.onclick = async () => {
      if (!confirm('Delete this round permanently? This cannot be undone.')) return;
      // Navigate away immediately so button can't be double-clicked
      await showHistory();
      try {
        await roundDelete(r.id);
        // Reload the list now the delete is done
        await loadHistory();
      } catch (err) {
        alert('Could not delete round: ' + err.message);
      }
    };
  }

  showScreen('screen-history-detail');
}

document.getElementById('history-detail-back')?.addEventListener('click', () => showHistory());

// ================================================================
// COURSE WIZARD
// ================================================================
function openCourseWizard(courseId) {
  cwiz.courseId = courseId;
  cwiz.tees     = [];
  cwiz.holes    = Array.from({ length: 18 }, () => ({ par: 4, si: {} }));
  cwiz.holeIdx  = 0;

  if (courseId) {
    const course = allCourses.find(c => c.id === courseId);
    if (course) {
      document.getElementById('cwiz-name').value     = course.name;
      document.getElementById('cwiz-location').value = course.location ?? '';
      cwiz.name = course.name; cwiz.location = course.location ?? '';
      cwiz.tees = (course.tees ?? []).map(t => ({ name: t.name, color: t.color }));
      cwiz.holes = Array.from({ length: 18 }, (_, i) => {
        const si = {}; course.tees?.forEach(t => { si[t.name] = t.si[i]; });
        return { par: course.tees?.[0]?.par?.[i] ?? 4, si };
      });
      document.getElementById('cwiz-title').textContent = 'Edit Course';
    }
  } else {
    document.getElementById('cwiz-name').value     = '';
    document.getElementById('cwiz-location').value = '';
    document.getElementById('cwiz-title').textContent = 'Add Course';
    cwiz.name = ''; cwiz.location = '';
  }

  renderCwizTeesList();
  document.getElementById('modal-course-wizard').classList.add('open');
  show('cwiz-phase-name'); hide('cwiz-phase-holes'); hide('cwiz-phase-review');
  updateCwizStartBtn();
}

function renderCwizTeesList() {
  const listEl = document.getElementById('cwiz-tees-list');
  if (!cwiz.tees.length) {
    listEl.innerHTML = '<div style="font-size:0.72rem;color:var(--muted);">Add at least one tee box</div>'; return;
  }
  listEl.innerHTML = cwiz.tees.map((t, i) => `
    <div class="tee-block" style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.4rem;">
      <div style="width:14px;height:14px;border-radius:50%;background:${t.color};flex-shrink:0;"></div>
      <span style="flex:1;font-family:'Barlow Condensed',sans-serif;font-weight:700;letter-spacing:0.08em;">${t.name}</span>
      <button class="btn btn-ghost" style="font-size:0.72rem;padding:2px 8px;" data-del="${i}">✕</button>
    </div>`).join('');
  listEl.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => { cwiz.tees.splice(parseInt(btn.dataset.del), 1); renderCwizTeesList(); updateCwizStartBtn(); });
  });
}

function updateCwizStartBtn() {
  const btn  = document.getElementById('cwiz-start-holes-btn');
  const name = document.getElementById('cwiz-name')?.value.trim();
  if (btn) { btn.disabled = !name || !cwiz.tees.length; btn.style.opacity = (!name || !cwiz.tees.length) ? '0.4' : '1'; }
}

document.getElementById('cwiz-name')?.addEventListener('input', e => { cwiz.name = e.target.value.trim(); updateCwizStartBtn(); });
document.getElementById('cwiz-location')?.addEventListener('input', e => { cwiz.location = e.target.value.trim(); });

document.getElementById('cwiz-add-tee-btn')?.addEventListener('click', () => {
  const presets = [{name:'Yellow',color:'#f5c518'},{name:'White',color:'#e8e8e8'},{name:'Red',color:'#e53e3e'},{name:'Blue',color:'#4299e1'},{name:'Black',color:'#2d3748'},{name:'Gold',color:'#d4a843'}];
  const used    = new Set(cwiz.tees.map(t => t.name));
  const preset  = presets.find(p => !used.has(p.name)) || { name: 'Custom', color: '#a0aec0' };
  cwiz.tees.push({ name: preset.name, color: preset.color });
  renderCwizTeesList(); updateCwizStartBtn();
});

document.getElementById('cwiz-start-holes-btn')?.addEventListener('click', () => {
  cwiz.holeIdx = 0;
  hide('cwiz-phase-name'); show('cwiz-phase-holes');
  renderCwizHole();
});

function renderCwizHole() {
  const h = cwiz.holeIdx;
  document.getElementById('cwiz-hole-num').textContent = h + 1;
  const dots = document.getElementById('cwiz-prog-dots');
  dots.innerHTML = Array.from({ length: 18 }, (_, i) => {
    const bg   = i < h ? 'var(--green)' : i === h ? 'var(--gold)' : 'rgba(255,255,255,0.1)';
    const size = i === h ? '10px' : '7px';
    return `<div style="width:${size};height:${size};border-radius:50%;background:${bg};flex-shrink:0;cursor:pointer;" data-jump="${i}"></div>`;
  }).join('');
  dots.querySelectorAll('[data-jump]').forEach(d => {
    d.addEventListener('click', () => { saveCwizHole(); cwiz.holeIdx = parseInt(d.dataset.jump); renderCwizHole(); });
  });

  const parBtns = document.getElementById('cwiz-par-btns');
  parBtns.innerHTML = [3,4,5].map(p =>
    `<button class="si-btn${cwiz.holes[h].par === p ? ' selected' : ''}" data-par="${p}">Par ${p}</button>`
  ).join('');
  parBtns.querySelectorAll('[data-par]').forEach(btn => {
    btn.addEventListener('click', () => {
      cwiz.holes[h].par = parseInt(btn.dataset.par);
      parBtns.querySelectorAll('.si-btn').forEach(b => b.classList.toggle('selected', parseInt(b.dataset.par) === cwiz.holes[h].par));
    });
  });

  const siSec = document.getElementById('cwiz-tee-si-sections');
  siSec.innerHTML = cwiz.tees.map(t => `
    <div style="margin-bottom:0.85rem;">
      <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.4rem;">
        <div style="width:12px;height:12px;border-radius:50%;background:${t.color};flex-shrink:0;"></div>
        <div style="font-size:0.6rem;letter-spacing:0.2em;text-transform:uppercase;color:var(--muted);">
          ${t.name} Tee -- SI <span style="color:var(--gold);">${cwiz.holes[h].si[t.name] ?? '?'}</span>
        </div>
      </div>
      <div class="si-picker">
        ${Array.from({ length: 18 }, (_, i) => {
          const n = i + 1;
          const isCur  = cwiz.holes[h].si[t.name] === n;
          const isUsed = Object.entries(cwiz.holes).some(([k, v]) => parseInt(k) !== h && v.si[t.name] === n);
          return `<button class="si-btn${isCur ? ' selected' : isUsed ? ' used' : ''}" data-tee="${t.name}" data-si="${n}">${n}</button>`;
        }).join('')}
      </div>
    </div>`).join('');

  siSec.querySelectorAll('[data-si]').forEach(btn => {
    btn.addEventListener('click', () => {
      cwiz.holes[h].si[btn.dataset.tee] = parseInt(btn.dataset.si);
      renderCwizHole();
    });
  });

  const backBtn = document.getElementById('cwiz-hole-back-btn');
  if (backBtn) backBtn.disabled = h === 0;
  const nextBtn = document.getElementById('cwiz-hole-next-btn');
  if (nextBtn) nextBtn.textContent = h < 17 ? 'Next →' : 'Review →';
}

function saveCwizHole() {
  // SI values are saved live via click handlers
}

document.getElementById('cwiz-hole-next-btn')?.addEventListener('click', () => {
  const h = cwiz.holeIdx;
  const allSet = cwiz.tees.every(t => cwiz.holes[h].si[t.name] > 0);
  if (!allSet) { alert('Please set the SI for all tees before continuing.'); return; }
  if (h < 17) { cwiz.holeIdx++; renderCwizHole(); }
  else { hide('cwiz-phase-holes'); show('cwiz-phase-review'); renderCwizReview(); }
});

document.getElementById('cwiz-hole-back-btn')?.addEventListener('click', () => {
  if (cwiz.holeIdx > 0) { cwiz.holeIdx--; renderCwizHole(); }
});

function renderCwizReview() {
  const total = cwiz.holes.reduce((s, h) => s + h.par, 0);
  document.getElementById('cwiz-review-par').textContent = total;
  document.getElementById('cwiz-review-grid').innerHTML = cwiz.holes.map((h, i) => `
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:5px;padding:3px 2px;text-align:center;cursor:pointer;"
      data-jump="${i}">
      <div style="font-size:0.42rem;color:var(--muted);">H${i+1}</div>
      <div style="font-family:'Barlow Condensed',sans-serif;font-size:0.92rem;font-weight:700;">${cwiz.tees[0]?.name ? (cwiz.holes[i].si[cwiz.tees[0].name] ?? '?') : '?'}</div>
      <div style="font-size:0.48rem;color:var(--muted);">P${h.par}</div>
    </div>`).join('');
  document.getElementById('cwiz-review-grid').querySelectorAll('[data-jump]').forEach(el => {
    el.addEventListener('click', () => {
      cwiz.holeIdx = parseInt(el.dataset.jump);
      hide('cwiz-phase-review'); show('cwiz-phase-holes');
      renderCwizHole();
    });
  });
}

document.getElementById('cwiz-redo-btn')?.addEventListener('click', () => {
  cwiz.holeIdx = 0; hide('cwiz-phase-review'); show('cwiz-phase-holes'); renderCwizHole();
});

document.getElementById('cwiz-save-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('cwiz-save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const tees = cwiz.tees.map(t => ({
      name: t.name, color: t.color,
      si:  cwiz.holes.map(h => h.si[t.name] ?? 1),
      par: cwiz.holes.map(h => h.par),
    }));
    const savedId = await courseSave({
      id: cwiz.courseId ?? undefined, name: cwiz.name, location: cwiz.location,
      tees, isDefault: false, createdBy: currentUser.id,
    });
    allCourses = await coursesLoadAll();
    document.getElementById('modal-course-wizard').classList.remove('open');
    if (cwiz.returnTo === 'setup') {
      populateCourseSelect();
      const sel = document.getElementById('setup-course-select');
      if (sel) { sel.value = savedId; onCourseSelectChange(); }
    } else if (cwiz.returnTo === 'profile') {
      populateProfileCourseSelect();
    }
  } catch (err) { alert('Could not save course: ' + err.message); }
  finally { btn.disabled = false; btn.textContent = '✅ SAVE COURSE'; }
});

document.getElementById('cwiz-cancel')?.addEventListener('click', () => document.getElementById('modal-course-wizard').classList.remove('open'));

// ================================================================
// JOIN FLOW
// ================================================================
async function handleJoinFlow(token, troundId = null, groupNumber = null) {
  showScreen('screen-join');
  try {
    const invite = await smsInviteLookup(token);
    if (!invite) {
      document.getElementById('join-invite-info').innerHTML =
        '<div style="color:var(--muted);">This invite link is invalid or has expired.</div>';
      return;
    }
    document.getElementById('join-invite-info').innerHTML = `
      <div style="font-family:'Barlow Condensed',sans-serif;font-size:1.2rem;font-weight:700;color:var(--gold);margin-bottom:0.3rem;">${invite.inviter_name ?? 'Someone'} invited you</div>
      <div style="font-size:0.72rem;color:var(--muted);">${invite.course_name ?? ''} · ${fmtLabel(invite.game_format ?? '')}</div>
      ${troundId ? `<div style="font-size:0.72rem;color:var(--muted);margin-top:0.25rem;">Group ${groupNumber} scorer</div>` : ''}`;
    const user = await authGetUser();
    if (!user) {
      show('join-auth-prompt');
      document.getElementById('btn-join-auth').addEventListener('click', () => {
        sessionStorage.setItem('lb-join-token', token);
        if (troundId) sessionStorage.setItem('lb-join-tround', troundId);
        if (groupNumber) sessionStorage.setItem('lb-join-group', groupNumber);
        showScreen('screen-auth');
      });
    } else {
      show('join-confirm-prompt');
      document.getElementById('btn-join-confirm').onclick = async () => {
        await smsInviteAccept(invite.id);
        window.history.replaceState({}, '', '/');
        if (troundId && groupNumber) {
          await joinTournamentRoundAsScorer(user, troundId, parseInt(groupNumber));
        } else {
          await onSignedIn(user);
        }
      };
    }
  } catch (err) {
    document.getElementById('join-invite-info').innerHTML =
      `<div style="color:var(--muted);">Error loading invite: ${err.message}</div>`;
  }
}

// Called when a group scorer opens a tournament round invite link
async function joinTournamentRoundAsScorer(user, troundId, groupNumber) {
  try {
    currentUser    = user;
    currentProfile = await profileLoad(user.id);
    allCourses     = await coursesLoadAll();
    allFriends     = await friendsLoad(user.id);

    // Load the tournament round and its tournament
    const tround = await tournamentRoundLoadById(troundId);
    if (!tround) { await onSignedIn(user); return; }

    activeTournament     = await tournamentLoadById(tround.tournament_id);
    activeTournPlayers   = await tournamentPlayersLoad(tround.tournament_id);
    activeTournRounds    = await tournamentRoundsLoad(tround.tournament_id);
    activeTournAllScores = await tournamentAllScoresLoad(tround.tournament_id);
    activeTournRound     = tround;
    if (activeTournament?.tournament_type === 'team') {
      activeTournTeams = await tournamentTeamsLoad(tround.tournament_id);
    }

    // Load saved group assignments
    const saved = restoreTroundSetup();
    const groups = saved?.groups ?? [];
    const myGroupData = groups.find(g => g.groupNumber === groupNumber) ?? groups[groupNumber - 1];
    if (!myGroupData) { await onSignedIn(user); return; }

    tournGroups = groups;

    const groupPlayers = myGroupData.players
      .map(pid => activeTournPlayers.find(p => p.id === pid))
      .filter(Boolean);

    if (!groupPlayers.length) { await onSignedIn(user); return; }

    const course = allCourses.find(c => c.name === tround.course_name);
    const tee    = course?.tees?.find(t => t.name === tround.tee_name);
    if (!course || !tee) { await onSignedIn(user); return; }

    const roundFormat = activeTournament.tournament_type === 'team'
      ? (activeTournRoundFmt ?? activeTournament.team_format ?? activeTournament.format)
      : activeTournament.format;

    const hcpArr = groupPlayers.map(p => p.current_hcp);
    const hcpObj = calcHandicaps(hcpArr, 100);

    setup.scoring    = roundFormat;
    setup.courseId   = course.id;
    setup.teeIdx     = course.tees.findIndex(t => t.name === tround.tee_name);
    setup.holes      = 18;
    setup.hcpPct     = 100;
    setup.numGroups  = 1;
    setup.players    = groupPlayers.map((p, i) => ({
      name:               p.name,
      hcpIndex:           p.current_hcp,
      groupNumber,
      profileId:          p.profile_id ?? null,
      isScorer:           p.profile_id === user.id || i === 0,
      mobile:             null,
      tournamentPlayerId: p.id,
    }));
    setup.numPlayers = setup.players.length;

    gameState = buildInitialState({
      format:           roundFormat,
      names:            groupPlayers.map(p => p.name),
      handicapIndexes:  hcpArr,
      playingHandicaps: hcpObj.map(h => h.playingHandicap),
      matchHandicaps:   hcpObj.map(h => h.matchHandicap),
      allowancePct:     100,
      si: tee.si, par: tee.par, numHoles: 18, holeOffset: 0,
      courseName: course.name, teeName: tround.tee_name,
      tournamentId:      activeTournament.id,
      tournamentRoundId: tround.id,
      groupNumber,
    });

    const designatedScorer    = setup.players.find(p => p.isScorer);
    gameState.organiserId     = user.id;
    gameState.scorerProfileId = designatedScorer
      ? (designatedScorer.profileId ?? null) : user.id;
    gameState.playerProfileIds = setup.players.map(p => p.profileId ?? null);

    // Create this group's own rounds row
    const { allGroupStates, ...stateToSave } = gameState;
    roundId = await roundCreate({
      organiserId:  user.id,
      courseName:   course.name,
      teeName:      tround.tee_name,
      gameFormat:   roundFormat,
      hcpAllowance: 100,
      si: tee.si, par: tee.par, numHoles: 18, holeOffset: 0,
      numGroups:    groups.length,
      playerNames:  groupPlayers.map(p => p.name),
      gameState:    stateToSave,
    });

    subscribeToRound(roundId);
    enterGameScreen();
  } catch (err) {
    console.error('joinTournamentRoundAsScorer error', err);
    await onSignedIn(user);
  }
}

// ================================================================
// KICK OFF
// ================================================================
document.addEventListener('DOMContentLoaded', boot);

// ================================================================
// TOURNAMENT MODE
// ================================================================



// Active tournament state
let activeTournament    = null;
let activeTournPlayers  = [];
let activeTournRounds   = [];
let activeTournAllScores = [];
let activeTournRound    = null; // the round currently being set up or played
let tournRealtimeCh     = null;
let tournGroups         = [];   // [{groupNumber, players: [playerIds]}]


// ----------------------------------------------------------------
// HOME → TOURNAMENT LIST
// ----------------------------------------------------------------
document.getElementById('btn-tournament-mode')?.addEventListener('click', () => showTournaments());
document.getElementById('tournaments-back')  ?.addEventListener('click', () => showHome());
document.getElementById('btn-new-tournament')?.addEventListener('click', () => showTournamentSetup());

async function showTournaments() {
  showScreen('screen-tournaments');
  const list = document.getElementById('tournaments-list');
  list.innerHTML = '<div class="history-empty">Loading…</div>';
  try {
    const tournaments = await tournamentsLoad(currentUser.id);
    if (!tournaments.length) {
      list.innerHTML = '<div class="history-empty">No tournaments yet -- create one above.</div>';
      return;
    }
    list.innerHTML = tournaments.map(t => `
      <div class="history-item" data-tid="${t.id}" style="cursor:pointer;">
        <div class="hi-icon">🏆</div>
        <div class="hi-body">
          <div class="hi-title">${t.name}</div>
          <div class="hi-date">${fmtLabel(t.format)} · ${t.num_rounds} rounds · ${t.hcp_mode} HCP</div>
          <div class="hi-winner" style="color:${t.status === 'completed' ? 'var(--muted)' : 'var(--green)'};">
            ${t.status === 'completed' ? 'Completed' : 'In Progress'}
          </div>
        </div>
        <div class="hi-arrow">›</div>
      </div>`).join('');

    list.querySelectorAll('.history-item').forEach(item => {
      item.addEventListener('click', () => showTournamentDetail(item.dataset.tid));
    });
  } catch (err) {
    list.innerHTML = `<div class="history-empty">${err.message}</div>`;
  }
}

// ----------------------------------------------------------------
// TOURNAMENT SETUP -- STEP 1: DETAILS
// ----------------------------------------------------------------
document.getElementById('tourn-team-size')?.addEventListener('change', updateTournFormatOptions);

function showTournamentSetup() {
  document.getElementById('tourn-name').value         = '';
  document.getElementById('tourn-format').value       = 'stableford';
  document.getElementById('tourn-num-rounds').value   = '3';
  document.getElementById('tourn-hcp-mode').value     = 'fixed';
  document.getElementById('tourn-scoring-mode').value = 'cumulative';
  updateRoundsToggle(false);
  document.getElementById('tourn-type').value         = 'individual';
  updateTournTypeToggle('individual');
  document.getElementById('tourn-type-individual').classList.add('selected');
  document.getElementById('tourn-type-team').classList.remove('selected');
  document.getElementById('tourn-team-opts').style.display = 'none';
  updateTournFormatOptions();
  showScreen('screen-tournament-setup');
}

// Open-ended rounds toggle
function updateRoundsToggle(isOpenEnded) {
  const cbx     = document.getElementById('tourn-open-ended');
  const sel     = document.getElementById('tourn-num-rounds');
  const btnFixed = document.getElementById('btn-fixed-rounds');
  const btnOpen  = document.getElementById('btn-open-ended');
  if (cbx) cbx.checked = isOpenEnded;
  if (sel) sel.style.display = isOpenEnded ? 'none' : '';
  const activeStyle   = 'background:var(--green);color:#fff;border-color:var(--green);font-weight:600;';
  const inactiveStyle = 'background:var(--card);color:var(--text);border-color:var(--border);font-weight:normal;';
  if (btnFixed) btnFixed.style.cssText += isOpenEnded ? inactiveStyle : activeStyle;
  if (btnOpen)  btnOpen.style.cssText  += isOpenEnded ? activeStyle   : inactiveStyle;
}

function updateTournTypeToggle(val) {
  const btnInd  = document.getElementById('tourn-type-individual');
  const btnTeam = document.getElementById('tourn-type-team');
  const hidden  = document.getElementById('tourn-type');
  if (hidden) hidden.value = val;
  const activeStyle   = 'background:var(--green);color:#fff;border-color:var(--green);font-weight:600;';
  const inactiveStyle = 'background:var(--card);color:var(--text);border-color:var(--border);font-weight:normal;';
  if (btnInd)  btnInd.style.cssText  += val === 'individual' ? activeStyle : inactiveStyle;
  if (btnTeam) btnTeam.style.cssText += val === 'team'       ? activeStyle : inactiveStyle;
}

document.getElementById('tourn-type-individual')?.addEventListener('click', () => {
  updateTournTypeToggle('individual');
  document.getElementById('tourn-team-opts').style.display = 'none';
});
document.getElementById('tourn-type-team')?.addEventListener('click', () => {
  updateTournTypeToggle('team');
  document.getElementById('tourn-team-opts').style.display = '';
  updateTournFormatOptions();
});

document.getElementById('btn-fixed-rounds')?.addEventListener('click', () => updateRoundsToggle(false));
document.getElementById('btn-open-ended')?.addEventListener('click',   () => updateRoundsToggle(true));

document.getElementById('tourn-open-ended')?.addEventListener('change', e => {
  const sel = document.getElementById('tourn-num-rounds');
  if (sel) sel.disabled = e.target.checked;
});

document.getElementById('tourn-scoring-mode')?.addEventListener('change', e => {
  const hints = {
    cumulative:  'Stableford points from every round add up. Highest total wins.',
    stroke:      'Net shots from every round add up. Lowest total wins.',
    points_game: '1st place each round gets N pts (N = players), 2nd gets N-1, etc. Ties share points and skip ranks.',
  };
  document.getElementById('tourn-scoring-hint').textContent = hints[e.target.value] ?? '';
});

document.getElementById('tournament-setup-back')?.addEventListener('click', () => showTournaments());

document.getElementById('btn-tourn-setup-next')?.addEventListener('click', () => {
  const name = document.getElementById('tourn-name').value.trim();
  if (!name) { alert('Please enter a tournament name.'); return; }
  // Show/hide team options based on type
  const type = document.getElementById('tourn-type').value;
  document.getElementById('tourn-indiv-format-wrap').style.display = type === 'individual' ? '' : 'none';
  document.getElementById('tourn-team-opts').style.display = type === 'team' ? '' : 'none';
  if (type === 'team') updateTournFormatOptions();
  showScreen('screen-tournament-format');
});

// ── Edit tournament name ─────────────────────────────────────────
document.getElementById('btn-td-edit')?.addEventListener('click', () => {
  document.getElementById('edit-tournament-name').value = activeTournament?.name ?? '';
  document.getElementById('modal-edit-tournament').classList.add('open');
});
document.getElementById('edit-tournament-close')?.addEventListener('click', () => {
  document.getElementById('modal-edit-tournament').classList.remove('open');
});
document.getElementById('btn-edit-tournament-save')?.addEventListener('click', async () => {
  const newName = document.getElementById('edit-tournament-name').value.trim();
  if (!newName) return;
  await tournamentUpdate(activeTournament.id, { name: newName });
  activeTournament.name = newName;
  document.getElementById('td-tournament-name').textContent = newName;
  document.getElementById('modal-edit-tournament').classList.remove('open');
});

// ── Finish tournament ────────────────────────────────────────────
document.getElementById('btn-finish-tournament')?.addEventListener('click', () => {
  document.getElementById('modal-finish-tournament').classList.add('open');
});
document.getElementById('finish-tournament-close')?.addEventListener('click', () =>
  document.getElementById('modal-finish-tournament').classList.remove('open'));
document.getElementById('btn-finish-cancel')?.addEventListener('click', () =>
  document.getElementById('modal-finish-tournament').classList.remove('open'));
document.getElementById('btn-finish-confirm')?.addEventListener('click', async () => {
  document.getElementById('modal-finish-tournament').classList.remove('open');
  await tournamentUpdate(activeTournament.id, { status: 'completed' });
  activeTournament.status = 'completed';
  // Disable next round button
  const btn = document.getElementById('btn-start-next-round');
  if (btn) { btn.textContent = '✓ Tournament Complete'; btn.disabled = true; }
  await showTournamentDetail(activeTournament.id);
});

// ----------------------------------------------------------------
// TOURNAMENT SETUP -- STEP 2: PLAYERS
// ----------------------------------------------------------------
// ── Step 2: Format & Groups ──────────────────────────────────────
document.getElementById('tournament-format-back')?.addEventListener('click', () =>
  showScreen('screen-tournament-setup'));

document.getElementById('btn-tourn-format-next')?.addEventListener('click', () => {
  buildGroupPlayerForms();
  showScreen('screen-tournament-players');
});

// ── Step 3: Players per Group ────────────────────────────────────
let tournSetupPlayers = []; // flat list [{name, hcp, profileId, groupIndex}]
let tournSetupNumGroups = 1;

function buildGroupPlayerForms() {
  tournSetupNumGroups = parseInt(document.getElementById('tourn-num-groups').value) || 1;

  // Populate course dropdown
  const courseSel = document.getElementById('tourn-course-select');
  const teeWrap   = document.getElementById('tourn-tee-wrap');
  const teeSel    = document.getElementById('tourn-tee-select');
  courseSel.innerHTML = '<option value="">-- Select course --</option>';
  allCourses.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id; opt.textContent = c.name;
    courseSel.appendChild(opt);
  });
  courseSel.onchange = () => {
    const course = allCourses.find(c => c.id === courseSel.value);
    if (course?.tees?.length) {
      teeSel.innerHTML = course.tees.map(t => `<option value="${t.name}">${t.name}</option>`).join('');
      teeWrap.style.display = '';
    } else { teeWrap.style.display = 'none'; }
  };
  // Pre-select last used course
  try {
    const lastCourse = localStorage.getItem('lb-last-course');
    if (lastCourse) { courseSel.value = lastCourse; courseSel.dispatchEvent(new Event('change')); }
  } catch {}

  document.getElementById('tourn-date').value = new Date().toISOString().split('T')[0];

  // Seed slots: current user in slot 0, rest blank — renderGroupCards will pad to full count
  const myName = currentProfile
    ? `${currentProfile.first_name ?? ''} ${currentProfile.last_name ?? ''}`.trim() : '';
  tournSetupPlayers = [{ name: myName, hcp: currentProfile?.hcp ?? 0, profileId: currentUser.id, groupIndex: 0 }];

  renderGroupCards('tourn-group-cards', tournSetupNumGroups, tournSetupPlayers,
    (players) => { tournSetupPlayers = players; });
}

function renderGroupCards(containerId, numGroups, players, onUpdate) {
  const container = document.getElementById(containerId);
  if (!container) return;

  // Work out slots per group:
  // For team tournaments: teamSize. For individual: total players / numGroups (min 1).
  const type     = document.getElementById('tourn-type')?.value ?? 'individual';
  const teamSize = parseInt(document.getElementById('tourn-team-size')?.value) || 2;
  const slotsPerGroup = type === 'team'
    ? teamSize
    : Math.max(1, Math.ceil((players.length || numGroups) / numGroups));

  // Ensure players array has exactly numGroups × slotsPerGroup entries
  const totalSlots = numGroups * slotsPerGroup;
  while (players.length < totalSlots) {
    const gi = Math.floor(players.length / slotsPerGroup);
    players.push({ name: '', hcp: 0, profileId: null, groupIndex: gi });
  }
  // Re-assign groupIndex by position
  players.forEach((p, i) => { p.groupIndex = Math.floor(i / slotsPerGroup); });
  onUpdate(players);

  container.innerHTML = '';
  for (let g = 0; g < numGroups; g++) {
    const card = document.createElement('div');
    card.className = 'card mb-sm';
    card.innerHTML = `<div class="card-title">Group ${g + 1}</div>
      <div id="group-slots-${containerId}-${g}"></div>`;
    container.appendChild(card);
    renderGroupSlots(containerId, g, players, slotsPerGroup, onUpdate);
  }
}

function renderGroupSlots(containerId, g, players, slotsPerGroup, onUpdate) {
  const el = document.getElementById(`group-slots-${containerId}-${g}`);
  if (!el) return;
  const startIdx = g * slotsPerGroup;

  // Ensure exactly one scorer per group — default to first slot if none set
  const groupIdxs = Array.from({ length: slotsPerGroup }, (_, s) => startIdx + s);
  const hasScorer = groupIdxs.some(i => players[i]?.isScorer);
  if (!hasScorer && players[startIdx]) players[startIdx].isScorer = true;

  el.innerHTML = Array.from({ length: slotsPerGroup }, (_, s) => {
    const idx     = startIdx + s;
    const p       = players[idx] ?? { name: '', hcp: 0, profileId: null, isScorer: false };
    const isScorer = p.isScorer ?? false;
    const scorerStyle = isScorer
      ? 'background:var(--green);color:#fff;border-color:var(--green);'
      : 'background:var(--card);color:var(--muted);border-color:var(--border);';
    return `
      <div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.5rem;">
        <span class="dot" style="background:${pHex(idx % 8)};flex-shrink:0;"></span>
        <input id="gpname-${containerId}-${idx}" type="text" value="${p.name}"
          placeholder="Player ${s + 1} name"
          style="flex:1;background:none;border:none;border-bottom:1px solid var(--border);
                 color:var(--white);font-size:0.88rem;outline:none;padding-bottom:2px;">
        <input id="gphcp-${containerId}-${idx}" type="number" value="${p.hcp || ''}"
          placeholder="HCP" min="0" max="54" step="0.1"
          style="width:55px;background:none;border:none;border-bottom:1px solid var(--border);
                 color:var(--white);font-size:0.82rem;outline:none;text-align:center;padding-bottom:2px;">
        <button class="btn btn-ghost btn-set-scorer" data-idx="${idx}" data-g="${g}" data-cid="${containerId}"
          style="padding:0.2rem 0.45rem;font-size:0.65rem;flex-shrink:0;border-radius:5px;
                 border:1.5px solid;letter-spacing:0.04em;${scorerStyle}"
          title="${isScorer ? 'Scorer' : 'Set as scorer'}">✏️</button>
        <button class="btn btn-ghost btn-pick-friend" data-idx="${idx}" data-cid="${containerId}"
          style="padding:0.25rem 0.5rem;font-size:1rem;flex-shrink:0;opacity:0.7;"
          title="Pick from friends">👤</button>
      </div>`;
  }).join('');

  // Wire up inputs
  el.querySelectorAll('[id^="gpname-"]').forEach(inp => {
    const idx = parseInt(inp.id.split('-').pop());
    inp.addEventListener('input', e => { if (players[idx]) players[idx].name = e.target.value.trim(); onUpdate(players); });
  });
  el.querySelectorAll('[id^="gphcp-"]').forEach(inp => {
    const idx = parseInt(inp.id.split('-').pop());
    inp.addEventListener('input', e => { if (players[idx]) players[idx].hcp = parseFloat(e.target.value) || 0; onUpdate(players); });
  });

  // Scorer toggle — clear group, set tapped player
  el.querySelectorAll('.btn-set-scorer').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      groupIdxs.forEach(i => { if (players[i]) players[i].isScorer = false; });
      if (players[idx]) players[idx].isScorer = true;
      onUpdate(players);
      renderGroupSlots(containerId, g, players, slotsPerGroup, onUpdate);
    });
  });

  // Friend picker per slot
  el.querySelectorAll('.btn-pick-friend').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      openFriendPicker(-1, (friend) => {
        players[idx] = { ...players[idx], name: friend.name, hcp: friend.hcp ?? 0, profileId: friend.profileId ?? null };
        onUpdate(players);
        renderGroupSlots(containerId, g, players, slotsPerGroup, onUpdate);
      });
    });
  });
}

document.getElementById('tournament-players-back')?.addEventListener('click', () =>
  showScreen('screen-tournament-format'));

// Shared: flush inputs, then either create tournament (round 1) or start next round (round 2+)
// startNow=true → tee off immediately; false → save and go to tournament detail
async function _submitTournamentSetup(startNow) {
  // Flush in-flight input values from group cards
  document.querySelectorAll('[id^="gpname-tourn-group-cards-"]').forEach(inp => {
    const idx = parseInt(inp.id.split('-').pop());
    if (tournSetupPlayers[idx]) tournSetupPlayers[idx].name = inp.value.trim();
  });
  document.querySelectorAll('[id^="gphcp-tourn-group-cards-"]').forEach(inp => {
    const idx = parseInt(inp.id.split('-').pop());
    if (tournSetupPlayers[idx]) tournSetupPlayers[idx].hcp = parseFloat(inp.value) || 0;
  });

  const courseId = document.getElementById('tourn-course-select')?.value;
  const teeName  = document.getElementById('tourn-tee-select')?.value;
  const date     = document.getElementById('tourn-date')?.value;
  if (startNow && !courseId) { alert('Please select a course before starting.'); return; }

  const completedRounds = activeTournament
    ? activeTournRounds.filter(r => r.status === 'completed').length
    : 0;
  const isRound1 = !activeTournament || completedRounds === 0 && activeTournRounds.length === 0;

  const numGroups = tournSetupNumGroups;
  const btnNext  = document.getElementById('btn-tourn-players-next');
  const btnLater = document.getElementById('btn-tourn-save-later');
  [btnNext, btnLater].forEach(b => { if (b) b.disabled = true; });
  if (btnNext)  btnNext.textContent  = 'Saving…';
  if (btnLater) btnLater.textContent = 'Saving…';

  try {
    // ── Round 1: create tournament ────────────────────────────────
    if (isRound1) {
      if (tournSetupPlayers.filter(p => p.name).length < 2) { alert('Add at least 2 players.'); return; }

      const type = document.getElementById('tourn-type').value;
      tournGroups = Array.from({ length: numGroups }, (_, g) => ({ groupNumber: g + 1, players: [] }));

      const tourn = await _createTournamentAndPlayers(type);
      // Wire groups: activeTournPlayers are returned in same order as tournSetupPlayers (filtered to named)
      const namedSetup = tournSetupPlayers.filter(p => p.name);
      activeTournPlayers.forEach(tp => {
        const si = namedSetup.findIndex(sp => sp.name === tp.name);
        const gi = si >= 0 ? Math.min(namedSetup[si].groupIndex ?? 0, numGroups - 1) : 0;
        if (tournGroups[gi]) tournGroups[gi].players.push(tp.id);
      });
      if (courseId) {
        localStorage.setItem(`lb-tround-${tourn.id}`, JSON.stringify({
          courseId, teeName, date, numGroups, groups: tournGroups,
        }));
      }
      if (startNow) {
        await _teeOffRound(tourn.id, courseId, teeName, date);
      } else {
        await showTournamentDetail(tourn.id);
      }

    // ── Round 2+: save groups and optionally tee off ──────────────
    } else {
      // Rebuild tournGroups from current tournSetupPlayers
      tournGroups = Array.from({ length: numGroups }, (_, g) => ({ groupNumber: g + 1, players: [] }));
      tournSetupPlayers.forEach(p => {
        const gi = Math.min(p.groupIndex ?? 0, numGroups - 1);
        const tp = activeTournPlayers.find(ap => ap.id === p._tournId || ap.name === p.name);
        if (tp && tournGroups[gi]) tournGroups[gi].players.push(tp.id);
      });

      // Save adjustable handicaps if needed
      if (activeTournament.hcp_mode === 'adjustable') {
        for (const p of activeTournPlayers.filter(x => !x.excluded)) {
          const inp = document.getElementById(`trhcp-${p.id}`);
          if (inp) {
            const newHcp = parseFloat(inp.value) || p.current_hcp;
            if (newHcp !== p.current_hcp) {
              await tournamentPlayerUpdate(p.id, { current_hcp: newHcp });
              p.current_hcp = newHcp;
            }
          }
        }
      }

      // Read team format if applicable
      if (activeTournament?.tournament_type === 'team') {
        activeTournRoundFmt = document.getElementById('tround-game-format')?.value
          ?? activeTournament.team_format;
      }

      // Save state
      localStorage.setItem(`lb-tround-${activeTournament.id}`, JSON.stringify({
        courseId: courseId || '', teeName: teeName || '', date: date || '',
        numGroups, groups: tournGroups,
      }));

      if (startNow) {
        await _teeOffRound(activeTournament.id, courseId, teeName, date);
      } else {
        await showTournamentDetail(activeTournament.id);
      }
    }

  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    const rn = activeTournament
      ? activeTournRounds.filter(r => r.status === 'completed').length + 1 : 1;
    if (btnNext)  { btnNext.disabled  = false; btnNext.textContent  = `⛳ START ROUND ${rn} NOW →`; }
    if (btnLater) { btnLater.disabled = false; btnLater.textContent = '💾 Save & Start Later'; }
  }
}

// Perform the actual tee-off for a round
async function _teeOffRound(tournId, courseId, teeName, date) {
  if (!courseId) { alert('Please select a course.'); return; }
  const course = allCourses.find(c => c.id === courseId);
  const tee    = course?.tees?.find(t => t.name === teeName);
  if (!course || !tee) { alert('Please select a tee.'); return; }

  const completedRounds = activeTournRounds.filter(r => r.status === 'completed').length;
  const roundNumber     = completedRounds + 1;

  // Always reload rounds to get the freshest state — avoids duplicate key on retry
  activeTournRounds = await tournamentRoundsLoad(tournId);
  activeTournRound  = activeTournRounds.find(r => r.round_number === roundNumber) ?? null;

  let troundRecord = activeTournRound;
  if (!troundRecord) {
    troundRecord = await tournamentRoundCreate({
      tournamentId: tournId, roundNumber,
      courseName: course.name, teeName, date,
    });
  } else {
    await tournamentRoundUpdate(troundRecord.id, {
      course_name: course.name, tee_name: teeName, date, status: 'active',
    });
  }
  activeTournRound = troundRecord;

  // Ensure status is active and reload
  await tournamentRoundUpdate(troundRecord.id, { status: 'active' });
  activeTournRounds = await tournamentRoundsLoad(tournId);

  // Find current user's group and start game
  const myGroup = tournGroups.find(g =>
    g.players.includes(activeTournPlayers.find(p => p.profile_id === currentUser.id)?.id)
  ) ?? tournGroups[0];

  const groupPlayers = myGroup.players
    .map(pid => activeTournPlayers.find(p => p.id === pid))
    .filter(Boolean);

  const hcpArr = groupPlayers.map(p => p.current_hcp);
  const hcpObj = calcHandicaps(hcpArr, 100);
  const si     = tee.si;
  const par    = tee.par;

  const roundFormat = activeTournament.tournament_type === 'team'
    ? (activeTournRoundFmt ?? activeTournament.team_format ?? activeTournament.format)
    : activeTournament.format;

  setup.scoring    = roundFormat;
  setup.courseId   = courseId;
  setup.teeIdx     = course.tees.findIndex(t => t.name === teeName);
  setup.holes      = 18;
  setup.hcpPct     = 100;
  setup.players    = groupPlayers.map((p, i) => {
    const sp = tournSetupPlayers.find(sp =>
      (sp._tournId && sp._tournId === p.id) ||
      (sp.profileId && sp.profileId === p.profile_id) ||
      (sp.name && sp.name === p.name)
    );
    return {
      name:        p.name,
      hcpIndex:    p.current_hcp,
      groupNumber: myGroup.groupNumber,
      profileId:   p.profile_id ?? null,
      isScorer:    sp?.isScorer ?? (i === 0),
      mobile:      null,
      tournamentPlayerId: p.id,
    };
  });
  setup.numPlayers = setup.players.length;
  setup.numGroups  = 1;

  gameState = buildInitialState({
    format:           roundFormat,
    names:            groupPlayers.map(p => p.name),
    handicapIndexes:  hcpArr,
    playingHandicaps: hcpObj.map(h => h.playingHandicap),
    matchHandicaps:   hcpObj.map(h => h.matchHandicap),
    allowancePct:     100,
    si, par, numHoles: 18, holeOffset: 0,
    courseName: course.name, teeName,
    tournamentId:      activeTournament.id,
    tournamentRoundId: troundRecord.id,
    groupNumber:       myGroup.groupNumber,
  });

  const designatedScorer     = setup.players.find(p => p.isScorer);
  gameState.organiserId      = currentUser.id;
  gameState.scorerProfileId  = designatedScorer
    ? (designatedScorer.profileId ?? null)
    : currentUser.id;
  gameState.playerProfileIds = setup.players.map(p => p.profileId ?? null);

  try { localStorage.setItem(`lb-last-tee-${courseId}`, teeName); } catch {}
  const { allGroupStates, ...stateToSave } = gameState;
  roundId = await roundCreate({
    organiserId:  currentUser.id,
    courseName:   course.name,
    teeName,
    gameFormat:   activeTournament.format,
    hcpAllowance: 100,
    si, par, numHoles: 18, holeOffset: 0,
    numGroups:    tournGroups.length,
    playerNames:  groupPlayers.map(p => p.name),
    gameState:    stateToSave,
  });

  await tournamentRoundUpdate(troundRecord.id, { round_id: roundId });
  subscribeToRound(roundId);

  // If there are other groups, show invite links for their scorers before starting
  const otherGroups = tournGroups.filter(g => g.groupNumber !== myGroup.groupNumber);
  if (otherGroups.length > 0) {
    await showGroupInviteModal(otherGroups, troundRecord, course, roundFormat);
  } else {
    enterGameScreen();
  }
}

async function showRegularGameInviteModal(otherGroupScorers, course, tee, fmt) {
  console.log('[invite] showRegularGameInviteModal called', otherGroupScorers);
  const modal   = document.getElementById('modal-group-invites');
  const listEl  = document.getElementById('group-invites-list');
  const doneBtn = document.getElementById('btn-group-invites-done');
  const myName  = currentProfile
    ? `${currentProfile.first_name ?? ''} ${currentProfile.last_name ?? ''}`.trim()
    : 'Your organiser';

  listEl.innerHTML = otherGroupScorers.map(({ groupNumber, scorer }) => `
    <div style="padding:0.75rem;background:var(--surface2);border:1px solid var(--border);
                border-radius:var(--radius-sm);margin-bottom:0.75rem;">
      <div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;
                  letter-spacing:0.1em;margin-bottom:0.3rem;">
        Group ${groupNumber} scorer · ${scorer.name}
      </div>
      <div id="reg-invite-status-${groupNumber}"
        style="font-size:0.8rem;color:var(--muted);margin-bottom:0.5rem;">
        Sending invite…
      </div>
    </div>`).join('');

  modal.classList.add('open');

  // Send invites immediately since we already know who the scorers are
  await Promise.all(otherGroupScorers.map(async ({ groupNumber, scorer }) => {
    const statusEl = document.getElementById(`reg-invite-status-${groupNumber}`);
    try {
      await smsInviteCreate({
        roundId:            roundId,
        inviterId:          currentUser.id,
        name:               myName,
        mobile:             null,
        recipientProfileId: scorer.profileId,
        tournamentRoundId:  null,
        groupNumber,
      });
      if (statusEl) {
        statusEl.textContent = `✅ Invite sent to ${scorer.name}`;
        statusEl.style.color = 'var(--green)';
      }
    } catch (err) {
      console.error('[invite] smsInviteCreate failed:', err);
      if (statusEl) { statusEl.textContent = `⚠️ Error: ${err.message}`; statusEl.style.color = 'var(--red)'; }
    }
  }));

  doneBtn.onclick = () => { modal.classList.remove('open'); enterGameScreen(); };
  document.getElementById('group-invites-close').onclick = () => {
    modal.classList.remove('open'); enterGameScreen();
  };
}

async function showGroupInviteModal(otherGroups, troundRecord, course, roundFormat) {
  const modal   = document.getElementById('modal-group-invites');
  const listEl  = document.getElementById('group-invites-list');
  const doneBtn = document.getElementById('btn-group-invites-done');
  const myName  = currentProfile
    ? `${currentProfile.first_name ?? ''} ${currentProfile.last_name ?? ''}`.trim()
    : 'Your organiser';

  // Build one card per other group
  listEl.innerHTML = otherGroups.map(g => {
    const playerNames = g.players
      .map(pid => activeTournPlayers.find(p => p.id === pid)?.name)
      .filter(Boolean).join(', ');
    return `
      <div style="padding:0.75rem;background:var(--surface2);border:1px solid var(--border);
                  border-radius:var(--radius-sm);margin-bottom:0.75rem;">
        <div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;
                    letter-spacing:0.1em;margin-bottom:0.3rem;">
          Group ${g.groupNumber} · ${playerNames}
        </div>
        <div id="group-invite-status-${g.groupNumber}"
          style="font-size:0.8rem;color:var(--muted);margin-bottom:0.5rem;">
          No scorer invited yet
        </div>
        <button class="btn btn-outline btn-invite-scorer" data-g="${g.groupNumber}"
          style="width:100%;font-size:0.85rem;">
          👤 Invite Scorer from Friends
        </button>
      </div>`;
  }).join('');

  // Wire up friend picker per group
  listEl.querySelectorAll('.btn-invite-scorer').forEach(btn => {
    btn.addEventListener('click', () => {
      const gNum = parseInt(btn.dataset.g);
      const g    = otherGroups.find(x => x.groupNumber === gNum);
      openFriendPicker(-1, async (friend) => {
        if (!friend.profileId) {
          alert('This friend needs to have a Leaderboard account to receive an in-app invite.');
          return;
        }
        btn.disabled = true; btn.textContent = 'Sending…';
        try {
          await smsInviteCreate({
            roundId:             roundId,
            inviterId:           currentUser.id,
            name:                myName,
            mobile:              null,
            recipientProfileId:  friend.profileId,
            tournamentRoundId:   troundRecord.id,
            groupNumber:         gNum,
          });
          const statusEl = document.getElementById(`group-invite-status-${gNum}`);
          if (statusEl) {
            statusEl.textContent = `✅ Invite sent to ${friend.name}`;
            statusEl.style.color = 'var(--green)';
          }
          btn.textContent = '✅ Sent — invite another?';
          btn.disabled = false;
        } catch (err) {
          alert('Could not send invite: ' + err.message);
          btn.disabled = false;
          btn.textContent = '👤 Invite Scorer from Friends';
        }
      });
    });
  });

  modal.classList.add('open');

  doneBtn.onclick = () => { modal.classList.remove('open'); enterGameScreen(); };
  document.getElementById('group-invites-close').onclick = () => {
    modal.classList.remove('open'); enterGameScreen();
  };
}

document.getElementById('btn-tourn-players-next')?.addEventListener('click',
  () => _submitTournamentSetup(true));
document.getElementById('btn-tourn-save-later')?.addEventListener('click',
  () => _submitTournamentSetup(false));

// Shared tournament+player creation helper
async function _createTournamentAndPlayers(type) {
  const name        = document.getElementById('tourn-name').value.trim();
  const isOpenEnded = document.getElementById('tourn-open-ended').checked;
  const numRounds   = isOpenEnded ? null : parseInt(document.getElementById('tourn-num-rounds').value);
  const hcpMode     = document.getElementById('tourn-hcp-mode').value;
  const scoringMode = document.getElementById('tourn-scoring-mode').value;

  let tourn;
  if (type === 'team') {
    const teamFormat  = document.getElementById('tourn-team-format').value;
    const teamSize    = parseInt(document.getElementById('tourn-team-size').value);
    const rotation    = document.getElementById('tourn-rotation').value;
    const format      = ['foursomes','greensomes'].includes(teamFormat) ? 'stroke' : 'stableford';
    tourn = await tournamentCreate({
      organiserId: currentUser.id, name, format, numRounds, hcpMode, scoringMode,
      tournamentType: 'team', teamSize, teamRotation: rotation, teamFormat,
    });
  } else {
    const format = document.getElementById('tourn-format').value;
    tourn = await tournamentCreate({
      organiserId: currentUser.id, name, format, numRounds, hcpMode, scoringMode,
    });
  }

  const players = await tournamentPlayersAdd(tourn.id, tournSetupPlayers.filter(p => p.name).map(p => ({
    name: p.name, profileId: p.profileId ?? null, startingHcp: p.hcp,
  })));

  // Teams for fixed team tournaments
  if (type === 'team' && document.getElementById('tourn-rotation').value === 'fixed') {
    const teamSize = parseInt(document.getElementById('tourn-team-size').value);
    const numTeams = Math.ceil(tournSetupPlayers.length / teamSize);
    const teamData = Array.from({ length: numTeams }, (_, ti) => {
      const idxs = tournSetupPlayers.map((_, i) => i).filter(i => Math.floor(i / teamSize) === ti);
      const memberIds = idxs.map(pi => players[pi]?.id).filter(Boolean);
      const autoName  = defaultTeamName(idxs.map(pi => tournSetupPlayers[pi]?.name).filter(Boolean));
      return { name: autoName || `Team ${ti + 1}`, playerIds: memberIds };
    });
    await tournamentTeamsCreate(tourn.id, teamData);
  }

  // Reload so activeTournPlayers is available
  activeTournament     = await tournamentLoadById(tourn.id);
  activeTournPlayers   = await tournamentPlayersLoad(tourn.id);
  activeTournRounds    = await tournamentRoundsLoad(tourn.id);
  activeTournAllScores = [];
  if (activeTournament?.tournament_type === 'team') {
    activeTournTeams = await tournamentTeamsLoad(tourn.id);
  }
  return tourn;
}

// ----------------------------------------------------------------
// TOURNAMENT DETAIL
// ----------------------------------------------------------------
document.getElementById('tournament-detail-back')?.addEventListener('click', () => showTournaments());

document.getElementById('btn-edit-tournament-setup')?.addEventListener('click', () => {
  if (!activeTournament) return;
  // Pre-fill page 1 fields from active tournament
  document.getElementById('tourn-name').value = activeTournament.name ?? '';
  const type = activeTournament.tournament_type ?? 'individual';
  updateTournTypeToggle(type);
  document.getElementById('tourn-team-opts').style.display  = type === 'team' ? '' : 'none';
  document.getElementById('tourn-indiv-format-wrap').style.display = type === 'individual' ? '' : 'none';
  const isOpen = activeTournament.num_rounds == null;
  updateRoundsToggle(isOpen);
  if (!isOpen && activeTournament.num_rounds) {
    document.getElementById('tourn-num-rounds').value = activeTournament.num_rounds;
  }
  document.getElementById('tourn-scoring-mode').value = activeTournament.scoring_mode ?? 'cumulative';
  document.getElementById('tourn-hcp-mode').value     = activeTournament.hcp_mode ?? 'fixed';
  document.getElementById('tournament-setup-title').textContent = activeTournament.name;
  document.getElementById('tournament-setup-edit-btn').style.display = '';
  showScreen('screen-tournament-setup');
});

// ----------------------------------------------------------------
// TOURNAMENT ROUND COMPLETE SCREEN
// ----------------------------------------------------------------
async function showTournamentRoundComplete(tournamentId) {
  showScreen('screen-tournament-round-complete');

  // Load fresh data
  activeTournament     = await tournamentLoadById(tournamentId);
  activeTournPlayers   = await tournamentPlayersLoad(tournamentId);
  activeTournRounds    = await tournamentRoundsLoad(tournamentId);
  activeTournAllScores = await tournamentAllScoresLoad(tournamentId);
  if (activeTournament?.tournament_type === 'team') {
    activeTournTeams = await tournamentTeamsLoad(tournamentId);
  }

  const completedRounds = activeTournRounds.filter(r => r.status === 'completed');
  const lastRound       = completedRounds[completedRounds.length - 1];
  const roundNum        = lastRound?.round_number ?? 1;
  const totalRounds     = activeTournament.num_rounds;
  const isComplete      = completedRounds.length >= totalRounds;

  document.getElementById('trc-title').textContent = activeTournament.name;
  document.getElementById('trc-round-label').textContent =
    `Round ${roundNum} of ${totalRounds} — Complete`;

  // Round result summary
  if (lastRound) {
    const lastScores = activeTournAllScores.filter(s => s.tournament_round_id === lastRound.id);
    const isStroke   = activeTournament.format === 'stroke';
    const isTeam     = activeTournament.tournament_type === 'team';

    if (isTeam) {
      // Team tournament — show single team score
      const teamScore = lastScores.find(s => !s.absent)?.points ?? 0;
      document.getElementById('trc-round-result').innerHTML = `
        <div style="text-align:center;padding:1rem 0;">
          <div style="font-size:0.7rem;letter-spacing:0.12em;color:var(--muted);margin-bottom:0.25rem;">TEAM SCORE</div>
          <div style="font-size:3rem;font-weight:700;color:var(--gold);">${teamScore}</div>
          <div style="font-size:0.78rem;color:var(--muted);">pts · best 2 scores combined</div>
        </div>`;
    } else {
      const sorted = [...lastScores].filter(s => !s.absent).sort((a, b) =>
        isStroke ? a.net_score - b.net_score : b.points - a.points
      );
      const resultLines = sorted.map((s, i) => {
        const player = activeTournPlayers.find(p => p.id === s.tournament_player_id);
        const score  = isStroke ? `${s.net_score} net` : `${s.points} pts`;
        const medal  = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
        return `<div style="display:flex;justify-content:space-between;padding:0.3rem 0;
                 border-bottom:1px solid var(--border);font-size:0.85rem;">
          <span>${medal} ${player?.name ?? '--'}</span>
          <span style="color:var(--gold);font-weight:600;">${score}</span>
        </div>`;
      }).join('');
      document.getElementById('trc-round-result').innerHTML = resultLines ||
        '<div style="color:var(--muted);">No scores recorded.</div>';
    }
  }

  // Tournament standings
  renderTrcStandings();

  // Next round button
  const nextBtn = document.getElementById('trc-next-round-btn');
  if (isComplete) {
    nextBtn.textContent = '🏆 Tournament Complete';
    nextBtn.disabled    = true;
    nextBtn.className   = 'btn btn-outline';
  } else {
    nextBtn.textContent = `⛳ SET UP ROUND ${roundNum + 1} →`;
    nextBtn.disabled    = false;
    nextBtn.className   = 'btn btn-green';
  }
}

function renderTrcStandings() {
  const el = document.getElementById('trc-standings');
  // Route to team standings for team tournaments
  if (activeTournament?.tournament_type === 'team') {
    renderTeamStandings(el);
    return;
  }
  const scoringMode = activeTournament.scoring_mode ?? 'cumulative';
  const standings   = buildStandings(
    activeTournPlayers, activeTournRounds, activeTournAllScores,
    activeTournament.format, scoringMode
  );

  const isStroke     = scoringMode === 'stroke';
  const isPointsGame = scoringMode === 'points_game';
  const modeLabel    = { cumulative: 'Pts', stroke: 'Net', points_game: 'T.Pts' }[scoringMode] ?? 'Total';

  let html = `<table class="sc-table" style="width:100%;font-size:0.82rem;">
    <thead><tr>
      <th style="text-align:left;">Player</th>
      <th>HCP</th>`;

  activeTournRounds.filter(r => r.status === 'completed').forEach(r => {
    const d = r.date ? new Date(r.date).toLocaleDateString('en-GB', { day:'numeric', month:'short' }) : `R${r.round_number}`;
    html += `<th>${d}</th>`;
  });
  html += `<th style="color:var(--gold);">${modeLabel}</th>`;
  if (isStroke) html += `<th style="color:var(--muted);">Gross</th>`;
  html += '</tr></thead><tbody>';

  standings.forEach((row, idx) => {
    const isLead = idx === 0;
    html += `<tr${isLead ? ' style="background:rgba(212,168,67,0.06);"' : ''}>
      <td style="text-align:left;font-weight:${isLead?'700':'500'};color:${isLead?'var(--gold)':''};">
        ${row.position}. ${row.name}
      </td>
      <td style="color:var(--muted);font-size:0.75rem;">${row.currentHcp}</td>`;

    activeTournRounds.filter(r => r.status === 'completed').forEach(r => {
      const rr = row.roundResults.find(x => x.roundId === r.id);
      let val = '--';
      if (!rr?.absent) {
        if (isPointsGame)  val = rr?.tournPts ?? '--';
        else if (isStroke) val = rr?.net      ?? '--';
        else               val = rr?.pts      ?? '--';
      }
      html += `<td>${val}</td>`;
    });

    html += `<td style="color:var(--gold);font-weight:700;">${row.total ?? '--'}</td>`;
    if (isStroke) html += `<td style="color:var(--muted);">${row.totalGross ?? '--'}</td>`;
    html += '</tr>';
  });

  html += '</tbody></table>';
  if (el) el.innerHTML = html;
  else document.getElementById('trc-standings').innerHTML = html;
}

// Wire up buttons
document.getElementById('trc-next-round-btn')?.addEventListener('click', () => showTournamentRoundSetup());
document.getElementById('trc-home-btn')      ?.addEventListener('click', () => showHome());
document.getElementById('trc-home-btn2')     ?.addEventListener('click', () => showHome());
document.getElementById('trc-share-btn')     ?.addEventListener('click', async () => {
  const url = buildTournamentViewUrl(APP_URL, activeTournament.id);
  const copied = document.getElementById('trc-share-copied');
  if (navigator.share) {
    try {
      await navigator.share({
        title: activeTournament.name,
        text:  `${activeTournament.name} — final leaderboard`,
        url,
      });
    } catch {}
  } else {
    await navigator.clipboard.writeText(url);
    if (copied) {
      copied.style.display = 'block';
      setTimeout(() => { copied.style.display = 'none'; }, 3000);
    }
  }
});

async function showTournamentDetail(tournamentId) {
  showScreen('screen-tournament-detail');

  try {
    activeTournament    = await tournamentLoadById(tournamentId);
    activeTournPlayers  = await tournamentPlayersLoad(tournamentId);
    activeTournRounds   = await tournamentRoundsLoad(tournamentId);
    activeTournAllScores = await tournamentAllScoresLoad(tournamentId);
    // Load teams if team tournament
    if (activeTournament?.tournament_type === 'team') {
      activeTournTeams = await tournamentTeamsLoad(tournamentId);
    }
  } catch (err) {
    alert('Could not load tournament: ' + err.message); return;
  }

  document.getElementById('td-tournament-name').textContent = activeTournament.name;

  // Meta info
  const metaEl = document.getElementById('td-meta');
  if (metaEl) {
    const typeLabel   = activeTournament.tournament_type === 'team' ? '👥 Team' : '👤 Individual';
    const roundsLabel = activeTournament.num_rounds ? `${activeTournament.num_rounds} rounds` : 'Open-ended';
    const modeLabel   = { cumulative: 'Cumulative', stroke: 'Total Stroke', points_game: 'Points per Game' }[activeTournament.scoring_mode] ?? '';
    const statusLabel = activeTournament.status === 'completed' ? ' · ✓ Complete' : '';
    metaEl.textContent = `${typeLabel} · ${roundsLabel} · ${modeLabel}${statusLabel}`;
  }

  renderTournamentStandings();
  renderTournamentRoundsList();

  // Show/hide start next round button
  const completedRounds = activeTournRounds.filter(r => r.status === 'completed').length;
  const nextRoundNum    = completedRounds + 1;
  const btn             = document.getElementById('btn-start-next-round');
  const isCompleted     = activeTournament.status === 'completed';
  const isFixedComplete = activeTournament.num_rounds && completedRounds >= activeTournament.num_rounds;

  // Show Live Leaderboard button only when a round is currently active
  const hasActiveRound = activeTournRounds.some(r => r.status === 'active');
  const liveBtn = document.getElementById('btn-view-leaderboard');
  if (liveBtn) liveBtn.style.display = hasActiveRound ? '' : 'none';

  if (isCompleted || isFixedComplete) {
    btn.textContent = '✓ Tournament Complete';
    btn.disabled    = true;
    btn.className   = 'btn btn-outline';
  } else if (completedRounds === 0) {
    btn.textContent = '▶ Start Round 1 →';
    btn.disabled    = false;
    btn.className   = 'btn btn-green';
  } else {
    btn.textContent = `⛳ SET UP ROUND ${nextRoundNum} →`;
    btn.disabled    = false;
    btn.className   = 'btn btn-green';
  }

  // Show/hide finish button — only show if not already completed
  const finishBtn = document.getElementById('btn-finish-tournament');
  if (finishBtn) finishBtn.style.display = isCompleted ? 'none' : '';
}

function renderTournamentStandings() {
  const el          = document.getElementById('td-standings');
  const scoringMode = activeTournament.scoring_mode ?? 'cumulative';
  const format      = activeTournament.format ?? 'stableford';
  const teamFormat  = activeTournament.team_format;

  // Build a human-readable scoring descriptor
  const formatLabels = {
    stableford: 'Stableford pts', stroke: 'Net strokes',
    best2: 'Best 2 of 3 pts', betterball: 'Better Ball pts',
    foursomes: 'Foursomes strokes', greensomes: 'Greensomes strokes',
    csm: 'CSM pts', split6: 'Split 6 pts',
  };
  const modeLabels = {
    cumulative: 'cumulative', stroke: 'total strokes', points_game: 'points per game',
  };
  const fmtLabel  = formatLabels[teamFormat ?? format] ?? format;
  const modeLabel = modeLabels[scoringMode] ?? scoringMode;
  const subtitle  = `${fmtLabel} · ${modeLabel}`;

  // Update the anchor label to include the subtitle
  const anchor = document.getElementById('td-standings-anchor');
  if (anchor) {
    anchor.innerHTML = `Standings <span style="font-size:0.6rem;color:var(--muted);font-weight:normal;
      letter-spacing:0.05em;text-transform:none;margin-left:0.5rem;">${subtitle}</span>`;
  }

  // Team tournament — use team standings renderer
  if (activeTournament?.tournament_type === 'team') {
    renderTeamStandings(el);
    return;
  }
  const standings = buildStandings(
    activeTournPlayers, activeTournRounds, activeTournAllScores,
    activeTournament.format, scoringMode
  );

  const isStroke      = scoringMode === 'stroke';
  const isPointsGame  = scoringMode === 'points_game';

  if (!standings.length) {
    el.innerHTML = '<div class="text-muted" style="font-size:0.82rem;">No rounds completed yet.</div>';
    return;
  }

  const colLabel = { cumulative: 'Pts', stroke: 'Net', points_game: 'T.Pts' }[scoringMode] ?? 'Total';

  let html = `<table class="sc-table" style="width:100%;font-size:0.75rem;">
    <thead><tr>
      <th style="text-align:left;">Player</th>
      <th>HCP</th>`;

  activeTournRounds.filter(r => r.status === 'completed').forEach(r => {
    const d = r.date ? new Date(r.date).toLocaleDateString('en-GB', { day:'numeric', month:'short' }) : `R${r.round_number}`;
    html += `<th title="${r.course_name ?? ''}">${d}</th>`;
  });

  html += `<th style="color:var(--gold);">${colLabel}</th>`;
  if (isStroke) html += '<th style="color:var(--muted);">Gross</th>';
  html += '</tr></thead><tbody>';

  standings.forEach((row, idx) => {
    const isLead = idx === 0;
    html += `<tr${isLead ? ' style="background:rgba(212,168,67,0.06);"' : ''}>
      <td style="text-align:left;font-weight:${isLead?'700':'500'};color:${isLead?'var(--gold)':''};">
        ${row.position}. ${row.name}
      </td>
      <td style="color:var(--muted);">${row.currentHcp}</td>`;

    activeTournRounds.filter(r => r.status === 'completed').forEach(r => {
      const rr = row.roundResults.find(x => x.roundId === r.id);
      let val = '--';
      if (!rr?.absent) {
        if (isPointsGame)   val = rr?.tournPts ?? '--';
        else if (isStroke)  val = rr?.net      ?? '--';
        else                val = rr?.pts      ?? '--';
      }
      html += `<td>${val}</td>`;
    });

    html += `<td style="color:var(--gold);font-weight:700;">${row.total || '--'}</td>`;
    if (isStroke) html += `<td style="color:var(--muted);">${row.totalGross || '--'}</td>`;
    html += '</tr>';
  });

  html += '</tbody></table>';
  el.innerHTML = html;
}

function renderTournamentRoundsList() {
  const el          = document.getElementById('td-rounds');
  const numRounds   = activeTournament.num_rounds;
  const isOpenEnded = !numRounds;
  const isCompleted = activeTournament.status === 'completed';

  const displayCount = isOpenEnded
    ? activeTournRounds.length + (isCompleted ? 0 : 1)
    : numRounds;

  el.innerHTML = Array.from({ length: displayCount }, (_, i) => {
    const r = activeTournRounds.find(x => x.round_number === i + 1);
    const statusBadge = !r
      ? `<span class="badge badge-blue">PENDING</span>`
      : r.status === 'completed'
        ? `<span class="badge badge-gold">COMPLETE</span>`
        : `<span class="badge badge-green">IN PROGRESS</span>`;

    const sub = r
      ? `${r.course_name ?? '--'} · ${r.tee_name ?? ''} · ${r.date ? new Date(r.date).toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric'}) : ''}`
      : 'Not started';

    // Clickable if completed (scorecard) or active (resume); pending rows are inert
    const clickable = r && (r.status === 'completed' || r.status === 'active');
    const cursor    = clickable ? 'cursor:pointer;' : '';
    const dataAttr  = r ? `data-round-id="${r.id}" data-round-status="${r.status}"` : '';

    return `
      <div class="round-row" ${dataAttr}
        style="display:flex;align-items:center;gap:0.75rem;padding:0.65rem 0.85rem;
               background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);
               margin-bottom:0.35rem;${cursor}">
        <div style="font-family:'Barlow Condensed',sans-serif;font-size:1.3rem;font-weight:700;color:var(--gold);min-width:2rem;">
          R${i+1}
        </div>
        <div style="flex:1;">
          <div style="font-size:0.85rem;">${sub}</div>
        </div>
        ${statusBadge}
        ${clickable ? `<span style="font-size:0.8rem;color:var(--muted);">›</span>` : ''}
      </div>`;
  }).join('');

  el.querySelectorAll('[data-round-id]').forEach(row => {
    const status = row.dataset.roundStatus;
    if (status === 'active') {
      row.addEventListener('click', () => resumeTournamentRound(row.dataset.roundId));
    } else if (status === 'completed') {
      row.addEventListener('click', () => {
        // Show the live leaderboard screen focused on this round
        const tround = activeTournRounds.find(r => r.id === row.dataset.roundId);
        showTournamentRoundScorecard(tround);
      });
    }
  });
}

// Show a completed round's hole-by-hole scorecard in the landscape overlay
async function showTournamentRoundScorecard(tround) {
  if (!tround) return;

  if (!tround.round_id) {
    alert('No scorecard saved for this round yet.');
    return;
  }

  try {
    const round = await roundLoadById(tround.round_id);
    if (!round?.game_state) { alert('Scorecard not available.'); return; }

    const state = round.game_state;
    const allStates = state.allGroupStates ?? [state];
    const displayState = mergeGroupStates(allStates);
    const dateStr = tround.date
      ? new Date(tround.date).toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric'})
      : '';

    document.getElementById('sc-overlay-title').textContent =
      `R${tround.round_number} · ${tround.course_name ?? ''}`;
    document.getElementById('sc-overlay-sub').textContent =
      `${tround.tee_name ?? ''} · ${dateStr}`;
    document.getElementById('sc-overlay-body').innerHTML =
      buildLandscapeScorecard(displayState, { showEdit: false, showChallenge: false });

    document.getElementById('scorecard-overlay').classList.add('open');
  } catch (err) {
    alert('Could not load scorecard: ' + err.message);
  }
}

// ----------------------------------------------------------------
// START NEXT ROUND
// ----------------------------------------------------------------
document.getElementById('btn-td-leaderboard')?.addEventListener('click', () => {
  document.getElementById('td-standings-anchor')
    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
document.getElementById('btn-view-leaderboard')?.addEventListener('click', () => showTournamentLive());
document.getElementById('btn-start-next-round')?.addEventListener('click', async () => {
  await showTournamentRoundSetup();
});

async function showTournamentRoundSetup() {
  const completedRounds = activeTournRounds.filter(r => r.status === 'completed').length;
  const roundNumber     = completedRounds + 1;
  activeTournRound      = activeTournRounds.find(r => r.round_number === roundNumber) ?? null;

  const roundsLabel = activeTournament.num_rounds ? `of ${activeTournament.num_rounds}` : '';
  document.getElementById('tourn-players-title').textContent = `Round ${roundNumber} ${roundsLabel} Setup`.trim();

  // Course & date — pre-fill from saved state or previous round
  const saved       = restoreTroundSetup();
  const courseSel   = document.getElementById('tourn-course-select');
  const teeWrap     = document.getElementById('tourn-tee-wrap');
  const teeSel      = document.getElementById('tourn-tee-select');
  const dateInp     = document.getElementById('tourn-date');

  courseSel.innerHTML = '<option value="">-- Select course --</option>';
  allCourses.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id; opt.textContent = c.name;
    const matchSaved = saved?.courseId && c.id === saved.courseId;
    const matchRound = !saved && activeTournRound?.course_name === c.name;
    if (matchSaved || matchRound) opt.selected = true;
    courseSel.appendChild(opt);
  });
  courseSel.onchange = () => {
    const course = allCourses.find(c => c.id === courseSel.value);
    if (course?.tees?.length) {
      teeSel.innerHTML = course.tees.map(t => `<option value="${t.name}">${t.name}</option>`).join('');
      teeWrap.style.display = '';
    } else { teeWrap.style.display = 'none'; }
  };
  if (courseSel.value) courseSel.dispatchEvent(new Event('change'));
  // Restore tee selection
  if (saved?.teeName) teeSel.value = saved.teeName;
  dateInp.value = saved?.date ?? new Date().toISOString().split('T')[0];

  // Adjustable HCP card (round 2+)
  const hcpCard = document.getElementById('tround-hcp-card');
  if (activeTournament.hcp_mode === 'adjustable' && roundNumber > 1) {
    hcpCard.style.display = '';
    renderTroundHcpRows();
  } else {
    hcpCard.style.display = 'none';
  }

  // Auto HCP adjustment (round 2+)
  if (activeTournament.hcp_mode === 'auto' && completedRounds > 0) {
    await showAutoHcpAdjustment();
  }

  // Team format card
  const formatCard = document.getElementById('tround-format-card');
  const formatSel  = document.getElementById('tround-game-format');
  if (activeTournament?.tournament_type === 'team' && formatCard && formatSel) {
    formatCard.style.display = '';
    const teamSize = parseInt(activeTournament.team_size) || 2;
    const formats  = TOURN_TEAM_FORMATS[teamSize] ?? TOURN_TEAM_FORMATS[2];
    const prevFmt  = activeTournRoundFmt ?? activeTournament.team_format ?? formats[0].value;
    formatSel.innerHTML = formats.map(f =>
      `<option value="${f.value}"${f.value === prevFmt ? ' selected' : ''}>${f.label}</option>`).join('');
  } else if (formatCard) {
    formatCard.style.display = 'none';
  }

  // Build group cards pre-filled from previous round groups
  const prevGroups = saved?.groups ?? [];
  const players    = activeTournPlayers.filter(p => !p.excluded);
  tournSetupNumGroups = prevGroups.length || 1;

  // Rebuild tournSetupPlayers from activeTournPlayers with saved group assignments
  tournSetupPlayers = players.map(p => {
    const gi = prevGroups.findIndex(g => g.players.includes(p.id));
    return {
      name:       p.name,
      hcp:        p.current_hcp,
      profileId:  p.profile_id ?? null,
      groupIndex: Math.max(0, gi),
      _tournId:   p.id,
    };
  });

  renderGroupCards('tourn-group-cards', tournSetupNumGroups, tournSetupPlayers,
    (pl) => { tournSetupPlayers = pl; });

  // Update button labels for round N
  const btnNext  = document.getElementById('btn-tourn-players-next');
  const btnLater = document.getElementById('btn-tourn-save-later');
  if (btnNext)  btnNext.textContent  = `⛳ START ROUND ${roundNumber} NOW →`;
  if (btnLater) btnLater.textContent = `💾 Save & Start Later`;

  // Back goes to tournament detail
  document.getElementById('tournament-players-back').onclick =
    () => showTournamentDetail(activeTournament.id);

  showScreen('screen-tournament-players');
}

function renderTroundHcpRows() {
  const el = document.getElementById('tround-hcp-rows');
  el.innerHTML = activeTournPlayers.filter(p => !p.excluded).map((p, i) => `
    <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.4rem;">
      <span style="flex:1;font-size:0.85rem;">${p.name}</span>
      <input id="trhcp-${p.id}" type="number" value="${p.current_hcp}" min="0" max="54" step="0.1"
        style="width:70px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;
               padding:0.3rem 0.5rem;color:var(--white);font-size:0.85rem;text-align:center;">
    </div>`).join('');
}

// ── Course selection for tournament round ────────────────────────
// ── Auto-save/restore round setup state ─────────────────────────
function saveTroundSetup() {
  if (!activeTournament) return;
  try {
    const state = {
      courseId:  document.getElementById('tourn-course-select')?.value ?? '',
      teeName:   document.getElementById('tourn-tee-select')?.value ?? '',
      date:      document.getElementById('tourn-date')?.value ?? '',
      numGroups: tournSetupNumGroups,
      groups:    tournGroups,
    };
    localStorage.setItem(`lb-tround-${activeTournament.id}`, JSON.stringify(state));
  } catch {}
}

function restoreTroundSetup() {
  if (!activeTournament) return null;
  try {
    const raw = localStorage.getItem(`lb-tround-${activeTournament.id}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ── Resume tournament round ───────────────────────────────────────
async function resumeTournamentRound(troundId) {
  const tround = activeTournRounds.find(r => r.id === troundId);
  if (!tround?.round_id) return;
  await resumeRound(tround.round_id);
}

// ── Auto HCP Adjustment Modal ────────────────────────────────────
async function showAutoHcpAdjustment() {
  // Get the last completed round
  const lastRound = [...activeTournRounds]
    .filter(r => r.status === 'completed')
    .sort((a, b) => b.round_number - a.round_number)[0];
  if (!lastRound) return;

  const lastScores = await tournamentScoresLoad(lastRound.id);
  const adjustments = calcHandicapAdjustments(
    activeTournPlayers, lastScores, activeTournament.format
  );

  if (!adjustments.length) return;

  const rowsEl = document.getElementById('hcp-adjust-rows');
  rowsEl.innerHTML = adjustments.map(a => `
    <div style="display:flex;justify-content:space-between;align-items:center;
         padding:0.5rem 0;border-bottom:1px solid var(--border);">
      <span style="font-size:0.85rem;">${a.name}</span>
      <span style="font-size:0.82rem;">
        <span style="color:var(--muted);">${a.oldHcp}</span>
        <span style="margin:0 4px;">→</span>
        <span style="color:${a.delta < 0 ? 'var(--green)' : 'var(--red)'};font-weight:600;">
          ${a.newHcp}
        </span>
        <span style="font-size:0.7rem;color:var(--muted);">
          (${a.delta > 0 ? '+' : ''}${a.delta})
        </span>
      </span>
    </div>`).join('');

  document.getElementById('modal-hcp-adjust').classList.add('open');

  // Store adjustments for confirmation
  document.getElementById('btn-hcp-adjust-confirm').onclick = async () => {
    for (const a of adjustments) {
      await tournamentPlayerUpdate(a.playerId, { current_hcp: a.newHcp });
      const p = activeTournPlayers.find(x => x.id === a.playerId);
      if (p) p.current_hcp = a.newHcp;
    }
    document.getElementById('modal-hcp-adjust').classList.remove('open');
  };
}

document.getElementById('hcp-adjust-close')?.addEventListener('click', () => {
  document.getElementById('modal-hcp-adjust').classList.remove('open');
});

// ── Share tournament ─────────────────────────────────────────────
document.getElementById('btn-share-tournament')?.addEventListener('click', () => {
  const url = buildTournamentViewUrl(APP_URL, activeTournament.id);
  const msg = `Follow the ${activeTournament.name} leaderboard here:\n${url}`;
  if (navigator.share) {
    navigator.share({ title: activeTournament.name, text: msg, url }).catch(() => {});
  } else {
    navigator.clipboard.writeText(msg).then(() => {
      alert('Link copied to clipboard!');
    });
  }
});

// ── Delete tournament ────────────────────────────────────────────
document.getElementById('btn-delete-tournament')?.addEventListener('click', async () => {
  if (!confirm(`Delete "${activeTournament.name}"? This cannot be undone.`)) return;
  try {
    await tournamentDelete(activeTournament.id);
    await showTournaments();
  } catch (err) {
    alert('Could not delete: ' + err.message);
  }
});

// ----------------------------------------------------------------
// TOURNAMENT LIVE LEADERBOARD
// ----------------------------------------------------------------
document.getElementById('tlive-back')?.addEventListener('click', () => {
  if (gameState?.tournamentId) showScreen('screen-game');
  else if (activeTournament) showTournamentDetail(activeTournament.id);
  else showScreen('screen-home');
});
document.getElementById('btn-game-leaderboard')?.addEventListener('click', () => {
  // If in a tournament round, show tournament leaderboard, else show regular
  if (gameState?.tournamentId) showTournamentLive();
  else showLeaderboard();
});

function showTournamentLive() {
  showScreen('screen-tournament-live');
  const fmt = activeTournament?.format ?? gameState?.format;
  document.getElementById('tlive-title').textContent =
    activeTournament?.name ?? 'Live Leaderboard';
  document.getElementById('tlive-meta').textContent =
    `${gameState?.courseName ?? ''} · Round ${activeTournRounds.filter(r=>r.status!=='pending').length}`;

  renderTliveRound();
  renderTliveTournament();

  // Subscribe for live updates
  if (activeTournament && !tournRealtimeCh) {
    tournRealtimeCh = realtimeSubscribeTournament(activeTournament.id, async () => {
      activeTournAllScores = await tournamentAllScoresLoad(activeTournament.id);
      renderTliveRound();
      renderTliveTournament();
    });
  }
}

document.getElementById('tlive-tab-round')?.addEventListener('click', () => {
  document.getElementById('tlive-tab-round').className      = 'btn btn-primary';
  document.getElementById('tlive-tab-tournament').className = 'btn btn-outline';
  document.getElementById('tlive-round-table').style.display      = '';
  document.getElementById('tlive-tournament-table').style.display = 'none';
});

document.getElementById('tlive-tab-tournament')?.addEventListener('click', () => {
  document.getElementById('tlive-tab-tournament').className = 'btn btn-primary';
  document.getElementById('tlive-tab-round').className      = 'btn btn-outline';
  document.getElementById('tlive-tournament-table').style.display = '';
  document.getElementById('tlive-round-table').style.display      = 'none';
});

function renderTliveRound() {
  const el = document.getElementById('tlive-round-table');
  if (!gameState) { el.innerHTML = ''; return; }
  // Use existing multi-group leaderboard logic
  const states = gameState.allGroupStates ?? [gameState];
  const rows   = buildMultiGroupLeaderboard(states);
  const fmt    = gameState.format;
  const isStableford = fmt === 'stableford';
  const isStroke     = fmt === 'stroke';

  let html = `<table class="sc-table" style="width:100%;"><thead><tr>
    <th style="text-align:left;">Player</th>
    <th>Grp</th><th>Holes</th><th>Gross</th>
    ${isStroke ? '<th style="color:var(--green);">Net</th>' : ''}
    ${isStableford ? '<th style="color:var(--gold);">Pts</th>' : ''}
  </tr></thead><tbody>`;

  rows.forEach((row, rank) => {
    html += `<tr${rank===0?' style="background:rgba(212,168,67,0.06);"':''}>
      <td style="font-weight:${rank===0?'700':'500'};color:${rank===0?'var(--gold)':''};text-align:left;">
        ${rank+1}. ${row.name}
      </td>
      <td>${row.group}</td>
      <td>${row.holesPlayed}</td>
      <td>${row.gross||'--'}</td>
      ${isStroke?`<td style="color:var(--green);font-weight:600;">${row.net??'--'}</td>`:''}
      ${isStableford?`<td style="color:var(--gold);font-weight:700;">${row.pts??'--'}</td>`:''}
    </tr>`;
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

function renderTliveTournament() {
  const el = document.getElementById('tlive-tournament-table');
  if (!activeTournament) { el.innerHTML = ''; return; }
  const standings = buildStandings(
    activeTournPlayers, activeTournRounds, activeTournAllScores, activeTournament.format
  );
  const isStroke = activeTournament.format === 'stroke';
  let html = `<table class="sc-table" style="width:100%;"><thead><tr>
    <th style="text-align:left;">Player</th><th>HCP</th>
    <th style="color:${isStroke?'var(--green)':'var(--gold)'};">Total</th>
    ${isStroke?'<th style="color:var(--muted);">Gross</th>':''}
  </tr></thead><tbody>`;
  standings.forEach((row, idx) => {
    html += `<tr${idx===0?' style="background:rgba(212,168,67,0.06);"':''}>
      <td style="font-weight:${idx===0?'700':'500'};color:${idx===0?'var(--gold)':''};text-align:left;">
        ${row.position}. ${row.name}
      </td>
      <td style="color:var(--muted);">${row.currentHcp}</td>
      <td style="font-weight:600;color:${isStroke?'var(--green)':'var(--gold)'};">${row.total||'--'}</td>
      ${isStroke?`<td style="color:var(--muted);">${row.totalGross||'--'}</td>`:''}
    </tr>`;
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

// ----------------------------------------------------------------
// TOURNAMENT PUBLIC VIEW (via link ?tournament=id)
// ----------------------------------------------------------------
async function handleTournamentViewLink(tournamentId) {
  showScreen('screen-tournament-view');
  try {
    const tourn   = await tournamentLoadById(tournamentId);
    const players = await tournamentPlayersLoad(tournamentId);
    const rounds  = await tournamentRoundsLoad(tournamentId);
    const scores  = await tournamentAllScoresLoad(tournamentId);

    document.getElementById('tview-title').textContent = tourn.name;
    document.getElementById('tview-meta').textContent  =
      `${fmtLabel(tourn.format)} · ${rounds.filter(r=>r.status==='completed').length} of ${tourn.num_rounds} rounds completed`;

    const standings = buildStandings(players, rounds, scores, tourn.format, tourn.scoring_mode ?? 'cumulative');
    const isStroke  = tourn.format === 'stroke';

    let html = `<table class="sc-table" style="width:100%;font-size:0.78rem;">
      <thead><tr>
        <th style="text-align:left;">Player</th><th>HCP</th>`;
    rounds.filter(r=>r.status==='completed').forEach(r => {
      const d = r.date ? new Date(r.date).toLocaleDateString('en-GB',{day:'numeric',month:'short'}) : `R${r.round_number}`;
      html += `<th>${d}</th>`;
    });
    html += `<th style="color:${isStroke?'var(--green)':'var(--gold)'};">Total</th>`;
    if (isStroke) html += '<th>Gross</th>';
    html += '</tr></thead><tbody>';

    standings.forEach((row, idx) => {
      html += `<tr${idx===0?' style="background:rgba(212,168,67,0.06);"':''}>
        <td style="text-align:left;font-weight:${idx===0?'700':'500'};color:${idx===0?'var(--gold)':''};">
          ${row.position}. ${row.name}
        </td>
        <td style="color:var(--muted);">${row.currentHcp}</td>`;
      rounds.filter(r=>r.status==='completed').forEach(r => {
        const rr = row.roundResults.find(x => x.roundId === r.id);
        html += `<td>${rr?.absent?'--':isStroke?(rr?.net??'--'):(rr?.pts??'--')}</td>`;
      });
      html += `<td style="font-weight:700;color:${isStroke?'var(--green)':'var(--gold)'};">${row.total||'--'}</td>`;
      if (isStroke) html += `<td style="color:var(--muted);">${row.totalGross||'--'}</td>`;
      html += '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('tview-standings').innerHTML = html;
  } catch (err) {
    document.getElementById('tview-standings').innerHTML =
      `<div class="history-empty">Could not load tournament: ${err.message}</div>`;
  }
}

// ----------------------------------------------------------------
// SAVE TOURNAMENT SCORES after round completes
// ----------------------------------------------------------------
async function saveTournamentScores() {
  if (!gameState?.tournamentId || !gameState?.tournamentRoundId) return;
  try {
    const tournId   = gameState.tournamentId;
    const tRoundId  = gameState.tournamentRoundId;

    // Safety net: if activeTournPlayers wasn't loaded (e.g. resumed via auto-resume
    // on sign-in), reload it now so absent players in other groups are correctly written.
    if (!activeTournPlayers?.length) {
      activeTournPlayers = await tournamentPlayersLoad(tournId);
    }

    const players   = activeTournPlayers.filter(p => !p.excluded);
    const format    = gameState.format; // use gameState not activeTournament
    const isStroke  = format === 'stroke';
    const log       = gameState.log ?? [];

    const isBest2   = format === 'best2';
    const teamScore = isBest2 ? (gameState.groupTotal ?? 0) : null;

    // Calculate scores from game state
    const scores = setup.players.map((sp, i) => {
      const gross = log.reduce((s, e) => s + (e.grosses?.[i] ?? 0), 0);
      const net   = isStroke ? (gameState.totals?.[i] ?? 0) : null;
      // For best2: all players in the group share the team score
      const pts   = isBest2 ? teamScore : (!isStroke ? (gameState.totals?.[i] ?? 0) : null);
      return {
        tournamentPlayerId: sp.tournamentPlayerId,
        gross, net, points: pts,
        hcpUsed: sp.hcpIndex,
        absent:  false,
      };
    });

    // Handle absent players (those not in this group)
    const playingIds = new Set(setup.players.map(p => p.tournamentPlayerId).filter(Boolean));
    const absentScores = players
      .filter(p => !playingIds.has(p.id))
      .map(p => ({
        tournamentPlayerId: p.id,
        gross: isStroke ? absentStrokeScore(scores) : null,
        net:   isStroke ? absentStrokeScore(scores) : null,
        points: !isStroke ? 0 : null,
        hcpUsed: p.current_hcp,
        absent: true,
      }));

    await tournamentScoresSave(tRoundId, [...scores, ...absentScores]);
    await tournamentRoundUpdate(tRoundId, { status: 'completed' });

    // Reload standings
    activeTournRounds    = await tournamentRoundsLoad(tournId);
    activeTournAllScores = await tournamentAllScoresLoad(tournId);
  } catch (err) {
    console.error('saveTournamentScores error', err);
  }
}

// ================================================================
// SCORE CHALLENGE SYSTEM
// ================================================================

let challengeRealtimeCh = null;
let pendingChallengeId  = null; // challenge being reviewed by scorer

// ── Subscribe to incoming challenges (scorer side) ───────────────
function subscribeChallenges() {
  if (!roundId || !currentUser) return;
  if (challengeRealtimeCh) realtimeUnsubscribe(challengeRealtimeCh);
  challengeRealtimeCh = realtimeSubscribeChallenges(roundId, onChallengeReceived);
}

function onChallengeReceived(challenge) {
  // Only show to scorer (organiser)
  if (!gameState || !roundId) return;
  showChallengeBanner(challenge);
}

function showChallengeBanner(challenge) {
  const banner = document.getElementById('challenge-banner');
  if (!banner) return;
  pendingChallengeId = challenge.id;
  banner.innerHTML = `
    <div style="display:flex;align-items:center;gap:0.75rem;flex:1;">
      <span style="font-size:1.1rem;">⚠️</span>
      <span><strong>${challenge.challenger_name}</strong> is challenging Hole ${challenge.hole_number} score</span>
    </div>
    <div style="display:flex;gap:0.4rem;flex-shrink:0;">
      <button class="btn btn-primary" id="btn-challenge-review"
        style="padding:0.3rem 0.75rem;font-size:0.78rem;"
        data-hole="${challenge.hole_number}" data-cid="${challenge.id}">
        Review
      </button>
      <button class="btn btn-ghost" id="btn-challenge-dismiss"
        style="padding:0.3rem 0.75rem;font-size:0.78rem;"
        data-cid="${challenge.id}">
        Dismiss
      </button>
    </div>`;
  banner.classList.remove('hidden');

  document.getElementById('btn-challenge-review')?.addEventListener('click', async () => {
    banner.classList.add('hidden');
    const hole = parseInt(document.getElementById('btn-challenge-review').dataset.hole);
    await challengeUpdate(challenge.id, 'accepted');
    openHoleEdit(hole);
  });

  document.getElementById('btn-challenge-dismiss')?.addEventListener('click', async () => {
    banner.classList.add('hidden');
    await challengeUpdate(challenge.id, 'dismissed');
  });
}

// ── Observer challenge button (in scorecard overlay) ─────────────
function renderScorecardWithChallenges(state) {
  const isScorer = currentUser?.id === state?.organiserId;
  const rows     = buildScorecardRows(state);
  const fmt      = state.format;

  let html = buildScorecardHTML(state);

  // If observer (not scorer) and round is active, add challenge buttons
  if (!isScorer && state.status !== 'completed') {
    // Replace the scorecard HTML with one that has challenge buttons per row
    const log = state.log ?? [];
    const holeOffset = state.holeOffset ?? 0;

    html += `<div style="margin-top:1rem;border-top:1px solid var(--border);padding-top:0.75rem;">
      <div style="font-size:0.65rem;letter-spacing:0.1em;text-transform:uppercase;
                  color:var(--muted);margin-bottom:0.5rem;">Challenge a Score</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(60px,1fr));gap:0.35rem;">
        ${log.map((e, i) => `
          <button class="btn btn-outline challenge-hole-btn" data-hole="${holeOffset + i + 1}"
            style="padding:0.3rem 0.4rem;font-size:0.75rem;">
            H${holeOffset + i + 1}
          </button>`).join('')}
      </div>
    </div>`;
  }

  return html;
}

// ── Wire up challenge buttons in scorecard overlay ────────────────
function attachChallengeBtnListeners() {
  document.querySelectorAll('.challenge-hole-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const hole = parseInt(btn.dataset.hole);
      if (!confirm(`Challenge the score recorded for Hole ${hole}?`)) return;
      try {
        const myName = currentProfile
          ? `${currentProfile.first_name ?? ''} ${currentProfile.last_name ?? ''}`.trim()
          : 'A player';
        await challengeCreate({
          roundId:       roundId,
          challengerId:  currentUser.id,
          challengerName: myName,
          holeNumber:    hole,
        });
        btn.textContent = 'Sent!';
        btn.disabled = true;
        btn.style.color = 'var(--green)';
      } catch (err) {
        alert('Could not send challenge: ' + err.message);
      }
    });
  });
}

// ── Hole edit mode (scorer opens specific hole to edit) ───────────
function openHoleEdit(holeNumber) {
  const holeOffset = gameState.holeOffset ?? 0;
  const holeIdx    = holeNumber - holeOffset - 1; // 0-based index in log
  const log        = gameState.log ?? [];

  if (holeIdx < 0 || holeIdx >= log.length) {
    alert(`Hole ${holeNumber} has not been played yet.`);
    return;
  }

  // Show edit modal
  const modal = document.getElementById('modal-hole-edit');
  if (!modal) return;

  const entry = log[holeIdx];
  const par   = gameState.par[holeIdx];
  const si    = gameState.si[holeIdx];

  document.getElementById('hole-edit-title').textContent =
    `Edit Hole ${holeNumber} (Par ${par}, SI ${si})`;

  // Build score inputs for each player
  const inputsEl = document.getElementById('hole-edit-inputs');
  inputsEl.innerHTML = gameState.names.map((name, pi) => `
    <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.5rem;">
      <span style="flex:1;font-size:0.88rem;color:${pHex(pi)};">${name}</span>
      <div class="counter" style="gap:0.3rem;">
        <button class="c-btn" data-pi="${pi}" data-dir="-1"
          style="width:32px;height:32px;font-size:1rem;">-</button>
        <div class="c-val" id="edit-cv-${pi}"
          style="width:40px;text-align:center;font-size:1.1rem;font-weight:700;">
          ${entry.grosses?.[pi] ?? par}
        </div>
        <button class="c-btn" data-pi="${pi}" data-dir="1"
          style="width:32px;height:32px;font-size:1rem;">+</button>
      </div>
    </div>`).join('');

  // Wire counter buttons
  inputsEl.querySelectorAll('.c-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pi    = parseInt(btn.dataset.pi);
      const valEl = document.getElementById(`edit-cv-${pi}`);
      let v = parseInt(valEl.textContent) + parseInt(btn.dataset.dir);
      valEl.textContent = Math.max(1, Math.min(15, v));
    });
  });

  // Store which hole we're editing
  modal.dataset.holeIdx = holeIdx;
  modal.dataset.holeNumber = holeNumber;
  modal.classList.add('open');
}

document.getElementById('btn-hole-edit-confirm')?.addEventListener('click', async () => {
  const modal    = document.getElementById('modal-hole-edit');
  const holeIdx  = parseInt(modal.dataset.holeIdx);
  const holeNum  = parseInt(modal.dataset.holeNumber);

  // Read new scores
  const newGrosses = gameState.names.map((_, pi) => {
    return parseInt(document.getElementById(`edit-cv-${pi}`)?.textContent ?? '0');
  });

  modal.classList.remove('hidden');
  modal.classList.remove('open');

  // ── CASCADE RECALCULATION ──────────────────────────────────────
  // Rebuild gameState from scratch up to (but not including) holeIdx
  // then replay from holeIdx with new grosses, then replay remaining holes
  const log         = gameState.log ?? [];
  const originalLog = [...log];

  // Rebuild state up to holeIdx
  let rebuiltState = buildInitialState({
    format:          gameState.format,
    names:           gameState.names,
    handicapIndexes: gameState.handicapIndexes,
    playingHandicaps: gameState.playingHandicaps,
    matchHandicaps:  gameState.matchHandicaps,
    allowancePct:    gameState.allowancePct ?? 100,
    si:              gameState.si,
    par:             gameState.par,
    numHoles:        gameState.numHoles,
    holeOffset:      gameState.holeOffset ?? 0,
    courseName:      gameState.courseName,
    teeName:         gameState.teeName,
    tournamentId:    gameState.tournamentId,
    tournamentRoundId: gameState.tournamentRoundId,
    groupNumber:     gameState.groupNumber,
  });

  // Replay holes 0..holeIdx-1 with original scores
  for (let i = 0; i < holeIdx; i++) {
    rebuiltState = processHole(rebuiltState, originalLog[i].grosses);
  }

  // Snapshot totals before edit (for diff)
  const beforeTotals  = [...(rebuiltState.totals ?? [])];
  const beforeMatch   = rebuiltState.matchScore ?? 0;
  const beforeSkins   = [...(rebuiltState.skins ?? [])];
  const beforeRunning = [...(rebuiltState.runningPts ?? [])];

  // Process the edited hole
  rebuiltState = processHole(rebuiltState, newGrosses);

  // Replay holes holeIdx+1..end with original scores
  for (let i = holeIdx + 1; i < originalLog.length; i++) {
    rebuiltState = processHole(rebuiltState, originalLog[i].grosses);
  }

  // Preserve allGroupStates reference
  rebuiltState.allGroupStates = gameState.allGroupStates;
  rebuiltState.organiserId    = gameState.organiserId;

  // ── DIFF SUMMARY ───────────────────────────────────────────────
  const fmt      = gameState.format;
  const isStroke = fmt === 'stroke';
  const isSkins  = fmt === 'skins';
  const isITC    = fmt === 'itc';
  const isMatch  = ['match','betterball','csm','foursomes','greensomes'].includes(fmt);
  const isS6     = fmt === 'split6';

  let diffLines = [`<div style="font-weight:700;margin-bottom:0.5rem;">Changes after editing Hole ${holeNum}:</div>`];

  gameState.names.forEach((name, pi) => {
    const newTotal = rebuiltState.totals?.[pi] ?? 0;
    const oldTotal = beforeTotals[pi] ?? 0;
    const delta    = newTotal - oldTotal;
    if (delta !== 0) {
      const label = isStroke ? 'shots' : 'pts';
      const sign  = delta > 0 ? '+' : '';
      const col   = isStroke
        ? (delta < 0 ? 'var(--green)' : 'var(--red)')
        : (delta > 0 ? 'var(--green)' : 'var(--red)');
      diffLines.push(`<div style="color:${col};">${name}: ${oldTotal} -> ${newTotal} (${sign}${delta} ${label})</div>`);
    }
  });

  if (isMatch) {
    const oldM = beforeMatch;
    const newM = rebuiltState.matchScore ?? 0;
    if (oldM !== newM) {
      diffLines.push(`<div>Match score: ${oldM > 0 ? '+' : ''}${oldM} -> ${newM > 0 ? '+' : ''}${newM}</div>`);
    }
  }

  if (isSkins) {
    gameState.names.forEach((name, pi) => {
      const oldS = beforeSkins[pi] ?? 0;
      const newS = rebuiltState.skins?.[pi] ?? 0;
      if (oldS !== newS) {
        diffLines.push(`<div>${name} skins: ${oldS} -> ${newS}</div>`);
      }
    });
  }

  if (isS6) {
    gameState.names.forEach((name, pi) => {
      const oldR = beforeRunning[pi] ?? 0;
      const newR = rebuiltState.runningPts?.[pi] ?? 0;
      if (oldR !== newR) {
        const sign = (newR - oldR) > 0 ? '+' : '';
        diffLines.push(`<div>${name} running pts: ${oldR} -> ${newR} (${sign}${newR-oldR})</div>`);
      }
    });
  }

  if (diffLines.length === 1) {
    diffLines.push('<div style="color:var(--muted);">No change to running totals.</div>');
  }

  // Show diff modal
  const diffModal = document.getElementById('modal-hole-edit-diff');
  document.getElementById('hole-edit-diff-content').innerHTML =
    diffLines.join('');
  diffModal.dataset.rebuiltState = JSON.stringify({
    // Store the rebuilt state temporarily
    _pendingRebuild: true,
  });
  // Store in closure
  diffModal._rebuiltState = rebuiltState;
  diffModal.classList.add('open');
});

document.getElementById('btn-hole-edit-cancel')?.addEventListener('click', () => {
  document.getElementById('modal-hole-edit').classList.remove('open');
});

document.getElementById('btn-hole-edit-diff-confirm')?.addEventListener('click', async () => {
  const diffModal   = document.getElementById('modal-hole-edit-diff');
  const rebuiltState = diffModal._rebuiltState;
  diffModal.classList.remove('open');

  if (!rebuiltState) return;

  // Apply the rebuilt state
  gameState = rebuiltState;

  // Save to Supabase
  await saveRoundState();

  // Re-render game screen
  renderGameHeader();
  renderScoreHeader();
  document.getElementById('result-flash').innerHTML = '&nbsp;';

  alert('Score updated and scorecard recalculated.');
});

document.getElementById('btn-hole-edit-diff-cancel')?.addEventListener('click', () => {
  document.getElementById('modal-hole-edit-diff').classList.remove('open');
});

// ── Scorer self-edit: edit pencil on scorecard ────────────────────
document.getElementById('scorecard-overlay')?.addEventListener('click', e => {
  const editBtn = e.target.closest('.sc-edit-btn');
  if (!editBtn) return;
  const hole = parseInt(editBtn.dataset.hole);
  document.getElementById('scorecard-overlay').classList.remove('open');
  openHoleEdit(hole);
});

// Challenge subscription is now called directly in enterGameScreen above

// ================================================================
// PRIVACY SETTINGS SCREEN
// ================================================================

function getPrivacyLevel(searchable, friendsOnly) {
  if (searchable) return 'public';
  if (friendsOnly) return 'friends';
  return 'private';
}

function setPrivacyRadio(groupId, level) {
  const sel = document.getElementById(groupId);
  if (sel) sel.value = level;
}

function getPrivacyRadio(groupId) {
  const sel = document.getElementById(groupId);
  return sel?.value ?? 'private';
}

// Scorecard tab navigation — event delegation
document.addEventListener('click', e => {
  const btn = e.target.closest('.sc-tab-btn');
  if (!btn) return;
  // Deactivate all tabs
  document.querySelectorAll('.sc-tab-btn').forEach(b => {
    b.style.background = 'transparent';
    b.style.borderBottomColor = 'transparent';
    b.style.color = 'var(--muted)';
  });
  // Activate clicked tab
  btn.style.background = 'var(--surface)';
  btn.style.borderBottomColor = 'var(--gold)';
  btn.style.color = 'var(--gold)';
  // Show target panel, hide others
  document.querySelectorAll('.sc-panel').forEach(p => p.style.display = 'none');
  const target = document.getElementById(btn.dataset.target);
  if (target) target.style.display = 'block';
});
document.addEventListener('click', e => {
  const btn = e.target.closest('.priv-btn');
  if (!btn) return;
  const group = btn.closest('.priv-btn-group');
  if (!group) return;
  group.querySelectorAll('.priv-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
});

function showPrivacySettings() {
  const p = currentProfile ?? {};

  // Populate current values
  document.getElementById('pv-username').textContent = p.username ? `@${p.username}` : '(not set)';
  document.getElementById('pv-name').textContent     =
    [p.first_name, p.last_name].filter(Boolean).join(' ') || '(not set)';
  document.getElementById('pv-hcp').textContent      = p.hcp != null ? `${p.hcp}` : '(not set)';
  document.getElementById('pv-mobile').textContent   = p.mobile || '(not set)';
  document.getElementById('pv-email').textContent    = currentUser?.email || '(not set)';

  // Set radio buttons from stored preferences
  setPrivacyRadio('pv-name-radio',   getPrivacyLevel(p.share_name,   p.friends_see_name));
  setPrivacyRadio('pv-hcp-radio',    getPrivacyLevel(p.share_hcp,    p.friends_see_hcp));
  setPrivacyRadio('pv-mobile-radio', getPrivacyLevel(p.share_mobile, p.friends_see_mobile));
  setPrivacyRadio('pv-email-radio',  getPrivacyLevel(p.share_email,  p.friends_see_email));

  showScreen('screen-privacy');
}

document.getElementById('btn-open-privacy')?.addEventListener('click', () => showPrivacySettings());
document.getElementById('privacy-back')?.addEventListener('click', () => showProfile());

document.getElementById('btn-save-privacy')?.addEventListener('click', async () => {
  const nameLevel   = getPrivacyRadio('pv-name-radio');
  const hcpLevel    = getPrivacyRadio('pv-hcp-radio');
  const mobileLevel = getPrivacyRadio('pv-mobile-radio');
  const emailLevel  = getPrivacyRadio('pv-email-radio');

  const updates = {
    share_name:           nameLevel   === 'public',
    friends_see_name:     nameLevel   === 'public' || nameLevel   === 'friends',
    share_hcp:            hcpLevel    === 'public',
    friends_see_hcp:      hcpLevel    === 'public' || hcpLevel    === 'friends',
    share_mobile:         mobileLevel === 'public',
    friends_see_mobile:   mobileLevel === 'public' || mobileLevel === 'friends',
    share_email:          emailLevel  === 'public',
    friends_see_email:    emailLevel  === 'public' || emailLevel  === 'friends',
  };

  const btn = document.getElementById('btn-save-privacy');
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    await profileSave({ id: currentUser.id, ...updates });
    // Update local profile cache
    Object.assign(currentProfile, updates);
    btn.textContent = 'Saved!';
    setTimeout(() => {
      btn.textContent = 'SAVE PREFERENCES';
      btn.disabled = false;
    }, 1500);
  } catch (err) {
    alert('Could not save: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'SAVE PREFERENCES';
  }
});

// ================================================================
// TEAM TOURNAMENT
// ================================================================

let activeTournTeams    = [];  // tournament_teams rows
let activeTournRoundFmt = null; // format chosen for current round

const TOURN_TEAM_FORMATS = {
  2: [
    { value: 'betterball',  label: 'Better Ball' },
    { value: 'csm',         label: 'Combined Stableford' },
    { value: 'foursomes',   label: 'Foursomes' },
    { value: 'greensomes',  label: 'Greensomes' },
  ],
  3: [
    { value: 'best2',       label: 'Best 2 of 3' },
  ],
  4: [
    { value: 'best2',       label: 'Best 2 of 4' },
  ],
};

function updateTournFormatOptions() {
  const type     = document.getElementById('tourn-type')?.value ?? 'individual';
  const teamSize = parseInt(document.getElementById('tourn-team-size')?.value) || 2;

  // Show/hide the right format selector
  const indivWrap = document.getElementById('tourn-indiv-format-wrap');
  const teamWrap  = document.getElementById('tourn-team-format-wrap');
  if (indivWrap) indivWrap.style.display = type === 'individual' ? '' : 'none';
  if (teamWrap)  teamWrap.style.display  = type === 'team'       ? '' : 'none';

  // Populate team formats based on size
  if (type === 'team') {
    const sel     = document.getElementById('tourn-team-format');
    const formats = TOURN_TEAM_FORMATS[teamSize] ?? TOURN_TEAM_FORMATS[2];
    if (sel) {
      sel.innerHTML = formats.map(f =>
        `<option value="${f.value}">${f.label}</option>`
      ).join('');
    }
  }
}

// Wire up — call on team size change


// ── Team tournament standings ────────────────────────────────────
function renderTeamStandings(containerEl) {
  if (!activeTournament || !containerEl) return;
  const rotation    = activeTournament.team_rotation;
  const scoringMode = activeTournament.scoring_mode ?? 'cumulative';

  let html = '';

  if (rotation === 'fixed' && activeTournTeams.length) {
    const standings = buildTeamStandings(
      activeTournTeams, activeTournPlayers, activeTournRounds, activeTournAllScores,
      activeTournament.format, scoringMode
    );

    html = `<table class="sc-table" style="width:100%;font-size:0.82rem;">
      <thead><tr>
        <th style="text-align:left;">Team</th>`;
    activeTournRounds.filter(r => r.status==='completed').forEach(r => {
      const d = r.date ? new Date(r.date).toLocaleDateString('en-GB',{day:'numeric',month:'short'}) : `R${r.round_number}`;
      html += `<th>${d}</th>`;
    });
    html += `<th style="color:var(--gold);">Total</th></tr></thead><tbody>`;

    standings.forEach((row, idx) => {
      const isLead = idx === 0;
      html += `<tr${isLead?' style="background:rgba(212,168,67,0.06);"':''}>
        <td style="text-align:left;font-weight:${isLead?'700':'500'};color:${isLead?'var(--gold)':''};">
          ${row.position}. ${row.name}
          <div style="font-size:0.65rem;color:var(--muted);">${row.teamPlayers.map(p=>p.name.split(' ')[0]).join(', ')}</div>
        </td>`;
      activeTournRounds.filter(r=>r.status==='completed').forEach(r => {
        const rr = row.roundResults.find(x => x.roundId === r.id);
        html += `<td>${rr?.score ?? '--'}</td>`;
      });
      html += `<td style="color:var(--gold);font-weight:700;">${row.total ?? '--'}</td></tr>`;
    });
    html += '</tbody></table>';

  } else {
    // Rotating teams or individual fallback — show individual standings
    const standings = buildRotatingStandings(
      activeTournPlayers, activeTournRounds, activeTournAllScores, scoringMode
    );
    html = `<table class="sc-table" style="width:100%;font-size:0.82rem;">
      <thead><tr>
        <th style="text-align:left;">Player</th><th>HCP</th>`;
    activeTournRounds.filter(r=>r.status==='completed').forEach(r => {
      const d = r.date ? new Date(r.date).toLocaleDateString('en-GB',{day:'numeric',month:'short'}) : `R${r.round_number}`;
      html += `<th>${d}</th>`;
    });
    html += `<th style="color:var(--gold);">Total</th></tr></thead><tbody>`;
    standings.forEach((row, idx) => {
      const isLead = idx === 0;
      html += `<tr${isLead?' style="background:rgba(212,168,67,0.06);"':''}>
        <td style="text-align:left;font-weight:${isLead?'700':'500'};color:${isLead?'var(--gold)':''};">
          ${row.position}. ${row.name}
        </td>
        <td style="color:var(--muted);">${row.currentHcp}</td>`;
      activeTournRounds.filter(r=>r.status==='completed').forEach(r => {
        const rr = row.roundResults.find(x=>x.roundId===r.id);
        html += `<td>${rr?.pts ?? rr?.tournPts ?? '--'}</td>`;
      });
      html += `<td style="color:var(--gold);font-weight:700;">${row.total ?? '--'}</td></tr>`;
    });
    html += '</tbody></table>';
  }

  containerEl.innerHTML = html;
}
