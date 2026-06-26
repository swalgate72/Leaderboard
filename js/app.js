// ================================================================
// LEADERBOARD - app.js  (v3.1 · build 20260604-02)
// UI controller. Imports data.js (Supabase) and game.js (engine).
// ================================================================

import {
  authSignIn, authSignUp, authSignOut, authSignInWithGoogle,
  authForgotPassword, authUpdatePassword, authOnStateChange, authGetUser,
  profileLoad, profileSave, profileFindByEmail, profileFindByUsername,
  coursesLoadAll, courseLoadById, courseSave, courseDelete, coursesEnsureDefaults,
  roundCreate, roundSaveState, roundPlayerClaimScorer, roundComplete, roundAbandon, roundReactivate, roundDelete,
  roundsLoadActive, roundLoadById, roundsLoadHistory,
  roundPlayersSave, roundPlayersLoad,
  friendsLoad, friendRequestsLoadPending,
  friendRequestSend, friendRequestAccept, friendRequestDecline, friendRemove,
  smsInviteCreate, gameInviteLoad, gameInvitesPollPending, gameInvitesLoadHistory, smsInviteLookup, smsInviteAccept,
  smsInvitesDeleteMany, invitesForRoundLoad, invitesForTournamentRoundLoad,
  smsBuildInviteLink, smsBuildMessage,
  realtimeSubscribeRound, realtimeBroadcastRound, realtimeSubscribeFriendRequests, realtimeSubscribeGameInvites, realtimeUnsubscribe,
  tournamentCreate, tournamentsLoad, tournamentLoadById, tournamentUpdate, tournamentDelete,
  tournamentPlayersAdd, tournamentPlayersLoad, tournamentPlayerUpdate,
  tournamentRoundsLoad, tournamentRoundLoadById, tournamentRoundCreate, tournamentRoundUpdate,
  tournamentScoresLoad, tournamentAllScoresLoad, tournamentScoresSave,
  realtimeSubscribeTournament,
  challengeCreate, challengeUpdate, challengesLoadPending, realtimeSubscribeChallenges,
} from '../data.js?v=20260626o';

import {
  FORMAT_LABELS, FORMAT_DESCS, FORMAT_MIN_PLAYERS, formatsForPlayerCount,
  calcHandicaps, strokesOnHole, indivStrokesOnHole,
  stablefordPoints, matchPlayStatus, matchPlayIsOver,
  buildInitialState, processHole, undoHole, editHole,
  getResultSummary, buildScorecardRows,
  greensomesPairHandicap, foursomedPairHandicap,
  buildMultiGroupLeaderboard,
  texasTeamHandicap,
  gpsDistanceYards, buildSideCompResults,
} from '../game.js?v=20260626o';

import {
  buildStandings, calcHandicapAdjustments, buildDefaultGroups,
  absentStrokeScore, roundSummary, buildTournamentViewUrl,
  buildTeamStandings, buildIndividualFromTeamStandings, buildRotatingStandings, defaultTeamName,
} from '../tournament.js?v=20260626o';

// ================================================================
// PLAYER COLOURS
// ================================================================
const P_HEX = ['#d4a843','#5ba3d9','#d96b4a','#e8c96a'];

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
  playersPerGroup: null,
  hcpPct:          100,
  players:         [],
  pairs:           [],
  tournamentId:       null, // set when starting a tournament round
  tournRoundNumber:   null,
  ldEnabled:   false,
  ldCount:     1,
  ldHoles:     [],   // selected hole numbers (1-18)
  ntpEnabled:  false,
  ntpCount:    1,
  ntpHoles:    [],
};

let roundId    = null;
let gameState  = null;
const _sessionId = Math.random().toString(36).slice(2);
let realtimeCh = null;
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

const SETUP_SCREENS = [
  'screen-setup-format', 'screen-setup-course', 'screen-setup-players',
  'screen-setup-pairs', 'screen-setup-groups', 'screen-setup-review',
];

// Tournament setup screens: simple persistence — just remember the screen
// so backgrounding the app returns here, but fields/state are reset on return.
const TOURNAMENT_SETUP_SCREENS = [
  'screen-tournament-setup', 'screen-tournament-format', 'screen-tournament-players',
];

const BOTTOM_NAV_SCREENS = [
  'screen-home', 'screen-history', 'screen-friends', 'screen-profile',
];

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) { el.classList.add('active'); window.scrollTo(0, 0); }

  const bottomNav = document.getElementById('bottom-nav');
  if (bottomNav) bottomNav.style.display = BOTTOM_NAV_SCREENS.includes(id) ? 'flex' : 'none';

  // Persist setup-flow screens so backgrounding the app doesn't lose progress
  if (SETUP_SCREENS.includes(id)) {
    saveSetupState(id);
  } else if (TOURNAMENT_SETUP_SCREENS.includes(id)) {
    // Simple persistence: remember the screen only (fields reset on return)
    try { localStorage.setItem('lb-tournament-setup-screen', id); } catch {}
    try { localStorage.removeItem('lb-setup-state'); } catch {}
  } else if (id !== 'screen-game') {
    // Leaving the setup flow for a non-game screen — clear persisted setup
    // BUT preserve lb-setup-state if a saved draft exists (so Active Games can restore it)
    try {
      const hasSavedDraft = !!(readSetupDraft()?.screen);
      if (!hasSavedDraft) localStorage.removeItem('lb-setup-state');
    } catch { try { localStorage.removeItem('lb-setup-state'); } catch {} }
    try { localStorage.removeItem('lb-tournament-setup-screen'); } catch {}
  }
}

function saveSetupDraft() {
  try {
    const course = allCourses.find(c => c.id === setup.courseId);
    const saved  = restoreSetupState();
    localStorage.setItem('lb-setup-draft', JSON.stringify({
      scoring:    setup.scoring,
      courseName: course?.name ?? null,
      teeName:    course?.tees?.[setup.teeIdx]?.name ?? null,
      players:    setup.players.filter(p => p.name).map(p => p.name),
      screen:     saved?.screen ?? null,
      savedAt:    Date.now(),
    }));
  } catch {}
}

function clearSetupDraft() {
  try { localStorage.removeItem('lb-setup-draft'); } catch {}
}

function readSetupDraft() {
  try { return JSON.parse(localStorage.getItem('lb-setup-draft') ?? 'null'); } catch { return null; }
}

function saveSetupState(screenId) {
  try {
    localStorage.setItem('lb-setup-state', JSON.stringify({
      screen: screenId,
      setup: setup,
      tournSetupPlayers: typeof tournSetupPlayers !== 'undefined' ? tournSetupPlayers : null,
      tournSetupNumGroups: typeof tournSetupNumGroups !== 'undefined' ? tournSetupNumGroups : null,
    }));
  } catch {}
}

function restoreSetupState() {
  try {
    const raw = localStorage.getItem('lb-setup-state');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function clearSetupState() {
  try { localStorage.removeItem('lb-setup-state'); } catch {}
}

// Attempt to restore an in-progress round setup after app reload.
// Returns true if a screen was restored, false otherwise.
async function tryRestoreSetupState() {
  const saved = restoreSetupState();
  if (!saved?.screen || !saved?.setup) return false;

  // Don't restore if it's a tournament setup we can't easily rebuild,
  // or if the saved state is stale (e.g. courseId no longer exists)
  if (saved.setup.courseId && !allCourses.some(c => c.id === saved.setup.courseId)) {
    clearSetupState();
    return false;
  }

  // Restore the setup object
  Object.assign(setup, saved.setup);

  try {
    if (saved.screen === 'screen-setup-format') {
      showFormatPicker(setup.category ?? 'solo');
    } else if (saved.screen === 'screen-setup-course') {
      const fmt = setup.scoring;
      document.getElementById('setup-course-format-label').textContent = FORMAT_LABELS[fmt] ?? fmt;
      populateCourseSelect();
      populateNumPlayerSelect();
      populateNumGroupSelect();
      document.getElementById('setup-hcp-pct').value = setup.hcpPct ?? 100;
      // Re-select the saved course/tee
      if (setup.courseId) {
        document.getElementById('setup-course-select').value = setup.courseId;
        onCourseSelectChange();
        const teeSel = document.getElementById('setup-tee-select');
        if (teeSel) teeSel.value = String(setup.teeIdx ?? 0);
      }
      showScreen('screen-setup-course');
    } else if (saved.screen === 'screen-setup-players') {
      renderSetupPlayerList();
      showScreen('screen-setup-players');
    } else if (saved.screen === 'screen-setup-groups') {
      renderSetupGroupCards();
      showScreen('screen-setup-groups');
    } else if (saved.screen === 'screen-setup-review') {
      renderSetupGroupCards();
      buildSetupReview();
      showScreen('screen-setup-review');
    } else {
      return false;
    }
    return true;
  } catch (err) {
    console.error('tryRestoreSetupState error', err);
    clearSetupState();
    return false;
  }
}

// Restore setup from the lb-setup-draft object (used when lb-setup-state was cleared by navigation)
async function _restoreSetupFromDraft(draft) {
  if (!draft?.screen || !draft?.setup) return false;
  try {
    Object.assign(setup, draft.setup);
    if (draft.screen === 'screen-setup-course') {
      document.getElementById('setup-course-format-label').textContent = FORMAT_LABELS[setup.scoring] ?? setup.scoring;
      populateCourseSelect();
      populateNumPlayerSelect();
      populateNumGroupSelect();
      document.getElementById('setup-hcp-pct').value = setup.hcpPct ?? 100;
      if (setup.courseId) {
        document.getElementById('setup-course-select').value = setup.courseId;
        onCourseSelectChange();
        const teeSel = document.getElementById('setup-tee-select');
        if (teeSel) teeSel.value = String(setup.teeIdx ?? 0);
      }
      showScreen('screen-setup-course');
    } else if (draft.screen === 'screen-setup-players') {
      renderSetupPlayerList();
      showScreen('screen-setup-players');
    } else if (draft.screen === 'screen-setup-groups') {
      renderSetupGroupCards();
      showScreen('screen-setup-groups');
    } else if (draft.screen === 'screen-setup-pairs') {
      renderSetupGroupCards();
      showScreen('screen-setup-pairs');
    } else if (draft.screen === 'screen-setup-review') {
      renderSetupGroupCards();
      buildSetupReview();
      showScreen('screen-setup-review');
    } else {
      return false;
    }
    return true;
  } catch (err) {
    console.error('_restoreSetupFromDraft error', err);
    return false;
  }
}

function tryRestoreTournamentSetupScreen() {
  try {
    const screenId = localStorage.getItem('lb-tournament-setup-screen');
    const draftId  = localStorage.getItem('lb-tourn-setup-id');

    // If there's a draft tournament in progress (players being added), restore to screen 2
    if (draftId && !screenId) {
      // Load draft tournament and players async, then show screen 2
      (async () => {
        try {
          activeTournament   = await tournamentLoadById(draftId);
          activeTournPlayers = await tournamentPlayersLoad(draftId);
          tournSetupPlayers  = activeTournPlayers.filter(p => !p.excluded).map(p => ({
            _tournId: p.id,
            name: p.name,
            hcp: p.current_hcp ?? p.starting_hcp ?? 0,
            profileId: p.profile_id ?? null,
          }));
          renderTournamentPlayerList();
          showScreen('screen-tournament-format');
        } catch {
          localStorage.removeItem('lb-tourn-setup-id');
          showHome();
        }
      })();
      return true;
    }

    if (!screenId || !TOURNAMENT_SETUP_SCREENS.includes(screenId)) return false;
    localStorage.removeItem('lb-tournament-setup-screen');
    showTournamentSetup();
    return true;
  } catch { return false; }
}

// Periodically autosave setup state while on a setup screen, so in-progress
// typing (course/player names/HCPs) survives the app being backgrounded.
setInterval(() => {
  const active = document.querySelector('.screen.active');
  if (active && SETUP_SCREENS.includes(active.id)) {
    // Capture current player input values before saving
    syncSetupPlayersFromDOM();
    saveSetupState(active.id);
  }
}, 3000);

// Read current values from player input fields into setup.players
function syncSetupPlayersFromDOM() {
  setup.players.forEach((p, i) => {
    const nameEl = document.getElementById(`pname-${i}`);
    const hcpEl  = document.getElementById(`phcp-${i}`);
    if (nameEl && nameEl.value !== undefined) p.name = nameEl.value;
    if (hcpEl  && hcpEl.value  !== undefined) p.hcpIndex = parseFloat(hcpEl.value) || 0;
  });
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
  try { localStorage.setItem('lb-theme', t); localStorage.setItem('lb_theme', t); } catch {}
  // Highlight the active theme button
  const lightBtn = document.getElementById('btn-theme-light');
  const darkBtn  = document.getElementById('btn-theme-dark');
  if (lightBtn) {
    lightBtn.style.background   = t === 'light' ? 'var(--gold)' : '';
    lightBtn.style.color        = t === 'light' ? '#000'        : '';
    lightBtn.style.borderColor  = t === 'light' ? 'var(--gold)' : '';
  }
  if (darkBtn) {
    darkBtn.style.background   = t === 'dark' ? 'var(--gold)' : '';
    darkBtn.style.color        = t === 'dark' ? '#000'        : '';
    darkBtn.style.borderColor  = t === 'dark' ? 'var(--gold)' : '';
  }
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
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 60" style="width:330px;height:auto;display:block;">
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

  if (tournViewId) { await handleTournamentViewLink(tournViewId); return; }
  if (joinToken)   { await handleJoinFlow(joinToken, troundParam, groupParam); return; }

  authOnStateChange(async (event, user) => {
    if (event === 'PASSWORD_RECOVERY') { showResetPasswordScreen(); return; }
    if (user) await onSignedIn(user);
    else      onSignedOut();
  });
}

// ================================================================
// AUTH
// ================================================================
function onSignedOut() {
  currentUser = null; currentProfile = null; roundId = null; gameState = null;
  showScreen('screen-auth');
}

// ================================================================
// PASSWORD RESET SCREEN
// ================================================================
function showResetPasswordScreen() {
  const errEl = document.getElementById('reset-password-error');
  if (errEl) errEl.style.display = 'none';
  const f1 = document.getElementById('reset-new-password');
  const f2 = document.getElementById('reset-confirm-password');
  if (f1) f1.value = '';
  if (f2) f2.value = '';
  showScreen('screen-reset-password');
}

document.getElementById('btn-reset-password-submit')?.addEventListener('click', async () => {
  const pw1   = document.getElementById('reset-new-password').value;
  const pw2   = document.getElementById('reset-confirm-password').value;
  const errEl = document.getElementById('reset-password-error');
  const showErr = msg => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };
  if (!pw1 || pw1.length < 8) { showErr('Password must be at least 8 characters.'); return; }
  if (pw1 !== pw2)             { showErr('Passwords do not match.'); return; }
  const btn = document.getElementById('btn-reset-password-submit');
  btn.disabled = true; btn.textContent = 'Saving…';
  if (errEl) errEl.style.display = 'none';
  try {
    await authUpdatePassword(pw1);
    const user = await authGetUser();
    if (user) await onSignedIn(user);
    else showScreen('screen-auth');
  } catch (err) {
    showErr(err.message || 'Could not update password. Please try again.');
    btn.disabled = false; btn.textContent = 'SET NEW PASSWORD →';
  }
});

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

    if (_joiningViaInvite) return;

    const actives = await roundsLoadActive(user.id);
    let storedRoundId = null;
    try { storedRoundId = localStorage.getItem('lb-active-round'); } catch {}
    if (storedRoundId && !actives.some(r => r.id === storedRoundId)) {
      const stored = await roundLoadById(storedRoundId);
      if (['active','paused'].includes(stored?.status)) actives.unshift(stored);
      else try { localStorage.removeItem('lb-active-round'); } catch {}
    }

    if (actives.length > 0) {
      await resumeRound(actives[0].id);
    } else {
      const restored = await tryRestoreSetupState();
      if (!restored && !tryRestoreTournamentSetupScreen()) await showHome();
    }
  } catch (err) {
    console.error('onSignedIn error', err);
    await showHome();
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
    // authOnStateChange will fire onSignedIn if successful
  } catch (err) {
    const msg = err.message || 'Sign in failed.';
    setMsg('auth-error', msg);
    alert('Sign in error: ' + msg); // temporary debug
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
    const { hasSession } = await authSignUp(email, pw, fname, lname);
    if (hasSession) {
      // Email confirmation is off — signUp already returned an active session,
      // so the auth state listener will sign the user straight into the app.
      // No "check your email" message needed since there's no confirmation step.
      setMsg('auth-success', 'Account created! Signing you in…');
    } else {
      setMsg('auth-success', 'Account created! Check your email to confirm, then sign in.');
      btn.disabled = false; btn.textContent = 'CREATE ACCOUNT →';
    }
  } catch (err) {
    setMsg('auth-error', err.message || 'Sign up failed.');
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
  setActiveBottomNav('nav-play');

  // Ryder Cup button — only visible to the authorised developer account
  const RC_AUTHORISED_USER = '52e987a2-ce84-4b47-a2a8-e5a2910e8593';
  const rcBtn = document.getElementById('btn-ryder-cup');
  if (rcBtn) rcBtn.style.display = currentUser?.id === RC_AUTHORISED_USER ? '' : 'none';

  // Update invite badges on home buttons
  if (currentUser) updateActiveGamesBadge();

  // Populate hero card
  const myName = currentProfile
    ? `${currentProfile.first_name ?? ''} ${currentProfile.last_name ?? ''}`.trim()
    : '';
  const initials = myName
    ? myName.split(' ').filter(Boolean).map(w => w[0]).slice(0,2).join('').toUpperCase()
    : '--';
  const avatarEl = document.getElementById('home-hero-avatar');
  if (avatarEl) avatarEl.textContent = initials || '--';

  const hcpEl = document.getElementById('home-stat-hcp');
  if (hcpEl) hcpEl.textContent = currentProfile?.hcp != null
    ? fmtHandicap(currentProfile.hcp) : '--';

  try {
    const actives = await roundsLoadActive(currentUser.id);

    // Also check localStorage for a round the user joined (e.g. as group 2 scorer)
    let storedRoundId = null;
    try { storedRoundId = localStorage.getItem('lb-active-round'); } catch {}
    if (storedRoundId && !actives.some(r => r.id === storedRoundId)) {
      const stored = await roundLoadById(storedRoundId);
      if (['active','paused'].includes(stored?.status)) actives.unshift(stored);
      else try { localStorage.removeItem('lb-active-round'); } catch {}
    }

  } catch {}

  // Populate Best Score / Rounds stats
  loadHomeStatsAndActive(myName);
}

async function loadHomeStatsAndActive(myName) {
  const roundsEl = document.getElementById('home-stat-rounds');
  const bestEl   = document.getElementById('home-stat-best');

  // Best score / rounds played
  try {
    const rounds = await roundsLoadHistory(currentUser.id);
    if (roundsEl) roundsEl.textContent = String(rounds.length);

    let best = null;
    rounds.forEach(r => {
      const state = r.game_state;
      if (!state || state.format !== 'stableford') return;
      const summary = getResultSummary(state);
      const mine = summary.scores?.find(s => s.nm === myName);
      if (mine && (best === null || mine.score > best)) best = mine.score;
    });
    if (bestEl) bestEl.textContent = best != null ? `${best} pts` : '--';
  } catch {
    if (roundsEl) roundsEl.textContent = '--';
    if (bestEl) bestEl.textContent = '--';
  }

  // Setup draft reminder — show if the user was mid-setup when they left
  const draftEl = document.getElementById('home-draft-row');
  const draft   = readSetupDraft();
  if (draftEl) {
    if (draft) {
      const draftNames = draft.players?.slice(0, 3).join(', ') + (draft.players?.length > 3 ? '…' : '');
      draftEl.innerHTML = `
        <div class="home-active-row" data-kind="draft"
          style="display:flex;align-items:center;gap:0.75rem;padding:0.75rem 1rem;
                 background:var(--surface2);border:1px solid var(--border);
                 border-radius:var(--radius-sm);cursor:pointer;">
          <div class="home-active-icon">✏️</div>
          <div class="home-active-body" style="flex:1;min-width:0;">
            <div class="home-active-title">Game Setup — ${draft.courseName ?? fmtLabel(draft.scoring)}</div>
            <div class="home-active-sub" style="font-size:0.82rem;color:var(--muted2);">${fmtLabel(draft.scoring)}${draftNames ? ` · ${draftNames}` : ''}</div>
          </div>
          <button class="btn btn-ghost" id="btn-dismiss-draft"
            style="font-size:0.85rem;color:var(--muted);border:none;padding:0.25rem 0.5rem;flex-shrink:0;"
            title="Dismiss">✕</button>
        </div>`;
      draftEl.style.display = '';
      draftEl.querySelector('#btn-dismiss-draft')?.addEventListener('click', e => {
        e.stopPropagation();
        clearSetupDraft();
        draftEl.style.display = 'none';
      });
      draftEl.querySelector('.home-active-row')?.addEventListener('click', (e) => {
        if (e.target.id === 'btn-dismiss-draft') return;
        tryRestoreSetupState().then(ok => {
          if (!ok) { clearSetupDraft(); showHome(); }
        });
      });
    } else {
      draftEl.style.display = 'none';
    }
  }

  // Update the Active Games and Invites badges
  updateActiveGamesBadge();
}

// Bottom nav active-state helper
function setActiveBottomNav(activeId) {
  document.querySelectorAll('.bottom-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.id === activeId);
  });
}

// Home screen three-button handlers
// Single Game button → show format picker (both solo and team)
document.getElementById('btn-single-game')?.addEventListener('click', () => {
  setup.category = null; // category chosen in format picker
  showFormatPicker('all');
});

// Tournament button → show tournament list or setup
document.getElementById('btn-tournament-mode')?.addEventListener('click', () => showTournaments());

document.getElementById('nav-profile')?.addEventListener('click', () => { setActiveBottomNav('nav-profile'); showProfile(); });
document.getElementById('nav-friends')?.addEventListener('click', () => { setActiveBottomNav('nav-friends'); showFriends(); });
document.getElementById('nav-history')?.addEventListener('click', () => { setActiveBottomNav('nav-history'); showHistory(); });
document.getElementById('nav-play')   ?.addEventListener('click', () => { setActiveBottomNav('nav-play'); showHome(); });

document.getElementById('coming-soon-close')?.addEventListener('click', () => hide('modal-coming-soon'));
document.getElementById('btn-resume')?.addEventListener('click', async () => { if (roundId) await resumeRound(roundId); });

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
  { key: 'foursomes',  icon: '🤝', label: 'Foursomes Match Play', desc: 'Pairs · alternate shots, one ball · combined handicap (50% of pair total)' },
  { key: 'greensomes', icon: '🤝', label: 'Greensomes Match Play', desc: 'Pairs · both drive, then alternate · combined handicap (60/40 split)' },
  { key: 'best2',      icon: '🥇', label: 'Best 2',         desc: 'Best 2 stableford scores per group · groups vs groups' },
  { key: 'texas',      icon: '🤠', label: 'Texas Scramble', desc: 'All play from best drive · one team score per hole · 2-4 players' },
];

function showFormatPicker(category) {
  const TOURNAMENT_EXCLUDED = ['match','skins','itc','split6'];
  const isTournMode  = !!setup.tournamentId;
  const tournGameType = isTournMode ? (activeTournament?.scoring_mode_team ?? 'individual') : null;

  document.getElementById('setup-format-screen-title').textContent = 'Choose Format';

  const list = document.getElementById('setup-format-list');

  const renderSection = (title, formats) => `
    <div style="font-size:0.8rem;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;
                color:var(--muted2);margin:1rem 0 0.5rem;">${title}</div>
    <div style="display:grid;gap:0.65rem;">
      ${formats.map(f => `
        <div class="mode-card" data-fmt="${f.key}">
          <div class="mode-card-icon">${f.icon}</div>
          <div class="mode-card-body">
            <div class="mode-card-title">${f.label}</div>
            <div class="mode-card-sub">${f.desc}</div>
          </div>
          <div class="mode-card-chevron">›</div>
        </div>`).join('')}
    </div>`;

  let sectionsHtml = '';
  if (!isTournMode) {
    // Single game — show both sections as before
    sectionsHtml = renderSection('Single Player', SOLO_FORMATS) + renderSection('Pairs &amp; Teams', TEAM_FORMATS);
  } else if (tournGameType === 'individual') {
    // Individual tournament — only Stableford / Stroke Play
    const soloFmts = SOLO_FORMATS.filter(f => ['stableford','stroke'].includes(f.key));
    sectionsHtml = renderSection('Single Player', soloFmts);
  } else {
    // team_fixed or team_individual — only team/pairs formats, match-style excluded
    sectionsHtml = renderSection('Pairs &amp; Teams', TEAM_FORMATS);
  }

  list.innerHTML = sectionsHtml;

  list.querySelectorAll('.mode-card').forEach(card => {
    card.addEventListener('click', () => {
      const fmt = card.dataset.fmt;
      setup.scoring  = fmt;
      setup.courseId = null; setup.teeIdx = 0; setup.holes = 18;
      setup.hcpPct   = 100; setup.pairs = [];
      // Only clear players and tournament context if NOT in tournament mode
      if (!setup.tournamentId) {
        setup.players = [];
      }
      // Clear tournament context if this is a fresh single game
      if (!activeTournament) {
        setup.tournamentId     = null;
        setup.tournRoundNumber = null;
      }
      setup.texasMode       = 'average'; // default handicap mode
      setup.texasScoringFmt = 'stableford'; // default scoring
      setup.texasDrivesTotal = null; // min total drives per player
      setup.texasDrivesPar3  = null; // min par 3 drives per player
      if (fmt === 'split6')                                                { setup.numPlayers = 3; setup.numGroups = 1; setup.playersPerGroup = null; }
      else if (['betterball','csm','foursomes','greensomes'].includes(fmt)){ setup.numPlayers = 4; setup.numGroups = 1; setup.playersPerGroup = null; }
      else if (fmt === 'best2')                                            { setup.numPlayers = 8; setup.numGroups = 2; setup.playersPerGroup = 4; }
      else if (fmt === 'match')                                            { setup.numPlayers = 2; setup.numGroups = 1; setup.playersPerGroup = null; }
      else if (fmt === 'texas')                                            { setup.numPlayers = 2; setup.numGroups = 1; setup.playersPerGroup = null; }
      else                                                                 { setup.numPlayers = 1; setup.numGroups = 1; setup.playersPerGroup = null; }
      startSetup();
    });
  });

  showScreen('screen-setup-format');
}

document.getElementById('setup-format-back')?.addEventListener('click', () => {
  if (setup.tournamentId && activeTournament) {
    // In tournament round setup — go back to tournament detail
    setup.tournamentId     = null;
    setup.tournRoundNumber = null;
    showTournamentDetail(activeTournament.id);
  } else {
    clearSetupState(); clearSetupDraft(); showHome();
  }
});

// ================================================================
// SETUP -- STEP 1: COURSE
// ================================================================
function startSetup() {
  const fmt = setup.scoring;
  document.getElementById('setup-course-format-label').textContent = FORMAT_LABELS[fmt] ?? fmt;

  // Show Texas Scramble options card only for that format
  const texasCard = document.getElementById('texas-options-card');
  if (texasCard) texasCard.classList.toggle('hidden', fmt !== 'texas');

  // Wire Texas option toggles (only once via _wired flag)
  if (fmt === 'texas' && !texasCard?._wired) {
    const setScoringFmt = (v) => {
      setup.texasScoringFmt = v;
      document.getElementById('texas-scoring-fmt').value = v;
      document.getElementById('texas-scoring-stableford').classList.toggle('active', v === 'stableford');
      document.getElementById('texas-scoring-stroke').classList.toggle('active', v === 'stroke');
    };
    const setHcpMode = (v) => {
      setup.texasMode = v;
      document.getElementById('texas-hcp-mode').value = v;
      document.getElementById('texas-hcp-average').classList.toggle('active', v === 'average');
      document.getElementById('texas-hcp-weighted').classList.toggle('active', v === 'weighted');
      document.getElementById('texas-hcp-hint').textContent = v === 'weighted'
        ? '25% + 20% + 15% + 10% of player indexes'
        : 'Average of all player indexes';
    };
    document.getElementById('texas-scoring-stableford')?.addEventListener('click', () => setScoringFmt('stableford'));
    document.getElementById('texas-scoring-stroke')?.addEventListener('click', () => setScoringFmt('stroke'));
    document.getElementById('texas-hcp-average')?.addEventListener('click', () => setHcpMode('average'));
    document.getElementById('texas-hcp-weighted')?.addEventListener('click', () => setHcpMode('weighted'));
    setScoringFmt(setup.texasScoringFmt ?? 'stableford');
    setHcpMode(setup.texasMode ?? 'average');

    // Drive quotas
    const drivesTotalEl = document.getElementById('texas-drives-total');
    const drivesPar3El  = document.getElementById('texas-drives-par3');
    if (drivesTotalEl) {
      drivesTotalEl.value = setup.texasDrivesTotal ?? '';
      drivesTotalEl.addEventListener('input', () => {
        setup.texasDrivesTotal = drivesTotalEl.value ? parseInt(drivesTotalEl.value) : null;
      });
    }
    if (drivesPar3El) {
      drivesPar3El.value = setup.texasDrivesPar3 ?? '';
      drivesPar3El.addEventListener('input', () => {
        setup.texasDrivesPar3 = drivesPar3El.value ? parseInt(drivesPar3El.value) : null;
      });
    }
    if (texasCard) texasCard._wired = true;
  }

  // Reset LD/NTP state for a fresh setup
  setup.ldEnabled = false; setup.ldCount = 1; setup.ldHoles = [];
  setup.ntpEnabled = false; setup.ntpCount = 1; setup.ntpHoles = [];
  document.getElementById('ld-enabled').checked = false;
  document.getElementById('ntp-enabled').checked = false;
  document.getElementById('ld-config')?.classList.add('hidden');
  document.getElementById('ntp-config')?.classList.add('hidden');
  setHoleCountBtns('ld', 1);
  setHoleCountBtns('ntp', 1);
  wireLdNtpToggles();

  populateCourseSelect();
  populateNumPlayerSelect();
  populateNumGroupSelect();
  document.getElementById('setup-hcp-pct').value = 100;
  showScreen('screen-setup-course');
}

// ── Longest Drive / Nearest the Pin setup wiring ───────────────────
function setHoleCountBtns(kind, count) {
  setup[`${kind}Count`] = count;
  [1, 2].forEach(n => {
    document.getElementById(`${kind}-count-${n}`)?.classList.toggle('active', n === count);
  });
  // Trim any over-selected holes if count was reduced
  if (setup[`${kind}Holes`].length > count) {
    setup[`${kind}Holes`] = setup[`${kind}Holes`].slice(0, count);
  }
  renderLdNtpGrid(kind);
  updateLdNtpHint(kind);
}

function updateLdNtpHint(kind) {
  const count    = setup[`${kind}Count`];
  const selected = setup[`${kind}Holes`].length;
  const hintEl   = document.getElementById(`${kind}-hint`);
  if (!hintEl) return;
  const unit = kind === 'ntp' ? ' · measured in cm' : '';
  hintEl.textContent = selected >= count
    ? `${selected} of ${count} hole${count > 1 ? 's' : ''} selected${unit}`
    : `Choose ${count} hole${count > 1 ? 's' : ''}${unit}`;
}

function renderLdNtpGrid(kind) {
  const grid = document.getElementById(`${kind}-hole-grid`);
  if (!grid) return;
  const course = allCourses.find(c => c.id === setup.courseId);
  const tee    = course?.tees?.[setup.teeIdx];
  if (!tee) { grid.innerHTML = '<div class="hint">Select a course and tee first</div>'; return; }

  const { offset, count } = holeRange(setup.holes);
  const parSlice = tee.par.slice(offset, offset + count);
  // par 3s excluded from LD (need a real tee shot), par 3s ONLY for NTP (no fairway approach)
  const isEligible = (par) => kind === 'ld' ? par !== 3 : par === 3;

  grid.innerHTML = parSlice.map((par, i) => {
    const holeNum  = offset + i + 1;
    const eligible = isEligible(par);
    const selected = setup[`${kind}Holes`].includes(holeNum);
    return `<div class="ld-ntp-hole-btn${eligible ? '' : ' disabled'}${selected ? ' selected' : ''}"
              data-hole="${holeNum}" data-kind="${kind}">
              <span class="h-num">${holeNum}</span>
              <span class="h-par">Par ${par}</span>
            </div>`;
  }).join('');

  grid.querySelectorAll('.ld-ntp-hole-btn:not(.disabled)').forEach(btn => {
    btn.addEventListener('click', () => {
      const holeNum = parseInt(btn.dataset.hole, 10);
      const holes   = setup[`${kind}Holes`];
      const idx     = holes.indexOf(holeNum);
      if (idx >= 0) {
        holes.splice(idx, 1);
      } else {
        if (holes.length >= setup[`${kind}Count`]) holes.shift(); // bump oldest if at cap
        holes.push(holeNum);
      }
      renderLdNtpGrid(kind);
      updateLdNtpHint(kind);
    });
  });
}

function wireLdNtpToggles() {
  const ldToggle  = document.getElementById('ld-enabled');
  const ntpToggle = document.getElementById('ntp-enabled');
  if (ldToggle && !ldToggle._wired) {
    ldToggle.addEventListener('change', () => {
      setup.ldEnabled = ldToggle.checked;
      document.getElementById('ld-config')?.classList.toggle('hidden', !ldToggle.checked);
      if (ldToggle.checked) renderLdNtpGrid('ld');
    });
    ldToggle._wired = true;
  }
  if (ntpToggle && !ntpToggle._wired) {
    ntpToggle.addEventListener('change', () => {
      setup.ntpEnabled = ntpToggle.checked;
      document.getElementById('ntp-config')?.classList.toggle('hidden', !ntpToggle.checked);
      if (ntpToggle.checked) renderLdNtpGrid('ntp');
    });
    ntpToggle._wired = true;
  }
  document.getElementById('ld-count-1')?.addEventListener('click', () => setHoleCountBtns('ld', 1));
  document.getElementById('ld-count-2')?.addEventListener('click', () => setHoleCountBtns('ld', 2));
  document.getElementById('ntp-count-1')?.addEventListener('click', () => setHoleCountBtns('ntp', 1));
  document.getElementById('ntp-count-2')?.addEventListener('click', () => setHoleCountBtns('ntp', 2));
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
  const teeSel = document.getElementById('setup-tee-select');
  if (!courseId) {
    teeSel.innerHTML = '<option value="">-- Select a course first --</option>';
    hide('setup-si-preview');
    return;
  }
  const course = allCourses.find(c => c.id === courseId);
  if (!course) return;
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

  renderSIPreview(course, setup.teeIdx);
}

document.getElementById('setup-course-select')?.addEventListener('change', () => {
  onCourseSelectChange();
  if (setup.ldEnabled)  renderLdNtpGrid('ld');
  if (setup.ntpEnabled) renderLdNtpGrid('ntp');
});
document.getElementById('setup-tee-select')?.addEventListener('change', e => {
  setup.teeIdx = parseInt(e.target.value, 10);
  const course = allCourses.find(c => c.id === setup.courseId);
  if (course) renderSIPreview(course, setup.teeIdx);
  if (setup.ldEnabled)  renderLdNtpGrid('ld');
  if (setup.ntpEnabled) renderLdNtpGrid('ntp');
});

function renderSIPreview(course, teeIdx) {
  const tee  = course.tees?.[teeIdx]; if (!tee) return;
  const grid = document.getElementById('setup-si-grid');
  if (!grid) return;
  const { offset, count } = holeRange(setup.holes);
  const siSlice  = tee.si.slice(offset, offset + count);
  const parSlice = tee.par.slice(offset, offset + count);
  grid.innerHTML = siSlice.map((si, i) => `
    <div style="background:var(--surface2);border-radius:3px;padding:4px 2px;text-align:center;">
      <div style="display:flex;justify-content:space-between;font-family:'Barlow Condensed',sans-serif;font-weight:400;font-size:0.96rem;color:var(--muted2);line-height:1;">
        <span>${offset+i+1}</span><span>SI ${si}</span>
      </div>
      <div style="font-family:'Barlow Condensed',sans-serif;font-weight:400;font-size:1.4rem;color:var(--white);line-height:1.3;">Par ${parSlice[i]}</div>
    </div>`).join('');
  show('setup-si-preview');
}

