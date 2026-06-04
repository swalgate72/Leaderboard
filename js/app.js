// ================================================================
// LEADERBOARD — app.js  (v3.0 · build 20260604-01)
// UI controller. Imports data.js (Supabase) and game.js (engine).
// No scoring logic here — everything goes through game.js.
// ================================================================

import {
  authSignIn, authSignUp, authSignOut, authSignInWithGoogle,
  authForgotPassword, authOnStateChange, authGetUser,
  profileLoad, profileSave, profileFindByEmail,
  coursesLoadAll, courseLoadById, courseSave, courseDelete, coursesEnsureDefaults,
  roundCreate, roundSaveState, roundComplete, roundAbandon,
  roundsLoadActive, roundLoadById, roundsLoadHistory,
  roundPlayersSave, roundPlayersLoad,
  friendsLoad, friendRequestsLoadPending,
  friendRequestSend, friendRequestAccept, friendRequestDecline, friendRemove,
  smsInviteCreate, smsInviteLookup, smsInviteAccept,
  smsBuildInviteLink, smsBuildMessage,
  realtimeSubscribeRound, realtimeSubscribeFriendRequests, realtimeUnsubscribe,
} from '../data.js';

import {
  FORMAT_LABELS, FORMAT_DESCS, FORMAT_MIN_PLAYERS, formatsForPlayerCount,
  calcHandicaps, strokesOnHole, indivStrokesOnHole,
  stablefordPoints, matchPlayStatus, matchPlayIsOver,
  buildInitialState, processHole, undoHole, editHole,
  getResultSummary, buildScorecardRows,
} from '../game.js';

// ================================================================
// APP STATE
// ================================================================

let currentUser    = null;
let currentProfile = null;
let allCourses     = [];
let allFriends     = [];

// Setup wizard state
const setup = {
  format:     null,
  courseId:   null,
  teeIdx:     0,
  holes:      18,       // 18 | 'front9' | 'back9'
  numPlayers: 2,
  numGroups:  1,
  hcpPct:     100,
  players:    [],       // [{ name, hcpIndex, groupNumber, profileId, mobile }]
};

// Active round
let roundId    = null;
let gameState  = null;
let realtimeCh = null;

// Pending abandon source ('game' | 'home' | 'setup')
let abandonSource = null;

// Course wizard state
const cwiz = {
  courseId:  null,   // null = new, string = edit
  name:      '',
  location:  '',
  tees:      [],
  holes:     [],     // array of 18 { par, si: {teeName: n, ...} }
  holeIdx:   0,
  returnTo:  null,   // 'setup' | 'profile'
};

// Friend-picker callback
let fpCallback = null;

// History filter
let historyFilter = 'all';

// Theme
let theme = localStorage.getItem('lb-theme') || 'dark';

// ================================================================
// UTILITIES
// ================================================================

function show(id)  { document.getElementById(id)?.classList.remove('hidden'); }
function hide(id)  { document.getElementById(id)?.classList.add('hidden'); }
function toggle(id, on) { on ? show(id) : hide(id); }

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) { el.classList.add('active'); el.scrollTop = 0; }
}

function setMsg(id, msg, isError = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

function clearMsg(id) { setMsg(id, ''); }

function fmtHandicap(h) {
  if (h == null || h === '') return '—';
  return parseFloat(h).toFixed(1);
}

function playerColor(idx) {
  const colors = [
    'var(--p0)', 'var(--p1)', 'var(--p2)', 'var(--p3)',
  ];
  return colors[idx] ?? 'var(--gold)';
}

function pluralHoles(n) { return n === 1 ? '1 hole' : `${n} holes`; }

function holeRange(holes) {
  if (holes === 'front9') return { offset: 0,  count: 9  };
  if (holes === 'back9')  return { offset: 9,  count: 9  };
  return                         { offset: 0,  count: 18 };
}

function formatLabel(fmt) { return FORMAT_LABELS[fmt] ?? fmt; }

function applyTheme(t) {
  theme = t;
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('lb-theme', t);
  const icon = document.getElementById('theme-icon');
  if (icon) icon.textContent = t === 'dark' ? '🌙' : '☀️';
  ['btn-theme-dark','btn-theme-light'].forEach(id => {
    document.getElementById(id)?.classList.toggle('active', id === `btn-theme-${t}`);
  });
}

// Render the SVG logo into every .logo-wrap element
function renderLogos() {
  const svg = `
  <svg viewBox="0 0 200 48" xmlns="http://www.w3.org/2000/svg" style="width:160px;height:auto;">
    <text x="0" y="38"
      font-family="'Barlow Condensed',sans-serif"
      font-size="42" font-weight="800" letter-spacing="-1"
      fill="var(--gold)">LEADER</text>
    <text x="120" y="38"
      font-family="'Barlow Condensed',sans-serif"
      font-size="42" font-weight="300" letter-spacing="-1"
      fill="var(--white)">BOARD</text>
  </svg>`;
  document.querySelectorAll('.logo-wrap').forEach(el => { el.innerHTML = svg; });
}

// ================================================================
// BOOT — check URL for ?join= token or normal auth flow
// ================================================================

async function boot() {
  applyTheme(theme);
  renderLogos();

  const params = new URLSearchParams(window.location.search);
  const joinToken = params.get('join');

  if (joinToken) {
    await handleJoinFlow(joinToken);
    return;
  }

  // Listen for auth state changes (handles OAuth redirect too)
  authOnStateChange(async (event, user) => {
    if (user) {
      await onSignedIn(user);
    } else {
      onSignedOut();
    }
  });
}

// ================================================================
// AUTH
// ================================================================

function onSignedOut() {
  currentUser    = null;
  currentProfile = null;
  roundId        = null;
  gameState      = null;
  showScreen('screen-auth');
}

async function onSignedIn(user) {
  currentUser = user;
  try {
    await coursesEnsureDefaults(user.id);
    currentProfile = await profileLoad(user.id);
    allCourses     = await coursesLoadAll();
    allFriends     = await friendsLoad(user.id);
    subscribeToFriendRequests();
    await showHome();
  } catch (err) {
    console.error('onSignedIn error', err);
    showScreen('screen-home');
  }
}

// Auth tab switching
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

// Sign In
document.getElementById('btn-signin')?.addEventListener('click', async () => {
  const email    = document.getElementById('si-email').value.trim();
  const password = document.getElementById('si-password').value;
  clearMsg('auth-error'); clearMsg('auth-success');
  if (!email || !password) { setMsg('auth-error', 'Please enter your email and password.', true); return; }
  const btn = document.getElementById('btn-signin');
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    await authSignIn(email, password);
    // onSignedIn fires via onAuthStateChange
  } catch (err) {
    setMsg('auth-error', err.message || 'Sign in failed.', true);
    btn.disabled = false; btn.textContent = 'SIGN IN →';
  }
});

// Sign Up
document.getElementById('btn-signup')?.addEventListener('click', async () => {
  const fname    = document.getElementById('su-fname').value.trim();
  const lname    = document.getElementById('su-lname').value.trim();
  const email    = document.getElementById('su-email').value.trim();
  const password = document.getElementById('su-password').value;
  clearMsg('auth-error'); clearMsg('auth-success');
  if (!fname || !email || !password) { setMsg('auth-error', 'Please fill in all fields.', true); return; }
  if (password.length < 8) { setMsg('auth-error', 'Password must be at least 8 characters.', true); return; }
  const btn = document.getElementById('btn-signup');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    await authSignUp(email, password, fname, lname);
    setMsg('auth-success', 'Account created! Check your email to confirm, then sign in.');
    btn.disabled = false; btn.textContent = 'CREATE ACCOUNT →';
  } catch (err) {
    setMsg('auth-error', err.message || 'Sign up failed.', true);
    btn.disabled = false; btn.textContent = 'CREATE ACCOUNT →';
  }
});

// Forgot password
document.getElementById('btn-forgot')?.addEventListener('click', async () => {
  const email = document.getElementById('si-email').value.trim();
  if (!email) { setMsg('auth-error', 'Enter your email first.', true); return; }
  try {
    await authForgotPassword(email);
    setMsg('auth-success', 'Password reset email sent — check your inbox.');
  } catch (err) {
    setMsg('auth-error', err.message || 'Could not send reset email.', true);
  }
});

// Google
document.getElementById('btn-google')?.addEventListener('click', async () => {
  try { await authSignInWithGoogle(); }
  catch (err) { setMsg('auth-error', err.message || 'Google sign-in failed.', true); }
});