document.querySelectorAll('[data-holes]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-holes]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    setup.holes = btn.dataset.holes === '18' ? 18 : btn.dataset.holes;
    const course = allCourses.find(c => c.id === setup.courseId);
    if (course) renderSIPreview(course, setup.teeIdx);
    // Hole numbers and par-3 eligibility shift with front9/back9 — re-render and clear stale selections
    if (setup.ldEnabled)  { setup.ldHoles  = []; renderLdNtpGrid('ld');  updateLdNtpHint('ld'); }
    if (setup.ntpEnabled) { setup.ntpHoles = []; renderLdNtpGrid('ntp'); updateLdNtpHint('ntp'); }
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
// Save & Close — save current setup position and return home
function saveSetupInPlace(screenId) {
  // Save draft to localStorage — stay on the current screen, just confirm inline.
  // Also write lb-setup-state so tryRestoreSetupState() can restore it from Active Games.
  saveSetupState(screenId);
  try {
    const course = allCourses.find(c => c.id === setup.courseId);
    const draft = {
      screen:     screenId,
      setup:      setup,
      scoring:    setup.scoring,
      courseName: course?.name ?? null,
      teeName:    course?.tees?.[setup.teeIdx]?.name ?? null,
      players:    (setup.players || []).filter(p => p.name).map(p => p.name),
      savedAt:    Date.now(),
    };
    localStorage.setItem('lb-setup-draft', JSON.stringify(draft));
    console.log('[saveSetupInPlace] draft saved for screen:', screenId,
      '| key present:', !!localStorage.getItem('lb-setup-draft'));
  } catch (err) {
    console.error('[saveSetupInPlace] failed:', err);
  }
  updateActiveGamesBadge();
  // Inline confirmation — pulse the save button green briefly, then show a toast
  const btnMap = {
    'screen-setup-course':   'setup-save-1',
    'screen-setup-players':  'setup-save-2',
    'screen-setup-groups':   'setup-save-3',
    'screen-setup-pairs':    'setup-save-pairs',
    'screen-setup-review':   'setup-save-review',
  };
  const btn = document.getElementById(btnMap[screenId]);
  if (btn) {
    const orig = btn.innerHTML;
    btn.innerHTML = '✅ Saved!';
    btn.style.background = 'var(--green)';
    btn.disabled = true;
    setTimeout(() => {
      btn.innerHTML = orig;
      btn.style.background = '';
      btn.disabled = false;
    }, 1800);
  }
  // Toast (stays on screen, doesn't navigate)
  const toast = document.createElement('div');
  toast.textContent = '💾 Game saved — visible in Active Games on Home';
  toast.style.cssText = `position:fixed;bottom:90px;left:50%;transform:translateX(-50%);
    background:var(--green);color:#fff;padding:0.65rem 1.25rem;border-radius:20px;
    font-weight:800;font-size:0.9rem;z-index:9999;pointer-events:none;
    white-space:nowrap;`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2800);
}

document.getElementById('setup-save-1')     ?.addEventListener('click', () => saveSetupInPlace('screen-setup-course'));
document.getElementById('setup-save-2')     ?.addEventListener('click', () => saveSetupInPlace('screen-setup-players'));
document.getElementById('setup-save-3')     ?.addEventListener('click', () => saveSetupInPlace('screen-setup-groups'));
document.getElementById('setup-save-pairs') ?.addEventListener('click', () => saveSetupInPlace('screen-setup-pairs'));
document.getElementById('setup-save-review')?.addEventListener('click', () => saveSetupInPlace('screen-setup-review'));

// Home buttons on setup screens — autosave current state then go home
function setupHomeAndSave(screenId) {
  saveSetupInPlace(screenId);   // saves draft + state, updates badge, shows toast
  showHome();
}
document.getElementById('setup-home-1')     ?.addEventListener('click', () => setupHomeAndSave('screen-setup-course'));
document.getElementById('setup-home-2')     ?.addEventListener('click', () => setupHomeAndSave('screen-setup-players'));
document.getElementById('setup-home-3')     ?.addEventListener('click', () => setupHomeAndSave('screen-setup-groups'));
document.getElementById('setup-home-pairs') ?.addEventListener('click', () => setupHomeAndSave('screen-setup-pairs'));
document.getElementById('setup-home-review')?.addEventListener('click', () => setupHomeAndSave('screen-setup-review'));

document.getElementById('btn-setup-course-next')?.addEventListener('click', () => {
  if (!setup.courseId) { alert('Please select a course.'); return; }
  setup.hcpPct    = parseInt(document.getElementById('setup-hcp-pct').value, 10) || 100;
  setup.numGroups = 1; // will be set on the groups screen

  // Only initialise setup.players if starting fresh (not returning from players screen)
  const hasExistingPlayers = setup.players.some(p => p.name);
  if (!hasExistingPlayers) {
    const myName      = currentProfile ? `${currentProfile.first_name ?? ''} ${currentProfile.last_name ?? ''}`.trim() : '';
    const myHcp       = currentProfile?.hcp ?? 0;
    const myCourseHcp = getMyCourseHandicapDefault();
    setup.players = [{
      name: myName, hcpIndex: myHcp,
      courseHandicap: myCourseHcp ?? myHcp,
      groupNumber: 1, profileId: currentUser?.id ?? null,
      mobile: currentProfile?.mobile ?? '', isScorer: true,
      hcpSource: 'course',
      gameHandicap: Math.round(myCourseHcp ?? myHcp ?? 0),
    }];
  }

  renderSetupPlayerList();
  saveSetupState('screen-setup-players');
  saveSetupDraft();
  showScreen('screen-setup-players');
});

// ================================================================
// SETUP -- STEP 2: PLAYERS (tournament-style list)
// ================================================================

function renderSetupPlayerList() {
  const listEl  = document.getElementById('setup-player-list');
  const countEl = document.getElementById('setup-player-count-label');
  if (!listEl) return;
  const filled = setup.players.filter(p => p.name);
  const count  = filled.length;
  if (countEl) countEl.textContent = `${count} player${count !== 1 ? 's' : ''} added`;

  if (!count) {
    listEl.innerHTML = `<div style="padding:1rem;text-align:center;color:var(--muted);font-size:0.95rem;">No players yet.</div>`;
    return;
  }

  listEl.innerHTML = setup.players.filter(p => p.name).map((p, i) => {
    const pi = setup.players.indexOf(p);
    const gameHcp   = p.gameHandicap ?? p.courseHandicap ?? p.hcpIndex ?? 0;
    const sourceLabel = { index: 'Handicap Index', course: 'Course HCP', playing: 'Playing Index' }[p.hcpSource] ?? 'Course HCP';
    return `<div style="display:flex;align-items:center;gap:0.75rem;padding:0.9rem 1rem;
                background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);">
      <span class="dot" style="background:${pHex(pi % 8)};flex-shrink:0;"></span>
      <div style="flex:1;">
        <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.25rem;">${p.name}</div>
        <div style="font-size:0.82rem;font-weight:700;color:var(--muted2);">
          Game HCP <span style="color:var(--white);font-size:0.95rem;">${fmtHandicap(gameHcp)}</span>
          <span style="color:var(--muted);font-size:0.75rem;margin-left:4px;">(${sourceLabel})</span>
        </div>
      </div>
      <button class="btn btn-outline player-hcp-btn" data-pi="${pi}"
        style="font-size:0.78rem;font-weight:800;color:var(--gold);border-color:var(--gold-border);
               padding:0.3rem 0.65rem;letter-spacing:0.04em;">HCP</button>
      ${pi > 0 ? `<button class="btn btn-ghost" data-remove="${pi}"
        style="font-size:0.85rem;color:var(--red);border-color:var(--red-border);padding:0.3rem 0.6rem;">✕</button>` : ''}
    </div>`;
  }).join('');

  listEl.querySelectorAll('.player-hcp-btn').forEach(btn => {
    btn.addEventListener('click', () => openPlayerHcpPicker(parseInt(btn.dataset.pi)));
  });

  listEl.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.remove);
      setup.players[idx] = { name: '', hcpIndex: 0, courseHandicap: null, groupNumber: 1, profileId: null, isScorer: false };
      saveSetupState('screen-setup-players');
      saveSetupDraft();
      renderSetupPlayerList();
    });
  });
}

// ================================================================
// PLAYER HCP PICKER MODAL
// ================================================================

// Resolves the three base values for a player (before any manual adjustment)
function playerHcpValues(p) {
  const index   = p.hcpIndex ?? 0;
  const course  = p.courseHandicap ?? index;
  const playing = Math.round(course * (setup.hcpPct ?? 100) / 100);
  return { index, course, playing };
}

let _hcpPickerSource  = 'course'; // currently selected source
let _hcpAdjusted      = {};       // { index, course, playing } — possibly user-nudged

function openPlayerHcpPicker(pi) {
  const p = setup.players[pi];
  if (!p) return;

  document.getElementById('player-hcp-modal-title').textContent = p.name;
  document.getElementById('modal-player-hcp').dataset.pi = pi;

  const vals = playerHcpValues(p);

  // Seed adjusted values: if the player already has a gameHandicap and matching
  // source, start the counter at their previously-adjusted value; otherwise use
  // the profile default so the counter starts at the right place.
  _hcpAdjusted = {
    index:   (p.hcpSource === 'index'   && p.gameHandicap != null) ? p.gameHandicap : Math.round(vals.index),
    course:  (p.hcpSource === 'course'  && p.gameHandicap != null) ? p.gameHandicap : Math.round(vals.course),
    playing: (p.hcpSource === 'playing' && p.gameHandicap != null) ? p.gameHandicap : Math.round(vals.playing),
  };

  _hcpPickerSource = p.hcpSource ?? 'course';

  // Fill profile-default labels under each row title
  document.getElementById('hcp-index-profile').textContent   = `Profile: ${fmtHandicap(vals.index)}`;
  document.getElementById('hcp-course-profile').textContent  = `Profile: ${fmtHandicap(vals.course)}`;
  document.getElementById('hcp-playing-profile').textContent = `Profile: ${fmtHandicap(vals.playing)}`;

  _renderHcpPickerRows();
  document.getElementById('modal-player-hcp').classList.add('open');
}

function _renderHcpPickerRows() {
  ['index','course','playing'].forEach(src => {
    const row       = document.getElementById(`hcp-row-${src}`);
    const counter   = document.getElementById(`hcp-counter-${src}`);
    const preview   = document.getElementById(`hcp-preview-${src}`);
    const valSpan   = document.getElementById(`hcp-val-${src}`);
    const isActive  = src === _hcpPickerSource;

    // Row styling
    row.style.borderColor  = isActive ? 'var(--gold)'               : 'var(--border)';
    row.style.background   = isActive ? 'rgba(212,168,67,0.1)'      : '';
    row.style.color        = isActive ? 'var(--gold)'               : 'var(--white)';

    // Muted labels inside the row
    row.querySelectorAll('[style*="color:var(--muted2)"]').forEach(el => {
      el.style.color = isActive ? 'rgba(212,168,67,0.7)' : 'var(--muted2)';
    });
    row.querySelectorAll('[style*="color:var(--muted)"]').forEach(el => {
      el.style.color = isActive ? 'rgba(212,168,67,0.55)' : 'var(--muted)';
    });

    if (isActive) {
      // Show counter, hide static preview
      counter.style.display = 'flex';
      preview.style.display = 'none';
      if (valSpan) valSpan.textContent = String(_hcpAdjusted[src]);
    } else {
      // Show static preview value, hide counter
      counter.style.display = 'none';
      preview.style.display = '';
      preview.textContent   = String(_hcpAdjusted[src]);
      preview.style.color   = 'var(--muted2)';
    }
  });
}

// Row click → select source
document.querySelectorAll('.hcp-src-row').forEach(row => {
  row.addEventListener('click', (e) => {
    // Ignore clicks that land on the +/- buttons themselves (they have their own handler)
    if (e.target.classList.contains('hcp-adj-btn')) return;
    _hcpPickerSource = row.dataset.src;
    _renderHcpPickerRows();
  });
});

// +/− buttons
document.addEventListener('click', e => {
  const btn = e.target.closest('.hcp-adj-btn');
  if (!btn) return;
  const src = btn.dataset.src;
  const dir = parseInt(btn.dataset.dir, 10);
  _hcpAdjusted[src] = Math.max(0, Math.min(54, (_hcpAdjusted[src] ?? 0) + dir));
  const valSpan = document.getElementById(`hcp-val-${src}`);
  if (valSpan) valSpan.textContent = String(_hcpAdjusted[src]);
});

document.getElementById('modal-player-hcp-close')?.addEventListener('click', () => {
  document.getElementById('modal-player-hcp').classList.remove('open');
});

document.getElementById('btn-player-hcp-confirm')?.addEventListener('click', () => {
  const modal = document.getElementById('modal-player-hcp');
  const pi    = parseInt(modal.dataset.pi);
  const p     = setup.players[pi];
  if (!p) return;

  const source      = _hcpPickerSource;
  const gameHandicap = _hcpAdjusted[source] ?? Math.round(playerHcpValues(p)[source]);

  setup.players[pi].hcpSource    = source;
  setup.players[pi].gameHandicap = gameHandicap;

  // Propagate source (and recalculated defaults) to all other players
  // who haven't been manually configured yet, when first player changes.
  const namedPlayers = setup.players.filter(q => q.name);
  if (namedPlayers[0] === p) {
    setup.players.forEach((q, qi) => {
      if (!q.name || qi === pi) return;
      if (!q.hcpSource || q.hcpSource === 'course') {
        q.hcpSource = source;
        const qv = playerHcpValues(q);
        q.gameHandicap = source === 'index'   ? Math.round(qv.index)
                       : source === 'playing' ? Math.round(qv.playing)
                       :                        Math.round(qv.course);
      }
    });
  }

  modal.classList.remove('open');
  renderSetupPlayerList();
});

// Open add-player modal (for adding a NEW player)
document.getElementById('btn-setup-add-player')?.addEventListener('click', () => {
  document.getElementById('game-manual-name').value = '';
  document.getElementById('game-manual-hcp').value  = '';
  document.getElementById('game-manual-chcp').value = '';
  const modal = document.getElementById('modal-add-game-player');
  delete modal.dataset.editIdx;
  modal.classList.add('open');
});
document.getElementById('modal-add-game-player-close')?.addEventListener('click', () => {
  const modal = document.getElementById('modal-add-game-player');
  delete modal.dataset.editIdx;
  modal.classList.remove('open');
});

document.getElementById('btn-game-add-from-friends')?.addEventListener('click', () => {
  document.getElementById('modal-add-game-player').classList.remove('open');
  openFriendPicker(-1, (friend) => {
    addSetupPlayer(friend.name, friend.hcp ?? 0, friend.hcp ?? 0, friend.profileId ?? null);
  }, true);
});

document.getElementById('btn-game-invite')?.addEventListener('click', () => {
  document.getElementById('modal-add-game-player').classList.remove('open');
  document.getElementById('modal-invite').classList.add('open');
});

document.getElementById('btn-game-confirm-player')?.addEventListener('click', () => {
  const name    = document.getElementById('game-manual-name').value.trim();
  const hcpRaw  = document.getElementById('game-manual-hcp').value.trim();
  const chcpRaw = document.getElementById('game-manual-chcp').value.trim();
  if (!name) { alert('Please enter a player name.'); return; }
  const chcp = chcpRaw ? parseFloat(chcpRaw) : null;
  const hcp  = hcpRaw  ? parseFloat(hcpRaw)  : (chcp ?? 0);

  const modal  = document.getElementById('modal-add-game-player');
  const editIdx = modal.dataset.editIdx != null && modal.dataset.editIdx !== ''
    ? parseInt(modal.dataset.editIdx) : -1;

  if (editIdx >= 0 && setup.players[editIdx]) {
    // Edit existing player
    setup.players[editIdx] = { ...setup.players[editIdx], name, hcpIndex: hcp, courseHandicap: chcp ?? hcp };
    delete modal.dataset.editIdx;
    saveSetupState('screen-setup-players');
    renderSetupPlayerList();
  } else {
    // Add new player
    delete modal.dataset.editIdx;
    addSetupPlayer(name, hcp, chcp ?? hcp, null);
  }
  modal.classList.remove('open');
});

function addSetupPlayer(name, hcpIndex, courseHandicap, profileId) {
  // Inherit the source chosen by the first player (if any), defaulting to 'course'
  const namedPlayers = setup.players.filter(p => p.name);
  const inheritedSource = namedPlayers[0]?.hcpSource ?? 'course';

  const newPlayer = {
    name, hcpIndex, courseHandicap, groupNumber: 1,
    profileId: profileId ?? null, isScorer: false,
    hcpSource: inheritedSource,
    gameHandicap: null, // will be set below
  };

  // Compute gameHandicap based on inherited source
  const vals = { index: Math.round(hcpIndex ?? 0), course: Math.round(courseHandicap ?? hcpIndex ?? 0), playing: Math.round((courseHandicap ?? hcpIndex ?? 0) * (setup.hcpPct ?? 100) / 100) };
  newPlayer.gameHandicap = inheritedSource === 'index'  ? vals.index
                         : inheritedSource === 'playing' ? vals.playing
                         : vals.course;

  const emptyIdx = setup.players.findIndex(p => !p.name);
  if (emptyIdx === -1) {
    setup.players.push(newPlayer);
  } else {
    setup.players[emptyIdx] = { ...setup.players[emptyIdx], ...newPlayer };
  }
  saveSetupState('screen-setup-players');
  saveSetupDraft();
  renderSetupPlayerList();
}

document.getElementById('btn-setup-players-next')?.addEventListener('click', () => {
  const filled = setup.players.filter(p => p.name);
  const minPlayers = ['betterball','csm','foursomes','greensomes','match','best2','split6','skins','itc'].includes(setup.scoring) ? 2 : 1;
  if (filled.length < minPlayers) { alert(`Add at least ${minPlayers} player${minPlayers > 1 ? 's' : ''}.`); return; }
  const isPairs = ['betterball','csm','foursomes','greensomes'].includes(setup.scoring);
  if (isPairs) {
    initSetupPairs();
    showScreen('screen-setup-pairs');
  } else {
    renderSetupGroupCards();
    showScreen('screen-setup-groups');
  }
});

// ================================================================
// SETUP -- PAIRS SCREEN (for betterball/csm/foursomes/greensomes)
// ================================================================

function initSetupPairs() {
  // Build initial pairs: consecutive player pairs (0&1, 2&3, ...)
  const named = setup.players.filter(p => p.name);
  setup.pairs = [];
  // Assign pairIndex -1 to all (unassigned)
  named.forEach(p => { p.pairIndex = -1; });
  // Auto-pair if even number
  for (let i = 0; i + 1 < named.length; i += 2) {
    const pA = named[i], pB = named[i + 1];
    const pairIdx = setup.pairs.length;
    const piA = setup.players.indexOf(pA), piB = setup.players.indexOf(pB);
    pA.pairIndex = pairIdx; pB.pairIndex = pairIdx;
    // If both players share a persisted team name (team_fixed mode), use it
    const sharedTeamName = (pA.teamName && pA.teamName === pB.teamName) ? pA.teamName : null;
    setup.pairs.push({
      _uid: `p${Date.now()}_${pairIdx}_${Math.random().toString(36).slice(2,7)}`,
      name: sharedTeamName || `${pA.name.split(' ')[0]} & ${pB.name.split(' ')[0]}`,
      teamName: sharedTeamName,
      playerIndices: [piA, piB],
      groupNumber: 1,
    });
  }
  if (named.length % 2 !== 0) named[named.length - 1].pairIndex = -1;
  renderSetupPairsScreen();
}