// Sign Out
document.getElementById('btn-sign-out')?.addEventListener('click', async () => {
  realtimeUnsubscribe(realtimeCh); realtimeCh = null;
  await authSignOut();
});

// ================================================================
// HOME SCREEN
// ================================================================

async function showHome() {
  showScreen('screen-home');
  applyTheme(theme);
  renderLogos();

  // Check for active round
  try {
    const actives = await roundsLoadActive(currentUser.id);
    if (actives.length > 0) {
      const r = actives[0];
      document.getElementById('resume-title').textContent =
        `${r.course_name} · ${r.tee_name} Tees`;
      document.getElementById('resume-sub').textContent =
        `${formatLabel(r.game_format)} · ${r.player_names?.join(', ') ?? ''}`;
      roundId = r.id;
      show('home-resume-banner');
    } else {
      hide('home-resume-banner');
      roundId = null;
    }
  } catch { hide('home-resume-banner'); }

  // Grey out formats that need more players when banner is shown
  renderFormatGrid();
}

function renderFormatGrid() {
  document.querySelectorAll('.format-btn').forEach(btn => {
    const fmt = btn.dataset.format;
    if (!fmt || fmt === 'tournament') return;
    const min = FORMAT_MIN_PLAYERS[fmt] ?? 1;
    btn.disabled = false; // always enabled — player count chosen in setup
  });
}

// Format buttons
document.getElementById('format-grid')?.addEventListener('click', e => {
  const btn = e.target.closest('.format-btn');
  if (!btn) return;
  const fmt = btn.dataset.format;
  if (fmt === 'tournament') { show('modal-coming-soon'); return; }
  startSetup(fmt);
});

// Coming soon close
document.getElementById('coming-soon-close')?.addEventListener('click', () => hide('modal-coming-soon'));

// Resume
document.getElementById('btn-resume')?.addEventListener('click', async () => {
  if (!roundId) return;
  await resumeRound(roundId);
});

// Abandon from home
document.getElementById('btn-abandon-home')?.addEventListener('click', () => {
  abandonSource = 'home';
  show('modal-abandon');
});

// Bottom nav
document.getElementById('nav-profile')?.addEventListener('click', () => showProfile());
document.getElementById('nav-friends')?.addEventListener('click', () => showFriends());
document.getElementById('nav-history')?.addEventListener('click', () => showHistory());
document.getElementById('nav-course') ?.addEventListener('click', () => { cwiz.returnTo = 'home'; openCourseWizard(null); });
document.getElementById('nav-theme')  ?.addEventListener('click', () => showProfile());

// ================================================================
// SETUP — STEP 1: COURSE
// ================================================================

function startSetup(fmt) {
  setup.format     = fmt;
  setup.courseId   = null;
  setup.teeIdx     = 0;
  setup.holes      = 18;
  setup.numPlayers = Math.max(2, FORMAT_MIN_PLAYERS[fmt] ?? 2);
  setup.numGroups  = 1;
  setup.hcpPct     = 100;
  setup.players    = [];

  document.getElementById('setup-course-format-label').textContent = formatLabel(fmt);
  populateCourseSelect();
  populateNumPlayerSelect();
  populateNumGroupSelect();
  document.getElementById('setup-hcp-pct').value = 100;
  hide('setup-tee-wrap');
  showScreen('screen-setup-course');
}

function populateCourseSelect() {
  const sel = document.getElementById('setup-course-select');
  sel.innerHTML = '<option value="">— Select course —</option>';
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
  const sel     = document.getElementById('setup-course-select');
  const courseId = sel.value;
  setup.courseId = courseId || null;
  if (!courseId) { hide('setup-tee-wrap'); return; }

  const course = allCourses.find(c => c.id === courseId);
  if (!course) return;

  const teeSel = document.getElementById('setup-tee-select');
  teeSel.innerHTML = '';
  (course.tees ?? []).forEach((t, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = t.name;
    teeSel.appendChild(opt);
  });
  setup.teeIdx = 0;
  teeSel.value = '0';
  show('setup-tee-wrap');
  renderSIPreview(course, 0);
}

document.getElementById('setup-course-select')?.addEventListener('change', onCourseSelectChange);

document.getElementById('setup-tee-select')?.addEventListener('change', e => {
  setup.teeIdx = parseInt(e.target.value, 10);
  const course = allCourses.find(c => c.id === setup.courseId);
  if (course) renderSIPreview(course, setup.teeIdx);
});

function renderSIPreview(course, teeIdx) {
  const tee   = course.tees?.[teeIdx];
  if (!tee) return;
  const grid  = document.getElementById('setup-si-grid');
  const wrap  = document.getElementById('setup-si-preview');
  if (!grid) return;
  const { offset, count } = holeRange(setup.holes);
  const siSlice  = tee.si.slice(offset, offset + count);
  const parSlice = tee.par.slice(offset, offset + count);
  grid.innerHTML = siSlice.map((si, i) => `
    <div style="background:var(--surface2);border-radius:2px;padding:2px 0;">
      <div style="color:var(--gold);font-weight:700;">${offset + i + 1}</div>
      <div>SI${si}</div>
      <div style="color:var(--text-muted);">P${parSlice[i]}</div>
    </div>`).join('');
  show('setup-si-preview');
}

// Holes buttons
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
  const sel = document.getElementById('setup-num-players');
  sel.innerHTML = '';
  const min  = FORMAT_MIN_PLAYERS[setup.format] ?? 1;
  const maxP = setup.format === 'split6' ? 3 :
               ['betterball','csm','foursomes','greensomes'].includes(setup.format) ? 4 : 4;
  for (let n = min; n <= maxP; n++) {
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = n;
    if (n === setup.numPlayers) opt.selected = true;
    sel.appendChild(opt);
  }
}

function populateNumGroupSelect() {
  const sel = document.getElementById('setup-num-groups');
  sel.innerHTML = '';
  for (let g = 1; g <= setup.numPlayers; g++) {
    const opt = document.createElement('option');
    opt.value = g;
    opt.textContent = g;
    if (g === 1) opt.selected = true;
    sel.appendChild(opt);
  }
}

document.getElementById('setup-num-players')?.addEventListener('change', e => {
  setup.numPlayers = parseInt(e.target.value, 10);
  populateNumGroupSelect();
});
document.getElementById('setup-num-groups')?.addEventListener('change', e => {
  setup.numGroups = parseInt(e.target.value, 10);
});

document.getElementById('setup-add-course-btn')?.addEventListener('click', () => {
  cwiz.returnTo = 'setup'; openCourseWizard(null);
});

document.getElementById('setup-course-back')?.addEventListener('click', () => showHome());
document.getElementById('setup-abandon-1')  ?.addEventListener('click', () => { abandonSource = 'setup'; show('modal-abandon'); });

document.getElementById('btn-setup-course-next')?.addEventListener('click', () => {
  if (!setup.courseId) { alert('Please select a course.'); return; }
  setup.hcpPct     = parseInt(document.getElementById('setup-hcp-pct').value, 10) || 100;
  setup.numPlayers = parseInt(document.getElementById('setup-num-players').value, 10);
  setup.numGroups  = parseInt(document.getElementById('setup-num-groups').value, 10);
  buildPlayerForms();
  showScreen('screen-setup-players');
});

// ================================================================
// SETUP — STEP 2: PLAYERS
// ================================================================