function renderSetupPairsScreen() {
  const poolEl   = document.getElementById('setup-pairs-pool');
  const pairsEl  = document.getElementById('setup-pair-cards');
  const poolCard = document.getElementById('setup-pairs-pool-card');
  if (!poolEl || !pairsEl) return;

  const named      = setup.players.filter(p => p.name);
  const unassigned = named.filter(p => p.pairIndex === -1);

  // Pool of unassigned players
  if (unassigned.length === 0) {
    poolCard.style.display = 'none';
  } else {
    poolCard.style.display = '';
    poolEl.innerHTML = unassigned.map(p => {
      const pi = setup.players.indexOf(p);
      return `<div class="sp-player-chip" draggable="true" data-pi="${pi}"
        style="display:inline-flex;align-items:center;gap:0.5rem;padding:0.55rem 0.85rem;
               background:var(--surface2);border:1px solid var(--border);border-radius:20px;
               cursor:grab;margin:0.25rem;user-select:none;">
        <span class="dot" style="background:${pHex(pi % 8)};width:10px;height:10px;flex-shrink:0;"></span>
        <span style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.05rem;">${p.name}</span>
      </div>`;
    }).join('');
  }

  // Pair cards
  pairsEl.innerHTML = '';
  setup.pairs.forEach((pair, pairIdx) => {
    const card = document.createElement('div');
    card.className = 'card mb-sm sp-pair-drop';
    card.dataset.pair = pairIdx;

    // Render-time safety net: never display more than 2 members for a pair,
    // even if playerIndices somehow ended up longer than that. This is a
    // last line of defence on top of the dedup/cap logic in dropPlayerIntoPair.
    const cappedIndices = [...new Set(pair.playerIndices)].slice(0, 2);
    const members = cappedIndices.map(pi => setup.players[pi]);

    // Combined pair handicap — only meaningful once both slots are filled.
    // Foursomes/Greensomes only; this screen is reused by Better Ball/CSM too,
    // which don't have a single combined-handicap concept.
    const isHcpFmt = ['foursomes','greensomes'].includes(setup.scoring);
    let pairHcpBadge = '';
    if (isHcpFmt && members.length === 2 && members[0] && members[1]) {
      const hcp0 = members[0].courseHandicap ?? members[0].hcpIndex ?? 0;
      const hcp1 = members[1].courseHandicap ?? members[1].hcpIndex ?? 0;
      const pairHcp = setup.scoring === 'greensomes'
        ? greensomesPairHandicap(hcp0, hcp1)
        : foursomedPairHandicap(hcp0, hcp1);
      pairHcpBadge = `
        <div style="text-align:right;flex-shrink:0;">
          <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;
                      font-size:1.2rem;color:var(--white);line-height:1;">${pairHcp}</div>
          <div style="font-size:0.6rem;color:var(--muted);font-weight:700;
                      text-transform:uppercase;letter-spacing:0.05em;">Pair HCP</div>
        </div>`;
    }

    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.75rem;">
        <div class="card-title" style="margin:0;flex:1;">Pair ${pairIdx + 1}</div>
        <input class="sp-pair-name" data-pair="${pairIdx}"
          value="${pair.name}"
          style="flex:2;background:none;border:none;border-bottom:1px solid var(--border);
                 color:var(--gold);font-family:'Barlow Condensed',sans-serif;
                 font-weight:800;font-size:1.05rem;outline:none;padding-bottom:2px;">
        ${pairHcpBadge}
      </div>
      <div class="sp-pair-slots" data-pair="${pairIdx}" style="display:grid;gap:0.4rem;min-height:48px;">
        ${members.map((p, slot) => {
          if (!p) return `<div class="sp-empty-slot" data-pair="${pairIdx}" data-slot="${slot}"
            style="padding:0.65rem;text-align:center;color:var(--muted);font-size:0.9rem;
                   border:1.5px dashed var(--border);border-radius:var(--radius-sm);">
            Drop player here</div>`;
          const pi = cappedIndices[slot];
          return `<div class="sp-player-chip" draggable="true" data-pi="${pi}"
            style="display:flex;align-items:center;gap:0.75rem;padding:0.65rem 0.75rem;
                   background:var(--surface2);border:1px solid var(--border);
                   border-radius:var(--radius-sm);cursor:grab;user-select:none;">
            <span style="font-size:1rem;color:var(--muted);">⣿</span>
            <span class="dot" style="background:${pHex(pi % 8)};flex-shrink:0;"></span>
            <span style="flex:1;font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.1rem;">${p.name}</span>
            <span style="font-size:0.82rem;color:var(--muted2);">HCP ${fmtHandicap(p.hcpIndex)}</span>
            <button class="sp-remove" data-pi="${pi}" data-pair="${pairIdx}"
              style="font-size:0.85rem;color:var(--muted);background:none;border:none;cursor:pointer;padding:0 0.25rem;">✕</button>
          </div>`;
        }).join('')}
      </div>`;
    pairsEl.appendChild(card);
  });

  // Add New Pair button
  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn-outline';
  addBtn.style.cssText = 'width:100%;padding:0.85rem;font-size:1rem;font-weight:700;border-style:dashed;border-color:var(--gold-border);color:var(--gold);';
  addBtn.textContent = '＋ Add Another Pair';
  addBtn.addEventListener('click', () => {
    setup.pairs.push({
      _uid: `p${Date.now()}_${setup.pairs.length}_${Math.random().toString(36).slice(2,7)}`,
      name: `Pair ${setup.pairs.length + 1}`, playerIndices: [], groupNumber: 1,
    });
    renderSetupPairsScreen();
  });
  pairsEl.appendChild(addBtn);

  // Wire name inputs
  pairsEl.querySelectorAll('.sp-pair-name').forEach(inp => {
    inp.addEventListener('input', e => {
      setup.pairs[parseInt(inp.dataset.pair)].name = e.target.value;
    });
  });

  // Wire remove buttons
  pairsEl.querySelectorAll('.sp-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const pi = parseInt(btn.dataset.pi), pairIdx = parseInt(btn.dataset.pair);
      if (setup.players[pi]) setup.players[pi].pairIndex = -1;
      const pair = setup.pairs[pairIdx];
      pair.playerIndices = pair.playerIndices.filter(i => i !== pi);
      renderSetupPairsScreen();
    });
  });

  // ── Drag and drop ──
  const allChips = document.querySelectorAll('.sp-player-chip[draggable]');
  let touchGhost = null, touchPi = null, touchSrc = null;

  allChips.forEach(chip => {
    chip.addEventListener('dragstart', e => {
      chip.style.opacity = '0.4';
      e.dataTransfer.setData('text/plain', chip.dataset.pi);
      e.dataTransfer.effectAllowed = 'move';
    });
    chip.addEventListener('dragend', () => { chip.style.opacity = '1'; });

    chip.addEventListener('touchstart', e => {
      touchPi = chip.dataset.pi; touchSrc = chip;
      touchGhost = chip.cloneNode(true);
      touchGhost.style.cssText = `position:fixed;z-index:9999;opacity:0.85;pointer-events:none;
        background:var(--surface2);border-radius:20px;padding:0.5rem 0.85rem;
        box-shadow:0 4px 20px rgba(0,0,0,0.4);`;
      document.body.appendChild(touchGhost);
      chip.style.opacity = '0.3';
    }, { passive: true });

    chip.addEventListener('touchmove', e => {
      if (!touchGhost) return;
      e.preventDefault();
      const t = e.touches[0];
      touchGhost.style.left = (t.clientX - 60) + 'px';
      touchGhost.style.top  = (t.clientY - 20) + 'px';
      document.querySelectorAll('.sp-pair-slots,.sp-empty-slot,.setup-pairs-pool').forEach(z => z.style.background = '');
      const el = document.elementFromPoint(t.clientX, t.clientY);
      el?.closest('.sp-pair-slots')?.style && (el.closest('.sp-pair-slots').style.background = 'rgba(212,168,67,0.08)');
    }, { passive: false });

    chip.addEventListener('touchend', e => {
      if (!touchGhost) return;
      document.body.removeChild(touchGhost); touchGhost = null;
      touchSrc && (touchSrc.style.opacity = '1');
      document.querySelectorAll('.sp-pair-slots').forEach(z => z.style.background = '');
      const t = e.changedTouches[0];
      const el = document.elementFromPoint(t.clientX, t.clientY);
      const dropZone = el?.closest('.sp-pair-slots') || el?.closest('.sp-empty-slot');
      if (dropZone) dropPlayerIntoPair(parseInt(touchPi), parseInt(dropZone.dataset.pair));
    });
  });

  // Desktop drop zones
  document.querySelectorAll('.sp-pair-slots, .sp-empty-slot').forEach(zone => {
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.style.background = 'rgba(212,168,67,0.08)'; });
    zone.addEventListener('dragleave', () => { zone.style.background = ''; });
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.style.background = '';
      const pi = parseInt(e.dataTransfer.getData('text/plain'));
      const pairIdx = parseInt(zone.dataset.pair);
      dropPlayerIntoPair(pi, pairIdx);
    });
  });

  // Pool drop zone (remove from pair)
  poolEl.addEventListener('dragover', e => { e.preventDefault(); poolEl.style.background = 'rgba(255,255,255,0.05)'; });
  poolEl.addEventListener('dragleave', () => { poolEl.style.background = ''; });
  poolEl.addEventListener('drop', e => {
    e.preventDefault(); poolEl.style.background = '';
    const pi = parseInt(e.dataTransfer.getData('text/plain'));
    removePlayerFromPair(pi);
  });

  // Validate next button
  const allPaired  = named.every(p => p.pairIndex !== -1);
  const validPairs = setup.pairs.every(pair => pair.playerIndices.length === 2);
  const btn = document.getElementById('btn-setup-pairs-next');
  if (btn) {
    const ok = allPaired && validPairs && setup.pairs.length > 0;
    btn.disabled   = !ok;
    btn.style.opacity = ok ? '' : '0.5';
  }
}

function dropPlayerIntoPair(pi, pairIdx) {
  const pair = setup.pairs[pairIdx];
  if (!pair || isNaN(pi) || !setup.players[pi]) return;

  // Defensive cleanup: remove this player from EVERY pair's playerIndices,
  // not just whichever pair setup.players[pi].pairIndex currently claims they're
  // in. This is what actually prevents duplicates — if pairIndex was ever stale
  // (e.g. from a fast drag, or a render that hadn't caught up), the player could
  // still be lingering in another pair's array even though their own pairIndex
  // says otherwise. Scrubbing every pair first makes this immune to that.
  let displacedFromTarget = null;
  setup.pairs.forEach((p, idx) => {
    if (p.playerIndices.includes(pi)) {
      p.playerIndices = p.playerIndices.filter(i => i !== pi);
    }
  });

  // If the target pair is already full (2 players) after the scrub above,
  // bump the first remaining member out to make room — they go back to
  // whichever pair the dragged player just vacated, or the pool if none.
  if (pair.playerIndices.length >= 2) {
    displacedFromTarget = pair.playerIndices.shift();
  }

  // Place the dragged player into the target pair (guaranteed not already
  // present, since we just scrubbed every pair above)
  pair.playerIndices.push(pi);
  setup.players[pi].pairIndex = pairIdx;

  // Re-home the displaced player, if any
  if (displacedFromTarget != null && setup.players[displacedFromTarget]) {
    // Try to put them in whatever pair still has room; otherwise pool
    const openPair = setup.pairs.find((p, idx) => idx !== pairIdx && p.playerIndices.length < 2);
    if (openPair) {
      openPair.playerIndices.push(displacedFromTarget);
      setup.players[displacedFromTarget].pairIndex = setup.pairs.indexOf(openPair);
      if (openPair.playerIndices.length === 2) {
        const [a, b] = openPair.playerIndices;
        openPair.name = `${setup.players[a]?.name.split(' ')[0] ?? ''} & ${setup.players[b]?.name.split(' ')[0] ?? ''}`;
      }
    } else {
      setup.players[displacedFromTarget].pairIndex = -1; // pool
    }
  }

  // Final safety net: deduplicate every pair's playerIndices in case anything
  // above still somehow produced a repeat (belt-and-braces — should be a no-op).
  setup.pairs.forEach(p => { p.playerIndices = [...new Set(p.playerIndices)]; });

  // Auto-update the target pair's name once it has both members
  if (pair.playerIndices.length === 2) {
    const [piA, piB] = pair.playerIndices;
    const nameA = setup.players[piA]?.name.split(' ')[0] ?? '';
    const nameB = setup.players[piB]?.name.split(' ')[0] ?? '';
    pair.name = `${nameA} & ${nameB}`;
  }

  renderSetupPairsScreen();
}

function removePlayerFromPair(pi, reRender = true) {
  const p = setup.players[pi];
  if (!p) return;
  // Scrub from every pair, not just whichever one p.pairIndex currently points
  // at — same defensive approach as dropPlayerIntoPair, so a stale pairIndex
  // can't leave a lingering duplicate reference behind.
  setup.pairs.forEach(pair => {
    pair.playerIndices = pair.playerIndices.filter(i => i !== pi);
  });
  p.pairIndex = -1;
  if (reRender) renderSetupPairsScreen();
}

// ================================================================
// SETUP -- GROUPS SCREEN (players for solo, pairs for pair formats)
// ================================================================

function renderSetupGroupCards() {
  const isPairs  = ['betterball','csm','foursomes','greensomes'].includes(setup.scoring);
  const isBest2  = setup.scoring === 'best2';
  const namedPlayers = setup.players.filter(p => p.name);
  const numPlayers   = namedPlayers.length;

  // Title
  const titleEl = document.getElementById('setup-groups-title');

  if (isPairs) {
    const numPairs = setup.pairs.length;
    if (titleEl) titleEl.textContent = 'Arrange Groups';
    // Auto-suggest: aim for 2 pairs per group
    const suggestedGrps = Math.max(1, Math.ceil(numPairs / 2));
    if (!setup.numGroups || setup.numGroups < 1) setup.numGroups = suggestedGrps;
    // Clamp any out-of-range group assignments
    setup.pairs.forEach(pair => {
      if ((pair.groupNumber ?? 1) > setup.numGroups) pair.groupNumber = setup.numGroups;
    });
    renderSetupPairGroupCards();
    return;
  }

  // ── Best 2: show grouping option buttons ──
  if (isBest2) {
    if (titleEl) titleEl.textContent = 'Arrange Teams';

    const container = document.getElementById('setup-group-cards');
    if (!container) return;

    // Calculate all valid splits: groups of 3 or 4
    const options = [];
    for (let grpSize = 3; grpSize <= 4; grpSize++) {
      if (numPlayers % grpSize === 0) {
        const numGrps = numPlayers / grpSize;
        options.push({ numGroups: numGrps, perGroup: grpSize });
      }
    }
    if (options.length === 0) {
      [3, 4].forEach(grpSize => {
        const numGrps = Math.round(numPlayers / grpSize);
        if (numGrps >= 1 && !options.find(o => o.numGroups === numGrps)) {
          options.push({ numGroups: numGrps, perGroup: Math.ceil(numPlayers / numGrps) });
        }
      });
    }

    const selectedNumGroups = setup.numGroups || options[0]?.numGroups || 2;
    const selectedPerGroup  = setup.playersPerGroup || options[0]?.perGroup || 4;

    let optionHTML = `
      <div class="home-section-label" style="margin-bottom:0.6rem;">Teams</div>
      <div style="display:grid;gap:0.5rem;margin-bottom:1rem;">`;
    options.forEach(opt => {
      const isActive = opt.numGroups === selectedNumGroups;
      optionHTML += `<button class="btn b2-group-opt ${isActive ? 'holes-btn active' : 'btn-outline'}"
        data-groups="${opt.numGroups}" data-per="${opt.perGroup}"
        style="padding:1rem;font-size:1.1rem;font-weight:800;font-family:'Barlow Condensed',sans-serif;">
        ${opt.numGroups} group${opt.numGroups > 1 ? 's' : ''} of ${opt.perGroup}
      </button>`;
    });
    optionHTML += `</div>`;

    if (!namedPlayers.some(p => p.groupNumber > 1) || setup.numGroups !== selectedNumGroups) {
      setup.numGroups       = selectedNumGroups;
      setup.playersPerGroup = selectedPerGroup;
      setup.numPlayers      = numPlayers;
      namedPlayers.forEach((p, i) => {
        p.groupNumber = Math.min(Math.floor(i / selectedPerGroup) + 1, selectedNumGroups);
      });
    }

    const groups = Array.from({ length: selectedNumGroups }, (_, g) =>
      namedPlayers.filter(p => (p.groupNumber ?? 1) === g + 1));

    container.innerHTML = optionHTML + renderB2GroupCards(groups, namedPlayers);
    wireB2GroupCards(container, groups, namedPlayers);

    container.querySelectorAll('.b2-group-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        const ng = parseInt(btn.dataset.groups);
        const np = parseInt(btn.dataset.per);
        setup.numGroups       = ng;
        setup.playersPerGroup = np;
        setup.numPlayers      = numPlayers;
        namedPlayers.forEach((p, i) => {
          p.groupNumber = Math.min(Math.floor(i / np) + 1, ng);
        });
        renderSetupGroupCards();
      });
    });

    const nextBtn = document.getElementById('btn-setup-groups-next');
    if (nextBtn) { nextBtn.disabled = false; nextBtn.style.opacity = ''; }
    return;
  }

  // ── Individual / split6 etc: auto-compute groups ──
  const suggested = Math.max(1, Math.ceil(numPlayers / 4));
  if (!setup.numGroups || setup.numGroups < 1) setup.numGroups = suggested;

  const perGroup  = Math.ceil(numPlayers / setup.numGroups);

  const suggestion = document.getElementById('setup-group-suggestion');
  if (suggestion) {
    suggestion.innerHTML = `
      <div style="display:flex;align-items:center;gap:0.75rem;">
        <button id="grp-dec" class="btn btn-ghost"
          style="padding:0.25rem 0.75rem;font-size:1.2rem;font-weight:800;" ${setup.numGroups <= 1 ? 'disabled' : ''}>−</button>
        <span style="flex:1;text-align:center;font-size:1rem;font-weight:800;">
          ${numPlayers} player${numPlayers !== 1 ? 's' : ''} · ${setup.numGroups} group${setup.numGroups > 1 ? 's' : ''} of ~${perGroup}
        </span>
        <button id="grp-inc" class="btn btn-ghost"
          style="padding:0.25rem 0.75rem;font-size:1.2rem;font-weight:800;" ${setup.numGroups >= numPlayers ? 'disabled' : ''}>＋</button>
      </div>`;
    document.getElementById('grp-dec')?.addEventListener('click', () => {
      if (setup.numGroups > 1) { setup.numGroups--; renderSetupGroupCards(); }
    });
    document.getElementById('grp-inc')?.addEventListener('click', () => {
      if (setup.numGroups < numPlayers) { setup.numGroups++; renderSetupGroupCards(); }
    });
  }

  // Assign groupNumber to players if not yet set
  const hasAssignment = namedPlayers.some(p => p.groupNumber > 1);
  if (!hasAssignment || namedPlayers.some(p => (p.groupNumber ?? 1) > setup.numGroups)) {
    namedPlayers.forEach((p, i) => {
      p.groupNumber = Math.min(Math.floor(i / Math.ceil(numPlayers / setup.numGroups)) + 1, setup.numGroups);
    });
  }

  const groups = Array.from({ length: setup.numGroups }, (_, g) =>
    namedPlayers.filter(p => (p.groupNumber ?? 1) === g + 1));

  const container = document.getElementById('setup-group-cards');
  if (!container) return;

  // Balance warning
  const sizes  = groups.map(g => g.length);
  const maxSz  = Math.max(...sizes), minSz = Math.min(...sizes);
  let warning  = '';
  if (setup.numGroups > 1 && maxSz - minSz >= 2) {
    const bigN  = sizes.filter(s => s === maxSz).length;
    const smlN  = sizes.filter(s => s === minSz).length;
    warning = `<div style="background:rgba(212,168,67,0.12);border:1px solid var(--gold-border);
      border-radius:var(--radius-sm);padding:0.65rem 0.85rem;margin-bottom:0.75rem;
      font-size:0.95rem;font-weight:700;color:var(--gold);">
      ⚠️ Groups are uneven — ${bigN} group${bigN>1?'s':''} of ${maxSz} and ${smlN} of ${minSz}.
      Consider ${Math.ceil(numPlayers/setup.numGroups)} or ${Math.floor(numPlayers/setup.numGroups)} per group.
    </div>`;
  }

  container.innerHTML = warning;

  const isTexasFmt = setup.scoring === 'texas';

  groups.forEach((groupPlayers, g) => {
    const overLimit = groupPlayers.length > 4;
    const card      = document.createElement('div');
    card.className  = 'card mb-sm sg-drop-zone';
    card.dataset.group = g + 1;
    if (overLimit) card.style.borderColor = 'var(--red-border)';

    // Texas Scramble: this group IS the scramble team — show their combined
    // team handicap, recalculated live from whoever is currently in the group.
    let texasHcpBadge = '';
    if (isTexasFmt && groupPlayers.length > 0) {
      const idxArr = groupPlayers.map(p => p.courseHandicap ?? p.hcpIndex ?? 0);
      const teamHcp = texasTeamHandicap(idxArr, setup.texasMode ?? 'average', setup.hcpPct ?? 100);
      texasHcpBadge = `
        <div style="text-align:right;flex-shrink:0;">
          <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;
                      font-size:1.3rem;color:var(--gold);">${teamHcp}</div>
          <div style="font-size:0.65rem;color:var(--muted);font-weight:700;
                      text-transform:uppercase;letter-spacing:0.05em;">Team HCP</div>
        </div>`;
    }

    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;">
        <div class="card-title" style="margin:0;">Group ${g + 1}</div>
        <div style="display:flex;align-items:center;gap:0.75rem;">
          <div style="font-size:0.85rem;font-weight:700;color:${overLimit ? 'var(--red)' : 'var(--muted2)'};">
            ${groupPlayers.length} player${groupPlayers.length !== 1 ? 's' : ''}${overLimit ? ' — max 4' : ''}
          </div>
          ${texasHcpBadge}
        </div>
      </div>
      <div class="sg-player-list" data-group="${g + 1}">
        ${groupPlayers.length === 0
          ? `<div style="padding:0.75rem;text-align:center;color:var(--muted);font-size:0.9rem;
              border:1.5px dashed var(--border);border-radius:var(--radius-sm);">Drop a player here</div>`
          : groupPlayers.map(p => {
              const pi = setup.players.indexOf(p);
              return `<div class="sg-player-row" draggable="true" data-name="${p.name}"
                style="display:flex;align-items:center;gap:0.75rem;padding:0.65rem 0.5rem;
                       border-bottom:1px solid var(--border);cursor:grab;user-select:none;
                       border-radius:var(--radius-sm);">
                <span style="font-size:1.1rem;color:var(--muted);">⣿</span>
                <span class="dot" style="background:${pHex(pi % 8)};flex-shrink:0;"></span>
                <div style="flex:1;">
                  <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.1rem;">${p.name}</div>
                  <div style="font-size:0.82rem;color:var(--muted2);">HCP ${fmtHandicap(p.hcpIndex)}</div>
                </div>
              </div>`;
            }).join('')}
      </div>`;
    container.appendChild(card);
  });

  // ── Drag & drop: onto player = swap, onto empty = move ──
  const sg = makeSwapDrop(
    setup.players,
    p => p.groupNumber, (p,v) => { p.groupNumber = v; },
    renderSetupGroupCards
  );
  // Add sg-empty-zone attribute to empty cards
  container.querySelectorAll('.sg-drop-zone').forEach(zone => {
    const emptyDiv = zone.querySelector('[data-group]');
    if (emptyDiv && !zone.querySelector('.sg-player-row')) emptyDiv.classList.add('sg-empty-zone');
  });
  sg.wireDrag(container, '.sg-player-row', '.sg-empty-zone');

  // Validate
  const overAny = groups.some(g => g.length > 4);
  const btn     = document.getElementById('btn-setup-groups-next');
  if (btn) { btn.disabled = overAny; btn.style.opacity = overAny ? '0.5' : ''; }
}


  // Drag onto a player = swap groups. Drag onto empty slot = move.
  function makeSwapDrop(players, getGroup, setGroup, rerender) {
    return {
      swapOrMove(fromName, toName, toGroupVal) {
        const fromP = players.find(p => p.name === fromName);
        if (!fromP) return;
        if (toName) {
          const toP = players.find(p => p.name === toName);
          if (!toP || fromName === toName) return;
          if (getGroup(fromP) === getGroup(toP)) {
            // Same group — reorder by swapping their positions in setup.players,
            // since display order is derived from that array's order, and the
            // `players` list passed in here may itself be a filtered/derived copy.
            const fromIdx = setup.players.indexOf(fromP);
            const toIdx   = setup.players.indexOf(toP);
            if (fromIdx === -1 || toIdx === -1) return;
            [setup.players[fromIdx], setup.players[toIdx]] = [setup.players[toIdx], setup.players[fromIdx]];
          } else {
            const tmp = getGroup(fromP); setGroup(fromP, getGroup(toP)); setGroup(toP, tmp);
          }
        } else { setGroup(fromP, toGroupVal); }
        rerender();
      },
      wireDrag(container, rowSel, emptySel) {
        const self = this;
        let ghost = null, srcName = null, srcEl = null;
        container.querySelectorAll(rowSel).forEach(row => {
          row.addEventListener('dragstart', e => {
            row.style.opacity = '0.4';
            e.dataTransfer.setData('text/plain', row.dataset.name);
            e.dataTransfer.effectAllowed = 'move';
          });
          row.addEventListener('dragend', () => { row.style.opacity = '1'; });
          row.addEventListener('dragover', e => { e.preventDefault(); row.style.background='rgba(212,168,67,0.15)'; row.style.borderColor='var(--gold-border)'; });
          row.addEventListener('dragleave', () => { row.style.background=''; row.style.borderColor=''; });
          row.addEventListener('drop', e => {
            e.preventDefault(); e.stopPropagation();
            row.style.background=''; row.style.borderColor='';
            const from = e.dataTransfer.getData('text/plain');
            if (from !== row.dataset.name) self.swapOrMove(from, row.dataset.name, null);
          });
          row.addEventListener('touchstart', e => {
            srcName = row.dataset.name; srcEl = row;
            ghost = row.cloneNode(true);
            ghost.style.cssText = 'position:fixed;z-index:9999;opacity:0.85;pointer-events:none;background:var(--surface2);border-radius:var(--radius-sm);padding:0.5rem;box-shadow:0 4px 20px rgba(0,0,0,.4);width:'+row.offsetWidth+'px;';
            document.body.appendChild(ghost); row.style.opacity = '0.3';
          }, { passive: true });
          row.addEventListener('touchmove', e => {
            if (!ghost) return; e.preventDefault();
            const t = e.touches[0];
            ghost.style.left = (t.clientX - ghost.offsetWidth/2)+'px';
            ghost.style.top  = (t.clientY - 30)+'px';
            container.querySelectorAll(rowSel+','+emptySel).forEach(el => { el.style.background=''; el.style.borderColor=''; });
            const under = document.elementFromPoint(t.clientX, t.clientY);
            const tr = under?.closest(rowSel); const ez = under?.closest(emptySel);
            if (tr && tr !== srcEl) { tr.style.background='rgba(212,168,67,0.15)'; tr.style.borderColor='var(--gold-border)'; }
            if (ez) ez.style.background='rgba(212,168,67,0.08)';
          }, { passive: false });
          row.addEventListener('touchend', e => {
            if (!ghost) return;
            document.body.removeChild(ghost); ghost = null; srcEl && (srcEl.style.opacity='1');
            container.querySelectorAll(rowSel+','+emptySel).forEach(el => { el.style.background=''; el.style.borderColor=''; });
            const t = e.changedTouches[0];
            const under = document.elementFromPoint(t.clientX, t.clientY);
            const tr = under?.closest(rowSel); const ez = under?.closest(emptySel);
            if (tr && tr !== srcEl) self.swapOrMove(srcName, tr.dataset.name, null);
            else if (ez) self.swapOrMove(srcName, null, parseInt(ez.dataset.group));
          });
        });
        container.querySelectorAll(emptySel).forEach(zone => {
          zone.addEventListener('dragover', e => { e.preventDefault(); zone.style.background='rgba(212,168,67,0.08)'; });
          zone.addEventListener('dragleave', () => { zone.style.background=''; });
          zone.addEventListener('drop', e => { e.preventDefault(); zone.style.background=''; self.swapOrMove(e.dataTransfer.getData('text/plain'), null, parseInt(zone.dataset.group)); });
        });
      }
    };
  }

function renderB2GroupCards(groups, namedPlayers) {
  let html = '';
  groups.forEach((groupPlayers, g) => {
    html += `<div class="card mb-sm sg-drop-zone" data-group="${g + 1}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;">
        <div class="card-title" style="margin:0;">Group ${g + 1}</div>
        <div style="font-size:0.85rem;font-weight:700;color:var(--muted2);">${groupPlayers.length} players</div>
      </div>
      <div class="sg-player-list" data-group="${g + 1}">
        ${groupPlayers.length === 0
          ? `<div style="padding:0.75rem;text-align:center;color:var(--muted);font-size:0.9rem;
              border:1.5px dashed var(--border);border-radius:var(--radius-sm);">Drop a player here</div>`
          : groupPlayers.map(p => {
              const pi = namedPlayers.indexOf(p);
              return `<div class="sg-player-row" draggable="true" data-name="${p.name}"
                style="display:flex;align-items:center;gap:0.75rem;padding:0.65rem 0.5rem;
                       border-bottom:1px solid var(--border);cursor:grab;user-select:none;
                       border-radius:var(--radius-sm);">
                <span style="font-size:1.1rem;color:var(--muted);">⣿</span>
                <span class="dot" style="background:${pHex(pi % 8)};flex-shrink:0;"></span>
                <div style="flex:1;">
                  <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.1rem;">${p.name}</div>
                  <div style="font-size:0.82rem;color:var(--muted2);">HCP ${fmtHandicap(p.hcpIndex)}</div>
                </div>
              </div>`;
            }).join('')}
      </div>
    </div>`;
  });
  return html;
}

function wireB2GroupCards(container, groups, namedPlayers) {
  // Mark empty group divs
  container.querySelectorAll('.sg-drop-zone').forEach(zone => {
    const empty = zone.querySelector('.sg-player-list > div:not(.sg-player-row)');
    if (empty) empty.classList.add('sg-empty-zone');
  });
  const b2 = makeSwapDrop(
    namedPlayers,
    p => p.groupNumber, (p,v) => { p.groupNumber = v; },
    renderSetupGroupCards
  );
  b2.wireDrag(container, '.sg-player-row', '.sg-empty-zone');
}

// Pair-groups mode: drag PAIRS into groups (2 pairs per group)
function renderSetupPairGroupCards() {
  const container  = document.getElementById('setup-group-cards');
  const suggestion = document.getElementById('setup-group-suggestion');
  if (!container) return;

  const numPairs = setup.pairs.length;

  // Auto-assign pairs to groups if not yet set
  const hasAssign = setup.pairs.some(p => (p.groupNumber ?? 1) > 1);
  if (!hasAssign) {
    const pairsPerGroup = Math.ceil(numPairs / setup.numGroups);
    setup.pairs.forEach((p, i) => {
      p.groupNumber = Math.min(Math.floor(i / pairsPerGroup) + 1, setup.numGroups);
    });
  }

  if (suggestion) {
    suggestion.innerHTML = `
      <div style="display:flex;align-items:center;gap:0.75rem;">
        <button id="pgrp-dec" class="btn btn-ghost"
          style="padding:0.25rem 0.75rem;font-size:1.2rem;font-weight:800;" ${setup.numGroups <= 1 ? 'disabled' : ''}>−</button>
        <span style="flex:1;text-align:center;font-size:1rem;font-weight:800;">
          ${numPairs} pairs · ${setup.numGroups} group${setup.numGroups > 1 ? 's' : ''} of 2 · Drag a pair onto another to swap
        </span>
        <button id="pgrp-inc" class="btn btn-ghost"
          style="padding:0.25rem 0.75rem;font-size:1.2rem;font-weight:800;" ${setup.numGroups >= numPairs ? 'disabled' : ''}>＋</button>
      </div>`;
    document.getElementById('pgrp-dec')?.addEventListener('click', () => {
      if (setup.numGroups > 1) {
        setup.numGroups--;
        setup.pairs.forEach(p => { if ((p.groupNumber ?? 1) > setup.numGroups) p.groupNumber = setup.numGroups; });
        renderSetupPairGroupCards();
      }
    });
    document.getElementById('pgrp-inc')?.addEventListener('click', () => {
      if (setup.numGroups < numPairs) { setup.numGroups++; renderSetupPairGroupCards(); }
    });
  }

  const groups = Array.from({ length: setup.numGroups }, (_, g) =>
    setup.pairs.filter(p => (p.groupNumber ?? 1) === g + 1));

  container.innerHTML = '';

  groups.forEach((groupPairs, g) => {
    const card = document.createElement('div');
    card.className = 'card mb-sm spg-group-card';
    card.dataset.group = g + 1;

    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;">
        <div class="card-title" style="margin:0;">Group ${g + 1}</div>
        <div style="font-size:0.85rem;font-weight:700;color:var(--muted2);">
          ${groupPairs.length} pair${groupPairs.length !== 1 ? 's' : ''}
        </div>
      </div>
      <div class="spg-pair-list" data-group="${g + 1}" style="display:grid;gap:0.4rem;min-height:52px;">
        ${groupPairs.length === 0
          ? `<div class="spg-empty" data-group="${g + 1}"
              style="padding:0.75rem;text-align:center;color:var(--muted);font-size:0.9rem;
                     border:1.5px dashed var(--border);border-radius:var(--radius-sm);">
              Drop a pair here</div>`
          : groupPairs.map(pair => {
              const [pi0, pi1] = pair.playerIndices;
              const p0 = setup.players[pi0], p1 = setup.players[pi1];
              const hcp0 = p0?.courseHandicap ?? p0?.hcpIndex ?? 0;
              const hcp1 = p1?.courseHandicap ?? p1?.hcpIndex ?? 0;
              const pairHcp = setup.scoring === 'greensomes'
                ? greensomesPairHandicap(hcp0, hcp1)
                : foursomedPairHandicap(hcp0, hcp1);
              return `<div class="spg-pair-row" draggable="true"
                data-uid="${pair._uid}" data-group="${g + 1}"
                style="display:flex;align-items:center;gap:0.75rem;padding:0.65rem 0.75rem;
                       background:var(--surface2);border:1px solid var(--border);
                       border-radius:var(--radius-sm);cursor:grab;user-select:none;
                       transition:background 0.1s,border-color 0.1s;">
                <span style="font-size:1.1rem;color:var(--muted);">⣿</span>
                <div style="flex:1;">
                  <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;
                              font-size:1.1rem;color:var(--gold);">${pair.name}</div>
                  <div style="font-size:0.82rem;color:var(--muted2);">
                    ${p0?.name ?? '?'} · HCP ${fmtHandicap(p0?.hcpIndex ?? 0)} &nbsp;
                    ${p1?.name ?? '?'} · HCP ${fmtHandicap(p1?.hcpIndex ?? 0)}
                  </div>
                </div>
                <div style="text-align:right;flex-shrink:0;">
                  <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;
                              font-size:1.3rem;color:var(--white);">${pairHcp}</div>
                  <div style="font-size:0.65rem;color:var(--muted);font-weight:700;
                              text-transform:uppercase;letter-spacing:0.05em;">Pair HCP</div>
                </div>
              </div>`;
            }).join('')}
      </div>`;
    container.appendChild(card);
  });

  // ── Swap logic ──────────────────────────────────────────────────
  // Drag a pair ROW onto another pair ROW → swap their groups
  // Drag onto an EMPTY group slot → move there (no swap partner)
  let draggingUid = null;
  let touchGhost = null, touchDragUid = null, touchSrcRow = null;

  function swapOrMove(fromUid, toUid) {
    const pA = setup.pairs.find(p => p._uid === fromUid);
    const pB = setup.pairs.find(p => p._uid === toUid);
    if (!pA || !pB || fromUid === toUid) return;
    const tmp = pA.groupNumber;
    pA.groupNumber = pB.groupNumber;
    pB.groupNumber = tmp;
    renderSetupPairGroupCards();
  }

  function movePairToGroup(uid, groupNum) {
    const pair = setup.pairs.find(p => p._uid === uid);
    if (pair && pair.groupNumber !== groupNum) {
      pair.groupNumber = groupNum;
      renderSetupPairGroupCards();
    }
  }

  // Desktop drag
  container.querySelectorAll('.spg-pair-row').forEach(row => {
    row.addEventListener('dragstart', e => {
      draggingUid = row.dataset.uid;
      row.style.opacity = '0.4';
      e.dataTransfer.setData('text/plain', row.dataset.uid);
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      row.style.opacity = '1';
      draggingUid = null;
    });

    // Drop onto another pair row = SWAP
    row.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (row.dataset.uid !== draggingUid) {
        row.style.background = 'rgba(212,168,67,0.15)';
        row.style.borderColor = 'var(--gold-border)';
      }
    });
    row.addEventListener('dragleave', () => {
      row.style.background = '';
      row.style.borderColor = '';
    });
    row.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation();
      row.style.background = ''; row.style.borderColor = '';
      const fromUid = e.dataTransfer.getData('text/plain');
      const toUid   = row.dataset.uid;
      if (fromUid && fromUid !== toUid) swapOrMove(fromUid, toUid);
    });
  });

  // Drop onto empty group slot = MOVE
  container.querySelectorAll('.spg-empty').forEach(slot => {
    slot.addEventListener('dragover', e => {
      e.preventDefault();
      slot.style.background = 'rgba(212,168,67,0.08)';
      slot.style.borderColor = 'var(--gold)';
    });
    slot.addEventListener('dragleave', () => {
      slot.style.background = '';
      slot.style.borderColor = '';
    });
    slot.addEventListener('drop', e => {
      e.preventDefault();
      slot.style.background = ''; slot.style.borderColor = '';
      const fromUid  = e.dataTransfer.getData('text/plain');
      const groupNum = parseInt(slot.dataset.group);
      if (fromUid) movePairToGroup(fromUid, groupNum);
    });
  });

  // Touch drag
  container.querySelectorAll('.spg-pair-row').forEach(row => {
    row.addEventListener('touchstart', e => {
      touchDragUid = row.dataset.uid;
      touchSrcRow = row;
      touchGhost = row.cloneNode(true);
      touchGhost.style.cssText = `position:fixed;z-index:9999;opacity:0.85;pointer-events:none;
        background:var(--surface2);border-radius:var(--radius-sm);padding:0.5rem;
        box-shadow:0 4px 20px rgba(0,0,0,0.4);width:${row.offsetWidth}px;`;
      document.body.appendChild(touchGhost);
      row.style.opacity = '0.3';
    }, { passive: true });

    row.addEventListener('touchmove', e => {
      if (!touchGhost) return;
      e.preventDefault();
      const t = e.touches[0];
      touchGhost.style.left = (t.clientX - touchGhost.offsetWidth / 2) + 'px';
      touchGhost.style.top  = (t.clientY - 30) + 'px';
      // Highlight the row/slot under finger
      container.querySelectorAll('.spg-pair-row,.spg-empty').forEach(el => {
        el.style.background = ''; el.style.borderColor = '';
      });
      const under = document.elementFromPoint(t.clientX, t.clientY);
      const targetRow  = under?.closest('.spg-pair-row');
      const targetSlot = under?.closest('.spg-empty');
      if (targetRow && targetRow !== touchSrcRow) {
        targetRow.style.background   = 'rgba(212,168,67,0.15)';
        targetRow.style.borderColor  = 'var(--gold-border)';
      }
      if (targetSlot) {
        targetSlot.style.background   = 'rgba(212,168,67,0.08)';
        targetSlot.style.borderColor  = 'var(--gold)';
      }
    }, { passive: false });

    row.addEventListener('touchend', e => {
      if (!touchGhost) return;
      document.body.removeChild(touchGhost); touchGhost = null;
      touchSrcRow && (touchSrcRow.style.opacity = '1');
      container.querySelectorAll('.spg-pair-row,.spg-empty').forEach(el => {
        el.style.background = ''; el.style.borderColor = '';
      });
      const t = e.changedTouches[0];
      const under      = document.elementFromPoint(t.clientX, t.clientY);
      const targetRow  = under?.closest('.spg-pair-row');
      const targetSlot = under?.closest('.spg-empty');
      if (targetRow) {
        const toUid = targetRow.dataset.uid;
        if (toUid !== touchDragUid) swapOrMove(touchDragUid, toUid);
      } else if (targetSlot) {
        movePairToGroup(touchDragUid, parseInt(targetSlot.dataset.group));
      }
    });
  });

  // Validate — all groups should have ≤ 2 pairs (no hard max now, swap always keeps counts constant)
  const btn = document.getElementById('btn-setup-groups-next');
  if (btn) { btn.disabled = false; btn.style.opacity = ''; }
}

document.getElementById('setup-groups-back')?.addEventListener('click', () => {
  const isPairs = ['betterball','csm','foursomes','greensomes'].includes(setup.scoring);
  if (isPairs) showScreen('screen-setup-pairs');
  else showScreen('screen-setup-players');
});
document.getElementById('setup-abandon-3')?.addEventListener('click', () => {
  clearSetupState(); clearSetupDraft(); showHome();
});
document.getElementById('setup-abandon-pairs')?.addEventListener('click', () => {
  clearSetupState(); clearSetupDraft(); showHome();
});
document.getElementById('setup-abandon-review')?.addEventListener('click', () => {
  clearSetupState(); clearSetupDraft(); showHome();
});
document.getElementById('setup-pairs-back')?.addEventListener('click', () => showScreen('screen-setup-players'));

document.getElementById('btn-setup-groups-next')?.addEventListener('click', () => {
  buildSetupReview();
  showScreen('screen-setup-review');
});

document.getElementById('btn-setup-pairs-next')?.addEventListener('click', () => {
  const named      = setup.players.filter(p => p.name);
  const unassigned = named.filter(p => p.pairIndex == null || p.pairIndex === -1);
  if (unassigned.length > 0) {
    alert(`${unassigned.map(p => p.name).join(', ')} still need${unassigned.length === 1 ? 's' : ''} to be assigned to a pair.`);
    return;
  }
  const incompletePairs = setup.pairs.filter(pair => pair.playerIndices.length < 2);
  if (incompletePairs.length > 0) {
    alert(`${incompletePairs.map(p => `"${p.name}"`).join(', ')} need${incompletePairs.length === 1 ? 's' : ''} a second player.`);
    return;
  }
  renderSetupGroupCards();
  showScreen('screen-setup-groups');
});

// Returns the user's saved Course Handicap for the currently-selected
// course/tee, if their home club + tee matches one with a saved value.
function getMyCourseHandicapDefault() {
  try {
    const course = allCourses.find(c => c.id === setup.courseId);
    const tee    = course?.tees?.[setup.teeIdx];
    const saved  = currentProfile?.home_course_handicaps ?? {};
    if (tee && saved[tee.name] != null) return saved[tee.name];
  } catch {}
  return null;
}


function openFriendPicker(playerIdx, customCallback = null, excludeAlreadyAdded = null) {
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
  // excludeAlreadyAdded:
  //   null/undefined → default behaviour: exclude against setup.players UNLESS a
  //     custom callback was given (co-organiser picker etc. opt out by default)
  //   true            → exclude against setup.players explicitly
  //   Array           → exclude against this list of already-added profileIds directly
  //   false           → no exclusion
  let excludeIds = null;
  if (Array.isArray(excludeAlreadyAdded)) {
    excludeIds = new Set(excludeAlreadyAdded.filter(Boolean));
  } else if (excludeAlreadyAdded === true || (excludeAlreadyAdded === null && !customCallback)) {
    excludeIds = new Set(
      setup.players.filter((p, i) => i !== playerIdx && p.profileId).map(p => p.profileId)
    );
  }

  document.getElementById('fp-title').textContent = `Pick Player ${playerIdx + 1}`;
  hide('fp-confirm'); show('fp-chips');
  const chips = document.getElementById('fp-chips');
  chips.innerHTML = '';

  const availableFriends = excludeIds
    ? allFriends.filter(f => !excludeIds.has(f.profileId))
    : allFriends;

  if (!availableFriends.length) {
    show('fp-empty');
    const emptyEl = document.getElementById('fp-empty');
    if (emptyEl) emptyEl.textContent = allFriends.length
      ? 'All your friends are already added to this game.'
      : 'No friends yet — add some from the Friends tab.';
    document.getElementById('modal-friend-picker').classList.add('open');
    return;
  }
  hide('fp-empty');
  availableFriends.forEach(f => {
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
document.getElementById('setup-abandon-2')        ?.addEventListener('click', () => { clearSetupState(); clearSetupDraft(); showHome(); });

// (btn-setup-players-next wired in player list section above)

// ================================================================
// SETUP -- STEP 3: REVIEW
// ================================================================
function buildSetupReview() {
  const course   = allCourses.find(c => c.id === setup.courseId);
  const tee      = course?.tees?.[setup.teeIdx];
  const { offset, count } = holeRange(setup.holes);
  const isPairs  = ['betterball','csm','foursomes','greensomes'].includes(setup.scoring);
  const isBest2  = setup.scoring === 'best2';
  const isTexas  = setup.scoring === 'texas';
  const named    = setup.players.filter(p => p.name);
  const hcpArr   = named.map(p => p.hcpIndex || 0);
  const hcpObj   = calcHandicaps(hcpArr, setup.hcpPct);

  // Texas: compute team HCP per group for display
  const texasGroupHcps = isTexas ? (() => {
    const numGroups = Math.max(1, ...named.map(p => p.groupNumber ?? 1));
    const result = {};
    for (let g = 1; g <= numGroups; g++) {
      const gPlayers = named.filter(p => (p.groupNumber ?? 1) === g);
      result[g] = texasTeamHandicap(gPlayers.map(p => p.hcpIndex || 0), setup.texasMode ?? 'average', setup.hcpPct);
    }
    return result;
  })() : {};

  let html = `
    <div style="display:grid;gap:0.5rem;font-size:1.05rem;font-weight:700;margin-bottom:1rem;">
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted2);">Format</span><span>${fmtLabel(setup.scoring)}</span></div>
      ${isTexas ? `
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted2);">Scoring</span><span>${setup.texasScoringFmt === 'stroke' ? 'Strokeplay' : 'Stableford'}</span></div>
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted2);">HCP Mode</span><span>${setup.texasMode === 'weighted' ? 'Weighted' : 'Average'}</span></div>
      ` : ''}
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted2);">Course</span><span>${course?.name ?? '--'}</span></div>
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted2);">Tees</span><span>${tee?.name ?? '--'}</span></div>
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted2);">Holes</span><span>${count === 18 ? '18' : count === 9 && offset === 0 ? 'Front 9' : 'Back 9'}</span></div>
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted2);">HCP Allowance</span><span>${setup.hcpPct}%</span></div>
    </div>
    <div style="border-top:1px solid var(--border);padding-top:0.75rem;">`;

  if (isTexas) {
    // Show groups with team HCP
    const numGroups = Math.max(1, ...named.map(p => p.groupNumber ?? 1));
    for (let g = 1; g <= numGroups; g++) {
      const gPlayers = named.filter(p => (p.groupNumber ?? 1) === g);
      const teamHcp  = texasGroupHcps[g] ?? 0;
      html += `<div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);
                            padding:0.65rem 0.85rem;margin-bottom:0.5rem;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.35rem;">
          <span style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.1rem;color:var(--gold);">
            🤠 Team ${g}
          </span>
          <span style="font-size:0.9rem;font-weight:700;color:var(--muted2);">Team HCP ${teamHcp}</span>
        </div>
        ${gPlayers.map((p, si) => {
          const pi = named.indexOf(p);
          return `<div style="display:flex;justify-content:space-between;align-items:center;padding:0.25rem 0;font-size:0.95rem;font-weight:700;">
            <span style="display:flex;align-items:center;gap:6px;">
              <span class="dot" style="background:${pHex(named.indexOf(p) % 8)};"></span>${p.name}
            </span>
            <span style="color:var(--muted2);">HCP ${fmtHandicap(p.hcpIndex)}</span>
          </div>`;
        }).join('')}
      </div>`;
    }
  } else if (isPairs && setup.pairs?.length > 0) {
    const isTournTeamMode = !!setup.tournamentId && activeTournament?.scoring_mode_team !== 'individual';
    const numGroups = Math.max(...setup.pairs.map(p => p.groupNumber ?? 1));
    for (let g = 1; g <= numGroups; g++) {
      const groupPairs = setup.pairs.filter(p => (p.groupNumber ?? 1) === g);
      if (numGroups > 1) {
        html += `<div style="font-size:0.8rem;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;
          color:var(--muted);margin:0.75rem 0 0.35rem;">Group ${g}</div>`;
      }
      groupPairs.forEach(pair => {
        const [pi0, pi1] = pair.playerIndices;
        const p0 = setup.players[pi0], p1 = setup.players[pi1];
        const h0 = named.indexOf(p0), h1 = named.indexOf(p1);
        html += `
          <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);
                      padding:0.65rem 0.85rem;margin-bottom:0.5rem;">
            ${isTournTeamMode
              ? `<input type="text" class="sg-team-name-input review-team-name"
                  data-pair="${setup.pairs.indexOf(pair)}"
                  value="${pair.teamName ?? pair.name}" placeholder="Team name">`
              : `<div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.1rem;
                        color:var(--gold);margin-bottom:0.35rem;">${pair.name}</div>`}
            ${[p0, p1].map((p, si) => {
              const pi  = si === 0 ? pi0 : pi1;
              const hi  = si === 0 ? h0  : h1;
              const hcp = hcpObj[hi];
              return `<div style="display:flex;justify-content:space-between;align-items:center;
                          padding:0.25rem 0;font-size:0.95rem;font-weight:700;">
                <span style="display:flex;align-items:center;gap:6px;">
                  <span class="dot" style="background:${pHex(pi % 8)};"></span>${p?.name ?? '?'}
                </span>
                <span style="color:var(--muted2);">Playing ${hcp?.playingHandicap ?? 0}</span>
              </div>`;
            }).join('')}
          </div>`;
      });
    }
  } else {
    const isTeamFmt = ['best2'].includes(setup.scoring); // texas handled separately above
    const isTournTeamMode = !!setup.tournamentId && activeTournament?.scoring_mode_team !== 'individual';
    const numGroups = Math.max(1, ...named.map(p => p.groupNumber ?? 1));
    for (let g = 1; g <= numGroups; g++) {
      const groupPlayers = named.filter(p => (p.groupNumber ?? 1) === g);
      if (isTeamFmt && isTournTeamMode) {
        const existingName = groupPlayers[0]?.teamName ?? `Team ${g}`;
        html += `<input type="text" class="sg-team-name-input review-group-team-name"
            data-group="${g}" value="${existingName}" placeholder="Team ${g} name">`;
      } else if (numGroups > 1) {
        html += `<div style="font-size:0.8rem;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;
          color:var(--muted);margin:0.75rem 0 0.35rem;">${isTeamFmt ? `Team ${g}` : `Group ${g}`}</div>`;
      }
      groupPlayers.forEach(p => {
        const hi  = named.indexOf(p);
        const pi  = setup.players.indexOf(p);
        const hcp = hcpObj[hi];
        html += `
          <div style="display:flex;justify-content:space-between;align-items:center;
                      padding:0.6rem 0;border-bottom:1px solid rgba(255,255,255,0.04);">
            <span style="display:flex;align-items:center;gap:8px;font-size:1.15rem;font-weight:800;">
              <span class="dot" style="background:${pHex(pi % 8)};"></span>${p.name}
            </span>
            <span style="color:var(--muted2);font-size:0.9rem;font-weight:700;text-align:right;">
              HCP ${fmtHandicap(p.hcpIndex)} · Playing ${hcp?.playingHandicap ?? 0}
            </span>
          </div>`;
      });
      if (isTeamFmt && isTournTeamMode) html += `<div style="margin-bottom:1rem;"></div>`;
    }
  }

  html += '</div>';
  document.getElementById('review-content').innerHTML = html;

  // Wire up team name inputs — store onto setup.players / setup.pairs as user types
  document.querySelectorAll('.review-team-name').forEach(inp => {
    inp.addEventListener('input', () => {
      const pairIdx = parseInt(inp.dataset.pair);
      if (setup.pairs[pairIdx]) setup.pairs[pairIdx].teamName = inp.value.trim();
    });
  });
  document.querySelectorAll('.review-group-team-name').forEach(inp => {
    inp.addEventListener('input', () => {
      const g = parseInt(inp.dataset.group);
      named.filter(p => (p.groupNumber ?? 1) === g).forEach(p => { p.teamName = inp.value.trim(); });
    });
  });
}

document.getElementById('setup-review-back') ?.addEventListener('click', () => showScreen('screen-setup-groups'));
document.getElementById('btn-review-back')   ?.addEventListener('click', () => showScreen('screen-setup-groups'));
document.getElementById('btn-tee-off')       ?.addEventListener('click', async () => await teeOff());

async function teeOff() {
  // Tournament mode: route through _teeOffRound
  if (setup.tournamentId) {
    const btn = document.getElementById('btn-tee-off');
    try {
      const course = allCourses.find(c => c.id === setup.courseId);
      const tee    = course?.tees?.[setup.teeIdx];
      if (!course || !tee) { alert('Please select a course and tee.'); return; }

      // Ensure activeTournPlayers is loaded
      if (!activeTournPlayers?.length) {
        activeTournPlayers = await tournamentPlayersLoad(setup.tournamentId).catch(() => []);
      }

      // Build tournGroups from setup.players
      const namedPlayers = setup.players.filter(p => p.name);
      const maxGroup     = Math.max(1, ...namedPlayers.map(p => p.groupNumber ?? 1));
      const isPairsFmt   = ['betterball','csm','foursomes','greensomes'].includes(setup.scoring);

      tournGroups = Array.from({ length: maxGroup }, (_, g) => {
        const groupNum = g + 1;
        // Resolve team name for this group:
        // - Pairs formats: from setup.pairs[*].teamName (set on review screen)
        // - Best2/Texas: from setup.players[*].teamName (set on review screen)
        let teamName = null;
        if (isPairsFmt && setup.pairs?.length) {
          const pair = setup.pairs.find(pr => (pr.groupNumber ?? 1) === groupNum);
          teamName = pair?.teamName ?? pair?.name ?? null;
        } else {
          const gp = namedPlayers.find(p => (p.groupNumber ?? 1) === groupNum);
          teamName = gp?.teamName ?? null;
        }
        return {
          groupNumber: groupNum,
          teamName,
          players: namedPlayers
            .filter(p => (p.groupNumber ?? 1) === groupNum)
            .map(p => {
              // Match by tournamentPlayerId first, then profileId, then name
              const tp = activeTournPlayers.find(tp =>
                (p.tournamentPlayerId && tp.id === p.tournamentPlayerId) ||
                (p.profileId && tp.profile_id === p.profileId) ||
                tp.name === p.name
              );
              return tp?.id ?? null;
            })
            .filter(Boolean),
        };
      });

      if (!tournGroups.some(g => g.players.length > 0)) {
        alert('Could not match players to tournament roster. Please go back and check the player list.');
        return;
      }

      // Save group state for next round
      localStorage.setItem(`lb-tround-${setup.tournamentId}`, JSON.stringify({
        courseId: setup.courseId, teeName: tee.name,
        date: new Date().toISOString().split('T')[0],
        numGroups: maxGroup, groups: tournGroups,
      }));

      await _teeOffRound(setup.tournamentId, setup.courseId, tee.name, new Date().toISOString().split('T')[0]);
    } catch (err) {
      console.error('[teeOff] tournament branch failed:', err);
      alert('Could not start the round: ' + (err.message || 'Unknown error. Please try again.'));
      if (btn) { btn.disabled = false; btn.textContent = '⛳ TEE OFF →'; }
    }
    return;
  }

  const course = allCourses.find(c => c.id === setup.courseId);
  const tee    = course?.tees?.[setup.teeIdx];
  if (!course || !tee) return;
  const { offset, count } = holeRange(setup.holes);
  const siSlice  = tee.si.slice(offset, offset + count);
  const parSlice = tee.par.slice(offset, offset + count);
  const fmt      = setup.scoring;
  const isPairs  = ['betterball','csm','foursomes','greensomes'].includes(fmt);

  // Derive numPlayers and numGroups from actual setup data
  const namedPlayers = setup.players.filter(p => p.name);
  setup.numPlayers   = namedPlayers.length;
  if (isPairs && setup.pairs?.length > 0) {
    // Each group has 2 pairs = 4 players; groups determined by pair.groupNumber
    setup.numGroups = Math.max(...setup.pairs.map(p => p.groupNumber ?? 1));
  } else {
    setup.numGroups = Math.max(...namedPlayers.map(p => p.groupNumber ?? 1));
  }

  // Remember last used tee for this course
  try { localStorage.setItem(`lb-last-tee-${setup.courseId}`, tee.name); } catch {}

  // Use gameHandicap (set by HCP picker) if available, then Course HCP, then Index
  const hcpArr = setup.players.map(p =>
    p.gameHandicap != null ? p.gameHandicap
    : p.courseHandicap != null ? p.courseHandicap
    : p.hcpIndex ?? 0
  );
  const hcpObj = calcHandicaps(hcpArr, setup.hcpPct);

  // For foursomes/greensomes override pair handicaps using official rules
  // We still store individual handicaps but the processHole function handles the pair calculation
  const playingHcps = hcpObj.map(h => h.playingHandicap);
  const matchHcps   = hcpObj.map(h => h.matchHandicap);

  const playersPerGroup = Math.ceil(setup.numPlayers / setup.numGroups);

  // Build one game state per group
  const groupStates = [];
  for (let g = 0; g < setup.numGroups; g++) {
    const groupNum = g + 1;
    let groupPlayers;

    if (isPairs && setup.pairs?.length > 0) {
      // For pair formats: order players so Pair A = [0,1], Pair B = [2,3]
      const groupPairs = setup.pairs.filter(p => (p.groupNumber ?? 1) === groupNum);
      groupPlayers = groupPairs.flatMap(pair =>
        pair.playerIndices.map(pi => setup.players[pi]).filter(Boolean)
      );
    } else if (setup.players.some(p => p.groupNumber > 1)) {
      groupPlayers = setup.players.filter(p => (p.groupNumber ?? 1) === groupNum);
    } else {
      groupPlayers = setup.players.slice(g * playersPerGroup, Math.min((g + 1) * playersPerGroup, setup.numPlayers));
    }

    const gNames  = groupPlayers.map((p, j) => p.name || `Player ${j + 1}`);
    const gHcpArr = groupPlayers.map(p =>
      p.gameHandicap != null ? p.gameHandicap
      : p.courseHandicap != null ? p.courseHandicap
      : p.hcpIndex ?? 0
    );
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
      longestDriveHoles: setup.ldEnabled  ? setup.ldHoles  : [],
      nearestPinHoles:   setup.ntpEnabled ? setup.ntpHoles : [],
    });

    // Texas Scramble: compute and store team handicap and options
    if (fmt === 'texas') {
      gs.teamHcp         = texasTeamHandicap(gHcpArr, setup.texasMode ?? 'average', setup.hcpPct);
      gs.texasMode       = setup.texasMode ?? 'average';
      gs.texasScoringFmt = setup.texasScoringFmt ?? 'stableford';
      gs.teamName        = `Team ${g + 1}`;
      gs.grossTotal      = 0;
      gs.texasPts        = 0;
      gs.driverUsage     = { par3: [], par4: [], par5: [] };
      gs.texasDrivesTotal = setup.texasDrivesTotal ?? null;
      gs.texasDrivesPar3  = setup.texasDrivesPar3  ?? null;
    }

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
      // Multi-group: auto-send invites to all players with a profile in other groups.
      // Use each player's actual groupNumber (set on the groups screen) rather than
      // recalculating even slices — group sizes aren't always equal (e.g. Best 2).
      const myGroupNum = setup.players.find(p => p.profileId === currentUser.id)?.groupNumber ?? 1;
      const otherGroupPlayers = setup.players.filter(p =>
        p.profileId && p.profileId !== currentUser.id && (p.groupNumber ?? 1) !== myGroupNum
      );
      for (const p of otherGroupPlayers) {
        try {
          await smsInviteCreate({
            roundId, inviterId: currentUser.id, name: myName,
            mobile: null, recipientProfileId: p.profileId,
            tournamentRoundId: null, groupNumber: p.groupNumber ?? 1,
          });
        } catch (e) { console.error('[invite] multi-group invite failed for', p.name, e); }
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
async function resumeRound(id) {
  try {
    const round = await roundLoadById(id);
    if (!round) return;
    roundId = id;
    let gs = round.game_state;
    if (gs?.allGroupStates) {
      gs.allGroupStates.forEach((s, i) => {
      });
    }

    if (gs?.allGroupStates?.length > 1 && currentUser) {
      const myGroup = gs.allGroupStates.find(s =>
        s.playerProfileIds?.some(pid => pid && pid === currentUser.id)
      );
      if (myGroup) {
        gs = { ...myGroup, allGroupStates: gs.allGroupStates };
      }
    }
    gameState = gs;

    // If this round was paused (saved via Abandon & Save Progress), mark it
    // active again now that someone's actually resumed play.
    if (round.status === 'paused') {
      await roundReactivate(id).catch(err => console.error('resumeRound: failed to reactivate', err));
    }

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
  clearSetupState();
  clearSetupDraft();
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
  const holesPlayed = gameState.log?.length ?? 0;
  const throughEl = document.getElementById('game-through');
  if (throughEl) throughEl.textContent = holesPlayed > 0 ? `Through ${holesPlayed}` : '';
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
  } else if (fmt === 'match') {
    renderMatchBar(); // only 1v1 match still uses the bar
  } else if (['betterball','csm','foursomes','greensomes'].includes(fmt)) {
    document.getElementById('game-match-bar')?.classList.add('hidden'); // status shown inline above pair blocks
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

  // Scale name font size down slightly for 3-4 players to fit
  const nameFontSize = n <= 2 ? '1.5rem' : n === 3 ? '1.2rem' : '1rem';

  bar.innerHTML = gameState.names.map((nm, i) => {
    const score = fmt === 'split6'
      ? (gameState.runningPts?.[i] ?? 0)
      : (gameState.totals?.[i] ?? 0);
    const label = fmt === 'stroke' ? 'shots' : 'pts';
    // Full first name for 1-2 players, first name only (truncated) for 3-4
    const displayName = n <= 2
      ? nm.split(' ')[0]
      : nm.split(' ')[0].slice(0, 8);

    let rawLabel = '';
    if (fmt === 'split6' && gameState.log?.length > 0) {
      const rawTotal = gameState.log.reduce((sum, e) => sum + (e.holePts?.[i] ?? 0), 0);
      rawLabel = `<div style="font-family:'Barlow Condensed',sans-serif;font-size:1.1rem;font-weight:700;color:rgba(255,255,255,0.6);margin-top:1px;">(${rawTotal})</div>`;
    }

    return `
      <div class="total-cell">
        <div class="tc-name" style="font-size:${nameFontSize};">
          <span class="dot" style="background:${pHex(i)};"></span>
          ${displayName}
        </div>
        <div style="display:flex;align-items:baseline;justify-content:center;gap:2px;">
          <div class="tc-pts" style="color:#fff;">${score}</div>
          <span style="font-size:0.9rem;font-weight:600;color:rgba(255,255,255,0.7);margin-left:3px;">${label}</span>
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
      <div class="sk-name" style="color:#fff;">
        <span class="dot" style="background:${pHex(i)};display:inline-block;margin-right:3px;"></span>${nm.split(' ')[0].toUpperCase()}
      </div>
      <div class="sk-pts" style="color:#fff;">${gameState.skins?.[i] ?? 0}</div>
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
        <div class="itc-pname" style="color:#fff;">
          <span class="dot" style="background:${pHex(i)};display:inline-block;margin-right:3px;"></span>${nm.split(' ')[0].toUpperCase()}
        </div>
        <div class="itc-pts" style="color:#fff;">${gameState.pts?.[i] ?? 0}</div>
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

  // Keep "Through N" label in the hero in sync
  const throughEl = document.getElementById('game-through');
  if (throughEl) {
    const holesPlayed = gameState.log?.length ?? 0;
    throughEl.textContent = holesPlayed > 0 ? `Through ${holesPlayed}` : '';
  }

  const si     = gameState.si[h];
  const par    = gameState.par[h];
  const dispH  = h + 1 + (gameState.holeOffset ?? 0);
  const fmt    = gameState.format;

  document.getElementById('game-hole-num').textContent = dispH;

  const isLdHole  = (gameState.longestDriveHoles ?? []).includes(dispH);
  const isNtpHole = (gameState.nearestPinHoles   ?? []).includes(dispH);
  const badgeHtml = isLdHole
    ? `<span class="ld-ntp-badge ld-badge">🏌️ Longest Drive</span>`
    : isNtpHole
      ? `<span class="ld-ntp-badge ntp-badge">🎯 Nearest the Pin</span>`
      : '';

  document.getElementById('game-hole-si').innerHTML =
    `<span class="si-big">SI ${si} · Par ${par}</span>${badgeHtml ? `<div style="margin-top:0.4rem;">${badgeHtml}</div>` : ''}`;

  const backBtn = document.getElementById('btn-back-hole');
  if (backBtn) backBtn.disabled = h === 0;

  // scorerProfileId === undefined  → legacy round, fall back to organiser check
  // scorerProfileId === null        → guest scorer, no logged-in user gets scorer UI  
  // scorerProfileId === '__unclaimed__' → nobody claimed yet, show "Become Scorer" button
  // scorerProfileId === string      → only that profile gets scorer UI
  const scorerPid    = gameState?.scorerProfileId;
  const userIsScorer = scorerPid === undefined
    ? (!gameState?.organiserId || gameState.organiserId === currentUser?.id)
    : (scorerPid !== '__unclaimed__' && scorerPid !== null && scorerPid === currentUser?.id);

  // Resend Invites — only the round organiser (who sent the original invites) sees this,
  // and only when there's more than one group (otherwise nobody to invite).
  const isOrganiser    = gameState?.organiserId && gameState.organiserId === currentUser?.id;
  const hasOtherGroups = (gameState?.allGroupStates?.length ?? 1) > 1;
  toggle('btn-resend-invites', !!(isOrganiser && hasOtherGroups));

  const inputsEl = document.getElementById('game-inputs');
  inputsEl.innerHTML = '';

  const recordBtn  = document.getElementById('btn-record-hole');
  const backHoleBtn = document.getElementById('btn-back-hole');

  if (recordBtn) {
    const isPast = h < (gameState.log?.length ?? 0);
    recordBtn.textContent = isPast ? 'UPDATE HOLE →' : 'RECORD HOLE →';
  }

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
      // Update round_players so RLS lets this scorer write game_state to the DB.
      // Fire-and-forget — if it fails the save will still work if organiser is
      // the RLS subject, or will surface its own error on next record attempt.
      roundPlayerClaimScorer(roundId, currentUser.id).catch(err =>
        console.warn('[claim-scorer] round_players update failed:', err)
      );
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
  const isTexas    = fmt === 'texas';

  if (isTexas) {
    // Texas Scramble: one team score + driver selector
    const teamName   = gameState.teamName ?? 'Team';
    const teamHcp    = gameState.teamHcp  ?? 0;
    const existEntry = gameState.log[h];

    const row = document.createElement('div');
    row.className = 'gi-row';
    row.style.cssText = 'flex-direction:column;align-items:stretch;gap:0.65rem;';
    const texasScoreStyle = existEntry?.gross != null
      ? (() => { const c = scoreColorForRelToPar(existEntry.gross - par); return `background:${c};border:1.5px solid ${c};color:#fff;`; })()
      : 'background:var(--surface2);border:1.5px solid var(--border);color:var(--muted);';

    row.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div class="gi-name" style="font-size:1.35rem;">🤠 ${teamName}</div>
          <div class="gi-hcp" style="font-size:1rem;font-weight:800;">Team HCP ${teamHcp}</div>
        </div>
        <div class="score-btn" id="cv-texas" data-value="${existEntry?.gross ?? ''}"
          style="min-width:64px;text-align:center;cursor:pointer;padding:0.6rem 1rem;
                 border-radius:10px;
                 font-family:'Barlow Condensed',sans-serif;font-size:1.6rem;font-weight:800;${texasScoreStyle}">
          ${existEntry?.gross ?? 'Score'}
        </div>
      </div>
      <div>
        <div style="font-size:1rem;font-weight:800;color:var(--muted2);margin-bottom:0.4rem;">Driver used:</div>
        <div style="display:flex;gap:0.4rem;flex-wrap:wrap;" id="texas-driver-btns">
          ${gameState.names.map((name, pi) => `
            <button class="texas-driver-btn ${(existEntry?.driverIdx ?? -1) === pi ? 'holes-btn active' : 'btn-outline'}"
              data-pi="${pi}"
              style="flex:1;min-width:80px;padding:0.65rem 0.4rem;font-size:1rem;font-weight:800;">
              ${name.split(' ')[0]}
            </button>`).join('')}
        </div>
      </div>`;
    inputsEl.appendChild(row);

    // Wire score button
    row.querySelector('#cv-texas')?.addEventListener('click', () => {
      openTexasScorePicker(h, par);
    });

    // Wire driver buttons
    row.querySelectorAll('.texas-driver-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        row.querySelectorAll('.texas-driver-btn').forEach(b => {
          b.className = 'texas-driver-btn btn-outline';
          b.style.cssText = 'flex:1;min-width:80px;padding:0.55rem 0.4rem;font-size:0.85rem;font-weight:700;';
        });
        btn.className = 'texas-driver-btn holes-btn active';
        btn.style.cssText = 'flex:1;min-width:80px;padding:0.55rem 0.4rem;font-size:0.85rem;font-weight:700;';
        // Store selected driver index on the score element
        const scoreEl = document.getElementById('cv-texas');
        if (scoreEl) scoreEl.dataset.driver = btn.dataset.pi;
      });
    });

    // Pre-select driver if editing
    if (existEntry?.driverIdx != null) {
      const scoreEl = document.getElementById('cv-texas');
      if (scoreEl) scoreEl.dataset.driver = String(existEntry.driverIdx);
    }

  } else if (isFoursome) {
    const ms        = gameState.matchScore ?? 0;
    const played    = gameState.log?.length ?? 0;
    const holesLeft = (gameState.numHoles ?? 18) - played;
    const up        = Math.abs(ms);

    // Foursomes Match Play: each pair's combined handicap = 50% of their
    // two handicap indexes added together. The lowest pair plays off
    // scratch; the other pair receives the difference over the match.
    // (Greensomes uses its own 60/40 weighting via greensomesPairHandicap,
    // computed the same way but kept separate per format.)
    const idxs   = gameState.handicapIndexes ?? [];
    const fmt    = gameState.format;
    const rawPairHcp = (a, b) => fmt === 'greensomes'
      ? Math.round(0.6 * Math.min(idxs[a] ?? 0, idxs[b] ?? 0) + 0.4 * Math.max(idxs[a] ?? 0, idxs[b] ?? 0))
      : Math.round(((idxs[a] ?? 0) + (idxs[b] ?? 0)) * 0.5);
    const pairAHcpRaw = rawPairHcp(0, 1);
    const pairBHcpRaw = rawPairHcp(2, 3);
    const lowestPairHcp = Math.min(pairAHcpRaw, pairBHcpRaw);
    const pairAllowance = { A: pairAHcpRaw - lowestPairHcp, B: pairBHcpRaw - lowestPairHcp };

    [['A', 0, 1, ms], ['B', 2, 3, -ms]].forEach(([label, p0, p1, teamMs]) => {
      const teamStatus = ms === 0
        ? 'All Square'
        : teamMs > 0
          ? `${up > holesLeft ? `${up}&${holesLeft}` : `${up} Up`}`
          : `${up > holesLeft ? `${up}&${holesLeft}` : `${up} Down`}`;

      // Team status header — same visual language as Better Ball / CSM
      const header = document.createElement('div');
      header.style.cssText = 'padding:0.65rem 0 0.35rem;border-top:1px solid var(--border);margin-top:0.25rem;';
      header.innerHTML = `
        <span style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.5rem;
                     color:${ms === 0 ? 'var(--white)' : teamMs > 0 ? 'var(--gold)' : 'var(--muted2)'};">
          Pair ${label}
        </span>
        <span style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:1.1rem;
                     color:${ms === 0 ? 'var(--muted2)' : teamMs > 0 ? 'var(--gold)' : 'var(--muted2)'};
                     margin-left:0.6rem;">
          ${teamStatus}
        </span>`;
      inputsEl.appendChild(header);

      // One shared score for the pair (alternate shot — single ball) — names
      // stacked vertically so they never collide with the score button,
      // regardless of how long either name is.
      const existingEntry = gameState.log?.[h];
      const existingGross = existingEntry?.grosses?.[label === 'A' ? 0 : 1];
      const hasExisting    = existingGross != null;
      const scoreBtnVal    = hasExisting ? String(existingGross) : 'Score';
      let scoreBtnStyle;
      if (!hasExisting) {
        scoreBtnStyle = 'border:2px solid var(--border);background:var(--surface2);color:var(--muted);';
      } else {
        const color = scoreColorForRelToPar(existingGross - par, existingGross);
        scoreBtnStyle = `border:2px solid ${color};background:${color};color:${existingGross === 1 ? '#000' : '#fff'};`;
      }

      const allowance  = pairAllowance[label];
      const hcpLineTxt = allowance === 0
        ? 'Team HCP — Plays off Scratch'
        : `Team HCP — Receives ${allowance} shot${allowance === 1 ? '' : 's'}`;

      const row = document.createElement('div');
      row.className = 'gi-row gi-row-pair';
      row.innerHTML = `
        <div style="flex:1;min-width:0;">
          <div class="gi-name" style="display:flex;align-items:center;gap:6px;">
            <span class="dot" style="background:${pHex(p0)};flex-shrink:0;"></span>
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${gameState.names[p0]}</span>
          </div>
          <div class="gi-name" style="display:flex;align-items:center;gap:6px;margin-top:2px;">
            <span class="dot" style="background:${pHex(p1)};flex-shrink:0;"></span>
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${gameState.names[p1]}</span>
          </div>
          <div class="gi-hcp" style="margin-top:2px;">${hcpLineTxt}</div>
        </div>
        <div style="flex-shrink:0;">
          <div id="cv-pair-${label}" data-value="${hasExisting ? existingGross : ''}"
            class="score-btn" data-pair="${label}"
            style="min-width:64px;min-height:52px;display:flex;align-items:center;justify-content:center;
                   border-radius:10px;
                   font-family:'Barlow Condensed',sans-serif;font-size:1.6rem;font-weight:800;
                   cursor:pointer;user-select:none;${scoreBtnStyle}">
            ${scoreBtnVal}
          </div>
        </div>`;
      inputsEl.appendChild(row);

      row.querySelector(`#cv-pair-${label}`)?.addEventListener('click', () => {
        openPairScorePicker(label, h, par, p0);
      });
    });
  } else if (isPairs) {
    const ms        = gameState.matchScore ?? 0;
    const played    = gameState.log?.length ?? 0;
    const holesLeft = (gameState.numHoles ?? 18) - played;
    const up        = Math.abs(ms);
    const nameA     = `${gameState.names[0]?.split(' ')[0] ?? ''} & ${gameState.names[1]?.split(' ')[0] ?? ''}`;
    const nameB     = `${gameState.names[2]?.split(' ')[0] ?? ''} & ${gameState.names[3]?.split(' ')[0] ?? ''}`;

    [[[0,1], nameA, ms], [[2,3], nameB, -ms]].forEach(([pis, teamName, teamMs]) => {
      // Bold team name + status above each pair's players
      const teamStatus = ms === 0
        ? 'All Square'
        : teamMs > 0
          ? `${up > holesLeft ? `${up}&${holesLeft}` : `${up} Up`}`
          : `${up > holesLeft ? `${up}&${holesLeft}` : `${up} Down`}`;

      const header = document.createElement('div');
      header.style.cssText = 'padding:0.65rem 0 0.35rem;border-top:1px solid var(--border);margin-top:0.25rem;';
      header.innerHTML = `
        <span style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.5rem;
                     color:${ms === 0 ? 'var(--white)' : teamMs > 0 ? 'var(--gold)' : 'var(--muted2)'};">
          ${teamName}
        </span>
        <span style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:1.1rem;
                     color:${ms === 0 ? 'var(--muted2)' : teamMs > 0 ? 'var(--gold)' : 'var(--muted2)'};
                     margin-left:0.6rem;">
          ${teamStatus}
        </span>`;
      inputsEl.appendChild(header);

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

  // Texas Scramble: show running driver usage tally
  if (isTexas) {
    const driverWrap = document.createElement('div');
    driverWrap.style.cssText = 'margin-top:0.75rem;';
    const usage         = gameState.driverUsage ?? { par3: [], par4: [], par5: [] };
    const names         = gameState.names ?? [];
    const quotaTotal    = gameState.texasDrivesTotal ?? null;
    const quotaPar3     = gameState.texasDrivesPar3  ?? null;

    // Per-player counts
    const totalCounts = {};
    const par3Counts  = {};
    [...(usage.par3 ?? []), ...(usage.par4 ?? []), ...(usage.par5 ?? [])].forEach(pi => {
      totalCounts[pi] = (totalCounts[pi] ?? 0) + 1;
    });
    (usage.par3 ?? []).forEach(pi => {
      par3Counts[pi] = (par3Counts[pi] ?? 0) + 1;
    });

    const headers = names.map((name, pi) =>
      `<th style="text-align:center;padding:0.4rem 0.35rem;font-size:0.9rem;font-weight:800;color:var(--muted2);">
        ${name.split(' ')[0]}
      </th>`
    ).join('');

    const totalRow = names.map((_, pi) => {
      const count = totalCounts[pi] ?? 0;
      const met   = quotaTotal != null && count >= quotaTotal;
      const color = met ? 'var(--green)' : 'var(--red, #d64545)';
      const label = quotaTotal != null ? `${count}/${quotaTotal}` : String(count);
      return `<td style="text-align:center;padding:0.5rem 0.35rem;
                font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.15rem;
                color:${color};">${label}</td>`;
    }).join('');

    const par3Row = names.map((_, pi) => {
      const count = par3Counts[pi] ?? 0;
      const met   = quotaPar3 != null && count >= quotaPar3;
      const color = met ? 'var(--green)' : 'var(--red, #d64545)';
      const label = quotaPar3 != null ? `${count}/${quotaPar3}` : String(count);
      return `<td style="text-align:center;padding:0.5rem 0.35rem;
                font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.15rem;
                color:${color};">${label}</td>`;
    }).join('');

    driverWrap.innerHTML = `
      <div style="font-size:0.9rem;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;
                  color:var(--muted);margin-bottom:0.35rem;">Drives Used</div>
      <table style="width:100%;border-collapse:collapse;background:var(--surface2);border-radius:var(--radius-sm);overflow:hidden;">
        <thead>
          <tr>
            <th style="padding:0.4rem 0.75rem;text-align:left;font-size:0.85rem;font-weight:700;color:var(--muted);"></th>
            ${headers}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="padding:0.5rem 0.75rem;font-size:0.9rem;font-weight:800;color:var(--muted2);">Total</td>
            ${totalRow}
          </tr>
          <tr style="border-top:1px solid var(--border);">
            <td style="padding:0.5rem 0.75rem;font-size:0.9rem;font-weight:800;color:var(--muted2);">Par 3s</td>
            ${par3Row}
          </tr>
        </tbody>
      </table>`;
    inputsEl.appendChild(driverWrap);
  }

  // ── Longest Drive / Nearest the Pin marking card ──────────────────
  if ((isLdHole || isNtpHole) && userIsScorer) {
    inputsEl.appendChild(buildLdNtpCard(dispH, isLdHole ? 'ld' : 'ntp'));
  }

  // Wire permanent Change Scorer button
  const passBtn = document.getElementById('btn-pass-scorer');
  if (passBtn) {
    passBtn.onclick = async () => {
      gameState.scorerProfileId = '__unclaimed__';
      if (gameState.allGroupStates?.length > 1) {
        const idx = gameState.allGroupStates.findIndex(s => s.groupNumber === gameState.groupNumber);
        if (idx >= 0) gameState.allGroupStates[idx].scorerProfileId = '__unclaimed__';
      }
      await saveRoundState();
      renderHolePanel();
    };
  }
}

// ────────────────────────────────────────────────────────────────
// LONGEST DRIVE / NEAREST THE PIN — marking UI
// ────────────────────────────────────────────────────────────────

function buildLdNtpCard(holeNum, kind) {
  const resultsKey = kind === 'ld' ? 'ldResults' : 'ntpResults';
  const existing   = gameState[resultsKey]?.[holeNum];
  const card = document.createElement('div');
  card.style.cssText = `margin-top:0.85rem;padding:0.85rem;border-radius:var(--radius-sm);
    background:${kind === 'ld' ? 'rgba(212,168,67,0.08)' : 'rgba(91,163,217,0.08)'};
    border:1.5px solid ${kind === 'ld' ? 'var(--gold-border)' : 'var(--blue-border)'};`;

  // ── NTP: unchanged single-button flow ──────────────────────────────
  if (kind === 'ntp') {
    const title = '🎯 Nearest the Pin';
    if (existing) {
      card.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <div>
            <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.1rem;">${title}</div>
            <div style="font-size:0.9rem;font-weight:700;color:var(--muted2);margin-top:2px;">
              ${existing.playerName} — <span style="color:var(--blue);font-weight:800;">${existing.cm} cm</span>
            </div>
          </div>
          <button class="btn btn-outline ld-ntp-remark" style="padding:0.5rem 0.9rem;font-size:0.85rem;">Re-mark</button>
        </div>`;
      card.querySelector('.ld-ntp-remark')?.addEventListener('click', () => openLdNtpMarkModal(holeNum, 'ntp'));
    } else {
      card.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.1rem;">${title}</div>
          <button class="btn btn-green ld-ntp-mark" style="padding:0.55rem 1rem;font-size:0.9rem;font-weight:800;">Mark</button>
        </div>`;
      card.querySelector('.ld-ntp-mark')?.addEventListener('click', () => openLdNtpMarkModal(holeNum, 'ntp'));
    }
    return card;
  }

  // ── LD: two-button inline flow ─────────────────────────────────────
  // Tee position persists in gameState.ldTeePos[holeNum] across re-renders.
  const teePos    = gameState.ldTeePos?.[holeNum] ?? null;
  const teeMarked = !!teePos;
  const titleEl   = `<div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.05rem;margin-bottom:0.65rem;">🏌️ Longest Drive</div>`;

  if (existing) {
    // Fully recorded — show result + re-mark
    card.innerHTML = `
      ${titleEl}
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div style="font-size:0.9rem;font-weight:700;color:var(--muted2);">
          ${existing.playerName} — <span style="color:var(--gold);font-weight:800;">${existing.yards} yds</span>
        </div>
        <button class="btn btn-outline ld-remark" style="padding:0.4rem 0.75rem;font-size:0.82rem;">Re-mark</button>
      </div>`;
    card.querySelector('.ld-remark')?.addEventListener('click', () => {
      gameState.ldResults = gameState.ldResults ?? {};
      delete gameState.ldResults[holeNum];
      gameState.ldTeePos  = gameState.ldTeePos  ?? {};
      delete gameState.ldTeePos[holeNum];
      renderHolePanel();
    });
    return card;
  }

  // Two side-by-side buttons
  const teeStyle = teeMarked
    ? 'background:transparent;border:2.5px solid var(--green);color:var(--green);box-shadow:0 0 0 4px rgba(76,175,118,0.2);'
    : 'background:var(--green);border:2px solid var(--green);color:#fff;';
  const ballStyle = teeMarked
    ? 'background:var(--gold);border:2px solid var(--gold);color:#000;cursor:pointer;'
    : 'background:var(--surface2);border:2px solid var(--border);color:var(--muted);opacity:0.45;cursor:not-allowed;';
  const statusTxt = teeMarked
    ? `<div style="font-size:0.72rem;color:var(--green);font-weight:700;margin-top:0.5rem;text-align:center;">Tee position locked ✓ — walk to the ball, then tap "At Long Drive Ball"</div>`
    : `<div style="font-size:0.72rem;color:var(--muted);margin-top:0.5rem;text-align:center;">Stand at the tee box and tap "Mark Tee Position"</div>`;

  card.innerHTML = `
    ${titleEl}
    <div style="display:flex;gap:0.5rem;">
      <button id="ld-btn-tee" style="flex:1;padding:0.75rem 0.4rem;border-radius:var(--radius-sm);
        font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:0.9rem;
        text-align:center;transition:all 0.2s;${teeStyle}">
        ${teeMarked ? '✓ Tee Marked' : '📍 Mark Tee Position'}
      </button>
      <button id="ld-btn-ball" ${!teeMarked ? 'disabled' : ''} style="flex:1;padding:0.75rem 0.4rem;border-radius:var(--radius-sm);
        font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:0.9rem;
        text-align:center;transition:all 0.2s;${ballStyle}">
        🏌️ At Long Drive Ball
      </button>
    </div>
    ${statusTxt}`;

  // Mark Tee Position
  card.querySelector('#ld-btn-tee')?.addEventListener('click', () => {
    if (teeMarked) {
      // Tap again to reset tee
      gameState.ldTeePos = gameState.ldTeePos ?? {};
      delete gameState.ldTeePos[holeNum];
      renderHolePanel();
      return;
    }
    const btn = card.querySelector('#ld-btn-tee');
    btn.textContent = '📍 Locating…';
    btn.disabled    = true;
    if (_ldWatchId != null) { navigator.geolocation?.clearWatch(_ldWatchId); _ldWatchId = null; }
    _ldWatchId = captureGpsPosition((pos) => {
      _ldWatchId = null;
      gameState.ldTeePos = gameState.ldTeePos ?? {};
      gameState.ldTeePos[holeNum] = { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy };
      renderHolePanel();
    }, null);
  });

  // At Long Drive Ball — open player picker then GPS-capture ball position
  card.querySelector('#ld-btn-ball')?.addEventListener('click', () => {
    if (!teeMarked) return;
    openLdBallModal(holeNum, teePos);
  });

  return card;
}

// LD ball modal — pick the player whose ball it is, then GPS-capture position
function openLdBallModal(holeNum, teePos) {
  const modal = document.getElementById('modal-ld-ntp-mark');
  if (!modal) return;
  modal.dataset.holeNum = holeNum;
  modal.dataset.kind    = 'ld';

  document.getElementById('ld-ntp-modal-title').textContent = '🏌️ Longest Drive — Whose ball?';
  document.getElementById('ld-ntp-value-section').classList.add('hidden');
  document.getElementById('ld-ntp-gps-section').classList.add('hidden');
  document.getElementById('ld-ntp-gps-status').textContent = '';
  modal.dataset.selectedPi = '';

  const playerWrap = document.getElementById('ld-ntp-player-list');
  playerWrap.innerHTML = gameState.names.map((name, pi) => `
    <button class="ld-ntp-player-btn" data-pi="${pi}"
      style="display:flex;align-items:center;gap:8px;width:100%;padding:0.65rem 0.85rem;
             background:var(--surface2);border:1.5px solid var(--border);border-radius:var(--radius-sm);
             margin-bottom:0.4rem;font-family:'Barlow Condensed',sans-serif;font-weight:700;
             font-size:1.05rem;text-align:left;cursor:pointer;">
      <span class="dot" style="background:${pHex(pi)};"></span>${name}
    </button>`).join('');

  // Remove any leftover confirm button from a previous open
  document.getElementById('ld-ball-confirm-btn')?.remove();
  const confirmBtn = document.createElement('button');
  confirmBtn.id          = 'ld-ball-confirm-btn';
  confirmBtn.className   = 'btn btn-green';
  confirmBtn.style.cssText = 'width:100%;padding:0.85rem;font-weight:800;font-size:1.05rem;margin-top:0.5rem;display:none;';
  confirmBtn.textContent = '📍 Confirm & Mark Ball Position';
  playerWrap.after(confirmBtn);

  playerWrap.querySelectorAll('.ld-ntp-player-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      playerWrap.querySelectorAll('.ld-ntp-player-btn').forEach(b => {
        b.style.borderColor = 'var(--border)'; b.style.background = 'var(--surface2)';
      });
      btn.style.borderColor = 'var(--gold-border)';
      btn.style.background  = 'rgba(212,168,67,0.1)';
      modal.dataset.selectedPi = btn.dataset.pi;
      confirmBtn.style.display = '';
    });
  });

  confirmBtn.addEventListener('click', () => {
    const pi = parseInt(modal.dataset.selectedPi, 10);
    if (isNaN(pi)) { alert('Please select a player first.'); return; }
    confirmBtn.textContent = '📍 Locating ball…';
    confirmBtn.disabled    = true;

    // Show GPS status below
    document.getElementById('ld-ntp-gps-section').classList.remove('hidden');
    document.getElementById('ld-ntp-gps-step1').classList.add('hidden');
    document.getElementById('ld-ntp-gps-step2').classList.add('hidden');
    document.getElementById('ld-ntp-gps-result').classList.add('hidden');
    const statusEl = document.getElementById('ld-ntp-gps-status');
    if (statusEl) statusEl.textContent = '📍 Locating… hold still';

    if (_ldWatchId != null) { navigator.geolocation?.clearWatch(_ldWatchId); _ldWatchId = null; }
    _ldWatchId = captureGpsPosition(async (pos) => {
      _ldWatchId = null;
      const yards = gpsDistanceYards(teePos.lat, teePos.lng, pos.lat, pos.lng);

      gameState.ldResults = gameState.ldResults ?? {};
      gameState.ldResults[holeNum] = {
        playerIdx:  pi, playerName: gameState.names[pi], yards,
        lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy,
        markedBy: currentUser?.id ?? null, ts: new Date().toISOString(),
      };
      // Clear tee pos now consumed
      if (gameState.ldTeePos) delete gameState.ldTeePos[holeNum];

      if (gameState.allGroupStates?.length > 1) {
        const idx = gameState.allGroupStates.findIndex(s => s.groupNumber === gameState.groupNumber);
        if (idx >= 0) {
          gameState.allGroupStates[idx].ldResults = gameState.ldResults;
          gameState.allGroupStates[idx].ldTeePos  = gameState.ldTeePos;
        }
      }
      await saveRoundState();
      modal.classList.remove('open');
      renderHolePanel();
    }, 'ld-ntp-gps-status');
  });

  modal.classList.add('open');
}