function buildPlayerForms() {
  const container = document.getElementById('setup-player-groups');
  container.innerHTML = '';
  setup.players = [];

  // Pre-fill player 0 from profile
  const myName = currentProfile
    ? `${currentProfile.first_name ?? ''} ${currentProfile.last_name ?? ''}`.trim()
    : '';
  const myHcp = currentProfile?.hcp ?? '';

  for (let g = 1; g <= setup.numGroups; g++) {
    const inGroup = Math.ceil((setup.numPlayers - (g - 1) * Math.floor(setup.numPlayers / setup.numGroups))
      / (setup.numGroups - g + 1));

    // Simpler: evenly distribute
    const perGroup = Math.round(setup.numPlayers / setup.numGroups);
    const start    = (g - 1) * perGroup;
    const end      = g === setup.numGroups ? setup.numPlayers : g * perGroup;
    const count    = end - start;

    const groupEl = document.createElement('div');
    groupEl.className = 'card';
    const heading = setup.numGroups > 1 ? `<div class="card-title mb-sm">Group ${g}</div>` : '';
    groupEl.innerHTML = heading;

    for (let p = start; p < end; p++) {
      setup.players[p] = {
        name:        p === 0 ? myName  : '',
        hcpIndex:    p === 0 ? myHcp   : '',
        groupNumber: g,
        profileId:   p === 0 ? currentUser?.id : null,
        mobile:      p === 0 ? currentProfile?.mobile ?? '' : '',
        isScorer:    p === 0,
      };

      const row = document.createElement('div');
      row.className = 'player-setup-row mb-sm';
      row.style.cssText = 'display:flex;align-items:center;gap:0.5rem;';
      row.innerHTML = `
        <div style="width:8px;height:8px;border-radius:50%;background:${playerColor(p)};flex-shrink:0;"></div>
        <div style="flex:1;display:grid;grid-template-columns:1fr auto;gap:0.4rem;align-items:end;">
          <div class="field" style="margin:0;">
            <label>Name</label>
            <div style="display:flex;gap:4px;">
              <input id="pname-${p}" type="text" placeholder="Player ${p + 1}"
                value="${setup.players[p].name}"
                style="flex:1;" autocomplete="off">
              ${p !== 0 ? `<button class="btn btn-ghost" style="padding:0.3rem 0.5rem;font-size:0.8rem;" data-pick="${p}">👤</button>` : ''}
            </div>
          </div>
          <div class="field" style="margin:0;width:80px;">
            <label>HCP</label>
            <input id="phcp-${p}" type="number" step="0.1" min="0" max="54"
              placeholder="0.0" value="${setup.players[p].hcpIndex}">
          </div>
        </div>`;
      groupEl.appendChild(row);

      // Live bind
      row.querySelector(`#pname-${p}`)?.addEventListener('input', e => {
        setup.players[p].name = e.target.value.trim();
      });
      row.querySelector(`#phcp-${p}`)?.addEventListener('input', e => {
        setup.players[p].hcpIndex = parseFloat(e.target.value) || 0;
      });
      const pickBtn = row.querySelector(`[data-pick="${p}"]`);
      if (pickBtn) pickBtn.addEventListener('click', () => openFriendPicker(p));
    }

    container.appendChild(groupEl);
  }
}

function openFriendPicker(playerIdx) {
  fpCallback = ({ name, hcp, profileId }) => {
    setup.players[playerIdx].name      = name;
    setup.players[playerIdx].hcpIndex  = hcp;
    setup.players[playerIdx].profileId = profileId;
    const nameEl = document.getElementById(`pname-${playerIdx}`);
    const hcpEl  = document.getElementById(`phcp-${playerIdx}`);
    if (nameEl) nameEl.value = name;
    if (hcpEl)  hcpEl.value  = hcp;
  };

  document.getElementById('fp-title').textContent = `Pick Player ${playerIdx + 1}`;
  hide('fp-confirm'); show('fp-chips');

  const chips = document.getElementById('fp-chips');
  chips.innerHTML = '';
  if (!allFriends.length) {
    show('fp-empty'); return;
  }
  hide('fp-empty');
  allFriends.forEach(f => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = f.name;
    chip.addEventListener('click', () => {
      document.getElementById('fp-selected-name').textContent =
        `${f.name} · HCP ${fmtHandicap(f.hcp)}`;
      document.getElementById('fp-hcp').value = f.hcp ?? '';
      show('fp-confirm'); hide('fp-chips');
      document.getElementById('fp-confirm-btn').onclick = () => {
        const hcp = parseFloat(document.getElementById('fp-hcp').value) || 0;
        fpCallback({ name: f.name, hcp, profileId: f.profileId });
        hide('modal-friend-picker');
      };
    });
    chips.appendChild(chip);
  });
  show('modal-friend-picker');
}

document.getElementById('fp-close')    ?.addEventListener('click', () => hide('modal-friend-picker'));
document.getElementById('fp-back-btn') ?.addEventListener('click', () => { show('fp-chips'); hide('fp-confirm'); });

document.getElementById('setup-players-back')      ?.addEventListener('click', () => showScreen('screen-setup-course'));
document.getElementById('btn-setup-players-back')  ?.addEventListener('click', () => showScreen('screen-setup-course'));
document.getElementById('setup-abandon-2')         ?.addEventListener('click', () => { abandonSource = 'setup'; show('modal-abandon'); });

document.getElementById('btn-setup-players-next')?.addEventListener('click', () => {
  // Validate names
  for (let i = 0; i < setup.numPlayers; i++) {
    setup.players[i].name     = document.getElementById(`pname-${i}`)?.value.trim() || `Player ${i + 1}`;
    setup.players[i].hcpIndex = parseFloat(document.getElementById(`phcp-${i}`)?.value) || 0;
  }
  buildSetupReview();
  showScreen('screen-setup-review');
});

// ================================================================
// SETUP — STEP 3: REVIEW
// ================================================================

function buildSetupReview() {
  const course = allCourses.find(c => c.id === setup.courseId);
  const tee    = course?.tees?.[setup.teeIdx];
  const { offset, count } = holeRange(setup.holes);

  let html = `
    <div class="review-row"><span class="eyebrow">Format</span><span>${formatLabel(setup.format)}</span></div>
    <div class="review-row"><span class="eyebrow">Course</span><span>${course?.name ?? '—'}</span></div>
    <div class="review-row"><span class="eyebrow">Tees</span><span>${tee?.name ?? '—'}</span></div>
    <div class="review-row"><span class="eyebrow">Holes</span><span>${count === 18 ? '18' : count === 9 && offset === 0 ? 'Front 9' : 'Back 9'}</span></div>
    <div class="review-row"><span class="eyebrow">HCP Allowance</span><span>${setup.hcpPct}%</span></div>
    <hr style="border-color:var(--gold-border);margin:0.75rem 0;">`;

  const hcpObj = calcHandicaps(setup.players.map(p => p.hcpIndex || 0), setup.hcpPct);
  setup.players.forEach((p, i) => {
    html += `
      <div class="review-row">
        <span style="display:flex;align-items:center;gap:6px;">
          <span style="width:8px;height:8px;border-radius:50%;background:${playerColor(i)};display:inline-block;"></span>
          ${p.name || `Player ${i + 1}`}
        </span>
        <span class="text-muted" style="font-size:0.8rem;">
          HCP ${fmtHandicap(p.hcpIndex)} · Playing ${hcpObj[i].playingHandicap}
        </span>
      </div>`;
  });

  document.getElementById('review-content').innerHTML = html;
}

document.getElementById('setup-review-back')  ?.addEventListener('click', () => showScreen('screen-setup-players'));
document.getElementById('btn-review-back')     ?.addEventListener('click', () => showScreen('screen-setup-players'));
document.getElementById('setup-abandon-3')     ?.addEventListener('click', () => { abandonSource = 'setup'; show('modal-abandon'); });

document.getElementById('btn-tee-off')?.addEventListener('click', async () => {
  await teeOff();
});

async function teeOff() {
  const course = allCourses.find(c => c.id === setup.courseId);
  const tee    = course?.tees?.[setup.teeIdx];
  if (!course || !tee) return;

  const { offset, count } = holeRange(setup.holes);
  const siSlice  = tee.si.slice(offset, offset + count);
  const parSlice = tee.par.slice(offset, offset + count);

  const hcpArr = setup.players.map(p => p.hcpIndex || 0);
  const hcpObj = calcHandicaps(hcpArr, setup.hcpPct);

  // Build initial game state
  gameState = buildInitialState({
    format:          setup.format,
    names:           setup.players.map(p => p.name || 'Player'),
    handicapIndexes: hcpArr,
    playingHandicaps: hcpObj.map(h => h.playingHandicap),
    matchHandicaps:   hcpObj.map(h => h.matchHandicap),
    allowancePct:    setup.hcpPct,
    si:              siSlice,
    par:             parSlice,
    numHoles:        count,
    holeOffset:      offset,
    courseName:      course.name,
    teeName:         tee.name,
  });

  const btn = document.getElementById('btn-tee-off');
  btn.disabled = true; btn.textContent = 'Starting…';

  try {
    roundId = await roundCreate({
      organiserId:  currentUser.id,
      courseName:   course.name,
      teeName:      tee.name,
      gameFormat:   setup.format,
      hcpAllowance: setup.hcpPct,
      si:           siSlice,
      par:          parSlice,
      numHoles:     count,
      holeOffset:   offset,
      playerNames:  setup.players.map(p => p.name || 'Player'),
      gameState,
    });

    await roundPlayersSave(roundId, setup.players.map((p, i) => ({
      profileId:       p.profileId ?? null,
      name:            p.name || `Player ${i + 1}`,
      handicapIndex:   p.hcpIndex || 0,
      playingHandicap: hcpObj[i].playingHandicap,
      groupNumber:     p.groupNumber,
      isScorer:        p.isScorer ?? false,
      mobile:          p.mobile ?? null,
    })));

    // Send SMS invites for players with mobiles
    for (let i = 1; i < setup.players.length; i++) {
      const p = setup.players[i];
      if (p.mobile) await sendSmsInvite(roundId, null, p);
    }

    subscribeToRound(roundId);
    enterGameScreen();
  } catch (err) {
    console.error('teeOff error', err);
    alert('Could not start round: ' + (err.message ?? err));
  } finally {
    btn.disabled = false; btn.textContent = '⛳ TEE OFF →';
  }
}

// ================================================================
// RESUME ROUND
// ================================================================

async function resumeRound(id) {
  try {
    const round = await roundLoadById(id);
    if (!round) return;
    roundId   = id;
    gameState = round.game_state;
    subscribeToRound(id);
    enterGameScreen();
  } catch (err) {
    console.error('resumeRound error', err);
  }
}

// ================================================================
// GAME SCREEN
// ================================================================

function enterGameScreen() {
  showScreen('screen-game');
  renderGameTopBar();
  renderScoreBar();
  renderHolePanel();
  document.getElementById('scorecard-overlay')?.classList.remove('open');
}

function renderGameTopBar() {
  document.getElementById('game-course-name').textContent = gameState.courseName ?? '';
  document.getElementById('game-sub').textContent =
    `${formatLabel(gameState.format)} · ${gameState.teeName ?? ''} Tees`;

  // Mini logo
  const mini = document.getElementById('game-logo-mini');
  if (mini) mini.innerHTML = `
    <svg viewBox="0 0 120 28" xmlns="http://www.w3.org/2000/svg" style="width:80px;height:auto;">
      <text x="0" y="22" font-family="'Barlow Condensed',sans-serif"
        font-size="26" font-weight="800" fill="var(--gold)">L</text>
      <text x="14" y="22" font-family="'Barlow Condensed',sans-serif"
        font-size="26" font-weight="300" fill="var(--white)">BOARD</text>
    </svg>`;
}

function renderScoreBar() {
  const fmt = gameState.format;
  // Hide all bars first
  ['game-totals-bar','game-match-bar','game-skins-bar','game-itc-bar'].forEach(id => {
    document.getElementById(id)?.classList.add('hidden');
  });

  if (fmt === 'stableford' || fmt === 'stroke') {
    const bar = document.getElementById('game-totals-bar');
    bar.classList.remove('hidden');
    bar.innerHTML = gameState.names.map((nm, i) => {
      const score = gameState.totals?.[i] ?? 0;
      const label = fmt === 'stableford' ? `${score} pts` : `${score} net`;
      return `<div class="totals-item" style="color:${playerColor(i)};">
        <div class="totals-name">${nm}</div>
        <div class="totals-score">${label}</div>
      </div>`;
    }).join('');
  }

  if (fmt === 'match') {
    renderMatchBar(gameState.names[0], gameState.names[1]);
  }

  if (fmt === 'betterball' || fmt === 'csm' || fmt === 'foursomes' || fmt === 'greensomes') {
    const pairA = `${gameState.names[0]} & ${gameState.names[1]}`;
    const pairB = `${gameState.names[2] ?? ''} & ${gameState.names[3] ?? ''}`;
    renderMatchBar(pairA, pairB);
  }

  if (fmt === 'skins') {
    const bar = document.getElementById('game-skins-bar');
    bar.classList.remove('hidden');
    bar.innerHTML = gameState.names.map((nm, i) => `
      <div class="skins-item" style="color:${playerColor(i)};">
        <div class="skins-name">${nm}</div>
        <div class="skins-score">${gameState.skins?.[i] ?? 0}</div>
      </div>`).join('') +
      `<div class="skins-pot">Pot: ${gameState.pot ?? 1}</div>`;
  }

  if (fmt === 'itc') {
    const bar = document.getElementById('game-itc-bar');
    bar.classList.remove('hidden');
    const chairName = gameState.chair !== null ? gameState.names[gameState.chair] : 'Empty';
    bar.innerHTML = gameState.names.map((nm, i) => `
      <div class="itc-item${gameState.chair === i ? ' in-chair' : ''}" style="color:${playerColor(i)};">
        <div>${nm}${gameState.chair === i ? ' 🪑' : ''}</div>
        <div class="itc-pts">${gameState.pts?.[i] ?? 0} pts</div>
      </div>`).join('');
  }

  if (fmt === 'split6') {
    const bar = document.getElementById('game-totals-bar');
    bar.classList.remove('hidden');
    const pts = gameState.runningPts ?? [0,0,0];
    bar.innerHTML = gameState.names.map((nm, i) => `
      <div class="totals-item" style="color:${playerColor(i)};">
        <div class="totals-name">${nm}</div>
        <div class="totals-score">${pts[i]} pts</div>
      </div>`).join('');
  }

  // Pot banner (skins carry-over hint)
  const potBanner = document.getElementById('game-pot-banner');
  const potText   = document.getElementById('game-pot-text');
  if (fmt === 'skins' && (gameState.pot ?? 1) > 1) {
    potText.textContent = `${gameState.pot} skins on the line`;
    potBanner.classList.remove('hidden');
  } else {
    potBanner.classList.add('hidden');
  }
}

function renderMatchBar(nameA, nameB) {
  const bar = document.getElementById('game-match-bar');
  bar.classList.remove('hidden');
  const ms        = gameState.matchScore ?? 0;
  const played    = gameState.log?.length ?? 0;
  const total     = gameState.numHoles ?? 18;
  const status    = matchPlayStatus(ms, played, total);
  const holesLeft = total - played;

  document.getElementById('mb-names-a').textContent  = nameA.split(' ')[0];
  document.getElementById('mb-names-b').textContent  = nameB.split(' ')[0];
  document.getElementById('mb-score-a').textContent  = ms > 0 ? Math.abs(ms) : '';
  document.getElementById('mb-score-b').textContent  = ms < 0 ? Math.abs(ms) : '';
  document.getElementById('mb-status').textContent   = status.text;
  document.getElementById('mb-holes-left').textContent = `${holesLeft} to play`;
  document.getElementById('mb-status').className     =
    'mb-status' + (ms === 0 ? ' all-sq' : '');
}

function renderHolePanel() {
  const h     = gameState.hole;
  const total = gameState.numHoles ?? 18;
  const fmt   = gameState.format;

  if (h >= total) {
    // All holes done — go to end screen
    showEndRound();
    return;
  }

  const si  = gameState.si[h];
  const par = gameState.par[h];
  const displayH = h + 1 + (gameState.holeOffset ?? 0);

  document.getElementById('game-hole-num').textContent = displayH;
  document.getElementById('game-hole-si').innerHTML =
    `<span class="hole-par">Par ${par}</span><span class="hole-si-val">SI ${si}</span>`;

  // Back button
  const backBtn = document.getElementById('btn-back-hole');
  if (backBtn) backBtn.disabled = h === 0 && gameState.log.length === 0;

  // Build input rows
  const inputsEl = document.getElementById('game-inputs');
  inputsEl.innerHTML = '';

  const isFoursome = (fmt === 'foursomes' || fmt === 'greensomes');

  if (isFoursome) {
    // Two pair inputs
    [['A', 0, 1], ['B', 2, 3]].forEach(([label, p0, p1]) => {
      const pairName = `${gameState.names[p0]} & ${gameState.names[p1]}`;
      const row = document.createElement('div');
      row.className = 'score-input-row';
      row.innerHTML = `
        <div class="si-player-name" style="color:${playerColor(p0)};">
          Pair ${label}: ${pairName}
        </div>
        <div class="si-controls">
          <button class="si-btn minus" data-pair="${label}">−</button>
          <input  class="si-input" id="gross-pair-${label}" type="number"
            min="1" max="15" value="${par + 2}">
          <button class="si-btn plus"  data-pair="${label}">＋</button>
        </div>`;
      inputsEl.appendChild(row);
    });

    // Hook spinners
    ['A','B'].forEach(label => {
      const inp = document.getElementById(`gross-pair-${label}`);
      inputsEl.querySelector(`[data-pair="${label}"].minus`)
        ?.addEventListener('click', () => { inp.value = Math.max(1, parseInt(inp.value)-1); });
      inputsEl.querySelector(`[data-pair="${label}"].plus`)
        ?.addEventListener('click', () => { inp.value = Math.min(15, parseInt(inp.value)+1); });
    });
  } else {
    // Individual inputs
    const showNames = gameState.names;
    showNames.forEach((nm, i) => {
      const row = document.createElement('div');
      row.className = 'score-input-row';
      const extras = indivStrokesOnHole(gameState.playingHandicaps[i], si);
      const hint   = extras > 0 ? `<span class="si-shots-hint">+${extras}</span>` : '';
      row.innerHTML = `
        <div class="si-player-name" style="color:${playerColor(i)};">
          ${nm} ${hint}
        </div>
        <div class="si-controls">
          <button class="si-btn minus" data-pi="${i}">−</button>
          <input  class="si-input" id="gross-p${i}" type="number"
            min="1" max="15" value="${par + 2}">
          <button class="si-btn plus"  data-pi="${i}">＋</button>
        </div>`;
      inputsEl.appendChild(row);
    });

    showNames.forEach((_, i) => {
      const inp = document.getElementById(`gross-p${i}`);
      inputsEl.querySelector(`[data-pi="${i}"].minus`)
        ?.addEventListener('click', () => { inp.value = Math.max(1, parseInt(inp.value)-1); });
      inputsEl.querySelector(`[data-pi="${i}"].plus`)
        ?.addEventListener('click', () => { inp.value = Math.min(15, parseInt(inp.value)+1); });
    });
  }

  // Finish early button visibility
  const finishBtn = document.getElementById('btn-finish-early');
  if (finishBtn) toggle('btn-finish-early', gameState.log.length > 0);
}