// NTP player + cm entry modal (LD now uses openLdBallModal instead)
function openLdNtpMarkModal(holeNum, kind) {
  const modal = document.getElementById('modal-ld-ntp-mark');
  if (!modal) return;
  modal.dataset.holeNum = holeNum;
  modal.dataset.kind    = kind;

  document.getElementById('ld-ntp-modal-title').textContent = '🎯 Mark Nearest the Pin';

  const playerWrap = document.getElementById('ld-ntp-player-list');
  playerWrap.innerHTML = gameState.names.map((name, pi) => `
    <button class="ld-ntp-player-btn" data-pi="${pi}"
      style="display:flex;align-items:center;gap:8px;width:100%;padding:0.65rem 0.85rem;
             background:var(--surface2);border:1.5px solid var(--border);border-radius:var(--radius-sm);
             margin-bottom:0.4rem;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:1.05rem;
             text-align:left;">
      <span class="dot" style="background:${pHex(pi)};"></span>${name}
    </button>`).join('');

  document.getElementById('ld-ntp-value-section').classList.add('hidden');
  document.getElementById('ld-ntp-gps-section').classList.add('hidden');
  modal.dataset.selectedPi = '';

  playerWrap.querySelectorAll('.ld-ntp-player-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      playerWrap.querySelectorAll('.ld-ntp-player-btn').forEach(b => {
        b.style.borderColor = 'var(--border)'; b.style.background = 'var(--surface2)';
      });
      btn.style.borderColor = 'var(--gold-border)'; btn.style.background = 'rgba(212,168,67,0.1)';
      modal.dataset.selectedPi = btn.dataset.pi;
      document.getElementById('ld-ntp-value-section').classList.remove('hidden');
      document.getElementById('ld-ntp-cm-input').value = '';
      document.getElementById('ld-ntp-cm-input').focus();
    });
  });

  modal.classList.add('open');
}

document.getElementById('ld-ntp-modal-close')?.addEventListener('click', () => {
  if (_ldWatchId != null) { navigator.geolocation?.clearWatch(_ldWatchId); _ldWatchId = null; }
  document.getElementById('modal-ld-ntp-mark')?.classList.remove('open');
});

// ── NTP: manual cm entry ───────────────────────────────────────────
document.getElementById('ld-ntp-cm-save')?.addEventListener('click', async () => {
  const modal = document.getElementById('modal-ld-ntp-mark');
  const pi    = parseInt(modal.dataset.selectedPi, 10);
  const cm    = parseInt(document.getElementById('ld-ntp-cm-input').value, 10);
  if (isNaN(pi)) { alert('Select a player first.'); return; }
  if (isNaN(cm) || cm < 0) { alert('Enter a valid distance in cm.'); return; }

  const holeNum = parseInt(modal.dataset.holeNum, 10);
  gameState.ntpResults = gameState.ntpResults ?? {};
  gameState.ntpResults[holeNum] = {
    playerIdx: pi, playerName: gameState.names[pi], cm,
    markedBy: currentUser?.id ?? null, ts: new Date().toISOString(),
  };
  if (gameState.allGroupStates?.length > 1) {
    const idx = gameState.allGroupStates.findIndex(s => s.groupNumber === gameState.groupNumber);
    if (idx >= 0) gameState.allGroupStates[idx].ntpResults = gameState.ntpResults;
  }
  await saveRoundState();
  modal.classList.remove('open');
  renderHolePanel();
});

// _ldWatchId tracks the active geolocation watcher so it can be cancelled
// if the user closes the modal or navigates away mid-capture.
let _ldWatchId = null;

function captureGpsPosition(onAccurate, statusElId) {
  const statusEl = statusElId ? document.getElementById(statusElId) : null;
  if (!navigator.geolocation) {
    if (statusEl) statusEl.textContent = 'GPS not available on this device.';
    return null;
  }
  if (statusEl) statusEl.textContent = '📍 Locating… hold still';
  const watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const acc = pos.coords.accuracy;
      if (statusEl) statusEl.textContent = `Accuracy: ${Math.round(acc)}m${acc <= 10 ? ' ✓' : ' — waiting for better signal…'}`;
      if (acc <= 10) {
        navigator.geolocation.clearWatch(watchId);
        onAccurate({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: acc });
      }
    },
    (err) => { if (statusEl) statusEl.textContent = 'Could not get GPS position: ' + err.message; },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
  );
  return watchId;
}


function makePlayerInputRow(pi, h, par) {
  const fmt     = gameState.format;
  const isIndiv = ['stableford','stroke','best2'].includes(fmt);
  const extra   = isIndiv
    ? indivStrokesOnHole(gameState.playingHandicaps[pi], gameState.si[h])
    : strokesOnHole(gameState.matchHandicaps[pi], gameState.si[h]);
  const badge   = extra > 0 ? `<span class="stroke-badge">+${extra}</span>` : '';
  const hcpLine = isIndiv
    ? `Playing HCP ${gameState.playingHandicaps[pi]}`
    : `Match HCP ${gameState.matchHandicaps[pi]}`;
  const inChair = fmt === 'itc' && gameState.chair === pi;

  // Look up previous hole score for this player if available
  const prevEntry = h > 0 ? gameState.log?.[h - 1] : null;
  const prevGross = prevEntry?.grosses?.[pi];
  const prevPts   = prevEntry?.holePts?.[pi];
  const prevNet   = prevEntry?.nets?.[pi];
  let prevLabel = '';
  if (prevEntry && prevGross != null) {
    const prevH = h; // 1-indexed hole number of the previous hole
    if (fmt === 'stableford' && prevPts != null) prevLabel = `H${prevH}: ${prevGross} gross · ${prevPts}pts`;
    else if (fmt === 'stroke' && prevNet != null) prevLabel = `H${prevH}: ${prevGross} gross · ${prevNet} net`;
    else if (fmt === 'split6' && prevEntry.holePts?.[pi] != null) prevLabel = `H${prevH}: ${prevGross} gross · ${prevEntry.holePts[pi]}pts`;
    else prevLabel = `H${prevH}: ${prevGross}`;
  }

  // If this hole already has a recorded entry (user went back to edit it),
  // pre-fill the score button with that value
  const existingEntry = gameState.log?.[h];
  const existingGross = existingEntry?.grosses?.[pi];

  const hasExisting = existingGross != null;
  const isPickup    = existingEntry?.pickups?.[pi] ?? false;
  const scoreBtnVal   = hasExisting ? String(existingGross) : 'Score';
  let scoreBtnStyle;
  if (!hasExisting) {
    scoreBtnStyle = 'border:2px solid var(--border);background:var(--surface2);color:var(--muted);';
  } else if (isPickup) {
    scoreBtnStyle = 'border:2px solid var(--gold);background:var(--gold);color:#fff;';
  } else {
    const color = scoreColorForRelToPar(existingGross - par, existingGross);
    scoreBtnStyle = `border:2px solid ${color};background:${color};color:${existingGross === 1 ? '#000' : '#fff'};`;
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
      <div id="cv${pi}" data-value="${hasExisting ? existingGross : ''}" data-pickup="0"
        class="score-btn" data-pi="${pi}"
        style="min-width:64px;min-height:52px;display:flex;align-items:center;justify-content:center;
               border-radius:10px;
               font-family:'Barlow Condensed',sans-serif;font-size:1.6rem;font-weight:800;
               cursor:pointer;user-select:none;${scoreBtnStyle}">
        ${scoreBtnVal}
      </div>
    </div>`;

  row.querySelector('.score-btn')?.addEventListener('click', () => {
    openScorePicker(pi, h, par);
  });
  return row;
}

// ── Score Picker Modal ────────────────────────────────────────────
function openTexasScorePicker(h, par) {
  // Reuse the existing score picker modal
  const teamHcp   = gameState.teamHcp ?? 0;
  const teamExtra = Math.floor(teamHcp / 18) + (h < (teamHcp % 18) ? 1 : 0);
  // Actually use strokesOnHole for per-hole calculation
  const { strokesOnHole: soHole } = (() => {
    // inline import reference
    return { strokesOnHole: (hcp, si) => (hcp <= 0 ? 0 : Math.floor(hcp / 18) + (si <= (hcp % 18) ? 1 : 0)) };
  })();
  const si     = gameState.si[h];
  const extra  = soHole(teamHcp, si);
  const min    = Math.max(1, par - 2), max = par + 3;

  document.getElementById('sp-player-name').textContent = gameState.teamName ?? 'Team';
  document.getElementById('sp-context').textContent     = `Hole ${h + 1} · Par ${par} · Team HCP ${teamHcp} (${extra} shot${extra !== 1 ? 's' : ''} on this hole)`;

  const gridEl = document.getElementById('sp-grid');
  gridEl.innerHTML = Array.from({ length: max - min + 1 }, (_, i) => {
    const v        = min + i;
    const net      = v - extra;
    const pts      = Math.max(0, 2 + par - net);
    const relToPar = v - par;
    let circleColor;
    if (relToPar === 0)      circleColor = 'var(--green)';
    else if (relToPar < 0)   circleColor = '#d64545';
    else if (relToPar <= 2)  circleColor = '#3a7bd5';
    else                     circleColor = '#2a2a2a';

    return `<button class="sp-num-btn" data-val="${v}"
      style="display:grid;grid-template-columns:1fr 2fr 1fr;align-items:center;
             padding:0.55rem 0.5rem;border-radius:12px;border:none;cursor:pointer;background:var(--surface2);">
      <span style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.3rem;color:var(--white);">${net}</span>
      <span style="display:flex;align-items:center;justify-content:center;width:54px;height:54px;margin:0 auto;
                    border-radius:50%;background:${circleColor};color:#fff;
                    font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.7rem;">${v}</span>
      <span style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.3rem;color:var(--muted2);">${pts > 0 ? pts : '-'}</span>
    </button>`;
  }).join('');

  gridEl.querySelectorAll('.sp-num-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const scoreEl = document.getElementById('cv-texas');
      if (scoreEl) {
        const val = parseInt(btn.dataset.val, 10);
        const color = scoreColorForRelToPar(val - par);
        scoreEl.dataset.value   = btn.dataset.val;
        scoreEl.textContent     = btn.dataset.val;
        scoreEl.style.color     = '#fff';
        scoreEl.style.background = color;
        scoreEl.style.borderColor = color;
      }
      closeScorePicker();
    });
  });

  document.getElementById('sp-pickup')?.classList.add('hidden');
  document.getElementById('modal-score-picker').classList.add('open');
}


function openScorePicker(pi, h, par) {
  const cvEl = document.getElementById(`cv${pi}`);
  const current = cvEl?.dataset.value;

  document.getElementById('sp-player-name').textContent = gameState.names[pi];
  document.getElementById('sp-context').textContent = `Hole ${h + 1} · Par ${par}`;

  const fmt     = gameState.format;
  const isIndiv = ['stableford','stroke','best2'].includes(fmt);
  const extra   = isIndiv
    ? indivStrokesOnHole(gameState.playingHandicaps[pi], gameState.si[h])
    : strokesOnHole(gameState.matchHandicaps[pi], gameState.si[h]);

  // Full range per par, scrollable rather than paginated:
  //   Par 3: 1-9   Par 4: 1-10   Par 5: 2-11
  let min, max;
  if (par <= 3)       { min = 1; max = 9;  }
  else if (par === 4) { min = 1; max = 10; }
  else                { min = 2; max = 11; }
  min = Math.max(1, min);

  const buildBtn = (v) => {
    const isCurrent = current && parseInt(current) === v;
    const relToPar = v - par;
    const net      = v - extra;
    const pts      = stablefordPoints(v, extra, par);

    // Colour by gross relative to par:
    // gold = hole-in-one, green = par, red = under par, blue = bogey/double, black = triple+
    let circleColor;
    if (v === 1)               circleColor = 'var(--gold)';
    else if (relToPar === 0)   circleColor = 'var(--green)';
    else if (relToPar < 0)     circleColor = '#d64545';
    else if (relToPar <= 2)    circleColor = '#3a7bd5';
    else                       circleColor = '#2a2a2a';

    const ring = isCurrent ? 'box-shadow:0 0 0 3px var(--gold);' : '';

    return `<button class="sp-num-btn" data-val="${v}"
      style="display:grid;grid-template-columns:1fr 2fr 1fr;align-items:center;gap:0.4fr;
             padding:0.55rem 0.5rem;border-radius:12px;border:none;cursor:pointer;
             background:var(--surface2);${ring}">
      <span style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.3rem;color:${v === 1 ? 'var(--gold)' : relToPar < 0 ? '#d64545' : 'var(--white)'};">${net}</span>
      <span style="display:flex;align-items:center;justify-content:center;width:54px;height:54px;margin:0 auto;
                    border-radius:50%;background:${circleColor};color:${v === 1 ? '#000' : '#fff'};
                    font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.7rem;">${v}</span>
      <span style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.3rem;color:var(--muted2);">${pts > 0 ? pts : '-'}</span>
    </button>`;
  };

  const gridEl = document.getElementById('sp-grid');
  const morePickupVal = par + extra + 1; // one worse than the score that would earn a point

  gridEl.innerHTML =
    Array.from({ length: max - min + 1 }, (_, i) => buildBtn(min + i)).join('')
    + `<button id="sp-pickup" class="btn"
        style="width:100%;font-size:0.95rem;font-weight:700;padding:0.85rem;margin-top:0.2rem;
               background:var(--gold);border:none;color:#000;">
        🏌️ Pick Up / DNF
      </button>`;

  gridEl.querySelectorAll('.sp-num-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = parseInt(btn.dataset.val, 10);
      setScoreValue(pi, h, par, v, false);
      closeScorePicker();
    });
  });

  document.getElementById('sp-pickup').onclick = () => {
    // Pickup = par + handicap strokes received on this hole + 1
    // (one worse than the score that would earn a Stableford point)
    setScoreValue(pi, h, par, morePickupVal, true);
    closeScorePicker();
  };

  document.getElementById('sp-cancel').onclick = closeScorePicker;

  // Open the modal FIRST — while it's display:none, every element inside it
  // (including sp-grid and its buttons) reports zero size and zero position,
  // so any scroll-position math done before this point is meaningless.
  document.getElementById('modal-score-picker').classList.add('open');

  // Default scroll position: show Birdie (par - 1) at the top of the list,
  // so Eagle/better is just a small scroll up and most scores need no
  // scrolling at all. If a score is already set for this hole, scroll to
  // that instead so re-opening the picker shows the current pick.
  const targetVal = (current ? parseInt(current, 10) : null) ?? (par - 1);
  const targetBtn = gridEl.querySelector(`.sp-num-btn[data-val="${Math.max(min, targetVal)}"]`);
  if (targetBtn) {
    // Use rendered positions via getBoundingClientRect, computed on the next
    // frame so layout has settled after the modal became visible.
    requestAnimationFrame(() => {
      const gridRect = gridEl.getBoundingClientRect();
      const btnRect  = targetBtn.getBoundingClientRect();
      const delta    = (btnRect.top - gridRect.top) - 6; // small top padding
      gridEl.scrollTop = Math.max(0, gridEl.scrollTop + delta);
    });
  } else {
    gridEl.scrollTop = 0;
  }
}

function closeScorePicker() {
  document.getElementById('modal-score-picker').classList.remove('open');
}

// Foursomes / Greensomes: one shared score per pair (alternate shot — single
// ball), so this writes to cv-pair-A/B instead of an individual cv${pi}.
// Net/points shown in the picker use the pair's combined match handicap.
function openPairScorePicker(label, h, par, anchorPi) {
  const cvEl    = document.getElementById(`cv-pair-${label}`);
  const current = cvEl?.dataset.value;

  const p0 = label === 'A' ? 0 : 2, p1 = label === 'A' ? 1 : 3;
  const pairNames = `${gameState.names[p0]?.split(' ')[0] ?? ''} & ${gameState.names[p1]?.split(' ')[0] ?? ''}`;

  document.getElementById('sp-player-name').textContent = `Pair ${label} — ${pairNames}`;
  document.getElementById('sp-context').textContent = `Hole ${h + 1} · Par ${par}`;

  const fmt     = gameState.format;
  const pairHcp = fmt === 'greensomes'
    ? greensomesPairHandicap(gameState.matchHandicaps[p0], gameState.matchHandicaps[p1])
    : foursomedPairHandicap(gameState.matchHandicaps[p0], gameState.matchHandicaps[p1]);
  const extra   = strokesOnHole(pairHcp, gameState.si[h]);

  let min, max;
  if (par <= 3)       { min = 1; max = 9;  }
  else if (par === 4) { min = 1; max = 10; }
  else                { min = 2; max = 11; }
  min = Math.max(1, min);

  const buildBtn = (v) => {
    const isCurrent = current && parseInt(current) === v;
    const relToPar = v - par;
    const net      = v - extra;
    const pts      = stablefordPoints(v, extra, par); // for display only — match play decides the hole, not points

    let circleColor;
    if (v === 1)               circleColor = 'var(--gold)';
    else if (relToPar === 0)   circleColor = 'var(--green)';
    else if (relToPar < 0)     circleColor = '#d64545';
    else if (relToPar <= 2)    circleColor = '#3a7bd5';
    else                       circleColor = '#2a2a2a';

    const ring = isCurrent ? 'box-shadow:0 0 0 3px var(--gold);' : '';

    return `<button class="sp-num-btn" data-val="${v}"
      style="display:grid;grid-template-columns:1fr 2fr 1fr;align-items:center;gap:0.4fr;
             padding:0.55rem 0.5rem;border-radius:12px;border:none;cursor:pointer;
             background:var(--surface2);${ring}">
      <span style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.3rem;color:${v === 1 ? 'var(--gold)' : relToPar < 0 ? '#d64545' : 'var(--white)'};">${net}</span>
      <span style="display:flex;align-items:center;justify-content:center;width:54px;height:54px;margin:0 auto;
                    border-radius:50%;background:${circleColor};color:${v === 1 ? '#000' : '#fff'};
                    font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.7rem;">${v}</span>
      <span style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.3rem;color:var(--muted2);">${pts > 0 ? pts : '-'}</span>
    </button>`;
  };

  const gridEl = document.getElementById('sp-grid');
  const pickupVal = par + extra + 1;

  gridEl.innerHTML =
    Array.from({ length: max - min + 1 }, (_, i) => buildBtn(min + i)).join('')
    + `<button id="sp-pickup" class="btn"
        style="width:100%;font-size:0.95rem;font-weight:700;padding:0.85rem;margin-top:0.2rem;
               background:var(--gold);border:none;color:#000;">
        🏌️ Pick Up / Concede Hole
      </button>`;

  gridEl.querySelectorAll('.sp-num-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = parseInt(btn.dataset.val, 10);
      setPairScoreValue(label, h, par, v, false);
      closeScorePicker();
    });
  });

  document.getElementById('sp-cancel').onclick = closeScorePicker;
  document.getElementById('modal-score-picker').classList.add('open');

  document.getElementById('sp-pickup').onclick = () => {
    setPairScoreValue(label, h, par, pickupVal, true);
    closeScorePicker();
  };

  const targetVal = (current ? parseInt(current, 10) : null) ?? (par - 1);
  const targetBtn = gridEl.querySelector(`.sp-num-btn[data-val="${Math.max(min, targetVal)}"]`);
  if (targetBtn) {
    requestAnimationFrame(() => {
      const gridRect = gridEl.getBoundingClientRect();
      const btnRect  = targetBtn.getBoundingClientRect();
      const delta    = (btnRect.top - gridRect.top) - 6;
      gridEl.scrollTop = Math.max(0, gridEl.scrollTop + delta);
    });
  } else {
    gridEl.scrollTop = 0;
  }
}

function setPairScoreValue(label, h, par, value, isPickup) {
  const cvEl = document.getElementById(`cv-pair-${label}`);
  if (!cvEl) return;
  cvEl.dataset.value  = String(value);
  cvEl.dataset.pickup = isPickup ? '1' : '0';
  cvEl.textContent    = String(value);
  if (isPickup) {
    cvEl.style.color       = '#fff';
    cvEl.style.background  = 'var(--gold)';
    cvEl.style.borderColor = 'var(--gold)';
    cvEl.innerHTML = `${value}<span style="font-size:0.6rem;display:block;font-weight:600;">PICKUP</span>`;
  } else {
    const relToPar = value - par;
    const color = scoreColorForRelToPar(relToPar, value);
    cvEl.style.color       = value === 1 ? '#000' : '#fff';
    cvEl.style.background  = color;
    cvEl.style.borderColor = color;
  }
}

// Shared colour logic for a recorded gross score relative to par
// Matches the score picker: gold = hole-in-one, par = green, under par = red, 1-2 over = blue, 3+ over = black/dark
function scoreColorForRelToPar(relToPar, value) {
  if (value === 1)        return 'var(--gold)';
  if (relToPar === 0)     return 'var(--green)';
  if (relToPar < 0)       return '#d64545';
  if (relToPar <= 2)      return '#3a7bd5';
  return '#2a2a2a';
}

function setScoreValue(pi, h, par, value, isPickup) {
  const cvEl = document.getElementById(`cv${pi}`);
  if (!cvEl) return;
  cvEl.dataset.value  = String(value);
  cvEl.dataset.pickup = isPickup ? '1' : '0';
  cvEl.textContent    = String(value);
  if (isPickup) {
    cvEl.style.color       = '#fff';
    cvEl.style.background  = 'var(--gold)';
    cvEl.style.borderColor = 'var(--gold)';
    cvEl.innerHTML = `${value}<span style="font-size:0.6rem;display:block;font-weight:600;">PICKUP</span>`;
  } else {
    const relToPar = value - par;
    const color = scoreColorForRelToPar(relToPar, value);
    cvEl.style.color       = value === 1 ? '#000' : '#fff';
    cvEl.style.background  = color;
    cvEl.style.borderColor = color;
  }
}

// ----------------------------------------------------------------
// RECORD HOLE
// ----------------------------------------------------------------
document.getElementById('btn-record-hole')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-record-hole');
  if (btn?.disabled) return; // already saving — ignore extra taps
  if (btn) btn.disabled = true;
  try {
    await recordHole();
  } finally {
    if (btn) btn.disabled = false;
  }
});

async function recordHole() {
  const fmt = gameState.format;
  const h   = gameState.hole;
  const par = gameState.par[h];
  let grosses = [];

  const isFoursome = fmt === 'foursomes' || fmt === 'greensomes';
  const isTexas    = fmt === 'texas';

  if (isTexas) {
    const scoreEl  = document.getElementById('cv-texas');
    const gross    = parseInt(scoreEl?.dataset?.value, 10);
    const driverEl = document.querySelector('.texas-driver-btn.active');
    const driver   = driverEl ? parseInt(driverEl.dataset.pi, 10) : 0;
    if (!gross || gross < 1) { alert('Please enter a score for the team.'); return; }
    grosses = [gross, driver];
  } else if (isFoursome) {
    const vA = parseInt(document.getElementById('cv-pair-A')?.dataset?.value, 10);
    const vB = parseInt(document.getElementById('cv-pair-B')?.dataset?.value, 10);
    if (!vA || !vB) { alert('Please enter scores for both pairs.'); return; }
    grosses = [vA, vB];
  } else {
    for (let i = 0; i < gameState.names.length; i++) {
      const el = document.getElementById(`cv${i}`);
      const v  = parseInt(el?.dataset?.value, 10);
      if (!v || v < 1) { alert(`Please enter a score for ${gameState.names[i]}.`); return; }
      grosses.push(v);
    }
  }

  const prevGroupStates = gameState.allGroupStates;
  const isEditingPast = h < (gameState.log?.length ?? 0);

  if (isEditingPast) {
    // Re-recording a hole we'd gone back to — edit in place and recalc
    gameState = editHole(gameState, h, grosses);
    gameState.hole = h + 1; // move forward to the next hole
  } else {
    gameState = processHole(gameState, grosses);
  }

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
      await saveRoundState();
      return;
    }
  }

  await saveRoundState();
  if (gameState.hole >= (gameState.numHoles ?? 18)) { showEndRound(); return; }
  renderScoreHeader();
  renderHolePanel();
}

document.getElementById('btn-back-hole')?.addEventListener('click', () => {
  if (gameState.hole <= 0) return;
  gameState.hole -= 1;
  renderScoreHeader(); renderHolePanel();
});

document.getElementById('btn-finish-early')?.addEventListener('click', () => showEndRound());
document.getElementById('btn-game-abandon')?.addEventListener('click', async () => {
  // "Home" — save the round as paused so it appears in Active Games, then go home
  await doAbandon(false);
});

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

function renderLdNtpLeaderboardCard() {
  const container = document.getElementById('leaderboard-ld-ntp');
  if (!container) return;

  const states = gameState.allGroupStates?.length ? gameState.allGroupStates : [gameState];
  const ldData  = buildSideCompResults(states, 'ld');
  const ntpData = buildSideCompResults(states, 'ntp');

  if (!ldData.holes.length && !ntpData.holes.length) { container.innerHTML = ''; return; }

  const rowsFor = (data, kind) => data.holes.map(holeNum => {
    const r = data.byHole[holeNum];
    const label = kind === 'ld' ? '🏌️' : '🎯';
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;
                  padding:0.55rem 0.85rem;border-bottom:1px solid var(--border);">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:1.1rem;">${label}</span>
          <span style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:0.95rem;color:var(--muted2);">
            Hole ${holeNum}
          </span>
        </div>
        ${r
          ? `<div style="text-align:right;">
              <span style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.05rem;">${r.playerName}</span>
              <span style="color:${kind === 'ld' ? 'var(--gold)' : 'var(--blue)'};font-weight:800;margin-left:6px;">
                ${kind === 'ld' ? `${r.yards} yds` : `${r.cm} cm`}
              </span>
            </div>`
          : `<span style="color:var(--muted);font-size:0.85rem;">Not yet marked</span>`}
      </div>`;
  }).join('');

  container.innerHTML = `
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);
                margin-bottom:1rem;overflow:hidden;">
      ${ldData.holes.length ? `
        <div style="padding:0.5rem 0.85rem;background:rgba(212,168,67,0.08);
                    font-size:0.75rem;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:var(--gold);">
          Longest Drive
        </div>${rowsFor(ldData, 'ld')}` : ''}
      ${ntpData.holes.length ? `
        <div style="padding:0.5rem 0.85rem;background:rgba(91,163,217,0.08);
                    font-size:0.75rem;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:var(--blue);">
          Nearest the Pin
        </div>${rowsFor(ntpData, 'ntp')}` : ''}
    </div>`;
}

function renderLeaderboard() {
  const fmt       = gameState.format;
  const isTourney = !!gameState.tournamentId;
  const tableEl   = document.getElementById('leaderboard-table');
  const metaEl    = document.getElementById('leaderboard-meta');
  if (!tableEl) return;

  const TEAM_PAIR_FORMATS = ['betterball','csm','foursomes','greensomes','best2','texas'];
  const isTeamPairFmt = TEAM_PAIR_FORMATS.includes(fmt);
  const tournGameType = isTourney ? (activeTournament?.scoring_mode_team ?? 'individual') : null;
  const isTeamScored  = isTourney && isTeamPairFmt && tournGameType !== 'individual';

  // Determine score label from format
  const isStroke   = fmt === 'stroke';
  const isTexas    = fmt === 'texas';
  const isMatch    = ['match','betterball','csm','foursomes','greensomes'].includes(fmt);
  const isSkins    = fmt === 'skins';
  const isItc      = fmt === 'itc';
  const isPoints   = ['stableford','split6','itc'].includes(fmt);
  const texasSbFmt = isTexas && (gameState.texasScoringFmt ?? 'stableford') === 'stableford';
  const scoreLabel = isTexas   ? (texasSbFmt ? 'Pts' : 'Gross')
    : isStroke  ? 'Net'
    : isMatch && !isTeamScored ? 'Holes'
    : isMatch && isTeamScored  ? 'Pts'  // match results converted to pts for tournament accumulation
    : isSkins   ? 'Skins'
    : isItc     ? 'Pts'
    : 'Pts'; // stableford, split6, best2

  metaEl.textContent = `${gameState.courseName} · ${gameState.teeName} · ${fmtLabel(fmt)}`.toUpperCase();

  renderLdNtpLeaderboardCard();

  // ── ROUND LEADERBOARD: team rows for team/pairs formats ───────────
  // Applies whether or not this is a tournament — a team/pairs format always
  // shows team-level rows in the round view (one row per group).
  if (isTeamPairFmt) {
    const states = gameState.allGroupStates ?? [gameState];
    const rows = states.filter(s => s && s.names).map((s, i) => {
      const teamName = s.teamName ?? `Team ${s.groupNumber ?? i + 1}`;
      const members  = s.names.join(', ');
      const holesPlayed = s.log?.length ?? 0;
      let score;
      if (isTexas) {
        score = texasSbFmt ? (s.texasPts ?? 0) : (s.grossTotal ?? 0);
      } else if (fmt === 'best2') {
        score = s.groupTotal ?? 0;
      } else {
        // betterball/csm/foursomes/greensomes — show match status for THIS round
        const ms = s.matchScore ?? 0;
        const up = Math.abs(ms);
        score = ms === 0 ? 'All Sq' : (ms > 0 ? `${up} Up` : `${up} Down`);
      }
      return { teamName, members, score, holesPlayed };
    });

    // Sort: numeric scores descending (or ascending for gross), match results by ms desc
    const numericRows = rows.filter(r => typeof r.score === 'number');
    const nonNumericRows = rows.filter(r => typeof r.score !== 'number');
    numericRows.sort((a, b) => (isTexas && !texasSbFmt) ? a.score - b.score : b.score - a.score);
    const sortedRows = [...numericRows, ...nonNumericRows];

    tableEl.innerHTML = buildLeaderboardTable(
      sortedRows.map((r, rank) => ({
        rank:   rank + 1,
        label:  r.teamName,
        sub:    r.members,
        score:  r.score,
        thru:   r.holesPlayed,
        isLead: rank === 0,
      })),
      isMatch ? 'Result' : scoreLabel
    );

    // In tournament team mode, also show a hint that the full tournament
    // standings (cumulative) are available via the tournament detail screen.
    return;
  }

  // ── Non-tournament, non-team format: live group scores ────────────
  if (!isTourney) {
    const states = gameState.allGroupStates ?? [gameState];
    const rows = buildMultiGroupLeaderboard(states);

    if (!rows.length) {
      tableEl.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--muted);">No scores yet.</div>';
      return;
    }

    tableEl.innerHTML = buildLeaderboardTable(
      rows.map((r, rank) => {
        let score;
        if (isStroke)     score = r.net ?? '--';
        else if (isMatch) score = r.pts != null
          ? (r.pts > 0 ? `${r.pts} Up` : r.pts < 0 ? `${Math.abs(r.pts)} Down` : 'All Sq')
          : 'All Sq';
        else              score = r.pts ?? '--';
        return {
          rank:   rank + 1,
          label:  r.name,
          sub:    null,
          score,
          thru:   r.holesPlayed,
          isLead: rank === 0,
        };
      }),
      scoreLabel
    );
    return;
  }

  // ── Tournament mode, individual format (Stableford/Stroke) ────────
  const scoringMode      = 'cumulative';
  const completedRnds    = (activeTournRounds ?? []).filter(r => r.status === 'completed');
  const numHolesPerRound = gameState.numHoles ?? 18;
  const liveHoles        = gameState.log?.length ?? 0;
  const liveStates       = gameState.allGroupStates ?? [gameState];

  // Build a map of live player scores from current round (all groups)
  const liveScoreByName = {};
  liveStates.forEach(gs => {
    (gs.names ?? []).forEach((name, pi) => {
      const pts  = isPoints ? (gs.totals?.[pi] ?? 0) : null;
      const net  = isStroke ? (gs.totals?.[pi] ?? 0) : null;
      liveScoreByName[name] = { pts, net, holes: gs.log?.length ?? 0 };
    });
  });

  const standings = buildStandings(
    activeTournPlayers ?? [], completedRnds, activeTournAllScores ?? [],
    fmt, scoringMode
  );
  const rows = standings.map((row, idx) => {
    const live  = liveScoreByName[row.name] ?? {};
    const historical = row.total ?? 0;
    const liveAdd    = isStroke ? (live.net ?? 0) : (live.pts ?? 0);
    const total      = historical + liveAdd;
    return {
      rank:   idx + 1,
      label:  row.name,
      sub:    null,
      score:  total || '--',
      thru:   completedRnds.length * numHolesPerRound + liveHoles,
      isLead: idx === 0,
    };
  });
  tableEl.innerHTML = buildLeaderboardTable(rows, scoreLabel);
}