// Record hole
document.getElementById('btn-record-hole')?.addEventListener('click', () => recordHole());

function recordHole() {
  const fmt     = gameState.format;
  const h       = gameState.hole;
  const par     = gameState.par[h];
  let grosses   = [];

  const isFoursome = fmt === 'foursomes' || fmt === 'greensomes';
  if (isFoursome) {
    const vA = parseInt(document.getElementById('gross-pair-A')?.value, 10);
    const vB = parseInt(document.getElementById('gross-pair-B')?.value, 10);
    if (!vA || !vB || vA < 1 || vB < 1) { alert('Please enter valid gross scores.'); return; }
    grosses = [vA, vB];
  } else {
    for (let i = 0; i < gameState.names.length; i++) {
      const v = parseInt(document.getElementById(`gross-p${i}`)?.value, 10);
      if (!v || v < 1) { alert(`Please enter a score for ${gameState.names[i]}.`); return; }
      grosses.push(v);
    }
  }

  gameState = processHole(gameState, grosses);

  // Flash result
  flashHoleResult(h);

  // Check match-play win
  const matchFmts = ['match','betterball','csm','foursomes','greensomes'];
  if (matchFmts.includes(fmt)) {
    const played = gameState.log.length;
    const total  = gameState.numHoles ?? 18;
    if (matchPlayIsOver(gameState.matchScore, played, total) && !gameState.matchDecided) {
      gameState.matchDecided = true;
      showMatchWonModal();
      saveRoundState(); // save in background
      return;
    }
  }

  saveRoundState();

  if (gameState.hole >= (gameState.numHoles ?? 18)) {
    showEndRound();
  } else {
    renderScoreBar();
    renderHolePanel();
  }
}

// Back / undo
document.getElementById('btn-back-hole')?.addEventListener('click', () => {
  if (gameState.log.length === 0) return;
  gameState = undoHole(gameState);
  renderScoreBar();
  renderHolePanel();
  saveRoundState();
});

// Finish early
document.getElementById('btn-finish-early')?.addEventListener('click', () => {
  showEndRound();
});

// Abandon from game
document.getElementById('btn-game-abandon')?.addEventListener('click', () => {
  abandonSource = 'game';
  show('modal-abandon');
});

// Scorecard overlay
document.getElementById('btn-game-scorecard')?.addEventListener('click', () => {
  renderScorecardOverlay();
  document.getElementById('scorecard-overlay')?.classList.add('open');
});
document.getElementById('btn-close-scorecard')?.addEventListener('click', () => {
  document.getElementById('scorecard-overlay')?.classList.remove('open');
});

function renderScorecardOverlay() {
  document.getElementById('sc-overlay-title').textContent =
    `${gameState.courseName} — ${gameState.teeName}`;
  document.getElementById('sc-overlay-sub').textContent = formatLabel(gameState.format);
  document.getElementById('sc-overlay-body').innerHTML =
    buildScorecardHTML(gameState);
}

// ================================================================
// RESULT FLASH
// ================================================================

function flashHoleResult(holeIdx) {
  const entry  = gameState.log[holeIdx];
  if (!entry) return;
  const fmt    = gameState.format;
  let msg      = '';

  if (fmt === 'stableford') {
    const pts = entry.holePts;
    if (pts) msg = pts.map((p, i) => `${gameState.names[i]}: ${p}pt`).join('  ·  ');
  } else if (fmt === 'stroke') {
    const nets = entry.nets;
    if (nets) msg = nets.map((n, i) => `${gameState.names[i]}: ${n}`).join('  ·  ');
  } else if (fmt === 'match' || fmt === 'betterball' || fmt === 'csm') {
    msg = formatMatchStr(entry.matchAfter, gameState.names);
  } else if (fmt === 'skins') {
    msg = entry.winner === -1
      ? `Halved — pot carries (${entry.potWon + 1} skins)`
      : `${gameState.names[entry.winner]} wins ${entry.potWon} skin${entry.potWon !== 1 ? 's' : ''}!`;
  } else if (fmt === 'itc') {
    if (entry.pointScoredBy !== null) {
      msg = `${gameState.names[entry.pointScoredBy]} defends the chair! +1 point`;
    } else if (entry.newChair !== null) {
      msg = `${gameState.names[entry.newChair]} takes the chair`;
    } else {
      msg = 'Halved — chair empty';
    }
  } else if (fmt === 'split6') {
    const pts = entry.holePts;
    if (pts) msg = pts.map((p, i) => `${gameState.names[i]}: ${p}`).join('  ·  ');
  } else if (fmt === 'foursomes' || fmt === 'greensomes') {
    msg = entry.result > 0 ? `Pair A wins hole` : entry.result < 0 ? `Pair B wins hole` : 'Halved';
  }

  const el = document.getElementById('result-flash');
  if (!el || !msg) return;
  el.textContent = msg;
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 2400);
}

function formatMatchStr(ms, names) {
  if (ms === 0) return 'All Square';
  const up = Math.abs(ms);
  return ms > 0 ? `${names[0].split(' ')[0]} ${up} up` : `${names[1].split(' ')[0]} ${up} up`;
}

// ================================================================
// MATCH WON MODAL
// ================================================================

function showMatchWonModal() {
  const ms   = gameState.matchScore ?? 0;
  const up   = Math.abs(ms);
  const left = (gameState.numHoles ?? 18) - gameState.log.length;
  const fmt  = gameState.format;
  let winner;
  if (fmt === 'foursomes' || fmt === 'greensomes' || fmt === 'betterball' || fmt === 'csm') {
    winner = ms > 0
      ? `${gameState.names[0]} & ${gameState.names[1]}`
      : `${gameState.names[2]} & ${gameState.names[3]}`;
  } else {
    winner = ms > 0 ? gameState.names[0] : gameState.names[1];
  }
  document.getElementById('mw-winner').textContent = winner;
  document.getElementById('mw-score').textContent  = `${up}&${left}`;
  show('modal-match-won');
}

document.getElementById('mw-keep-playing')?.addEventListener('click', () => {
  hide('modal-match-won');
  renderScoreBar();
  renderHolePanel();
});

document.getElementById('mw-end-match')?.addEventListener('click', () => {
  hide('modal-match-won');
  showEndRound();
});

// ================================================================
// AUTO-SAVE
// ================================================================

async function saveRoundState() {
  if (!roundId || !gameState) return;
  const badge = document.getElementById('game-sync-badge');
  badge?.classList.remove('hidden');
  try {
    await roundSaveState(roundId, gameState, gameState.names);
  } catch (err) {
    console.error('saveRoundState error', err);
  } finally {
    badge?.classList.add('hidden');
  }
}

// ================================================================
// REALTIME SYNC
// ================================================================