function buildLeaderboardTable(rows, scoreLabel) {
  if (!rows.length) return '<div style="padding:2rem;text-align:center;color:var(--muted);">No scores yet.</div>';

  let html = `
    <div style="display:grid;grid-template-columns:auto 1fr auto auto;
                align-items:center;border-bottom:2px solid var(--border2);
                padding:0.5rem 0.75rem;margin-top:1rem;">
      <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:0.85rem;
                  color:var(--muted);letter-spacing:0.1em;width:2rem;">#</div>
      <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:0.85rem;
                  color:var(--muted);letter-spacing:0.1em;">NAME</div>
      <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:0.85rem;
                  color:var(--muted);letter-spacing:0.1em;text-align:right;padding-right:1.25rem;">${scoreLabel.toUpperCase()}</div>
      <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:0.85rem;
                  color:var(--muted);letter-spacing:0.1em;text-align:right;">THRU</div>
    </div>`;

  rows.forEach(r => {
    const gold = r.isLead ? 'var(--gold)' : 'var(--white)';
    const bg   = r.isLead ? 'background:rgba(212,168,67,0.06);' : '';
    html += `
      <div style="display:grid;grid-template-columns:auto 1fr auto auto;
                  align-items:center;padding:0.9rem 0.75rem;
                  border-bottom:1px solid var(--border);${bg}">
        <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;
                    font-size:1.4rem;color:var(--muted2);width:2rem;">${r.rank}</div>
        <div>
          <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;
                      font-size:1.5rem;color:${gold};line-height:1.1;">${r.label}</div>
          ${r.sub ? `<div style="font-size:0.85rem;font-weight:700;color:var(--muted2);">${r.sub}</div>` : ''}
        </div>
        <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;
                    font-size:1.6rem;color:${gold};text-align:right;padding-right:1.25rem;">${r.score}</div>
        <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;
                    font-size:1.2rem;color:var(--muted2);text-align:right;">${r.thru}</div>
      </div>`;
  });

  return html;
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
// ================================================================
// NEW VERTICAL SCORECARD (full-screen, swipeable per group)
// ================================================================

// Which score modes a format supports
function scorecardModesFor(fmt) {
  if (['stableford','split6','csm','best2','texas'].includes(fmt)) return ['points','strokes'];
  return ['strokes'];
}

// Build the column definitions for a given group's state.
// Each column: { label, dotColor, getCell(rowEntry, mode) -> {text, sub, highlight} }
function scorecardColumns(state) {
  const fmt   = state.format;
  const names = state.names ?? [];

  const indivCol = (pi) => ({
    label: names[pi] ?? `P${pi+1}`,
    dotColor: pHex(pi),
    getCell: (entry, mode) => {
      if (!entry) return { text: '' };
      const gross = entry.grosses?.[pi];
      if (gross == null) return { text: '' };
      if (mode === 'points') {
        const pts = entry.holePts?.[pi] ?? entry.sbPts?.[pi];
        return { text: pts != null ? String(pts) : '-' };
      }
      // Strokes mode: show gross, with par-relative for colour coding
      const relToPar = gross - entry.par;
      return { text: String(gross), relToPar };
    },
  });

  switch (fmt) {
    case 'stableford':
    case 'split6':
    case 'stroke':
      return names.map((_, pi) => indivCol(pi));

    case 'skins':
    case 'itc':
      return names.map((_, pi) => indivCol(pi));

    case 'match':
      return [0, 1].map(pi => indivCol(pi));

    case 'betterball':
      return [
        {
          label: `${names[0]} & ${names[1]}`, dotColor: pHex(0),
          getCell: (entry) => {
            if (!entry?.bbA) return { text: '' };
            return { text: String(entry.bbA.net) };
          },
        },
        {
          label: `${names[2]} & ${names[3]}`, dotColor: pHex(2),
          getCell: (entry) => {
            if (!entry?.bbB) return { text: '' };
            return { text: String(entry.bbB.net) };
          },
        },
      ];

    case 'csm':
      return [
        {
          label: `${names[0]} & ${names[1]}`, dotColor: pHex(0),
          getCell: (entry, mode) => {
            if (!entry) return { text: '' };
            if (mode === 'points') {
              const pts = (entry.sbPts?.[0] ?? 0) + (entry.sbPts?.[1] ?? 0);
              return { text: String(pts) };
            }
            return { text: entry.totalA != null ? String(entry.totalA) : '' };
          },
        },
        {
          label: `${names[2]} & ${names[3]}`, dotColor: pHex(2),
          getCell: (entry, mode) => {
            if (!entry) return { text: '' };
            if (mode === 'points') {
              const pts = (entry.sbPts?.[2] ?? 0) + (entry.sbPts?.[3] ?? 0);
              return { text: String(pts) };
            }
            return { text: entry.totalB != null ? String(entry.totalB) : '' };
          },
        },
      ];

    case 'foursomes':
    case 'greensomes':
      return [0, 1].map(pi => ({
        label: pi === 0 ? `${names[0]} & ${names[1]}` : `${names[2]} & ${names[3]}`,
        dotColor: pHex(pi === 0 ? 0 : 2),
        getCell: (entry) => {
          if (!entry) return { text: '' };
          const gross = entry.grosses?.[pi];
          const net   = entry.nets?.[pi] ?? gross;
          if (gross == null) return { text: '' };
          return { text: String(net), sub: gross !== net ? String(gross) : null };
        },
      }));

    case 'best2':
      return [{
        label: 'Team',
        dotColor: pHex(0),
        getCell: (entry, mode) => {
          if (!entry) return { text: '' };
          if (mode === 'points') return { text: entry.holeB2 != null ? String(entry.holeB2) : '-' };
          const counted = entry.counted ?? [];
          if (!counted.length) return { text: '-' };
          let sum = 0;
          counted.forEach(pi => {
            const gross  = entry.grosses?.[pi];
            const extras = entry.extras?.[pi] ?? indivStrokesOnHole(state.playingHandicaps?.[pi] ?? 0, entry.si);
            sum += (gross ?? 0) - extras;
          });
          return { text: String(sum) };
        },
      }];

    case 'texas':
      return [{
        label: state.teamName ?? 'Team',
        dotColor: pHex(0),
        getCell: (entry, mode) => {
          if (!entry) return { text: '' };
          if (mode === 'points') return { text: entry.pts != null ? String(entry.pts) : '-' };
          // Strokes mode: show gross with par-relative colouring
          if (entry.gross == null) return { text: '' };
          return { text: String(entry.gross), relToPar: entry.gross - entry.par };
        },
      }];

    default:
      return names.map((_, pi) => indivCol(pi));
  }
}

// Build the full 18-hole vertical scorecard table for one group's state
function buildVerticalScorecard(state, mode) {
  const par = state.par ?? [];
  const si  = state.si  ?? [];
  const numHoles = state.numHoles ?? 18;
  const log = state.log ?? [];
  const byHole = {};
  log.forEach(e => { byHole[e.hIdx] = e; });

  const columns = scorecardColumns(state);
  const totalHoles = par.length || 18;

  const headCells = columns.map(c => `
    <th>
      <div class="sc-player-header">
        <span class="dot" style="background:${c.dotColor};"></span>
        <span>${c.label}</span>
      </div>
    </th>`).join('');

  let bodyRows = '';
  let frontTotals = columns.map(() => 0);
  let backTotals  = columns.map(() => 0);
  let frontHas = columns.map(() => false);
  let backHas  = columns.map(() => false);

  for (let h = 0; h < totalHoles; h++) {
    const entry = byHole[h];
    const isCurrent = h === state.hole && !entry;
    const cells = columns.map((c, ci) => {
      const cell = c.getCell(entry, mode);
      const num = cell.text !== '' && cell.text !== '-' ? parseFloat(cell.text) : null;
      if (num != null) {
        if (h < 9) { frontTotals[ci] += num; frontHas[ci] = true; }
        else       { backTotals[ci]  += num; backHas[ci]  = true; }
      }

      // Colour-coded border for strokes mode based on gross vs par
      let inner = cell.text;
      if (mode === 'strokes' && cell.relToPar != null && cell.text !== '') {
        const r = cell.relToPar;
        const red  = '#d64545';
        const blue = '#3a7bd5';
        const single = (color) =>
          `<span style="display:inline-block;border:2px solid ${color};border-radius:2px;padding:1px 5px;line-height:1.2;">${cell.text}</span>`;
        const double = (color) =>
          `<span style="display:inline-block;border:2px solid ${color};border-radius:4px;padding:3px 7px;line-height:1.2;">
             <span style="display:inline-block;border:2px solid ${color};border-radius:2px;padding:0 3px;line-height:1.2;">${cell.text}</span>
           </span>`;
        if (r <= -2)      inner = double(red);
        else if (r === -1) inner = single(red);
        else if (r === 1)  inner = single(blue);
        else if (r === 2)  inner = double(blue);
      }

      return `<td class="sc-score-cell">${inner}</td>`;
    }).join('');

    const holeDisp1 = h + 1 + (state.holeOffset ?? 0);
    const isLdRow  = (state.longestDriveHoles ?? []).includes(holeDisp1);
    const isNtpRow = (state.nearestPinHoles   ?? []).includes(holeDisp1);
    const ldNtpIcon = isLdRow ? ' 🏌️' : isNtpRow ? ' 🎯' : '';

    bodyRows += `
      <tr class="${isCurrent ? 'sc-row-current' : ''}">
        <td><span class="sc-hole-cell">${h + 1}</span>${ldNtpIcon} &nbsp; <span class="sc-meta-cell">(Par ${par[h] ?? '-'} · SI ${si[h] ?? '-'})</span></td>
        ${cells}
      </tr>`;

    if (h === 8 && totalHoles > 9) {
      bodyRows += `
        <tr class="sc-subtotal-row">
          <td>Front 9</td>
          ${columns.map((c, ci) => `<td>${frontHas[ci] ? frontTotals[ci] : ''}</td>`).join('')}
        </tr>`;
    }
  }

  if (totalHoles > 9) {
    bodyRows += `
      <tr class="sc-subtotal-row">
        <td>Back 9</td>
        ${columns.map((c, ci) => `<td>${backHas[ci] ? backTotals[ci] : ''}</td>`).join('')}
      </tr>`;
  }

  const grandTotals = columns.map((c, ci) => {
    if (!frontHas[ci] && !backHas[ci]) return '';
    return (frontHas[ci] ? frontTotals[ci] : 0) + (backHas[ci] ? backTotals[ci] : 0);
  });
  bodyRows += `
    <tr class="sc-total-row">
      <td>Total</td>
      ${columns.map((c, ci) => `<td>${grandTotals[ci]}</td>`).join('')}
    </tr>`;

  // Texas Scramble: add team HCP footer and net total for stroke mode
  if (state.format === 'texas' && state.teamHcp != null) {
    const gross  = grandTotals[0];
    const net    = typeof gross === 'number' ? gross - state.teamHcp : '';
    bodyRows += `
      <tr style="background:var(--surface2);">
        <td style="font-size:0.85rem;font-weight:700;color:var(--muted2);">Team HCP</td>
        <td style="font-size:0.85rem;font-weight:700;color:var(--muted2);">${state.teamHcp}</td>
      </tr>
      ${typeof net === 'number' ? `<tr class="sc-total-row">
        <td>Net</td>
        <td>${net}</td>
      </tr>` : ''}`;
  }

  return `
    <table class="sc-table">
      <thead><tr><th>Hole</th>${headCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>`;
}

let scState = { mode: 'points', groupIdx: 0, groups: [] };

function renderScorecardOverlay() {
  document.getElementById('sc-overlay-title').textContent =
    `${gameState.courseName} -- ${gameState.teeName}`;
  document.getElementById('sc-overlay-sub').textContent =
    `${fmtLabel(gameState.format)} · ${gameState.log?.length ?? 0} holes played`;

  // Build per-group state list (own group's slot replaced with live gameState)
  const allStates = gameState.allGroupStates ?? [gameState];
  const groups = allStates
    .map(s => s.groupNumber === gameState.groupNumber ? gameState : s)
    .slice()
    .sort((a, b) => (a.groupNumber ?? 0) - (b.groupNumber ?? 0));

  const modes = scorecardModesFor(gameState.format);
  scState.mode  = modes.includes(scState.mode) ? scState.mode : modes[0];
  scState.groups = groups;
  if (scState.groupIdx >= groups.length) scState.groupIdx = 0;

  // Mode toggle visibility
  const modeRow = document.getElementById('sc-mode-row');
  if (modes.length > 1) {
    modeRow.classList.remove('hidden');
    modeRow.querySelectorAll('.sc-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === scState.mode);
    });
  } else {
    modeRow.classList.add('hidden');
  }

  // Group pager dots
  const dotsEl = document.getElementById('sc-group-dots');
  if (groups.length > 1) {
    dotsEl.classList.remove('hidden');
    dotsEl.innerHTML = groups.map((g, i) => `
      <button class="sc-group-btn${i === scState.groupIdx ? ' active' : ''}" data-idx="${i}">
        Group ${g.groupNumber ?? i + 1}
      </button>`).join('');
    dotsEl.querySelectorAll('.sc-group-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        scState.groupIdx = parseInt(btn.dataset.idx, 10);
        scrollToScorecardPage();
        renderScorecardOverlay();
      });
    });
  } else {
    dotsEl.classList.add('hidden');
  }

  // Build pages
  const bodyEl = document.getElementById('sc-overlay-body');
  bodyEl.innerHTML = `
    <div class="sc-pages" id="sc-pages">
      ${groups.map((g, i) => `
        <div class="sc-page" data-idx="${i}">
          ${groups.length > 1 ? `<div style="text-align:center;padding:0.5rem 0;font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1rem;color:var(--muted2);">Group ${g.groupNumber ?? i+1}</div>` : ''}
          ${buildVerticalScorecard(g, scState.mode)}
        </div>`).join('')}
    </div>`;

  setupScorecardSwipe();
  scrollToScorecardPage();
}

function scrollToScorecardPage() {
  const pagesEl = document.getElementById('sc-pages');
  if (!pagesEl) return;
  pagesEl.scrollTo({ left: pagesEl.clientWidth * scState.groupIdx, behavior: 'auto' });
}

function setupScorecardSwipe() {
  const pagesEl = document.getElementById('sc-pages');
  if (!pagesEl) return;
  let scrollTimeout = null;
  pagesEl.addEventListener('scroll', () => {
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      const idx = Math.round(pagesEl.scrollLeft / pagesEl.clientWidth);
      if (idx !== scState.groupIdx && idx >= 0 && idx < scState.groups.length) {
        scState.groupIdx = idx;
        const dotsEl = document.getElementById('sc-group-dots');
        dotsEl?.querySelectorAll('.sc-group-btn').forEach((btn, i) => {
          btn.classList.toggle('active', i === idx);
        });
      }
    }, 100);
  });
}

document.querySelectorAll('.sc-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    scState.mode = btn.dataset.mode;
    renderScorecardOverlay();
  });
});

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

  // Strip circular allGroupStates reference from the state we're about to save
  const { allGroupStates, ...myGroupState } = gameState;

  let stateToSave;

  if (allGroupStates?.length > 1) {
    // Multi-group round: fetch the current DB state first so we can merge our
    // group's updated scores into it without clobbering what the other scorer
    // has written.  This is the fix for the "group 2 scores never show up"
    // bug — previously every save overwrote the entire row, so whichever
    // scorer saved last would erase the other's scores from allGroupStates.
    let latestDbState = null;
    try {
      const fresh = await roundLoadById(roundId);
      latestDbState = fresh?.game_state ?? null;
    } catch {}

    // Build the merged allGroupStates: start from what's in the DB (so other
    // groups' data is preserved), then stamp in our own group's latest state.
    const myGroupNumber = gameState.groupNumber ?? 1;
    let mergedGroupStates;

    if (latestDbState?.allGroupStates?.length > 1) {
      mergedGroupStates = latestDbState.allGroupStates.map(gs => {
        if ((gs.groupNumber ?? 1) === myGroupNumber) {
          // Replace with our freshly-scored group state
          const { allGroupStates: _, ...stripped } = myGroupState;
          return stripped;
        }
        return gs;
      });
    } else {
      // DB doesn't have allGroupStates yet (first save) — build from memory
      mergedGroupStates = allGroupStates.map(gs => {
        const { allGroupStates: _, ...stripped } = gs;
        return stripped;
      });
      // Stamp our own group in at the right slot
      const myIdx = mergedGroupStates.findIndex(gs => (gs.groupNumber ?? 1) === myGroupNumber);
      if (myIdx >= 0) {
        const { allGroupStates: _, ...stripped } = myGroupState;
        mergedGroupStates[myIdx] = stripped;
      }
    }

    // The top-level state in the DB is always the organiser's group (group 1),
    // so that resumeRound and renderLeaderboard get consistent top-level data.
    const topGroup = mergedGroupStates.find(gs => (gs.groupNumber ?? 1) === 1) ?? mergedGroupStates[0];
    stateToSave = { ...topGroup, allGroupStates: mergedGroupStates };

    // Keep our in-memory allGroupStates in sync too
    gameState.allGroupStates = mergedGroupStates;

  } else {
    // Single group — save directly
    stateToSave = myGroupState;
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await roundSaveState(roundId, stateToSave, stateToSave.names);
      await realtimeBroadcastRound(realtimeCh, { ...myGroupState, groupNumber: gameState.groupNumber }, _sessionId).catch(() => {});
      badge?.classList.add('hidden');
      return;
    } catch (err) {
      lastErr = err;
      console.error(`saveRoundState error (attempt ${attempt})`, err);
      if (attempt === 1) await new Promise(r => setTimeout(r, 600));
    }
  }

  badge?.classList.add('hidden');
  alert('Your last score could not be saved — please check your connection and try recording that hole again. (' + (lastErr?.message || 'unknown error') + ')');
}

function subscribeToRound(id) {
  try { localStorage.setItem('lb-active-round', id); } catch {}
  realtimeUnsubscribe(realtimeCh);
  realtimeCh = realtimeSubscribeRound(id, remote => {
    if (!remote?.game_state) return;

    // Ignore our own broadcasts (tagged with our session ID)
    if (remote._senderSession === _sessionId) return;

    const incoming = remote.game_state;

    const scorerPid = gameState?.scorerProfileId;
    const iAmScorer = scorerPid === undefined
      ? (!gameState?.organiserId || gameState.organiserId === currentUser?.id)
      : (scorerPid !== '__unclaimed__' && scorerPid !== null && scorerPid === currentUser?.id);


    // Always update other groups in allGroupStates (scorers need this for the scorecard)
    const isOtherGroup = gameState?.allGroupStates?.length > 1 &&
      incoming.groupNumber && incoming.groupNumber !== gameState.groupNumber;

    if (isOtherGroup) {
      let idx = gameState.allGroupStates.findIndex(s => s.groupNumber === incoming.groupNumber);
      if (idx < 0) idx = incoming.groupNumber - 1;
      if (idx >= 0 && idx < gameState.allGroupStates.length) {
        gameState.allGroupStates[idx] = { ...incoming, allGroupStates: undefined };
      }
    }

    // Scorers don't replace their own gameState, but DO need to re-render
    // the leaderboard when another group's scores arrive.
    if (iAmScorer) {
      if (isOtherGroup) {
        // Re-render the leaderboard if it's currently visible
        const lbScreen = document.getElementById('screen-leaderboard');
        if (lbScreen?.classList.contains('active')) renderLeaderboard();
      }
      return;
    }

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

  // Immediately check for any pending invites (catches invites sent before app was opened)
  checkPendingInvitesNow();

  _gameInviteChannel = realtimeSubscribeGameInvites(currentUser.id, async (row) => {
    try {
      const invite = await gameInviteLoad(row.id);
      if (!invite || invite.status === 'accepted') return;
      showGameInviteBanner(invite);
    } catch (e) { console.error('[invite] load error', e); }
  });

  // Always start polling as a belt-and-braces fallback — realtime can drop
  // silently on mobile (backgrounding the app, network switches, etc.).
  // startInvitePoll() is a no-op if already running.
  setTimeout(() => startInvitePoll(), 3000);
}

async function checkPendingInvitesNow() {
  // Poll with no timestamp — catches any pending invite regardless of when it was sent
  try {
    const rows = await gameInvitesPollPending(currentUser.id, null);
    for (const row of rows) {
      const invite = await gameInviteLoad(row.id ?? row);
      if (invite && invite.status !== 'accepted') showGameInviteBanner(invite);
    }
    _lastInviteCheck = new Date().toISOString();
  } catch {}
}

async function startInvitePoll() {
  if (_gameInvitePollTimer) return;
  // Don't pre-set _lastInviteCheck here — leave it null so the first poll
  // has no time filter and catches anything pending (same as checkPendingInvitesNow).
  _gameInvitePollTimer = setInterval(async () => {
    try {
      const rows = await gameInvitesPollPending(currentUser.id, _lastInviteCheck);
      if (rows.length) {
        for (const row of rows) showGameInviteBanner(row);
      }
      // Only advance the timestamp after a successful check
      _lastInviteCheck = new Date().toISOString();
    } catch {}
  }, 5000);
}

function showGameInviteBanner(invite) {
  _pendingGameInvite = invite;
  const banner  = document.getElementById('game-invite-banner');
  const titleEl = document.getElementById('game-invite-banner-title');
  const subEl   = document.getElementById('game-invite-banner-sub');
  titleEl.textContent = `${invite.name ?? 'Someone'} started a round`;
  subEl.textContent   = invite.group_number
    ? `Group ${invite.group_number} · Tap Join or find it in Active Games`
    : 'Tap Join or find it in Active Games';
  banner.style.display = '';
  // Also update badges on the home buttons
  updateActiveGamesBadge();
}

function hideGameInviteBanner() {
  _pendingGameInvite = null;
  document.getElementById('game-invite-banner').style.display = 'none';
}

async function updateActiveGamesBadge() {
  try {
    const [inviteRows, activeRounds] = await Promise.all([
      gameInvitesPollPending(currentUser.id, null).catch(() => []),
      roundsLoadActive(currentUser.id).catch(() => []),
    ]);

    // Active Games badge = active/paused rounds + any saved setup draft
    const _draft = readSetupDraft();
    const hasDraft = !!(_draft?.screen);
    console.log('[updateActiveGamesBadge] hasDraft:', hasDraft, '| draft screen:', _draft?.screen ?? 'none', '| hasSetup:', !!_draft?.setup);
    const gamesBadge = document.getElementById('home-active-games-badge');
    const roundCount = activeRounds.length + (hasDraft ? 1 : 0);
    if (gamesBadge) {
      gamesBadge.textContent = String(roundCount);
      gamesBadge.style.display = roundCount > 0 ? 'inline-flex' : 'none';
    }

    // Game Invites badge
    const gameInvites  = inviteRows.filter(r => r.round_id);
    const invitesBadge = document.getElementById('home-game-invites-badge');
    if (invitesBadge) {
      invitesBadge.textContent = String(gameInvites.length);
      invitesBadge.style.display = gameInvites.length > 0 ? 'inline-flex' : 'none';
    }
  } catch {}
}

// ── Active Games modal ───────────────────────────────────────────
// ── Resend Invites (in-game, organiser only) ───────────────────────
document.getElementById('btn-resend-invites')?.addEventListener('click', async () => {
  if (!gameState?.allGroupStates?.length) return;
  await openResendInvitesModal({
    roundId,
    isTournament: false,
    organiserId: gameState.organiserId,
    organiserName: currentProfile
      ? `${currentProfile.first_name ?? ''} ${currentProfile.last_name ?? ''}`.trim()
      : 'Your organiser',
    groups: gameState.allGroupStates.map(gs => ({
      groupNumber: gs.groupNumber,
      players: (gs.names ?? []).map((name, i) => ({
        name,
        profileId: gs.playerProfileIds?.[i] ?? null,
      })),
    })),
  });
});

// ── Resend Invites (tournament detail, organiser/co-organiser) ─────
document.getElementById('btn-td-resend-invites')?.addEventListener('click', async () => {
  const liveRound = activeTournRounds.find(r => r.status === 'active');
  if (!liveRound?.round_id) {
    alert('No active round to resend invites for. Start a round first.');
    return;
  }
  const groups = {};
  activeTournPlayers.forEach(p => {
    // We don't have per-round group numbers readily on activeTournPlayers,
    // so just present everyone with a profile as one list — still lets the
    // organiser see status and resend per player.
    if (!groups[1]) groups[1] = [];
    groups[1].push({ name: p.name, profileId: p.profile_id ?? null });
  });
  await openResendInvitesModal({
    roundId: liveRound.round_id,
    isTournament: true,
    tournamentRoundId: liveRound.id,
    organiserId: activeTournament.organiser_id,
    organiserName: currentProfile
      ? `${currentProfile.first_name ?? ''} ${currentProfile.last_name ?? ''}`.trim()
      : 'Your organiser',
    groups: Object.entries(groups).map(([g, players]) => ({ groupNumber: parseInt(g), players })),
  });
});

async function openResendInvitesModal({ roundId, isTournament, tournamentRoundId, organiserId, organiserName, groups }) {
  const listEl = document.getElementById('resend-invites-list');
  listEl.innerHTML = '<div style="padding:1rem;text-align:center;color:var(--muted);">Loading…</div>';
  document.getElementById('modal-resend-invites').classList.add('open');

  try {
    const existingInvites = isTournament
      ? await invitesForTournamentRoundLoad(tournamentRoundId)
      : await invitesForRoundLoad(roundId);

    // Flatten all players with a profile, excluding the organiser themself
    const allPlayers = [];
    groups.forEach(g => {
      g.players.forEach(p => {
        if (p.profileId && p.profileId !== organiserId) {
          allPlayers.push({ ...p, groupNumber: g.groupNumber });
        }
      });
    });

    if (!allPlayers.length) {
      listEl.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--muted);font-size:0.95rem;">No other players with a Leaderboard account in this round.</div>';
      return;
    }

    const statusFor = (profileId) => {
      const invs = existingInvites.filter(i => i.recipient_profile_id === profileId);
      if (!invs.length) return { text: 'Not sent', color: 'var(--muted)' };
      if (invs.some(i => i.status === 'accepted')) return { text: 'Accepted', color: 'var(--green)' };
      return { text: 'Pending', color: 'var(--gold)' };
    };

    listEl.innerHTML = allPlayers.map((p, i) => {
      const st = statusFor(p.profileId);
      return `
        <button class="resend-invite-row" data-idx="${i}"
          style="display:flex;align-items:center;gap:0.75rem;width:100%;text-align:left;
                 padding:0.7rem 1rem;border-bottom:1px solid var(--border);background:none;border-left:none;border-right:none;border-top:none;">
          <span class="dot" style="background:${pHex(i % 8)};flex-shrink:0;"></span>
          <div style="flex:1;min-width:0;">
            <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.1rem;">${p.name}</div>
            <div style="font-size:0.8rem;color:var(--muted2);font-weight:700;">Group ${p.groupNumber}</div>
          </div>
          <div style="font-size:0.8rem;font-weight:800;color:${st.color};flex-shrink:0;">${st.text}</div>
          <span style="font-size:1.1rem;color:var(--muted);flex-shrink:0;">↻</span>
        </button>`;
    }).join('');

    listEl.querySelectorAll('.resend-invite-row').forEach(btn => {
      btn.addEventListener('click', async () => {
        const p = allPlayers[parseInt(btn.dataset.idx, 10)];
        btn.style.opacity = '0.5';
        try {
          await smsInviteCreate({
            roundId,
            inviterId: organiserId,
            name: organiserName,
            mobile: null,
            recipientProfileId: p.profileId,
            tournamentRoundId: isTournament ? tournamentRoundId : null,
            groupNumber: p.groupNumber,
          });
          btn.querySelector('div:nth-child(3)')?.remove();
          const statusSpan = btn.children[2];
          if (statusSpan) { statusSpan.textContent = 'Sent ✓'; statusSpan.style.color = 'var(--gold)'; }
        } catch (err) {
          alert('Could not resend invite: ' + (err.message || 'unknown error'));
        } finally {
          btn.style.opacity = '1';
        }
      });
    });
  } catch (err) {
    listEl.innerHTML = `<div style="padding:1rem;color:var(--red);">Error loading invite status: ${err.message}</div>`;
  }
}
document.getElementById('modal-resend-invites-close')?.addEventListener('click', () => {
  document.getElementById('modal-resend-invites').classList.remove('open');
});

document.getElementById('btn-home-active-games')?.addEventListener('click', async () => {
  const listEl = document.getElementById('active-games-list');
  listEl.innerHTML = '<div style="padding:1rem;text-align:center;color:var(--muted);">Loading…</div>';
  document.getElementById('modal-active-games').classList.add('open');
  _agSelectMode = false; _agSelectedIds.clear();
  document.getElementById('active-games-bulk-bar')?.classList.add('hidden');
  document.getElementById('active-games-select-toggle').textContent = 'Select';
  await renderActiveGamesList();
});

let _agSelectMode = false;
const _agSelectedIds = new Set(); // round IDs only — invites aren't selectable for delete here

document.getElementById('active-games-select-toggle')?.addEventListener('click', () => {
  _agSelectMode = !_agSelectMode;
  _agSelectedIds.clear();
  document.getElementById('active-games-select-toggle').textContent = _agSelectMode ? 'Cancel' : 'Select';
  document.getElementById('active-games-bulk-bar')?.classList.toggle('hidden', !_agSelectMode);
  renderActiveGamesList();
});

document.getElementById('active-games-select-all')?.addEventListener('click', () => {
  const checkboxes = document.querySelectorAll('.active-games-checkbox');
  const allChecked = [...checkboxes].every(cb => _agSelectedIds.has(cb.dataset.roundId));
  checkboxes.forEach(cb => {
    if (allChecked) _agSelectedIds.delete(cb.dataset.roundId);
    else _agSelectedIds.add(cb.dataset.roundId);
  });
  renderActiveGamesList();
});

document.getElementById('active-games-delete-selected')?.addEventListener('click', () => {
  if (!_agSelectedIds.size) return;
  document.getElementById('confirm-delete-round-text').textContent =
    `This will permanently delete ${_agSelectedIds.size} game${_agSelectedIds.size > 1 ? 's' : ''} and all their scores. This cannot be undone.`;
  document.getElementById('modal-confirm-delete-round').dataset.pendingRoundIds = JSON.stringify([..._agSelectedIds]);
  delete document.getElementById('modal-confirm-delete-round').dataset.pendingRoundId;
  document.getElementById('modal-confirm-delete-round').classList.add('open');
});

async function renderActiveGamesList() {
  const listEl = document.getElementById('active-games-list');
  // Read draft FIRST — before any async calls — so a network failure can never hide it
  const savedDraft = readSetupDraft();
  const _rawDraft = localStorage.getItem('lb-setup-draft');
  console.log('[renderActiveGamesList] raw lb-setup-draft:', _rawDraft ? _rawDraft.slice(0,120) : 'NULL');
  console.log('[renderActiveGamesList] parsed:', savedDraft ? `screen=${savedDraft.screen} hasSetup=${!!savedDraft.setup} scoring=${savedDraft.setup?.scoring ?? savedDraft.scoring}` : 'null');
  try {
    // Load active rounds + any pending game invites
    const [rounds, inviteRows] = await Promise.all([
      roundsLoadActive(currentUser?.id).catch(() => []),
      gameInvitesPollPending(currentUser?.id, null).catch(() => []),
    ]);
    const invites = (await Promise.all(
      inviteRows
        .filter(r => r.round_id && !r.tournament_round_id)
        .map(r => gameInviteLoad(r.id ?? r).catch(() => null))
    )).filter(inv => inv && inv.status !== 'accepted');

    const items = [];

    // Saved setup draft — shown first so user can complete setup
    try {
      if (savedDraft?.screen) {
        const su         = savedDraft.setup ?? {};
        const course     = su.courseId ? allCourses.find(c => c.id === su.courseId) : null;
        const courseName = course?.name ?? savedDraft.courseName ?? 'Course not set';
        const fmt        = su.scoring ?? savedDraft.scoring ?? null;
        const players    = savedDraft.players
          ?? (su.players ?? []).filter(p => p?.name).map(p => p.name);
        const screenLabels = {
          'screen-setup-course':  'Step 1 — Choose course',
          'screen-setup-players': 'Step 2 — Add players',
          'screen-setup-groups':  'Step 3 — Arrange groups',
          'screen-setup-pairs':   'Step 3 — Pair up players',
          'screen-setup-review':  'Step 4 — Review & tee off',
        };
        const step = screenLabels[savedDraft.screen] ?? 'Setup in progress';
        items.push({
          kind:        'draft',
          icon:        '✏️',
          title:       fmt ? `${FORMAT_LABELS[fmt] ?? fmt} · ${courseName}` : 'Setup in progress',
          sub:         `${step}${players.length ? ` · ${players.slice(0,3).join(', ')}${players.length > 3 ? '…' : ''}` : ''}`,
          actionLabel: 'Complete Setup',
          action: async () => {
            if (su && Object.keys(su).length) Object.assign(setup, su);
            const ok = await tryRestoreSetupState() || await _restoreSetupFromDraft(savedDraft);
            if (!ok) {
              if (su && Object.keys(su).length) {
                saveSetupState(savedDraft.screen);
                const ok2 = await tryRestoreSetupState();
                if (!ok2) { clearSetupState(); clearSetupDraft(); showHome(); }
              } else {
                clearSetupState(); clearSetupDraft(); showHome();
              }
            }
          },
          discard: () => { clearSetupState(); clearSetupDraft(); renderActiveGamesList(); updateActiveGamesBadge(); },
        });
      }
    } catch (draftErr) {
      console.error('[renderActiveGamesList] draft section error:', draftErr);
    }

    // Active rounds this user is scoring — Resume + Delete
    rounds.forEach(r => {
      const isPaused = r.status === 'paused';
      items.push({
        kind: 'round',
        roundId: r.id,
        icon: isPaused ? '⏸️' : '⛳',
        title: r.course_name ?? 'Round',
        sub: `${fmtLabel(r.game_state?.format ?? '')} · Group ${r.game_state?.groupNumber ?? 1}${isPaused ? ' · Saved' : ''}`,
        action: () => resumeRound(r.id),
        actionLabel: 'Resume',
      });
    });

    // Pending game invites — Join only, no delete
    invites.forEach(inv => {
      items.push({
        kind: 'invite',
        icon: '📩',
        title: inv.name ?? 'Game invite',
        sub: `Group ${inv.group_number ?? 1} · Tap to join`,
        action: async () => {
          document.getElementById('modal-active-games').classList.remove('open');
          await acceptAndJoinInvite(inv);
        },
        actionLabel: 'Join',
      });
    });

    const selectedCountEl = document.getElementById('active-games-selected-count');
    const deleteSelBtn    = document.getElementById('active-games-delete-selected');
    if (selectedCountEl) selectedCountEl.textContent = _agSelectedIds.size ? `${_agSelectedIds.size} selected` : '';
    if (deleteSelBtn) deleteSelBtn.disabled = _agSelectedIds.size === 0;

    listEl.innerHTML = items.length === 0
      ? '<div style="padding:1.5rem;text-align:center;color:var(--muted);font-size:0.95rem;">No active games or pending invites.</div>'
      : items.map((item, i) => `
          <div style="display:flex;align-items:center;gap:0.75rem;
               padding:0.85rem 1rem;border-bottom:1px solid var(--border);">
            ${_agSelectMode && item.kind === 'round'
              ? `<input type="checkbox" class="active-games-checkbox" data-round-id="${item.roundId}"
                  ${_agSelectedIds.has(item.roundId) ? 'checked' : ''}
                  style="width:20px;height:20px;flex-shrink:0;accent-color:var(--red);">`
              : _agSelectMode ? `<div style="width:20px;flex-shrink:0;"></div>` : ''}
            <div style="font-size:1.5rem;flex-shrink:0;">${item.icon}</div>
            <div style="flex:1;min-width:0;">
              <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.15rem;
                          white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${item.title}</div>
              <div style="font-size:0.82rem;color:var(--muted2);font-weight:700;">${item.sub}</div>
            </div>
            ${!_agSelectMode ? `
              <div style="display:flex;gap:0.4rem;flex-shrink:0;">
                <button class="btn btn-green active-games-action" data-item="${i}"
                  style="padding:0.45rem 0.9rem;font-size:0.85rem;font-weight:800;white-space:nowrap;">
                  ${item.actionLabel}
                </button>
                ${item.kind === 'round' ? `
                  <button class="btn btn-outline active-games-delete" data-round-id="${item.roundId}"
                    style="padding:0.45rem 0.6rem;font-size:0.95rem;border-color:var(--red-border);color:var(--red);"
                    title="Delete this game">🗑</button>
                ` : ''}
                ${item.kind === 'draft' ? `
                  <button class="btn btn-outline active-games-discard" data-item="${i}"
                    style="padding:0.45rem 0.6rem;font-size:0.95rem;border-color:var(--red-border);color:var(--red);"
                    title="Discard setup">🗑</button>
                ` : ''}
              </div>
            ` : ''}
          </div>`).join('');

    listEl.querySelectorAll('.active-games-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) _agSelectedIds.add(cb.dataset.roundId);
        else _agSelectedIds.delete(cb.dataset.roundId);
        const cnt = document.getElementById('active-games-selected-count');
        const btn = document.getElementById('active-games-delete-selected');
        if (cnt) cnt.textContent = _agSelectedIds.size ? `${_agSelectedIds.size} selected` : '';
        if (btn) btn.disabled = _agSelectedIds.size === 0;
      });
    });

    listEl.querySelectorAll('.active-games-action').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.item);
        document.getElementById('modal-active-games').classList.remove('open');
        items[idx]?.action();
      });
    });

    listEl.querySelectorAll('.active-games-discard').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.item);
        items[idx]?.discard?.();
        updateActiveGamesBadge();
      });
    });

    listEl.querySelectorAll('.active-games-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        const rid = btn.dataset.roundId;
        const item = items.find(it => it.roundId === rid);
        document.getElementById('confirm-delete-round-text').textContent =
          `This will permanently delete "${item?.title ?? 'this round'}" and all its scores. This cannot be undone.`;
        document.getElementById('modal-confirm-delete-round').dataset.pendingRoundId = rid;
        delete document.getElementById('modal-confirm-delete-round').dataset.pendingRoundIds;
        document.getElementById('modal-confirm-delete-round').classList.add('open');
      });
    });
  } catch (err) {
    listEl.innerHTML = `<div style="padding:1rem;color:var(--red);">Error loading games: ${err.message}</div>`;
  }
}

document.getElementById('confirm-delete-round-cancel')?.addEventListener('click', () => {
  document.getElementById('modal-confirm-delete-round').classList.remove('open');
});
document.getElementById('confirm-delete-round-confirm')?.addEventListener('click', async () => {
  const modal = document.getElementById('modal-confirm-delete-round');
  const bulkIdsJson = modal.dataset.pendingRoundIds;
  const rid   = modal.dataset.pendingRoundId;
  modal.classList.remove('open');

  try {
    if (bulkIdsJson) {
      const ids = JSON.parse(bulkIdsJson);
      const failures = [];
      for (const id of ids) {
        try {
          await roundDelete(id);
          try {
            const stored = localStorage.getItem('lb-active-round');
            if (stored === id) localStorage.removeItem('lb-active-round');
          } catch {}
        } catch (err) {
          console.error('[bulk delete] failed for', id, err);
          failures.push(err.message || 'unknown error');
        }
      }
      _agSelectedIds.clear();
      _agSelectMode = false;
      document.getElementById('active-games-select-toggle').textContent = 'Select';
      document.getElementById('active-games-bulk-bar')?.classList.add('hidden');
      if (failures.length) {
        alert(`${failures.length} of ${ids.length} game(s) could not be deleted: ${failures[0]}`);
      }
    } else if (rid) {
      await roundDelete(rid);
      try {
        const stored = localStorage.getItem('lb-active-round');
        if (stored === rid) localStorage.removeItem('lb-active-round');
      } catch {}
    }
  } catch (err) {
    alert('Could not delete the game: ' + (err.message || 'unknown error'));
  }
  delete modal.dataset.pendingRoundId;
  delete modal.dataset.pendingRoundIds;
  await renderActiveGamesList();
  updateActiveGamesBadge();
});
document.getElementById('modal-active-games-close')?.addEventListener('click', () => {
  document.getElementById('modal-active-games').classList.remove('open');
});

// ── Active Tournaments modal ─────────────────────────────────────
document.getElementById('btn-home-game-invites')?.addEventListener('click', async () => {
  const listEl = document.getElementById('game-invites-list');
  listEl.innerHTML = '<div style="padding:1rem;text-align:center;color:var(--muted);">Loading…</div>';
  document.getElementById('modal-game-invites').classList.add('open');
  _giSelectMode = false; _giSelectedIds.clear();
  document.getElementById('game-invites-bulk-bar')?.classList.add('hidden');
  document.getElementById('game-invites-select-toggle').textContent = 'Select';
  await renderGameInvitesList();
});

let _giSelectMode = false;
const _giSelectedIds = new Set();

document.getElementById('game-invites-select-toggle')?.addEventListener('click', () => {
  _giSelectMode = !_giSelectMode;
  _giSelectedIds.clear();
  document.getElementById('game-invites-select-toggle').textContent = _giSelectMode ? 'Cancel' : 'Select';
  document.getElementById('game-invites-bulk-bar')?.classList.toggle('hidden', !_giSelectMode);
  renderGameInvitesList();
});