function subscribeToRound(id) {
  realtimeUnsubscribe(realtimeCh);
  realtimeCh = realtimeSubscribeRound(id, remote => {
    // Another scorer updated the round — merge if we're not mid-entry
    if (remote?.game_state && remote.game_state.hole !== gameState.hole) {
      gameState = remote.game_state;
      renderScoreBar();
      renderHolePanel();
    }
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

// ================================================================
// ABANDON MODAL
// ================================================================

document.getElementById('abandon-cancel')?.addEventListener('click', () => hide('modal-abandon'));

document.getElementById('abandon-confirm')?.addEventListener('click', async () => {
  hide('modal-abandon');
  if (roundId) {
    try { await roundAbandon(roundId); } catch {}
  }
  realtimeUnsubscribe(realtimeCh); realtimeCh = null;
  roundId = null; gameState = null;
  await showHome();
});

// ================================================================
// END ROUND SCREEN
// ================================================================

function showEndRound() {
  showScreen('screen-end-round');

  const fmt     = gameState.format;
  const summary = getResultSummary(gameState);

  document.getElementById('er-format').textContent = formatLabel(fmt);
  document.getElementById('er-result').textContent = summary.winner ?? 'Completed';
  document.getElementById('er-sub').textContent    = summary.summary ?? '';

  // Podium
  const podiumEl = document.getElementById('er-podium');
  podiumEl.innerHTML = '';
  if (summary.scores?.length) {
    summary.scores.forEach((s, rank) => {
      const card = document.createElement('div');
      card.className = 'er-player-card';
      const orig = gameState.names.indexOf(s.nm);
      card.style.borderLeft = `3px solid ${playerColor(orig >= 0 ? orig : rank)}`;
      card.innerHTML = `
        <div class="er-rank">${rank + 1}</div>
        <div class="er-pname">${s.nm}</div>
        <div class="er-pscore">${s.score}${fmt === 'stroke' ? ' net' : ' pts'}</div>`;
      podiumEl.appendChild(card);
    });
  } else if (summary.winner) {
    const card = document.createElement('div');
    card.className = 'er-player-card';
    card.innerHTML = `<div class="er-pname" style="font-size:1.3rem;">${summary.winner}</div>
      <div class="er-pscore">${summary.summary}</div>`;
    podiumEl.appendChild(card);
  }

  // Scorecard
  document.getElementById('er-scorecard').innerHTML = buildScorecardHTML(gameState);
}

document.getElementById('btn-back-to-game')?.addEventListener('click', () => {
  showScreen('screen-game');
  renderScoreBar();
  renderHolePanel();
});

document.getElementById('btn-confirm-end')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-confirm-end');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await roundComplete(roundId, gameState);
    realtimeUnsubscribe(realtimeCh); realtimeCh = null;
    roundId = null; gameState = null;
    await showHome();
  } catch (err) {
    alert('Could not save round: ' + err.message);
    btn.disabled = false; btn.textContent = '✓ SAVE & FINISH';
  }
});

// ================================================================
// SCORECARD HTML BUILDER
// ================================================================

function buildScorecardHTML(state) {
  const rows = buildScorecardRows(state);
  if (!rows.length) return '<p class="text-muted" style="padding:0.5rem;">No holes recorded yet.</p>';

  const fmt     = state.format;
  const names   = state.names;
  const isPairs = ['foursomes','greensomes'].includes(fmt);
  const dispNames = isPairs
    ? [`${names[0]} & ${names[1]}`, `${names[2]} & ${names[3]}`]
    : names;

  // Header
  let html = '<table class="sc-table"><thead><tr>';
  html += '<th>H</th><th>Par</th><th>SI</th>';
  dispNames.forEach((nm, i) => {
    html += `<th style="color:${playerColor(i)};">${nm}</th>`;
    if (fmt === 'stableford') html += '<th class="sc-pts">Pts</th>';
    if (fmt === 'stroke')     html += '<th class="sc-net">Net</th>';
  });
  if (['match','betterball','csm','foursomes','greensomes'].includes(fmt)) {
    html += '<th>Status</th>';
  }
  if (['skins','itc','split6'].includes(fmt)) html += '<th>Result</th>';
  html += '</tr></thead><tbody>';

  // Rows
  rows.forEach(row => {
    html += `<tr><td>${row.holeDisplay}</td><td>${row.par}</td><td>${row.si}</td>`;
    row.players.forEach((p, pi) => {
      const won = p.won || p.isBest;
      html += `<td${won ? ' class="sc-won"' : ''}>${p.gross ?? '—'}</td>`;
      if (fmt === 'stableford') html += `<td class="sc-pts">${p.pts ?? '—'}</td>`;
      if (fmt === 'stroke')     html += `<td class="sc-net">${p.net ?? '—'}</td>`;
    });
    if (row.matchStr) html += `<td class="sc-status">${row.matchStr}</td>`;
    if (row.extra)    html += `<td class="sc-extra">${row.extra}</td>`;
    html += '</tr>';
  });

  // Totals footer
  html += '<tr class="sc-totals"><td colspan="3">Total</td>';
  if (fmt === 'stableford') {
    state.totals?.forEach(t => { html += `<td></td><td class="sc-pts">${t}</td>`; });
  } else if (fmt === 'stroke') {
    state.totals?.forEach(t => { html += `<td></td><td class="sc-net">${t}</td>`; });
  } else if (fmt === 'split6') {
    state.runningPts?.forEach(p => { html += `<td>${p}</td>`; });
  } else if (fmt === 'skins') {
    state.skins?.forEach(s => { html += `<td>${s}</td>`; });
  } else if (fmt === 'itc') {
    state.pts?.forEach(p => { html += `<td>${p}</td>`; });
  } else {
    dispNames.forEach(() => { html += '<td></td>'; });
  }
  html += '</tr></tbody></table>';
  return html;
}

// ================================================================
// PROFILE SCREEN
// ================================================================