document.getElementById('game-invites-select-all')?.addEventListener('click', () => {
  const checkboxes = document.querySelectorAll('.game-invites-checkbox');
  const allChecked = [...checkboxes].every(cb => _giSelectedIds.has(cb.dataset.inviteId));
  checkboxes.forEach(cb => {
    if (allChecked) _giSelectedIds.delete(cb.dataset.inviteId);
    else _giSelectedIds.add(cb.dataset.inviteId);
  });
  renderGameInvitesList();
});

document.getElementById('game-invites-delete-selected')?.addEventListener('click', async () => {
  if (!_giSelectedIds.size) return;
  const count = _giSelectedIds.size;
  if (!confirm(`Delete ${count} invite${count > 1 ? 's' : ''} from your history? This won't affect anyone who already joined.`)) return;
  const btn = document.getElementById('game-invites-delete-selected');
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
  try {
    await smsInvitesDeleteMany([..._giSelectedIds]);
    _giSelectedIds.clear();
  } catch (err) {
    alert('Could not delete invites: ' + (err.message || 'unknown error'));
  } finally {
    if (btn) btn.textContent = 'Delete Selected';
  }
  await renderGameInvitesList();
});

async function renderGameInvitesList() {
  const listEl = document.getElementById('game-invites-list');
  try {
    const invites = await gameInvitesLoadHistory(currentUser.id, 30);

    const selectedCountEl = document.getElementById('game-invites-selected-count');
    const deleteSelBtn    = document.getElementById('game-invites-delete-selected');
    if (selectedCountEl) selectedCountEl.textContent = _giSelectedIds.size ? `${_giSelectedIds.size} selected` : '';
    if (deleteSelBtn) deleteSelBtn.disabled = _giSelectedIds.size === 0;

    if (!invites.length) {
      listEl.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--muted);font-size:0.95rem;">No invites yet.</div>';
      return;
    }

    const statusLabel = (s) => ({
      pending:  { text: 'Pending',  color: 'var(--gold)' },
      accepted: { text: 'Accepted', color: 'var(--green)' },
      declined: { text: 'Declined', color: 'var(--muted)' },
    }[s] ?? { text: s, color: 'var(--muted)' });

    listEl.innerHTML = invites.map((inv, i) => {
      const isSent     = inv.inviter_id === currentUser.id;
      const isPending   = inv.status === 'pending';
      const canJoin     = !isSent && isPending && (inv.round_id || inv.tournament_round_id);
      const dir         = isSent ? 'Sent to' : 'Invited by';
      const who         = isSent ? (inv.recipient_profile_id ? 'a player' : inv.mobile ?? 'a player') : inv.name;
      const st          = statusLabel(inv.status);
      const dateStr     = inv.created_at
        ? new Date(inv.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
        : '';
      return `
        <div style="display:flex;align-items:center;gap:0.75rem;padding:0.7rem 1rem;border-bottom:1px solid var(--border);">
          ${_giSelectMode
            ? `<input type="checkbox" class="game-invites-checkbox" data-invite-id="${inv.id}"
                ${_giSelectedIds.has(inv.id) ? 'checked' : ''}
                style="width:20px;height:20px;flex-shrink:0;accent-color:var(--red);">`
            : ''}
          <div style="font-size:1.3rem;flex-shrink:0;">${isSent ? '↗️' : '↘️'}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.05rem;">
              ${dir} ${who}
            </div>
            <div style="font-size:0.8rem;color:var(--muted2);font-weight:700;">
              ${inv.tournament_round_id ? 'Tournament round' : 'Game'}${inv.group_number ? ` · Group ${inv.group_number}` : ''} · ${dateStr}
            </div>
          </div>
          ${!_giSelectMode
            ? (canJoin
                ? `<button class="btn btn-green game-invite-join-btn" data-idx="${i}"
                    style="padding:0.4rem 0.85rem;font-size:0.85rem;font-weight:800;flex-shrink:0;">Join</button>`
                : `<div style="font-size:0.8rem;font-weight:800;color:${st.color};flex-shrink:0;">${st.text}</div>`)
            : ''}
        </div>`;
    }).join('');

    listEl.querySelectorAll('.game-invites-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) _giSelectedIds.add(cb.dataset.inviteId);
        else _giSelectedIds.delete(cb.dataset.inviteId);
        const cnt = document.getElementById('game-invites-selected-count');
        const btn = document.getElementById('game-invites-delete-selected');
        if (cnt) cnt.textContent = _giSelectedIds.size ? `${_giSelectedIds.size} selected` : '';
        if (btn) btn.disabled = _giSelectedIds.size === 0;
      });
    });

    listEl.querySelectorAll('.game-invite-join-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const inv = invites[parseInt(btn.dataset.idx, 10)];
        document.getElementById('modal-game-invites').classList.remove('open');
        await acceptAndJoinInvite(inv);
      });
    });
  } catch (err) {
    listEl.innerHTML = `<div style="padding:1rem;color:var(--red);">Error loading invites: ${err.message}</div>`;
  }
}
document.getElementById('modal-game-invites-close')?.addEventListener('click', () => {
  document.getElementById('modal-game-invites').classList.remove('open');
});

// ── Shared invite accept helper ──────────────────────────────────
async function acceptAndJoinInvite(invite) {
  _joiningViaInvite = true;
  try {
    await smsInviteAccept(invite.id);
    if (invite.tournament_round_id && invite.group_number) {
      await joinTournamentRoundAsScorer(currentUser, invite.tournament_round_id, invite.group_number);
    } else if (invite.round_id) {
      await _joinRoundWithRole(invite.round_id, invite.group_number ?? 1, false);
    }
  } catch (err) {
    alert('Could not join: ' + err.message);
  } finally {
    _joiningViaInvite = false;
  }
}