function showProfile() {
  // Populate fields
  const p = currentProfile ?? {};
  document.getElementById('prof-fname').value  = p.first_name  ?? '';
  document.getElementById('prof-lname').value  = p.last_name   ?? '';
  document.getElementById('prof-email').value  = currentUser?.email ?? '';
  document.getElementById('prof-mobile').value = p.mobile      ?? '';
  document.getElementById('prof-hcp').value    = p.hcp         ?? '';
  document.getElementById('prof-whs').value    = p.whs_number  ?? '';

  // Avatar
  const initials = `${(p.first_name ?? '?')[0]}${(p.last_name ?? '')[0] ?? ''}`.toUpperCase();
  document.getElementById('profile-avatar').textContent = initials;
  document.getElementById('profile-name').textContent   =
    `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || 'Welcome';
  document.getElementById('profile-email-display').textContent = currentUser?.email ?? '';

  const hcpEl = document.getElementById('profile-hcp');
  if (p.hcp != null) {
    hcpEl.textContent = `HCP ${fmtHandicap(p.hcp)}`;
    hcpEl.classList.remove('hidden');
  } else {
    hcpEl.classList.add('hidden');
  }

  // Home club course select
  populateProfileCourseSelect();

  // Theme buttons
  ['btn-theme-dark','btn-theme-light'].forEach(id => {
    document.getElementById(id)?.classList.toggle('active',
      id === `btn-theme-${theme}`);
  });

  showScreen('screen-profile');
}

function populateProfileCourseSelect() {
  const sel = document.getElementById('prof-course-select');
  sel.innerHTML = '<option value="">— None —</option>';
  allCourses.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    if (c.is_default || c.id === currentProfile?.home_course_id) opt.selected = true;
    sel.appendChild(opt);
  });
}

document.getElementById('btn-save-profile')?.addEventListener('click', async () => {
  const profile = {
    id:           currentUser.id,
    first_name:   document.getElementById('prof-fname').value.trim(),
    last_name:    document.getElementById('prof-lname').value.trim(),
    mobile:       document.getElementById('prof-mobile').value.trim(),
    hcp:          parseFloat(document.getElementById('prof-hcp').value) || null,
    whs_number:   document.getElementById('prof-whs').value.trim(),
    home_course_id: document.getElementById('prof-course-select').value || null,
    preferred_tees: document.getElementById('prof-tees').value,
  };
  const btn = document.getElementById('btn-save-profile');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await profileSave(profile);
    currentProfile = { ...currentProfile, ...profile };
    const syncEl = document.getElementById('profile-sync-text');
    if (syncEl) syncEl.textContent = 'Saved ✓';
    setTimeout(() => { if (syncEl) syncEl.textContent = 'Synced'; }, 2000);
  } catch (err) {
    alert('Could not save profile: ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'SAVE PROFILE';
  }
});

document.getElementById('btn-profile-home')?.addEventListener('click', () => showHome());

document.getElementById('prof-add-course-btn')?.addEventListener('click', () => {
  cwiz.returnTo = 'profile'; openCourseWizard(null);
});

document.getElementById('btn-theme-dark') ?.addEventListener('click', () => applyTheme('dark'));
document.getElementById('btn-theme-light')?.addEventListener('click', () => applyTheme('light'));

// ================================================================
// FRIENDS SCREEN
// ================================================================

async function showFriends() {
  showScreen('screen-friends');
  await loadFriendRequests();
  await renderFriendsList();
}

async function loadFriendRequests() {
  try {
    const pending = await friendRequestsLoadPending(currentUser.id);
    const section = document.getElementById('friend-requests-section');
    const list    = document.getElementById('friend-requests-list');
    const badge   = document.getElementById('friend-req-badge');
    if (pending.length) {
      show('friend-requests-section');
      if (badge) { badge.textContent = pending.length; badge.classList.remove('hidden'); }
      list.innerHTML = pending.map(r => `
        <div class="friend-request-row" data-fid="${r.friendshipId}">
          <div>${r.name} <span class="text-muted">(HCP ${fmtHandicap(r.hcp)})</span></div>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-green"   data-accept="${r.friendshipId}">Accept</button>
            <button class="btn btn-outline" data-decline="${r.friendshipId}">Decline</button>
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
    listEl.innerHTML = '<div class="history-empty">No friends yet — add one above.</div>';
    return;
  }
  listEl.innerHTML = allFriends.map(f => `
    <div class="friend-row" style="display:flex;justify-content:space-between;align-items:center;padding:0.6rem 0;border-bottom:1px solid var(--gold-border);">
      <div>
        <div style="font-weight:600;">${f.name}</div>
        <div class="text-muted" style="font-size:0.8rem;">HCP ${fmtHandicap(f.hcp)}</div>
      </div>
      <button class="btn btn-ghost btn-danger-ghost" style="font-size:0.75rem;padding:0.3rem 0.6rem;"
        data-remove="${f.friendshipId}">Remove</button>
    </div>`).join('');

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
  const email = document.getElementById('friend-search-email').value.trim();
  if (!email) return;
  hide('friend-search-result'); hide('friend-search-empty');
  try {
    const user = await profileFindByEmail(email);
    if (!user || user.id === currentUser.id) {
      document.getElementById('friend-search-empty').textContent = 'No user found with that email.';
      show('friend-search-empty'); return;
    }
    document.getElementById('friend-found-name').textContent =
      `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim() || email;
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

// ================================================================
// HISTORY SCREEN
// ================================================================

async function showHistory() {
  showScreen('screen-history');
  historyFilter = 'all';
  document.querySelectorAll('.filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === 'all');
  });
  await loadHistory();
}

async function loadHistory() {
  const listEl  = document.getElementById('history-list');
  const countEl = document.getElementById('history-count');
  listEl.innerHTML = '<div class="history-empty">Loading…</div>';
  try {
    const rounds = await roundsLoadHistory(currentUser.id);
    const filtered = historyFilter === 'all'
      ? rounds
      : rounds.filter(r => r.game_format === historyFilter);
    countEl.textContent = `${filtered.length} round${filtered.length !== 1 ? 's' : ''}`;

    if (!filtered.length) {
      listEl.innerHTML = '<div class="history-empty">No rounds found.</div>';
      return;
    }

    listEl.innerHTML = filtered.map(r => {
      const date = r.completed_at
        ? new Date(r.completed_at).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })
        : '—';
      const state   = r.game_state;
      const summary = state ? getResultSummary(state) : null;
      return `
        <div class="history-card" data-rid="${r.id}" style="cursor:pointer;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.25rem;">
            <div>
              <div class="card-title" style="margin:0;">${r.course_name ?? '—'}</div>
              <div class="eyebrow">${formatLabel(r.game_format)} · ${r.tee_name ?? ''} Tees</div>
            </div>
            <div class="text-muted" style="font-size:0.75rem;white-space:nowrap;">${date}</div>
          </div>
          <div class="text-muted" style="font-size:0.82rem;">${r.player_names?.join(', ') ?? ''}</div>
          ${summary ? `<div class="history-result" style="margin-top:0.3rem;font-size:0.85rem;color:var(--gold);">${summary.summary}</div>` : ''}
        </div>`;
    }).join('');

    listEl.querySelectorAll('.history-card').forEach(card => {
      card.addEventListener('click', () => showHistoryDetail(card.dataset.rid, filtered));
    });
  } catch (err) {
    listEl.innerHTML = `<div class="history-empty">${err.message}</div>`;
  }
}

document.getElementById('history-filter-bar')?.addEventListener('click', e => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  historyFilter = btn.dataset.filter;
  loadHistory();
});

document.getElementById('history-back')?.addEventListener('click', () => showHome());

// ================================================================
// HISTORY DETAIL
// ================================================================

function showHistoryDetail(roundId, rounds) {
  const r     = rounds.find(x => x.id === roundId);
  if (!r) return;
  const state = r.game_state;

  document.getElementById('hd-title').textContent =
    `${r.course_name ?? '—'} · ${formatLabel(r.game_format)}`;

  if (state) {
    const summary = getResultSummary(state);
    document.getElementById('hd-result').innerHTML = `
      <div style="font-size:1.1rem;font-weight:600;color:var(--gold);margin-bottom:0.25rem;">${summary.winner ?? 'Completed'}</div>
      <div class="text-muted">${summary.summary ?? ''}</div>`;
    document.getElementById('hd-scorecard').innerHTML = buildScorecardHTML(state);
  } else {
    document.getElementById('hd-result').innerHTML  = '';
    document.getElementById('hd-scorecard').innerHTML = '<p class="text-muted">No scorecard data.</p>';
  }

  showScreen('screen-history-detail');
}

document.getElementById('history-detail-back')?.addEventListener('click', () => showHistory());

// ================================================================
// COURSE WIZARD
// ================================================================

function openCourseWizard(courseId) {
  // Reset state
  cwiz.courseId = courseId;
  cwiz.tees     = [];
  cwiz.holes    = Array.from({ length: 18 }, () => ({ par: 4, si: {} }));
  cwiz.holeIdx  = 0;

  if (courseId) {
    // Edit mode — pre-populate
    const course = allCourses.find(c => c.id === courseId);
    if (course) {
      document.getElementById('cwiz-name').value     = course.name;
      document.getElementById('cwiz-location').value = course.location ?? '';
      cwiz.name     = course.name;
      cwiz.location = course.location ?? '';
      cwiz.tees     = (course.tees ?? []).map(t => ({ name: t.name, color: t.color }));
      cwiz.holes    = Array.from({ length: 18 }, (_, i) => {
        const si = {};
        course.tees?.forEach(t => { si[t.name] = t.si[i]; });
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
  document.getElementById('cwiz-sub').textContent = '';

  renderCwizTeesList();
  show('modal-course-wizard');
  // Show name phase
  show('cwiz-phase-name'); hide('cwiz-phase-holes'); hide('cwiz-phase-review');
  updateCwizStartBtn();
}

function renderCwizTeesList() {
  const listEl = document.getElementById('cwiz-tees-list');
  if (!cwiz.tees.length) {
    listEl.innerHTML = '<div class="text-muted" style="font-size:0.82rem;">No tees added yet.</div>';
    return;
  }
  listEl.innerHTML = cwiz.tees.map((t, i) => `
    <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.4rem;">
      <span style="width:12px;height:12px;border-radius:50%;background:${t.color};flex-shrink:0;"></span>
      <span style="flex:1;">${t.name}</span>
      <button class="btn btn-ghost" style="font-size:0.75rem;padding:2px 6px;"
        data-del-tee="${i}">✕</button>
    </div>`).join('');

  listEl.querySelectorAll('[data-del-tee]').forEach(btn => {
    btn.addEventListener('click', () => {
      cwiz.tees.splice(parseInt(btn.dataset.delTee), 1);
      renderCwizTeesList();
      updateCwizStartBtn();
    });
  });
}

function updateCwizStartBtn() {
  const btn  = document.getElementById('cwiz-start-holes-btn');
  const name = document.getElementById('cwiz-name').value.trim();
  if (btn) btn.disabled = !name || !cwiz.tees.length;
}

document.getElementById('cwiz-name')?.addEventListener('input', e => {
  cwiz.name = e.target.value.trim(); updateCwizStartBtn();
});
document.getElementById('cwiz-location')?.addEventListener('input', e => {
  cwiz.location = e.target.value.trim();
});

// Add tee button
document.getElementById('cwiz-add-tee-btn')?.addEventListener('click', () => {
  const teeName = prompt('Tee name (e.g. Yellow, White, Red):');
  if (!teeName) return;
  const teeColor = prompt('Colour hex (e.g. #f5c518):', '#ffffff');
  cwiz.tees.push({ name: teeName.trim(), color: teeColor?.trim() || '#ffffff' });
  renderCwizTeesList();
  updateCwizStartBtn();
});

// Start holes entry
document.getElementById('cwiz-start-holes-btn')?.addEventListener('click', () => {
  cwiz.holeIdx = 0;
  hide('cwiz-phase-name'); show('cwiz-phase-holes');
  renderCwizHole();
});

function renderCwizHole() {
  const h   = cwiz.holeIdx;
  document.getElementById('cwiz-hole-num').textContent = h + 1;

  // Progress dots
  const dots = document.getElementById('cwiz-prog-dots');
  dots.innerHTML = Array.from({ length: 18 }, (_, i) =>
    `<div style="width:10px;height:10px;border-radius:50%;background:${
      i < h ? 'var(--gold)' : i === h ? 'var(--white)' : 'var(--surface2)'
    };"></div>`).join('');

  // Par buttons
  const parBtns = document.getElementById('cwiz-par-btns');
  parBtns.innerHTML = [3,4,5].map(p => `
    <button class="btn ${cwiz.holes[h].par === p ? 'btn-primary' : 'btn-outline'} par-btn"
      data-par="${p}">Par ${p}</button>`).join('');
  parBtns.querySelectorAll('.par-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      cwiz.holes[h].par = parseInt(btn.dataset.par, 10);
      parBtns.querySelectorAll('.par-btn').forEach(b =>
        b.classList.toggle('btn-primary', parseInt(b.dataset.par) === cwiz.holes[h].par));
      parBtns.querySelectorAll('.par-btn').forEach(b =>
        b.classList.toggle('btn-outline', parseInt(b.dataset.par) !== cwiz.holes[h].par));
    });
  });

  // SI inputs per tee
  const siSec = document.getElementById('cwiz-si-sections');
  siSec.innerHTML = cwiz.tees.map(t => `
    <div class="field mb-sm">
      <label style="color:${t.color};">SI — ${t.name} Tees</label>
      <input type="number" min="1" max="18" id="cwiz-si-${t.name}"
        value="${cwiz.holes[h].si[t.name] ?? h + 1}">
    </div>`).join('');

  // Back/Next buttons
  document.getElementById('cwiz-hole-back-btn').disabled = h === 0;
  document.getElementById('cwiz-hole-next-btn').textContent = h < 17 ? 'Next →' : 'Review →';
}

function saveCwizHole() {
  const h = cwiz.holeIdx;
  cwiz.tees.forEach(t => {
    cwiz.holes[h].si[t.name] = parseInt(document.getElementById(`cwiz-si-${t.name}`)?.value, 10) || (h + 1);
  });
}

document.getElementById('cwiz-hole-next-btn')?.addEventListener('click', () => {
  saveCwizHole();
  if (cwiz.holeIdx < 17) {
    cwiz.holeIdx++;
    renderCwizHole();
  } else {
    // Go to review
    hide('cwiz-phase-holes'); show('cwiz-phase-review');
    renderCwizReview();
  }
});

document.getElementById('cwiz-hole-back-btn')?.addEventListener('click', () => {
  saveCwizHole();
  if (cwiz.holeIdx > 0) { cwiz.holeIdx--; renderCwizHole(); }
});

function renderCwizReview() {
  const grid   = document.getElementById('cwiz-review-grid');
  const parEl  = document.getElementById('cwiz-review-par');
  const total  = cwiz.holes.reduce((s, h) => s + h.par, 0);
  parEl.textContent = total;
  grid.innerHTML    = cwiz.holes.map((h, i) => `
    <div style="text-align:center;background:var(--surface2);border-radius:3px;padding:3px 0;font-size:0.7rem;">
      <div style="color:var(--gold);font-weight:700;">${i + 1}</div>
      <div>P${h.par}</div>
    </div>`).join('');
}

document.getElementById('cwiz-redo-btn')?.addEventListener('click', () => {
  cwiz.holeIdx = 0;
  hide('cwiz-phase-review'); show('cwiz-phase-holes');
  renderCwizHole();
});

document.getElementById('cwiz-save-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('cwiz-save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    // Build tee objects with si and par arrays
    const tees = cwiz.tees.map(t => ({
      name:  t.name,
      color: t.color,
      si:    cwiz.holes.map(h => h.si[t.name] ?? 1),
      par:   cwiz.holes.map(h => h.par),
    }));

    const savedId = await courseSave({
      id:        cwiz.courseId ?? undefined,
      name:      cwiz.name,
      location:  cwiz.location,
      tees,
      isDefault: false,
      createdBy: currentUser.id,
    });

    allCourses = await coursesLoadAll();
    hide('modal-course-wizard');

    if (cwiz.returnTo === 'setup') {
      populateCourseSelect();
      const sel = document.getElementById('setup-course-select');
      if (sel) { sel.value = savedId; onCourseSelectChange(); }
    } else if (cwiz.returnTo === 'profile') {
      populateProfileCourseSelect();
    }
  } catch (err) {
    alert('Could not save course: ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = '✅ SAVE COURSE';
  }
});

document.getElementById('cwiz-cancel')?.addEventListener('click', () => hide('modal-course-wizard'));

// ================================================================
// SMS INVITE
// ================================================================

async function sendSmsInvite(rId, roundPlayerId, player) {
  if (!player.mobile) return;
  try {
    const myName     = currentProfile
      ? `${currentProfile.first_name ?? ''} ${currentProfile.last_name ?? ''}`.trim()
      : 'Your friend';
    const invite = await smsInviteCreate({
      roundId:      rId,
      roundPlayerId,
      inviterId:    currentUser.id,
      name:         player.name,
      mobile:       player.mobile,
    });
    const body = smsBuildMessage({
      inviterName:  myName,
      courseName:   gameState?.courseName ?? '',
      teeName:      gameState?.teeName    ?? '',
      formatLabel:  formatLabel(gameState?.format ?? ''),
      token:        invite.token,
    });
    // Open native SMS app
    window.open(`sms:${player.mobile}?body=${encodeURIComponent(body)}`);
  } catch (err) {
    console.warn('SMS invite failed', err);
  }
}

// ================================================================
// JOIN FLOW (SMS invite link)
// ================================================================

async function handleJoinFlow(token) {
  showScreen('screen-join');
  try {
    const invite = await smsInviteLookup(token);
    if (!invite) {
      document.getElementById('join-invite-info').innerHTML =
        '<div class="text-muted">This invite link is invalid or has expired.</div>';
      return;
    }

    document.getElementById('join-invite-info').innerHTML = `
      <div class="card-title">${invite.inviter_name ?? 'Someone'} invited you</div>
      <div class="text-muted">${invite.course_name ?? ''} · ${formatLabel(invite.game_format ?? '')}</div>`;

    const user = await authGetUser();
    if (!user) {
      show('join-auth-prompt');
      document.getElementById('btn-join-auth').addEventListener('click', () => {
        // Store token, show auth, come back
        sessionStorage.setItem('lb-join-token', token);
        showScreen('screen-auth');
      });
    } else {
      show('join-confirm-prompt');
      document.getElementById('btn-join-confirm').addEventListener('click', async () => {
        await smsInviteAccept(invite.id);
        // Clear join param, go home
        window.history.replaceState({}, '', '/');
        await onSignedIn(user);
      });
    }
  } catch (err) {
    document.getElementById('join-invite-info').innerHTML =
      `<div class="text-muted">Error loading invite: ${err.message}</div>`;
  }
}

// After OAuth sign-in, check if we were in a join flow
async function checkPendingJoinToken(user) {
  const token = sessionStorage.getItem('lb-join-token');
  if (!token) return false;
  sessionStorage.removeItem('lb-join-token');
  await handleJoinFlow(token);
  return true;
}

// ================================================================
// KICK OFF
// ================================================================

document.addEventListener('DOMContentLoaded', boot);