document.getElementById('btn-game-invite-join')?.addEventListener('click', async () => {
  const invite = _pendingGameInvite;
  if (!invite) return;
  hideGameInviteBanner();
  if (_gameInvitePollTimer) { clearInterval(_gameInvitePollTimer); _gameInvitePollTimer = null; }
  await acceptAndJoinInvite(invite);
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
    // Update round_players so RLS lets this scorer write to the rounds table
    roundPlayerClaimScorer(roundId, currentUser.id).catch(err =>
      console.warn('[join-scorer] round_players update failed:', err)
    );
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
async function doAbandon(shouldDelete) {
  const tid = setup.tournamentId;
  // Fall back to the locally-stored round id if the in-memory one is missing
  // (e.g. abandon triggered from a stale screen state)
  let targetRoundId = roundId;
  if (!targetRoundId) {
    try { targetRoundId = localStorage.getItem('lb-active-round'); } catch {}
  }

  if (targetRoundId) {
    try {
      if (shouldDelete) await roundDelete(targetRoundId);
      else await roundAbandon(targetRoundId);
    } catch (err) {
      console.error('doAbandon: failed to update round', err);
      alert('Could not abandon the round — please try again. (' + (err.message || 'unknown error') + ')');
      return; // don't navigate away if the DB update failed — let the user retry
    }
  }

  realtimeUnsubscribe(realtimeCh); realtimeCh = null;
  roundId = null; gameState = null;
  try { localStorage.removeItem('lb-active-round'); } catch {}
  clearSetupState();
  clearSetupDraft();
  setup.tournamentId     = null;
  setup.tournRoundNumber = null;

  if (tid && activeTournament) {
    await showTournamentDetail(tid);
  } else {
    await showHome();
  }
}

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
  const merged      = mergeGroupStates(allStates, gameState);
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
    // Build allGroupStates with clean individual group states
    const rawGroups = gameState.allGroupStates?.length > 1
      ? gameState.allGroupStates.map(s => {
          const { allGroupStates: _, ...stripped } = s;
          // Replace current group's slot with live gameState (has latest scores)
          if (stripped.groupNumber === gameState.groupNumber) {
            const { allGroupStates: __, ...liveStripped } = gameState;
            return liveStripped;
          }
          return stripped;
        })
      : null;

    // Build merged state for top-level (so history shows all players)
    const allStates = rawGroups ?? [gameState];
    const merged = mergeGroupStates(allStates);
    if (rawGroups) merged.allGroupStates = rawGroups;

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
function mergeGroupStates(states, currentState) {
  if (!states?.length) return currentState ?? null;
  let merged = states;
  if (currentState?.groupNumber) {
    merged = states.map(s =>
      s.groupNumber === currentState.groupNumber ? { ...currentState, allGroupStates: undefined } : s
    );
  }
  if (merged.length === 1) {
    const { allGroupStates: _, ...stripped } = merged[0];
    return stripped;
  }
  const sorted = [...merged].sort((a, b) => (a.groupNumber ?? 0) - (b.groupNumber ?? 0));
  const base = sorted[0];
  return {
    ...base,
    names:           sorted.flatMap(s => s.names ?? []),
    playingHandicaps:sorted.flatMap(s => s.playingHandicaps ?? []),
    matchHandicaps:  sorted.flatMap(s => s.matchHandicaps ?? []),
    totals:          sorted.flatMap(s => s.totals ?? []),
    log: base.log?.map((_, hi) => {
      const merged = { grosses: [], extras: [], holePts: [], pars: [] };
      sorted.forEach(s => {
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
  setActiveBottomNav('nav-profile');
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

  const hcpEl = document.getElementById('profile-hcp');
  if (hcpEl) hcpEl.textContent = p.hcp != null ? fmtHandicap(p.hcp) : '--';

  populateProfileCourseSelect();
  renderCourseHandicapSection();
  renderLogos();
  applyTheme(theme); // refresh button highlight state
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

// Show / build the per-tee course handicap inputs for the selected home club
function renderCourseHandicapSection() {
  const section  = document.getElementById('prof-course-hcp-section');
  const teesWrap = document.getElementById('prof-course-hcp-tees');
  const idxEl    = document.getElementById('prof-course-hcp-index');
  if (!section || !teesWrap) return;

  const courseId = document.getElementById('prof-course-select')?.value || null;
  const course   = courseId ? allCourses.find(c => c.id === courseId) : null;

  if (!course) {
    section.classList.add('hidden');
    teesWrap.innerHTML = '';
    return;
  }

  section.classList.remove('hidden');

  // Handicap Index — mirrors the main Handicap Index field
  const hcpVal = currentProfile?.hcp ?? '';
  if (idxEl) idxEl.value = hcpVal;

  const saved = currentProfile?.home_course_handicaps ?? {};
  teesWrap.innerHTML = (course.tees ?? []).map(t => {
    const safeId = `prof-course-hcp-${t.name.replace(/\s+/g,'-').toLowerCase()}`;
    const val = saved[t.name] ?? '';
    return `
      <div class="field" style="margin:0;">
        <label>${t.name}</label>
        <input id="${safeId}" data-tee="${t.name}" class="prof-course-hcp-input"
          type="number" step="1" min="0" max="54" placeholder="e.g. ${fmtHandicap(currentProfile?.hcp ?? 0)}"
          value="${val}">
      </div>`;
  }).join('');
}

document.getElementById('prof-course-select')?.addEventListener('change', renderCourseHandicapSection);

document.getElementById('prof-hcp')?.addEventListener('input', e => {
  const idxEl = document.getElementById('prof-course-hcp-index');
  if (idxEl) idxEl.value = e.target.value;
});

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
    home_course_handicaps: (() => {
      const result = { ...(currentProfile?.home_course_handicaps ?? {}) };
      document.querySelectorAll('.prof-course-hcp-input').forEach(input => {
        const tee = input.dataset.tee;
        const v   = parseFloat(input.value);
        if (input.value.trim() === '') delete result[tee];
        else result[tee] = v;
      });
      return result;
    })(),
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
  setActiveBottomNav('nav-friends');
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
        <button class="btn btn-ghost" style="font-size:0.85rem;border-color:var(--red-border);color:var(--red);"
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
    const sendBtn = document.getElementById('btn-send-request');
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send Request';
    sendBtn.onclick = async () => {
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending…';
      try {
        await friendRequestSend(currentUser.id, user.id);
        hide('friend-search-result');
        document.getElementById('friend-search-email').value = '';
        document.getElementById('friend-search-empty').textContent = '✓ Friend request sent!';
        show('friend-search-empty');
      } catch (err) {
        // Supabase unique constraint error = request already exists
        const isDuplicate = err?.code === '23505' || err?.message?.includes('duplicate') || err?.message?.includes('unique');
        const msg = isDuplicate
          ? 'A friend request to this person already exists, or you\'re already friends.'
          : (err.message ?? 'Could not send request — please try again.');
        document.getElementById('friend-search-empty').textContent = msg;
        show('friend-search-empty');
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Request';
      }
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
  setActiveBottomNav('nav-history');
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
        <div class="history-card" data-rid="${r.id}">
          <div class="history-card-icon">⛳</div>
          <div class="history-card-body">
            <div class="history-card-date">${date}</div>
            <div class="history-card-title">${r.course_name ?? '--'}</div>
            <div class="history-card-winner">${fmtLabel(r.game_format)} · ${r.tee_name ?? ''} Tees${summary?.winner ? ` · 🏆 ${summary.winner}` : ''}</div>
          </div>
          <div class="history-card-chevron">›</div>
        </div>`;
    }).join('');
    listEl.querySelectorAll('.history-card').forEach(item => {
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

  document.getElementById('hd-title').textContent =
    `${r.course_name ?? '--'} · ${fmtLabel(r.game_format)}`;

  // Clear tabs back to default (leaderboard visible)
  document.getElementById('hd-tab-leaderboard').style.display = '';
  document.getElementById('hd-tab-scorecard').style.display   = 'none';
  document.querySelectorAll('.hd-tab-btn').forEach((btn, i) => {
    const isFirst = i === 0;
    btn.classList.toggle('active', isFirst);
    btn.style.borderBottomColor = isFirst ? 'var(--gold)' : 'transparent';
    btn.style.color             = isFirst ? 'var(--gold)' : 'var(--muted2)';
  });

  if (!state) {
    document.getElementById('hd-result').innerHTML      = '';
    document.getElementById('hd-leaderboard').innerHTML = '<div style="color:var(--muted);padding:1rem;">No data saved for this round.</div>';
    document.getElementById('hd-scorecard').innerHTML   = '';
    document.getElementById('hd-side-comps').innerHTML  = '';
    document.getElementById('hd-sc-mode-row').classList.add('hidden');
    document.getElementById('hd-sc-groups').classList.add('hidden');
  } else {
    const allStates = state.allGroupStates?.length ? state.allGroupStates : [state];
    const merged    = mergeGroupStates(allStates, state);
    const fmt       = merged.format;
    const summary   = getResultSummary(merged);

    // ── Result summary ───────────────────────────────────────────────
    document.getElementById('hd-result').innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1rem;">
        <div style="font-size:0.58rem;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted);margin-bottom:0.3rem;">
          ${fmtLabel(r.game_format)} · ${r.tee_name ?? ''} Tees · ${merged.log?.length ?? 0} holes
        </div>
        <div style="font-family:'Barlow Condensed',sans-serif;font-size:1.4rem;font-weight:700;color:var(--gold);">
          ${summary.winner ?? 'Completed'}
        </div>
        ${summary.summary ? `<div style="font-size:0.72rem;color:var(--muted);margin-top:2px;">${summary.summary}</div>` : ''}
      </div>`;

    // ── LD/NTP side competition results ─────────────────────────────
    const ldData  = buildSideCompResults(allStates, 'ld');
    const ntpData = buildSideCompResults(allStates, 'ntp');
    const sideEl  = document.getElementById('hd-side-comps');
    if (ldData.holes.length || ntpData.holes.length) {
      const rowsFor = (data, kind) => data.holes.map(holeNum => {
        const res = data.byHole[holeNum];
        const icon = kind === 'ld' ? '🏌️' : '🎯';
        return `<div style="display:flex;align-items:center;justify-content:space-between;
                            padding:0.55rem 0.85rem;border-bottom:1px solid var(--border);">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:1.1rem;">${icon}</span>
            <span style="font-family:'Barlow Condensed',sans-serif;font-weight:700;
                         font-size:0.95rem;color:var(--muted2);">Hole ${holeNum}</span>
          </div>
          ${res
            ? `<div style="text-align:right;">
                <span style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.05rem;">${res.playerName}</span>
                <span style="color:${kind === 'ld' ? 'var(--gold)' : 'var(--blue)'};font-weight:800;margin-left:6px;">
                  ${kind === 'ld' ? `${res.yards} yds` : `${res.cm} cm`}
                </span>
              </div>`
            : `<span style="color:var(--muted);font-size:0.85rem;">Not marked</span>`}
        </div>`;
      }).join('');

      sideEl.innerHTML = `
        <div style="background:var(--surface2);border:1px solid var(--border);
                    border-radius:var(--radius-sm);overflow:hidden;margin-bottom:0.5rem;">
          ${ldData.holes.length ? `
            <div style="padding:0.5rem 0.85rem;background:rgba(212,168,67,0.08);
                        font-size:0.75rem;font-weight:800;letter-spacing:0.08em;
                        text-transform:uppercase;color:var(--gold);">Longest Drive</div>
            ${rowsFor(ldData, 'ld')}` : ''}
          ${ntpData.holes.length ? `
            <div style="padding:0.5rem 0.85rem;background:rgba(91,163,217,0.08);
                        font-size:0.75rem;font-weight:800;letter-spacing:0.08em;
                        text-transform:uppercase;color:var(--blue);">Nearest the Pin</div>
            ${rowsFor(ntpData, 'ntp')}` : ''}
        </div>`;
    } else {
      sideEl.innerHTML = '';
    }

    // ── Leaderboard ──────────────────────────────────────────────────
    const lbEl    = document.getElementById('hd-leaderboard');
    const isStroke  = fmt === 'stroke';
    const isTexas   = fmt === 'texas';
    const isMatch   = ['match','betterball','csm','foursomes','greensomes'].includes(fmt);
    const isSkins   = fmt === 'skins';
    const isItc     = fmt === 'itc';
    const isBest2   = fmt === 'best2';
    const texasSbFmt = isTexas && (state.texasScoringFmt ?? 'stableford') === 'stableford';
    const scoreLabel = isTexas  ? (texasSbFmt ? 'Pts'   : 'Gross')
                     : isStroke ? 'Net'
                     : isSkins  ? 'Skins'
                     : 'Pts';

    const TEAM_PAIR_FORMATS = ['betterball','csm','foursomes','greensomes','best2','texas'];
    if (TEAM_PAIR_FORMATS.includes(fmt)) {
      // Team/pairs formats — one row per group
      const rows = allStates.filter(s => s?.names).map((s, i) => {
        const teamName  = s.teamName ?? `Team ${s.groupNumber ?? i + 1}`;
        const members   = s.names.join(', ');
        const holesPlayed = s.log?.length ?? 0;
        let score;
        if (isTexas)   score = texasSbFmt ? (s.texasPts ?? 0) : (s.grossTotal ?? 0);
        else if (isBest2) score = s.groupTotal ?? 0;
        else {
          const ms = s.matchScore ?? 0;
          const up = Math.abs(ms);
          score = ms === 0 ? 'All Sq' : (ms > 0 ? `${up} Up` : `${up} Down`);
        }
        return { rank: i + 1, label: teamName, sub: members, score, thru: holesPlayed, isLead: i === 0 };
      });
      // Sort numeric scores
      const numRows = rows.filter(r => typeof r.score === 'number');
      const strRows = rows.filter(r => typeof r.score !== 'number');
      numRows.sort((a, b) => (isTexas && !texasSbFmt) ? a.score - b.score : b.score - a.score);
      const sorted = [...numRows, ...strRows].map((r, i) => ({ ...r, rank: i + 1, isLead: i === 0 }));
      lbEl.innerHTML = buildLeaderboardTable(sorted, isMatch ? 'Result' : scoreLabel);
    } else {
      // Individual formats — per-player rows from merged state
      const rows = buildMultiGroupLeaderboard(allStates);
      if (!rows.length) {
        lbEl.innerHTML = '<div style="padding:1rem;color:var(--muted);">No scores recorded.</div>';
      } else {
        lbEl.innerHTML = buildLeaderboardTable(
          rows.map((row, i) => {
            let score;
            if (isStroke)    score = row.net ?? '--';
            else if (isMatch) score = row.pts != null ? (row.pts > 0 ? `${row.pts} Up` : row.pts < 0 ? `${Math.abs(row.pts)} Down` : 'All Sq') : 'All Sq';
            else              score = row.pts ?? '--';
            return { rank: i + 1, label: row.name, sub: null, score, thru: row.holesPlayed, isLead: i === 0 };
          }),
          scoreLabel
        );
      }
    }

    // ── Scorecard (vertical, swipeable groups) ───────────────────────
    const modes    = scorecardModesFor(fmt);
    const modeRow  = document.getElementById('hd-sc-mode-row');
    const groupsEl = document.getElementById('hd-sc-groups');

    let hdScMode  = modes[0];
    let hdScGroup = 0;

    const groups = [...allStates].sort((a, b) => (a.groupNumber ?? 0) - (b.groupNumber ?? 0));

    const renderHdScorecard = () => {
      const g     = groups[hdScGroup] ?? groups[0];
      const sc    = buildVerticalScorecard(g, hdScMode);
      document.getElementById('hd-scorecard').innerHTML = sc;
    };

    if (modes.length > 1) {
      modeRow.classList.remove('hidden');
      modeRow.querySelectorAll('.hd-sc-mode-btn').forEach(btn => {
        btn.onclick = () => {
          hdScMode = btn.dataset.mode;
          modeRow.querySelectorAll('.hd-sc-mode-btn').forEach(b => {
            const active = b.dataset.mode === hdScMode;
            b.classList.toggle('active', active);
            b.style.background   = active ? 'var(--gold)'    : 'var(--surface2)';
            b.style.color        = active ? '#000'            : 'var(--white)';
            b.style.borderColor  = active ? 'var(--gold)'    : 'var(--border)';
          });
          renderHdScorecard();
        };
        const active = btn.dataset.mode === hdScMode;
        btn.style.background  = active ? 'var(--gold)'  : 'var(--surface2)';
        btn.style.color       = active ? '#000'          : 'var(--white)';
        btn.style.borderColor = active ? 'var(--gold)'  : 'var(--border)';
        btn.style.border      = '2px solid';
        btn.style.borderRadius = 'var(--radius-sm)';
        btn.style.cursor      = 'pointer';
      });
    } else {
      modeRow.classList.add('hidden');
    }

    if (groups.length > 1) {
      groupsEl.classList.remove('hidden');
      groupsEl.style.display = 'flex';
      groupsEl.innerHTML = groups.map((g, i) => `
        <button class="hd-grp-btn${i === 0 ? ' active' : ''}" data-idx="${i}"
          style="padding:0.4rem 0.85rem;font-size:0.88rem;font-weight:800;border-radius:20px;
                 background:${i === 0 ? 'var(--gold)' : 'var(--surface2)'};
                 color:${i === 0 ? '#000' : 'var(--white)'};
                 border:2px solid ${i === 0 ? 'var(--gold)' : 'var(--border)'};cursor:pointer;">
          Group ${g.groupNumber ?? i + 1}
        </button>`).join('');
      groupsEl.querySelectorAll('.hd-grp-btn').forEach(btn => {
        btn.onclick = () => {
          hdScGroup = parseInt(btn.dataset.idx);
          groupsEl.querySelectorAll('.hd-grp-btn').forEach(b => {
            const active = parseInt(b.dataset.idx) === hdScGroup;
            b.style.background  = active ? 'var(--gold)'  : 'var(--surface2)';
            b.style.color       = active ? '#000'          : 'var(--white)';
            b.style.borderColor = active ? 'var(--gold)'  : 'var(--border)';
          });
          renderHdScorecard();
        };
      });
    } else {
      groupsEl.classList.add('hidden');
      groupsEl.style.display = 'none';
    }

    renderHdScorecard();
  }

  // ── Tab switching ─────────────────────────────────────────────────
  document.querySelectorAll('.hd-tab-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.hd-tab-btn').forEach(b => {
        const active = b === btn;
        b.classList.toggle('active', active);
        b.style.borderBottomColor = active ? 'var(--gold)' : 'transparent';
        b.style.color             = active ? 'var(--gold)' : 'var(--muted2)';
      });
      const targetId = btn.dataset.tab;
      ['hd-tab-leaderboard','hd-tab-scorecard'].forEach(id => {
        document.getElementById(id).style.display = id === targetId ? '' : 'none';
      });
    };
  });

  // ── Delete button ─────────────────────────────────────────────────
  const delBtn = document.getElementById('btn-delete-round');
  if (delBtn) {
    delBtn.disabled = false; delBtn.textContent = '🗑 Delete Round';
    delBtn.onclick = async () => {
      if (!confirm('Delete this round permanently? This cannot be undone.')) return;
      await showHistory();
      try {
        await roundDelete(r.id);
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

    // The organiser already created the shared round with every group's state
    // embedded in allGroupStates. Join that SAME round rather than creating a new one.
    if (!tround.round_id) { await onSignedIn(user); return; }

    const existingRound = await roundLoadById(tround.round_id);
    if (!existingRound) { await onSignedIn(user); return; }

    roundId   = existingRound.id;
    gameState = existingRound.game_state;

    if (!gameState?.allGroupStates?.length) {
      // Fallback: single-group round, no group switching needed
      gameState.allGroupStates = [gameState];
    }

    // Find my group within allGroupStates
    const myGroupIdx = gameState.allGroupStates.findIndex(gs => gs.groupNumber === groupNumber);
    if (myGroupIdx === -1) { await onSignedIn(user); return; }

    // Switch active gameState to my group, but keep allGroupStates intact
    const myGroupState = gameState.allGroupStates[myGroupIdx];
    gameState = { ...myGroupState, allGroupStates: gameState.allGroupStates };

    // Claim scorer for my group if unclaimed
    if (gameState.scorerProfileId === '__unclaimed__' || !gameState.scorerProfileId) {
      gameState.scorerProfileId = user.id;
      gameState.allGroupStates[myGroupIdx].scorerProfileId = user.id;
      await saveRoundState();
    }

    setup.scoring        = gameState.format;
    setup.courseId       = allCourses.find(c => c.name === gameState.courseName)?.id ?? null;
    setup.tournamentId   = activeTournament.id;
    setup.tournRoundNumber = tround.round_number;

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
    const active = tournaments.filter(t => t.status !== 'completed');

    if (!active.length) {
      list.innerHTML = '<div class="history-empty">No active tournaments — configure one above.</div>';
      return;
    }

    // Load rounds for each active tournament to show courses booked
    const withRounds = await Promise.all(active.map(async t => {
      const rounds = await tournamentRoundsLoad(t.id).catch(() => []);
      return { t, rounds };
    }));

    list.innerHTML = withRounds.map(({ t, rounds }) => {
      const courses = rounds.map(r => r.course_name).filter(Boolean);
      const coursesLabel = courses.length
        ? courses.join(', ')
        : 'No rounds booked yet';
      return `
        <button class="tourn-list-btn" data-tid="${t.id}">
          <div class="tourn-list-icon">🏆</div>
          <div class="tourn-list-body">
            <div class="tourn-list-name">${t.name}</div>
            <div class="tourn-list-courses">${coursesLabel}</div>
          </div>
          <div class="tourn-list-chevron">›</div>
        </button>`;
    }).join('');

    list.querySelectorAll('.tourn-list-btn').forEach(item => {
      item.addEventListener('click', () => showTournamentDetail(item.dataset.tid));
    });
  } catch (err) {
    list.innerHTML = `<div class="history-empty">${err.message}</div>`;
  }
}

document.getElementById('btn-tournament-history')?.addEventListener('click', () => showTournamentHistory());
document.getElementById('tournament-history-back')?.addEventListener('click', () => showTournaments());

async function showTournamentHistory() {
  showScreen('screen-tournament-history');
  const list = document.getElementById('tournament-history-list');
  list.innerHTML = '<div class="history-empty">Loading…</div>';
  try {
    const tournaments = await tournamentsLoad(currentUser.id);
    const completed = tournaments.filter(t => t.status === 'completed');

    if (!completed.length) {
      list.innerHTML = '<div class="history-empty">No completed tournaments yet.</div>';
      return;
    }

    // Load standings summary for each completed tournament
    const withStandings = await Promise.all(completed.map(async t => {
      const [players, rounds, scores] = await Promise.all([
        tournamentPlayersLoad(t.id).catch(() => []),
        tournamentRoundsLoad(t.id).catch(() => []),
        tournamentAllScoresLoad(t.id).catch(() => []),
      ]);
      const lastRound = [...rounds].filter(r => r.status === 'completed').pop();
      const format = lastRound?.format ?? t.format ?? 'stableford';
      const standings = buildStandings(players, rounds, scores, format, 'cumulative');
      return { t, standings, rounds };
    }));

    list.innerHTML = withStandings.map(({ t, standings, rounds }) => {
      const winner = standings[0]?.name ?? '--';
      const winnerScore = standings[0]?.total ?? '--';
      const courses = [...new Set(rounds.map(r => r.course_name).filter(Boolean))];
      return `
        <button class="tourn-list-btn" data-tid="${t.id}">
          <div class="tourn-list-icon">🏅</div>
          <div class="tourn-list-body">
            <div class="tourn-list-name">${t.name}</div>
            <div class="tourn-list-courses">${courses.join(', ') || '--'}</div>
            <div class="tourn-list-winner">🥇 ${winner} — ${winnerScore}</div>
          </div>
          <div class="tourn-list-chevron">›</div>
        </button>`;
    }).join('');

    list.querySelectorAll('.tourn-list-btn').forEach(item => {
      item.addEventListener('click', () => showTournamentDetail(item.dataset.tid));
    });
  } catch (err) {
    list.innerHTML = `<div class="history-empty">${err.message}</div>`;
  }
}

// ----------------------------------------------------------------
// TOURNAMENT SETUP -- STEP 1: DETAILS (simplified)
// ----------------------------------------------------------------

function showTournamentSetup() {
  document.getElementById('tourn-name').value       = '';
  document.getElementById('tourn-num-rounds').value = '3';
  document.getElementById('tourn-hcp-mode').value   = 'fixed';
  updateRoundsToggle(false);
  updateGameTypeButtons('individual');
  tournSetupPlayers = [];
  try { localStorage.removeItem('lb-tourn-setup-id'); } catch {}
  activeTournament = null;
  showScreen('screen-tournament-setup');
}

function updateGameTypeButtons(mode) {
  document.getElementById('tourn-game-type').value = mode;
  document.querySelectorAll('.tourn-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
}

document.getElementById('btn-mode-individual')?.addEventListener('click', () => updateGameTypeButtons('individual'));
document.getElementById('btn-mode-team-fixed')?.addEventListener('click', () => updateGameTypeButtons('team_fixed'));
document.getElementById('btn-mode-team-individual')?.addEventListener('click', () => updateGameTypeButtons('team_individual'));

function updateRoundsToggle(isOpenEnded) {
  const cbx      = document.getElementById('tourn-open-ended');
  const sel      = document.getElementById('tourn-num-rounds');
  const btnFixed = document.getElementById('btn-fixed-rounds');
  const btnOpen  = document.getElementById('btn-open-ended');
  if (cbx) cbx.checked = isOpenEnded;
  if (sel) sel.style.display = isOpenEnded ? 'none' : '';
  btnFixed?.classList.toggle('active', !isOpenEnded);
  btnOpen?.classList.toggle('active',  isOpenEnded);
}

document.getElementById('btn-fixed-rounds')?.addEventListener('click', () => updateRoundsToggle(false));
document.getElementById('btn-open-ended')?.addEventListener('click',   () => updateRoundsToggle(true));
document.getElementById('tournament-setup-back')?.addEventListener('click', () => showHome());

document.getElementById('btn-tourn-setup-next')?.addEventListener('click', async () => {
  const name = document.getElementById('tourn-name').value.trim();
  if (!name) { alert('Please enter a tournament name.'); return; }

  const btn = document.getElementById('btn-tourn-setup-next');
  btn.disabled = true; btn.textContent = 'Creating…';

  try {
    const isOpenEnded = document.getElementById('tourn-open-ended').checked;
    const numRounds   = isOpenEnded ? null : parseInt(document.getElementById('tourn-num-rounds').value);
    const hcpMode     = document.getElementById('tourn-hcp-mode').value;
    const gameType    = document.getElementById('tourn-game-type').value; // individual | team_fixed | team_individual

    // Create tournament — format will be set per round
    const tourn = await tournamentCreate({
      organiserId: currentUser.id, name,
      format: 'stableford', // placeholder, overridden per round
      numRounds, hcpMode, scoringMode: 'cumulative',
      scoringModeTeam: gameType,
    });

    activeTournament = tourn;
    try { localStorage.setItem('lb-tourn-setup-id', tourn.id); } catch {}

    // Seed with current user
    const myName = currentProfile
      ? `${currentProfile.first_name ?? ''} ${currentProfile.last_name ?? ''}`.trim() : '';
    tournSetupPlayers = [];
    if (myName) {
      const saved = await tournamentPlayersAdd(tourn.id, [{
        name: myName, profileId: currentUser.id, startingHcp: currentProfile?.hcp ?? 0,
      }]);
      tournSetupPlayers = [{ _tournId: saved[0].id, name: myName, hcp: currentProfile?.hcp ?? 0, profileId: currentUser.id }];
    }

    renderTournamentPlayerList();
    showScreen('screen-tournament-format');
  } catch (err) {
    alert('Could not create tournament: ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'NEXT: ADD PLAYERS →';
  }
});

// ── Co-organiser ────────────────────────────────────────────────
document.getElementById('btn-td-co-organiser')?.addEventListener('click', () => {
  const current = activeTournament?.co_organiser_id;
  const currentEl = document.getElementById('co-organiser-current');
  const removeBtn = document.getElementById('btn-co-organiser-remove');

  if (current) {
    const coOrg = activeTournPlayers.find(p => p.profile_id === current);
    if (currentEl) currentEl.textContent = `Current co-organiser: ${coOrg?.name ?? 'Unknown'}`;
    if (removeBtn) removeBtn.style.display = '';
  } else {
    if (currentEl) currentEl.textContent = 'No co-organiser set.';
    if (removeBtn) removeBtn.style.display = 'none';
  }
  document.getElementById('modal-co-organiser').classList.add('open');
});
document.getElementById('co-organiser-close')?.addEventListener('click', () => {
  document.getElementById('modal-co-organiser').classList.remove('open');
});
document.getElementById('btn-co-organiser-pick')?.addEventListener('click', () => {
  openFriendPicker(-1, async (friend) => {
    if (!friend.profileId) {
      alert('This friend needs a Leaderboard account to be a co-organiser.');
      return;
    }
    try {
      await tournamentUpdate(activeTournament.id, { co_organiser_id: friend.profileId });
      activeTournament.co_organiser_id = friend.profileId;
      document.getElementById('modal-co-organiser').classList.remove('open');
      alert(`${friend.name} is now a co-organiser.`);
    } catch (err) { alert('Could not set co-organiser: ' + err.message); }
  });
});
document.getElementById('btn-co-organiser-remove')?.addEventListener('click', async () => {
  try {
    await tournamentUpdate(activeTournament.id, { co_organiser_id: null });
    activeTournament.co_organiser_id = null;
    document.getElementById('modal-co-organiser').classList.remove('open');
  } catch (err) { alert('Could not remove co-organiser: ' + err.message); }
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
// ── Screen 2: Add Players ────────────────────────────────────────

function renderTournamentPlayerList() {
  const listEl  = document.getElementById('tourn-player-list');
  const countEl = document.getElementById('tourn-player-count-label');
  if (!listEl) return;
  const count = tournSetupPlayers.length;
  if (countEl) countEl.textContent = `${count} player${count !== 1 ? 's' : ''} added`;

  if (!count) {
    listEl.innerHTML = '<div style="padding:1rem;text-align:center;color:var(--muted);font-size:0.95rem;">No players yet.</div>';
    return;
  }
  listEl.innerHTML = tournSetupPlayers.map((p, i) => `
    <div style="display:flex;align-items:center;gap:0.75rem;padding:0.9rem 1rem;
                background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);">
      <span class="dot" style="background:${pHex(i % 8)};flex-shrink:0;"></span>
      <div style="flex:1;">
        <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.25rem;">${p.name}</div>
        <div style="font-size:0.85rem;font-weight:700;color:var(--muted2);">HCP ${fmtHandicap(p.hcp)}</div>
      </div>
      ${i > 0 ? `<button class="btn btn-ghost" data-remove="${i}"
        style="font-size:0.85rem;color:var(--red);border-color:var(--red-border);padding:0.3rem 0.6rem;">✕</button>` : ''}
    </div>`).join('');

  listEl.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.remove);
      const p = tournSetupPlayers[idx];
      // Remove from DB if saved
      if (p._tournId && activeTournament?.id) {
        try { await tournamentPlayerUpdate(p._tournId, { excluded: true }); } catch {}
      }
      tournSetupPlayers.splice(idx, 1);
      renderTournamentPlayerList();
    });
  });
}

// Open add-player modal
document.getElementById('btn-tourn-add-player')?.addEventListener('click', () => {
  document.getElementById('tourn-manual-name').value = '';
  document.getElementById('tourn-manual-hcp').value  = '';
  document.getElementById('modal-add-tourn-player').classList.add('open');
});
document.getElementById('modal-add-tourn-player-close')?.addEventListener('click', () => {
  document.getElementById('modal-add-tourn-player').classList.remove('open');
});

// Add from friends
document.getElementById('btn-tourn-add-from-friends')?.addEventListener('click', () => {
  document.getElementById('modal-add-tourn-player').classList.remove('open');
  openFriendPicker(-1, async (friend) => {
    await addTournamentPlayer(friend.name, friend.hcp ?? 0, friend.profileId ?? null);
  }, tournSetupPlayers.map(p => p.profileId).filter(Boolean));
});

// Invite to Leaderboard
document.getElementById('btn-tourn-invite')?.addEventListener('click', () => {
  document.getElementById('modal-add-tourn-player').classList.remove('open');
  document.getElementById('modal-invite').classList.add('open');
});

// Confirm manual player
document.getElementById('btn-tourn-confirm-player')?.addEventListener('click', async () => {
  const name = document.getElementById('tourn-manual-name').value.trim();
  const hcp  = parseFloat(document.getElementById('tourn-manual-hcp').value) || 0;
  if (!name) { alert('Please enter a player name.'); return; }
  await addTournamentPlayer(name, hcp, null);
  document.getElementById('modal-add-tourn-player').classList.remove('open');
});

async function addTournamentPlayer(name, hcp, profileId) {
  // Autosave immediately to DB
  let tournId = null;
  try { tournId = activeTournament?.id ?? null; } catch {}

  const player = { name, hcp, profileId: profileId ?? null, _tournId: null };
  if (tournId) {
    try {
      const saved = await tournamentPlayersAdd(tournId, [{ name, profileId, startingHcp: hcp }]);
      player._tournId = saved[0]?.id ?? null;
    } catch (err) { console.error('addTournamentPlayer save error', err); }
  }
  tournSetupPlayers.push(player);
  renderTournamentPlayerList();
}

document.getElementById('tournament-format-back')?.addEventListener('click', () => {
  // Going back: delete the draft tournament to avoid orphans
  if (activeTournament?.id) {
    tournamentDelete(activeTournament.id).catch(() => {});
    activeTournament = null;
    try { localStorage.removeItem('lb-tourn-setup-id'); } catch {}
  }
  tournSetupPlayers = [];
  showScreen('screen-tournament-setup');
});

document.getElementById('btn-tourn-format-next')?.addEventListener('click', async () => {
  if (tournSetupPlayers.filter(p => p.name).length < 2) {
    alert('Add at least 2 players to continue.');
    return;
  }
  // Tournament and players already saved — go straight to tournament detail
  try { localStorage.removeItem('lb-tourn-setup-id'); } catch {}
  await showTournamentDetail(activeTournament.id);
});

// ── Screen 3: Round 1 Setup ──────────────────────────────────────


function renderGroupAssignmentCards() {
  // tournSetupNumGroups is auto-computed (aim for 4 per group), user can adjust with +/-
  const namedPlayers  = tournSetupPlayers.filter(p => p.name);
  const numPlayers    = namedPlayers.length;
  const container     = document.getElementById('tourn-group-cards');
  const suggestion    = document.getElementById('tourn-group-suggestion');
  if (!container) return;

  // Render +/- stepper in suggestion area
  if (suggestion) {
    const perGroup = Math.ceil(numPlayers / tournSetupNumGroups);
    suggestion.innerHTML = `
      <div style="display:flex;align-items:center;gap:0.75rem;">
        <button id="tourn-grp-dec" class="btn btn-ghost"
          style="padding:0.25rem 0.75rem;font-size:1.2rem;font-weight:800;" ${tournSetupNumGroups <= 1 ? 'disabled' : ''}>−</button>
        <span style="font-size:1rem;font-weight:800;flex:1;text-align:center;">
          ${tournSetupNumGroups} group${tournSetupNumGroups > 1 ? 's' : ''} of ~${perGroup}
        </span>
        <button id="tourn-grp-inc" class="btn btn-ghost"
          style="padding:0.25rem 0.75rem;font-size:1.2rem;font-weight:800;" ${tournSetupNumGroups >= numPlayers ? 'disabled' : ''}>＋</button>
      </div>`;
    document.getElementById('tourn-grp-dec')?.addEventListener('click', () => {
      if (tournSetupNumGroups > 1) { tournSetupNumGroups--; renderGroupAssignmentCards(); }
    });
    document.getElementById('tourn-grp-inc')?.addEventListener('click', () => {
      if (tournSetupNumGroups < numPlayers) { tournSetupNumGroups++; renderGroupAssignmentCards(); }
    });
  }

  // First call: assign round-robin. Subsequent calls: respect existing groupIndex.
  const hasAssignments = namedPlayers.some(p => p.groupIndex != null);
  if (!hasAssignments) {
    const slotsPerGroup = Math.max(1, Math.ceil(namedPlayers.length / tournSetupNumGroups));
    namedPlayers.forEach((p, i) => { p.groupIndex = Math.min(Math.floor(i / slotsPerGroup), tournSetupNumGroups - 1); });
  } else {
    // Clamp any groupIndex that exceeds new group count
    namedPlayers.forEach(p => { if ((p.groupIndex ?? 0) >= tournSetupNumGroups) p.groupIndex = tournSetupNumGroups - 1; });
  }

  // Build group arrays
  const groups = Array.from({ length: tournSetupNumGroups }, (_, g) =>
    namedPlayers.filter(p => (p.groupIndex ?? 0) === g));

  // Balance warning
  const sizes = groups.map(g => g.length);
  const max = Math.max(...sizes), min = Math.min(...sizes);
  let warning = '';
  if (tournSetupNumGroups > 1 && max - min >= 2) {
    // Suggest balanced split
    const total = namedPlayers.length;
    const ideal = total / tournSetupNumGroups;
    const bigGroups = sizes.filter(s => s === max).length;
    const smallGroups = sizes.filter(s => s === min).length;
    warning = `<div style="background:rgba(212,168,67,0.12);border:1px solid var(--gold-border);
      border-radius:var(--radius-sm);padding:0.65rem 0.85rem;margin-bottom:0.75rem;
      font-size:0.95rem;font-weight:700;color:var(--gold);">
      ⚠️ Groups are uneven — ${bigGroups} group${bigGroups>1?'s':''} of ${max} and ${smallGroups} of ${min}.
      Consider ${Math.ceil(ideal)} or ${Math.floor(ideal)} per group.
    </div>`;
  }

  container.innerHTML = warning;

  let dragSrc = null; // { playerName }

  groups.forEach((groupPlayers, g) => {
    const overLimit = groupPlayers.length > 4;
    const card = document.createElement('div');
    card.className = 'card mb-sm tgroup-drop-zone';
    card.dataset.group = g;
    card.style.cssText = overLimit
      ? 'border-color:var(--red-border);'
      : 'transition:background 0.15s;';

    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;">
        <div class="card-title" style="margin:0;">Group ${g + 1}</div>
        <div style="font-size:0.85rem;font-weight:700;color:${overLimit ? 'var(--red)' : 'var(--muted2)'};">
          ${groupPlayers.length} player${groupPlayers.length !== 1 ? 's' : ''}${overLimit ? ' — max 4' : ''}
        </div>
      </div>
      <div class="tgroup-player-list" data-group="${g}">
        ${groupPlayers.length === 0
          ? `<div class="tgroup-empty" style="padding:0.75rem;text-align:center;
              color:var(--muted);font-size:0.9rem;border:1.5px dashed var(--border);
              border-radius:var(--radius-sm);">Drop a player here</div>`
          : groupPlayers.map(p => {
              const pi = namedPlayers.indexOf(p);
              return `<div class="tgroup-player-row" draggable="true" data-name="${p.name}"
                style="display:flex;align-items:center;gap:0.75rem;padding:0.65rem 0.5rem;
                       border-bottom:1px solid var(--border);cursor:grab;user-select:none;
                       border-radius:var(--radius-sm);transition:background 0.1s;">
                <span style="font-size:1.1rem;color:var(--muted);flex-shrink:0;">⣿</span>
                <span class="dot" style="background:${pHex(pi % 8)};flex-shrink:0;"></span>
                <div style="flex:1;">
                  <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:1.1rem;">${p.name}</div>
                  <div style="font-size:0.82rem;color:var(--muted2);">HCP ${fmtHandicap(p.hcp)}</div>
                </div>
              </div>`;
            }).join('')}
      </div>`;

    container.appendChild(card);
  });

  // ── Drag onto player = swap, onto empty = move ──
  container.querySelectorAll('.tgroup-drop-zone').forEach(zone => {
    const empty = zone.querySelector('.tgroup-empty');
    if (empty) empty.classList.add('tgroup-empty-zone');
  });
  const tg = makeSwapDrop(
    namedPlayers,
    p => p.groupIndex, (p,v) => { p.groupIndex = v; },
    renderGroupAssignmentCards
  );
  tg.wireDrag(container, '.tgroup-player-row', '.tgroup-empty-zone');

  // ── Validation ──────────────────────────────────────────────────
  validateGroupSizes(groups);
}

function validateGroupSizes(groups) {
  const overLimit = groups.some(g => g.length > 4);
  const empty     = groups.some(g => g.length === 0);
  const btnNext   = document.getElementById('btn-tourn-players-next');
  const btnLater  = document.getElementById('btn-tourn-save-later');
  if (!btnNext) return;

  if (overLimit) {
    btnNext.disabled = true;
    btnNext.style.opacity = '0.5';
    btnNext.title = 'Fix groups with more than 4 players before continuing.';
    if (btnLater) { btnLater.disabled = true; btnLater.style.opacity = '0.5'; }
  } else {
    btnNext.disabled = false;
    btnNext.style.opacity = '';
    btnNext.title = '';
    if (btnLater) { btnLater.disabled = false; btnLater.style.opacity = ''; }
  }
}

// ── Step 3: Players per Group ────────────────────────────────────
let tournSetupPlayers = []; // flat list [{name, hcp, profileId, groupIndex}]
let tournSetupNumGroups = 1;


document.getElementById('tournament-players-back')?.addEventListener('click', () =>
  showScreen('screen-tournament-format'));

// Shared: flush inputs, then either create tournament (round 1) or start next round (round 2+)
// startNow=true → tee off immediately; false → save and go to tournament detail

// Perform the actual tee-off for a round
async function _teeOffRound(tournId, courseId, teeName, date) {
  if (!courseId) { alert('Please select a course.'); return; }
  const course = allCourses.find(c => c.id === courseId);
  const tee    = course?.tees?.find(t => t.name === teeName);
  if (!course || !tee) { alert('Please select a tee.'); return; }

  const btn = document.getElementById('btn-tee-off');
  if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }

  try {
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

    if (!tournGroups?.length) {
      throw new Error('No groups were set up for this round. Please go back and arrange players into groups.');
    }

    const si  = tee.si;
    const par = tee.par;

    // Use format chosen by organiser in format picker (setup.scoring)
    const roundFormat = setup.scoring ?? activeTournament.format ?? 'stableford';

    // ── Build a gameState for EVERY group (matches single-game teeOff) ──
    const groupStates = [];
    for (let g = 0; g < tournGroups.length; g++) {
      const tg = tournGroups[g];
      const groupPlayers = tg.players
        .map(pid => activeTournPlayers.find(p => p.id === pid))
        .filter(Boolean);

      if (!groupPlayers.length) continue; // skip empty groups defensively

      const gNames  = groupPlayers.map(p => p.name);
      const gHcpArr = groupPlayers.map(p => p.current_hcp ?? 0);
      const gHcpObj = calcHandicaps(gHcpArr, 100);

      const gs = buildInitialState({
        format:           roundFormat,
        names:            gNames,
        handicapIndexes:  gHcpArr,
        playingHandicaps: gHcpObj.map(h => h.playingHandicap),
        matchHandicaps:   gHcpObj.map(h => h.matchHandicap),
        allowancePct:     100,
        si, par, numHoles: 18, holeOffset: 0,
        courseName: course.name, teeName,
        groupNumber:  tg.groupNumber,
        totalGroups:  tournGroups.length,
        longestDriveHoles: setup.ldEnabled  ? setup.ldHoles  : [],
        nearestPinHoles:   setup.ntpEnabled ? setup.ntpHoles : [],
      });

      // Texas Scramble: compute team handicap
      if (roundFormat === 'texas') {
        gs.teamHcp         = texasTeamHandicap(gHcpArr, setup.texasMode ?? 'average', 100);
        gs.texasMode       = setup.texasMode ?? 'average';
        gs.texasScoringFmt = setup.texasScoringFmt ?? 'stableford';
        gs.grossTotal      = 0;
        gs.texasPts        = 0;
        gs.driverUsage     = { par3: [], par4: [], par5: [] };
      }

      // Team name: use the name set on the review screen, falling back to a generic label
      gs.teamName = tg.teamName?.trim() || defaultTeamName(gNames) || `Team ${tg.groupNumber}`;

      gs.tournamentId      = tournId;
      gs.tournamentRoundId = troundRecord.id;
      gs.groupNumber        = tg.groupNumber;
      gs.organiserId         = currentUser.id;
      gs.playerProfileIds = groupPlayers.map(p => p.profile_id ?? null).filter(Boolean);
      gs.scorerProfileId  = '__unclaimed__';

      groupStates.push(gs);
    }

    if (!groupStates.length) {
      throw new Error('Could not build any groups for this round. Please check the player list and try again.');
    }

    // Persist team_name on tournament_players so the next round can pre-fill
    // fixed teams correctly even if players are re-fetched fresh.
    if (activeTournament.scoring_mode_team === 'team_fixed') {
      for (const gs of groupStates) {
        const memberIds = gs.playerProfileIds?.length
          ? activeTournPlayers.filter(p => gs.names.includes(p.name)).map(p => p.id)
          : [];
        for (const pid of memberIds) {
          const tp = activeTournPlayers.find(p => p.id === pid);
          if (tp && tp.team_name !== gs.teamName) {
            await tournamentPlayerUpdate(pid, { team_name: gs.teamName }).catch(() => {});
            tp.team_name = gs.teamName;
          }
        }
      }
    }

    // Find the organiser's own group — fall back to group 0
    const myTournPlayer = activeTournPlayers.find(p => p.profile_id === currentUser.id);
    const myGroupIdx = myTournPlayer
      ? groupStates.findIndex(gs => gs.playerProfileIds?.includes(currentUser.id))
      : -1;
    const activeIdx = myGroupIdx >= 0 ? myGroupIdx : 0;

    gameState = groupStates[activeIdx];
    gameState.allGroupStates = groupStates;
    gameState.organiserId     = currentUser.id;
    gameState.scorerProfileId = currentUser.id; // organiser scores their own group by default

    setup.scoring  = roundFormat;
    setup.courseId = courseId;
    setup.teeIdx   = course.tees.findIndex(t => t.name === teeName);
    setup.holes    = 18;
    setup.hcpPct   = 100;
    setup.numGroups = groupStates.length;

    try { localStorage.setItem(`lb-last-tee-${courseId}`, teeName); } catch {}
    const { allGroupStates, ...stateToSave } = gameState;
    // Include group states so a joining scorer can find their own group
    if (allGroupStates?.length > 1) {
      stateToSave.allGroupStates = allGroupStates.map(gs => {
        const { allGroupStates: _, ...stripped } = gs;
        return stripped;
      });
    }
    roundId = await roundCreate({
      organiserId:  currentUser.id,
      courseName:   course.name,
      teeName,
      gameFormat:   roundFormat,
      hcpAllowance: 100,
      si, par, numHoles: 18, holeOffset: 0,
      numGroups:    groupStates.length,
      playerNames:  gameState.names,
      gameState:    stateToSave,
    });

    await tournamentRoundUpdate(troundRecord.id, { round_id: roundId, format: roundFormat });
    // Update tournament's stored format to match last played round (for leaderboard display)
    if (activeTournament.format !== roundFormat) {
      await tournamentUpdate(activeTournament.id, { format: roundFormat }).catch(() => {});
      activeTournament.format = roundFormat;
    }
    subscribeToRound(roundId);

    // Auto-send invites to all players in OTHER groups who have a Leaderboard account
    const myGroupNumber = gameState.groupNumber;
    const myName = currentProfile
      ? `${currentProfile.first_name ?? ''} ${currentProfile.last_name ?? ''}`.trim()
      : 'Tournament organiser';

    for (const tg of tournGroups.filter(g => g.groupNumber !== myGroupNumber)) {
      for (const pid of tg.players) {
        const player = activeTournPlayers.find(p => p.id === pid);
        if (!player?.profile_id || player.profile_id === currentUser.id) continue;
        try {
          await smsInviteCreate({
            roundId,
            inviterId:          currentUser.id,
            name:               myName,
            mobile:             null,
            recipientProfileId: player.profile_id,
            tournamentRoundId:  troundRecord.id,
            groupNumber:        tg.groupNumber,
          });
        } catch (e) { console.error('[invite] tournament auto-invite failed for', player.name, e); }
      }
    }

    enterGameScreen();
  } catch (err) {
    console.error('[_teeOffRound] failed:', err);
    alert('Could not start the round: ' + (err.message || 'Unknown error. Please try again.'));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⛳ TEE OFF →'; }
  }
}


// Shared tournament+player creation helper
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

  const completedRounds = activeTournRounds.filter(r => r.status === 'completed');
  const lastRound       = completedRounds[completedRounds.length - 1];
  const roundNum        = lastRound?.round_number ?? 1;
  const totalRounds     = activeTournament.num_rounds;
  const isComplete      = totalRounds ? completedRounds.length >= totalRounds : false;

  document.getElementById('trc-title').textContent = activeTournament.name;
  document.getElementById('trc-round-label').textContent = totalRounds
    ? `Round ${roundNum} of ${totalRounds} — Complete`
    : `Round ${roundNum} — Complete`;

  // Round result summary
  if (lastRound) {
    const lastScores = activeTournAllScores.filter(s => s.tournament_round_id === lastRound.id);
    const isStroke    = (lastRound.format ?? activeTournament.format) === 'stroke';
    const gameType    = activeTournament.scoring_mode_team ?? 'individual';

    if (gameType !== 'individual') {
      // Team mode — one line per team for this round
      const byTeam = {};
      lastScores.filter(s => !s.absent && s.team_name).forEach(s => {
        if (!byTeam[s.team_name]) byTeam[s.team_name] = { score: isStroke ? s.net_score : s.points, members: [] };
        const player = activeTournPlayers.find(p => p.id === s.tournament_player_id);
        if (player) byTeam[s.team_name].members.push(player.name);
      });
      const teamRows = Object.entries(byTeam).sort((a, b) =>
        isStroke ? a[1].score - b[1].score : b[1].score - a[1].score
      );
      const resultLines = teamRows.map(([teamName, info], i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
        const score = isStroke ? `${info.score} net` : `${info.score} pts`;
        return `<div style="padding:0.4rem 0;border-bottom:1px solid var(--border);">
          <div style="display:flex;justify-content:space-between;font-size:0.95rem;font-weight:700;">
            <span>${medal} ${teamName}</span>
            <span style="color:var(--gold);font-weight:700;">${score}</span>
          </div>
          <div style="font-size:0.78rem;color:var(--muted2);">${info.members.join(', ')}</div>
        </div>`;
      }).join('');
      document.getElementById('trc-round-result').innerHTML = resultLines ||
        '<div style="color:var(--muted);">No scores recorded.</div>';
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
  if (!el) return;

  const lastRound = [...activeTournRounds].filter(r => r.status === 'completed').pop();
  const format    = lastRound?.format ?? activeTournament.format ?? 'stableford';
  const isStroke  = format === 'stroke';
  const gameType  = activeTournament.scoring_mode_team ?? 'individual';
  const colLabel  = isStroke ? 'Net' : 'Pts';

  let rows = [];
  if (gameType === 'team_fixed') {
    const standings = buildTeamStandings(activeTournPlayers, activeTournRounds, activeTournAllScores, format, 'cumulative');
    rows = standings.map((row, idx) => ({
      rank: idx + 1, label: row.name, sub: row.memberNames?.join(', ') ?? '',
      score: row.total ?? '--', thru: row.roundsPlayed, isLead: idx === 0,
    }));
  } else if (gameType === 'team_individual') {
    const standings = buildIndividualFromTeamStandings(activeTournPlayers, activeTournRounds, activeTournAllScores, format, 'cumulative');
    rows = standings.map((row, idx) => ({
      rank: idx + 1, label: row.name, sub: null,
      score: row.total ?? '--', thru: row.roundsPlayed, isLead: idx === 0,
    }));
  } else {
    const standings = buildStandings(activeTournPlayers, activeTournRounds, activeTournAllScores, format, 'cumulative');
    rows = standings.map((row, idx) => ({
      rank: idx + 1, label: row.name, sub: null,
      score: row.total ?? '--', thru: row.roundsPlayed, isLead: idx === 0,
    }));
  }

  el.innerHTML = rows.length
    ? buildLeaderboardTable(rows, colLabel)
    : '<div style="color:var(--muted);font-size:0.9rem;padding:0.75rem 0;">No rounds completed yet.</div>';
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
    activeTournament     = await tournamentLoadById(tournamentId);
    activeTournPlayers   = await tournamentPlayersLoad(tournamentId);
    activeTournRounds    = await tournamentRoundsLoad(tournamentId);
    activeTournAllScores = await tournamentAllScoresLoad(tournamentId);
  } catch (err) {
    alert('Could not load tournament: ' + err.message); return;
  }

  document.getElementById('td-tournament-name').textContent = activeTournament.name;

  const metaEl = document.getElementById('td-meta');
  if (metaEl) {
    const roundsLabel = activeTournament.num_rounds ? `${activeTournament.num_rounds} rounds` : 'Open-ended';
    const hcpLabel    = { fixed: 'Fixed HCP', adjustable: 'Adjustable HCP', auto: 'Auto HCP' }[activeTournament.hcp_mode] ?? '';
    const statusLabel = activeTournament.status === 'completed' ? ' · ✓ Complete' : '';
    metaEl.textContent = `${roundsLabel} · ${hcpLabel}${statusLabel}`;
  }

  renderTournamentStandings();
  renderTournamentRoundsList();

  const completedRounds = activeTournRounds.filter(r => r.status === 'completed').length;
  const nextRoundNum    = completedRounds + 1;
  const isCompleted     = activeTournament.status === 'completed';
  const isFixedComplete = activeTournament.num_rounds && completedRounds >= activeTournament.num_rounds;
  const hasActiveRound  = activeTournRounds.some(r => r.status === 'active');

  // Check if current user can manage tournament (organiser or co-organiser)
  const canManage = activeTournament.organiser_id === currentUser?.id
    || activeTournament.co_organiser_id === currentUser?.id;

  // Live round button
  const liveBtn = document.getElementById('btn-view-leaderboard');
  if (liveBtn) liveBtn.style.display = hasActiveRound ? '' : 'none';

  // Start round button
  const btn = document.getElementById('btn-start-next-round');
  if (isCompleted || isFixedComplete) {
    btn.textContent = '✓ Tournament Complete';
    btn.disabled    = true; btn.className = 'btn btn-outline';
  } else if (completedRounds === 0) {
    btn.textContent = '▶ Start Round 1 →';
    btn.disabled    = false; btn.className = 'btn btn-green';
  } else {
    btn.textContent = `⛳ SET UP ROUND ${nextRoundNum} →`;
    btn.disabled    = false; btn.className = 'btn btn-green';
  }
  btn.style.display = canManage ? '' : 'none';

  const finishBtn = document.getElementById('btn-finish-tournament');
  if (finishBtn) finishBtn.style.display = isCompleted || !canManage ? 'none' : '';

  const coOrgBtn = document.getElementById('btn-td-co-organiser');
  if (coOrgBtn) coOrgBtn.style.display = canManage ? '' : 'none';

  const resendBtn = document.getElementById('btn-td-resend-invites');
  if (resendBtn) resendBtn.classList.toggle('hidden', !(canManage && hasActiveRound));
}

function renderTournamentStandings() {
  const el          = document.getElementById('td-standings');
  const scoringMode = 'cumulative';

  // Use format from most recent completed round, or tournament's stored format
  const lastRound   = [...activeTournRounds].filter(r => r.status === 'completed').pop();
  const format      = lastRound?.format ?? activeTournament.format ?? 'stableford';
  const isStroke    = format === 'stroke';
  const isMatch     = ['betterball','csm','foursomes','greensomes'].includes(format);
  const gameType    = activeTournament.scoring_mode_team ?? 'individual';
  const completedRnds = activeTournRounds.filter(r => r.status === 'completed');

  const anchor = document.getElementById('td-standings-anchor');
  if (anchor) {
    const fmtLabelText = FORMAT_LABELS[format] ?? format;
    const modeNote = gameType === 'team_fixed' ? 'team totals' : gameType === 'team_individual' ? 'individual totals' : 'cumulative';
    anchor.innerHTML = `Standings <span style="font-size:0.7rem;color:var(--muted);font-weight:normal;
      margin-left:0.5rem;">${fmtLabelText} · ${modeNote}</span>`;
  }

  const colLabel = isStroke ? 'Net' : isMatch ? 'Pts' : 'Pts';

  let rows = [];
  if (gameType === 'team_fixed') {
    const standings = buildTeamStandings(activeTournPlayers, activeTournRounds, activeTournAllScores, format, scoringMode);
    rows = standings.map((row, idx) => ({
      rank:   idx + 1,
      label:  row.name,
      sub:    row.memberNames?.join(', ') ?? '',
      score:  row.total || '--',
      thru:   `${row.roundsPlayed}/${completedRnds.length}`,
      isLead: idx === 0,
    }));
  } else if (gameType === 'team_individual') {
    const standings = buildIndividualFromTeamStandings(activeTournPlayers, activeTournRounds, activeTournAllScores, format, scoringMode);
    rows = standings.map((row, idx) => ({
      rank:   idx + 1,
      label:  row.name,
      sub:    null,
      score:  row.total || '--',
      thru:   `${row.roundsPlayed}/${completedRnds.length}`,
      isLead: idx === 0,
    }));
  } else {
    const standings = buildStandings(activeTournPlayers, activeTournRounds, activeTournAllScores, format, scoringMode);
    rows = standings.map((row, idx) => ({
      rank:   idx + 1,
      label:  row.name,
      sub:    null,
      score:  row.total || '--',
      thru:   `${row.roundsPlayed}/${completedRnds.length}`,
      isLead: idx === 0,
    }));
  }

  if (!rows.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:0.9rem;padding:0.75rem 0;">No rounds completed yet.</div>';
    return;
  }

  el.innerHTML = buildLeaderboardTable(rows, colLabel);
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
    const displayState = mergeGroupStates(allStates, state);
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
document.getElementById('btn-view-leaderboard')?.addEventListener('click', async () => {
  const liveRound = activeTournRounds.find(r => r.status === 'active');
  if (!liveRound?.round_id) { alert('Could not find the live round to rejoin.'); return; }
  await resumeRound(liveRound.round_id);
});
document.getElementById('btn-start-next-round')?.addEventListener('click', async () => {
  await showTournamentRoundSetup();
});

async function showTournamentRoundSetup() {
  const completedRounds = activeTournRounds.filter(r => r.status === 'completed').length;
  const roundNumber     = completedRounds + 1;
  activeTournRound      = activeTournRounds.find(r => r.round_number === roundNumber) ?? null;

  // Handle adjustable handicaps before starting
  if (activeTournament.hcp_mode === 'adjustable' && roundNumber > 1) {
    await showAdjustableHcpModal();
    return; // modal will call continueRoundSetup after saving
  }

  // Auto HCP adjustment
  if (activeTournament.hcp_mode === 'auto' && completedRounds > 0) {
    await showAutoHcpAdjustment();
    // Auto-adjust applies and falls through
  }

  continueRoundSetup(roundNumber);
}

async function showAdjustableHcpModal() {
  const completedRounds = activeTournRounds.filter(r => r.status === 'completed').length;
  const roundNumber     = completedRounds + 1;

  renderTroundHcpRows();
  const modal = document.getElementById('tround-hcp-card') ?? document.createElement('div');

  // Show a modal with the HCP adjustment
  const adjModal = document.getElementById('modal-hcp-adjust');
  if (adjModal) {
    const rowsEl = document.getElementById('hcp-adjust-rows');
    // Reuse the HCP rows rendering into the modal
    if (rowsEl) rowsEl.innerHTML = document.getElementById('tround-hcp-rows')?.innerHTML ?? '';
    adjModal.classList.add('open');
    document.getElementById('btn-hcp-adjust-confirm').onclick = async () => {
      // Save adjustable handicaps
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
      adjModal.classList.remove('open');
      continueRoundSetup(roundNumber);
    };
  } else {
    continueRoundSetup(roundNumber);
  }
}

function continueRoundSetup(roundNumber) {
  // Pre-populate setup from tournament players, defaulting to previous round groups
  const players = activeTournPlayers.filter(p => !p.excluded);
  const isFixedTeamTourn = activeTournament.scoring_mode_team === 'team_fixed';

  // Try to get previous round group assignments from saved state
  const saved = restoreTroundSetup();
  const prevGroups = saved?.groups ?? [];

  setup.tournamentId   = activeTournament.id;
  setup.tournRoundNumber = roundNumber;
  setup.courseId       = null;
  setup.teeIdx         = 0;
  setup.holes          = 18;
  setup.hcpPct         = 100;
  setup.pairs          = [];
  setup.numGroups      = 1;

  if (isFixedTeamTourn) {
    // Group by persistent team_name — players keep their team regardless of
    // any positional shuffling in previous rounds' group data.
    const teamNames = [...new Set(players.map(p => p.team_name).filter(Boolean))];
    setup.players = players.map(p => {
      const teamIdx = p.team_name ? teamNames.indexOf(p.team_name) : -1;
      return {
        name:               p.name,
        hcpIndex:           p.current_hcp,
        courseHandicap:     p.current_hcp,
        groupNumber:        teamIdx >= 0 ? teamIdx + 1 : teamNames.length + 1,
        profileId:          p.profile_id ?? null,
        isScorer:           p.profile_id === currentUser?.id,
        tournamentPlayerId: p.id,
        teamName:           p.team_name ?? null,
      };
    });
  } else {
    // Pre-populate players with previous round's positional group assignments
    setup.players = players.map(p => {
      const gi = prevGroups.findIndex(g => g.players?.includes(p.id));
      return {
        name:               p.name,
        hcpIndex:           p.current_hcp,
        courseHandicap:     p.current_hcp,
        groupNumber:        gi >= 0 ? gi + 1 : 1,
        profileId:          p.profile_id ?? null,
        isScorer:           p.profile_id === currentUser?.id,
        tournamentPlayerId: p.id,
      };
    });
  }

  // Go through normal format picker → course → players (pre-populated) → groups → review → teeOff
  // Players screen will show pre-populated list, groups screen will show previous groups
  showFormatPicker('all');
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
// TOURNAMENT PUBLIC VIEW (via link ?tournament=id)
// ----------------------------------------------------------------
async function handleTournamentViewLink(tournamentId) {
  showScreen('screen-tournament-view');
  try {
    const tourn   = await tournamentLoadById(tournamentId);
    const players = await tournamentPlayersLoad(tournamentId);
    const rounds  = await tournamentRoundsLoad(tournamentId);
    const scores  = await tournamentAllScoresLoad(tournamentId);

    const lastRound = [...rounds].filter(r => r.status === 'completed').pop();
    const format     = lastRound?.format ?? tourn.format ?? 'stableford';
    const isStroke   = format === 'stroke';
    const gameType   = tourn.scoring_mode_team ?? 'individual';
    const completedRnds = rounds.filter(r => r.status === 'completed');

    document.getElementById('tview-title').textContent = tourn.name;
    document.getElementById('tview-meta').textContent  =
      `${fmtLabel(format)} · ${completedRnds.length} of ${tourn.num_rounds ?? '∞'} rounds completed`;

    const colLabel = isStroke ? 'Net' : 'Pts';

    let rows = [];
    if (gameType === 'team_fixed') {
      const standings = buildTeamStandings(players, rounds, scores, format, 'cumulative');
      rows = standings.map((row, idx) => ({
        rank: idx + 1, label: row.name, sub: row.memberNames?.join(', ') ?? '',
        score: row.total || '--', thru: `${row.roundsPlayed}/${completedRnds.length}`, isLead: idx === 0,
      }));
    } else if (gameType === 'team_individual') {
      const standings = buildIndividualFromTeamStandings(players, rounds, scores, format, 'cumulative');
      rows = standings.map((row, idx) => ({
        rank: idx + 1, label: row.name, sub: null,
        score: row.total || '--', thru: `${row.roundsPlayed}/${completedRnds.length}`, isLead: idx === 0,
      }));
    } else {
      const standings = buildStandings(players, rounds, scores, format, tourn.scoring_mode ?? 'cumulative');
      rows = standings.map((row, idx) => ({
        rank: idx + 1, label: row.name, sub: null,
        score: row.total || '--', thru: `${row.roundsPlayed}/${completedRnds.length}`, isLead: idx === 0,
      }));
    }

    document.getElementById('tview-standings').innerHTML = rows.length
      ? buildLeaderboardTable(rows, colLabel)
      : '<div class="history-empty">No rounds completed yet.</div>';
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

    const players  = activeTournPlayers.filter(p => !p.excluded);
    const allGroups = gameState.allGroupStates?.length ? gameState.allGroupStates : [gameState];

    // Build a name → tournamentPlayerId lookup
    const findTPlayerId = (name) => {
      const tp = activeTournPlayers.find(p => p.name === name);
      return tp?.id ?? null;
    };

    const MATCH_FORMATS = ['betterball','csm','foursomes','greensomes'];

    const scores = [];
    let playingIds = new Set();

    // Save scores from EVERY group in this round, not just the active group
    for (const gs of allGroups) {
      const format    = gs.format;
      const isStroke   = format === 'stroke';
      const isBest2    = format === 'best2';
      const isTexas    = format === 'texas';
      const isMatchFmt = MATCH_FORMATS.includes(format);
      const log        = gs.log ?? [];
      const teamName   = gs.teamName ?? null;

      // Determine the team-level score for THIS group, applied to every member.
      // Stableford/stroke/split6: per-player score (no team concept).
      // Best 2: gs.groupTotal already shared across the group.
      // Texas: team pts or gross, shared across the group.
      // Match-style pairs (betterball/csm/foursomes/greensomes): convert match
      // result into points so it accumulates sensibly across a tournament —
      // win = 2pts, halve = 1pt, loss = 0pts, per pair (not per group).
      let groupTeamScore = null;
      if (isBest2)  groupTeamScore = gs.groupTotal ?? 0;
      if (isTexas)  groupTeamScore = (gs.texasScoringFmt ?? 'stableford') === 'stableford'
        ? (gs.texasPts ?? 0) : (gs.grossTotal ?? 0);

      gs.names?.forEach((name, i) => {
        const tPlayerId = findTPlayerId(name);
        if (!tPlayerId) return;
        playingIds.add(tPlayerId);

        const gross = log.reduce((s, e) => s + (e.grosses?.[i] ?? 0), 0);
        let net = null, pts = null;

        if (isStroke)        net = gs.totals?.[i] ?? 0;
        else if (isBest2)     pts = groupTeamScore;
        else if (isTexas)     pts = groupTeamScore;
        else if (isMatchFmt) {
          // Pair A = indices 0,1 / Pair B = indices 2,3 within this group's gameState
          const ms = gs.matchScore ?? 0;
          const onPairA = i < 2;
          const won  = onPairA ? ms > 0 : ms < 0;
          const lost = onPairA ? ms < 0 : ms > 0;
          pts = ms === 0 ? 1 : (won ? 2 : (lost ? 0 : 1));
        } else {
          // stableford / split6 / itc / skins fallback — per-player points
          pts = gs.totals?.[i] ?? 0;
        }

        scores.push({
          tournamentPlayerId: tPlayerId,
          gross, net, points: pts,
          hcpUsed: gs.handicapIndexes?.[i] ?? 0,
          absent:  false,
          teamName,
        });
      });
    }

    // Handle absent players (those not in any group of this round)
    const absentScores = players
      .filter(p => !playingIds.has(p.id))
      .map(p => ({
        tournamentPlayerId: p.id,
        gross: null,
        net:   null,
        points: 0,
        hcpUsed: p.current_hcp,
        absent: true,
        teamName: null,
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
    longestDriveHoles: gameState.longestDriveHoles ?? [],
    nearestPinHoles:   gameState.nearestPinHoles   ?? [],
  });
  // Rebuild wipes results since they're independent of score replay — restore them
  rebuiltState.ldResults  = gameState.ldResults  ?? {};
  rebuiltState.ntpResults = gameState.ntpResults ?? {};

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
