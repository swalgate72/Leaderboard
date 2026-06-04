// ================================================================
// LEADERBOARD — app.js  (v3.1 · build 20260604-02)
// UI controller. Imports data.js (Supabase) and game.js (engine).
// ================================================================

import {
  authSignIn, authSignUp, authSignOut, authSignInWithGoogle,
  authForgotPassword, authOnStateChange, authGetUser,
  profileLoad, profileSave, profileFindByEmail,
  coursesLoadAll, courseLoadById, courseSave, courseDelete, coursesEnsureDefaults,
  roundCreate, roundSaveState, roundComplete, roundAbandon, roundDelete,
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
  format: null, courseId: null, teeIdx: 0, holes: 18,
  numPlayers: 2, numGroups: 1, hcpPct: 100, players: [],
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
  if (h == null || h === '') return '—';
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

  const params    = new URLSearchParams(window.location.search);
  const joinToken = params.get('join');
  if (joinToken) { await handleJoinFlow(joinToken); return; }

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
  const email = document.getElementById('si-email').value.trim();
  const pw    = document.getElementById('si-password').value;
  clearMsg('auth-error'); clearMsg('auth-success');
  if (!email || !pw) { setMsg('auth-error', 'Please enter your email and password.'); return; }
  const btn = document.getElementById('btn-signin');
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    await authSignIn(email, pw);
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

document.getElementById('format-grid')?.addEventListener('click', e => {
  const btn = e.target.closest('.format-btn');
  if (!btn) return;
  const fmt = btn.dataset.format;
  if (fmt === 'tournament') { show('modal-coming-soon'); return; }
  startSetup(fmt);
});

document.getElementById('coming-soon-close')?.addEventListener('click', () => hide('modal-coming-soon'));
document.getElementById('btn-resume')?.addEventListener('click', async () => { if (roundId) await resumeRound(roundId); });
document.getElementById('btn-abandon-home')?.addEventListener('click', () => { abandonSource = 'home'; document.getElementById('modal-abandon').classList.add('open'); });

document.getElementById('nav-profile')?.addEventListener('click', () => showProfile());
document.getElementById('nav-friends')?.addEventListener('click', () => showFriends());
document.getElementById('nav-history')?.addEventListener('click', () => showHistory());
document.getElementById('nav-course') ?.addEventListener('click', () => { cwiz.returnTo = 'home'; openCourseWizard(null); });

// ================================================================
// SETUP — STEP 1: COURSE
// ================================================================
function startSetup(fmt) {
  setup.format     = fmt;
  setup.courseId   = null; setup.teeIdx = 0; setup.holes = 18;
  setup.numPlayers = Math.max(2, FORMAT_MIN_PLAYERS[fmt] ?? 2);
  setup.numGroups  = 1; setup.hcpPct = 100; setup.players = [];

  document.getElementById('setup-course-format-label').textContent = fmtLabel(fmt);
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
  const sel = document.getElementById('setup-num-players');
  sel.innerHTML = '';
  const min  = FORMAT_MIN_PLAYERS[setup.format] ?? 1;
  const maxP = ['betterball','csm','foursomes','greensomes'].includes(setup.format) ? 4 : setup.format === 'split6' ? 3 : 4;
  for (let n = min; n <= maxP; n++) {
    const opt = document.createElement('option');
    opt.value = n; opt.textContent = n;
    if (n === setup.numPlayers) opt.selected = true;
    sel.appendChild(opt);
  }
}

function populateNumGroupSelect() {
  const sel = document.getElementById('setup-num-groups');
  sel.innerHTML = '';
  for (let g = 1; g <= setup.numPlayers; g++) {
    const opt = document.createElement('option');
    opt.value = g; opt.textContent = g;
    if (g === 1) opt.selected = true;
    sel.appendChild(opt);
  }
}

document.getElementById('setup-num-players')?.addEventListener('change', e => {
  setup.numPlayers = parseInt(e.target.value, 10); populateNumGroupSelect();
});
document.getElementById('setup-num-groups')?.addEventListener('change', e => {
  setup.numGroups = parseInt(e.target.value, 10);
});
document.getElementById('setup-add-course-btn')?.addEventListener('click', () => { cwiz.returnTo = 'setup'; openCourseWizard(null); });
document.getElementById('setup-course-back')?.addEventListener('click', () => showHome());
document.getElementById('setup-abandon-1')  ?.addEventListener('click', () => { abandonSource = 'setup'; document.getElementById('modal-abandon').classList.add('open'); });

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
  container.innerHTML = ''; setup.players = [];
  const myName = currentProfile ? `${currentProfile.first_name ?? ''} ${currentProfile.last_name ?? ''}`.trim() : '';
  const myHcp  = currentProfile?.hcp ?? '';
  const perGroup = Math.round(setup.numPlayers / setup.numGroups);

  for (let g = 1; g <= setup.numGroups; g++) {
    const start = (g - 1) * perGroup;
    const end   = g === setup.numGroups ? setup.numPlayers : g * perGroup;
    const groupEl = document.createElement('div');
    groupEl.className = 'group-block';
    if (setup.numGroups > 1) groupEl.innerHTML = `<div class="group-label">Group ${g}</div>`;

    for (let p = start; p < end; p++) {
      setup.players[p] = {
        name: p === 0 ? myName : '', hcpIndex: p === 0 ? myHcp : '',
        groupNumber: g, profileId: p === 0 ? currentUser?.id : null,
        mobile: p === 0 ? currentProfile?.mobile ?? '' : '', isScorer: p === 0,
      };
      const row = document.createElement('div');
      row.className = 'player-slot';
      row.innerHTML = `
        <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.4rem;">
          <span class="dot" style="background:${pHex(p)};"></span>
          <input id="pname-${p}" type="text" placeholder="Player ${p+1}"
            value="${setup.players[p].name}" style="flex:1;background:none;border:none;
            color:var(--white);font-size:0.88rem;outline:none;
            border-bottom:1px solid var(--border);" autocomplete="off">
          ${p !== 0 ? `<button class="btn btn-ghost" style="padding:0.25rem 0.6rem;font-size:0.8rem;" data-pick="${p}">👤</button>` : ''}
        </div>
        <div style="display:flex;gap:0.5rem;align-items:center;">
          <div class="field" style="margin:0;width:90px;">
            <label>HCP Index</label>
            <input id="phcp-${p}" type="number" step="0.1" min="0" max="54"
              placeholder="0.0" value="${setup.players[p].hcpIndex}">
          </div>
        </div>`;
      groupEl.appendChild(row);

      row.querySelector(`#pname-${p}`)?.addEventListener('input', e => { setup.players[p].name = e.target.value.trim(); });
      row.querySelector(`#phcp-${p}`) ?.addEventListener('input', e => { setup.players[p].hcpIndex = parseFloat(e.target.value) || 0; });
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
  if (!allFriends.length) { show('fp-empty'); show('modal-friend-picker'); return; }
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
        hide('modal-friend-picker');
      };
    });
    chips.appendChild(chip);
  });
  show('modal-friend-picker');
}

document.getElementById('fp-close')    ?.addEventListener('click', () => hide('modal-friend-picker'));
document.getElementById('fp-back-btn') ?.addEventListener('click', () => { show('fp-chips'); hide('fp-confirm'); });
document.getElementById('setup-players-back')     ?.addEventListener('click', () => showScreen('screen-setup-course'));
document.getElementById('btn-setup-players-back') ?.addEventListener('click', () => showScreen('screen-setup-course'));
document.getElementById('setup-abandon-2')        ?.addEventListener('click', () => { abandonSource = 'setup'; document.getElementById('modal-abandon').classList.add('open'); });

document.getElementById('btn-setup-players-next')?.addEventListener('click', () => {
  for (let i = 0; i < setup.numPlayers; i++) {
    setup.players[i].name     = document.getElementById(`pname-${i}`)?.value.trim() || `Player ${i+1}`;
    setup.players[i].hcpIndex = parseFloat(document.getElementById(`phcp-${i}`)?.value) || 0;
  }
  buildSetupReview(); showScreen('screen-setup-review');
});

// ================================================================
// SETUP — STEP 3: REVIEW
// ================================================================
function buildSetupReview() {
  const course = allCourses.find(c => c.id === setup.courseId);
  const tee    = course?.tees?.[setup.teeIdx];
  const { offset, count } = holeRange(setup.holes);
  const hcpObj = calcHandicaps(setup.players.map(p => p.hcpIndex || 0), setup.hcpPct);

  let html = `
    <div style="display:grid;gap:0.35rem;font-size:0.82rem;margin-bottom:0.75rem;">
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Format</span><span>${fmtLabel(setup.format)}</span></div>
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Course</span><span>${course?.name ?? '—'}</span></div>
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Tees</span><span>${tee?.name ?? '—'}</span></div>
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
          HCP ${fmtHandicap(p.hcpIndex)} · Playing ${hcpObj[i]?.playingHandicap ?? 0}
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
  const hcpArr   = setup.players.map(p => p.hcpIndex || 0);
  const hcpObj   = calcHandicaps(hcpArr, setup.hcpPct);

  // Remember last used tee for this course
  try { localStorage.setItem(`lb-last-tee-${setup.courseId}`, tee.name); } catch {}

  gameState = buildInitialState({
    format: setup.format,
    names: setup.players.map(p => p.name || 'Player'),
    handicapIndexes: hcpArr,
    playingHandicaps: hcpObj.map(h => h.playingHandicap),
    matchHandicaps:   hcpObj.map(h => h.matchHandicap),
    allowancePct: setup.hcpPct,
    si: siSlice, par: parSlice, numHoles: count, holeOffset: offset,
    courseName: course.name, teeName: tee.name,
  });

  const btn = document.getElementById('btn-tee-off');
  btn.disabled = true; btn.textContent = 'Starting…';
  try {
    roundId = await roundCreate({
      organiserId: currentUser.id, courseName: course.name, teeName: tee.name,
      gameFormat: setup.format, hcpAllowance: setup.hcpPct,
      si: siSlice, par: parSlice, numHoles: count, holeOffset: offset,
      playerNames: setup.players.map(p => p.name || 'Player'), gameState,
    });
    await roundPlayersSave(roundId, setup.players.map((p, i) => ({
      profileId: p.profileId ?? null, name: p.name || `Player ${i+1}`,
      handicapIndex: p.hcpIndex || 0, playingHandicap: hcpObj[i].playingHandicap,
      groupNumber: p.groupNumber, isScorer: p.isScorer ?? false, mobile: p.mobile ?? null,
    })));
    subscribeToRound(roundId);
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
    roundId = id; gameState = round.game_state;
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

  if (['stableford','stroke','split6'].includes(fmt)) {
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
  bar.style.gridTemplateColumns = `repeat(${Math.min(n, 4)}, 1fr)`;

  bar.innerHTML = gameState.names.map((nm, i) => {
    const score = fmt === 'split6'
      ? (gameState.runningPts?.[i] ?? 0)
      : (gameState.totals?.[i] ?? 0);
    const label = fmt === 'stroke' ? 'shots' : 'pts';

    // For split6, compute raw cumulative (before min subtraction) to show in brackets
    let rawLabel = '';
    if (fmt === 'split6' && gameState.log?.length > 0) {
      const rawTotal = gameState.log.reduce((sum, e) => sum + (e.holePts?.[i] ?? 0), 0);
      rawLabel = `<div style="font-family:'Barlow Condensed',sans-serif;font-size:1.1rem;font-weight:700;color:${pCol(i)};margin-top:1px;">(${rawTotal} raw)</div>`;
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

  const inputsEl = document.getElementById('game-inputs');
  inputsEl.innerHTML = '';

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
    // Better ball / CSM — show pair groupings
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

  gameState = processHole(gameState, grosses);
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
  gameState = undoHole(gameState);
  renderScoreHeader(); renderHolePanel(); saveRoundState();
});

document.getElementById('btn-finish-early')?.addEventListener('click', () => showEndRound());
document.getElementById('btn-game-abandon')?.addEventListener('click', () => { abandonSource = 'game'; document.getElementById('modal-abandon').classList.add('open'); });

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
    if (ms === 0) { msg = `<span style="color:var(--green);font-weight:600;">Hole halved — All Square</span>`; }
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
      msg = `<span style="color:var(--green);font-weight:600;">Halved — skins carry</span><span style="font-size:0.68rem;color:var(--muted);display:block;margin-top:2px;">Next hole worth <b style="color:var(--gold)">${gameState.pot}</b> skins</span>`;
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
      msg = `<span style="color:var(--green);font-weight:600;">Halved — chair empty</span>`;
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
    `${gameState.courseName} — ${gameState.teeName}`;
  document.getElementById('sc-overlay-sub').textContent =
    `${fmtLabel(gameState.format)} · ${gameState.log?.length ?? 0} holes played`;
  document.getElementById('sc-overlay-body').innerHTML = buildScorecardHTML(gameState);
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
  try { await roundSaveState(roundId, gameState, gameState.names); }
  catch (err) { console.error('saveRoundState error', err); }
  finally { badge?.classList.add('hidden'); }
}

function subscribeToRound(id) {
  realtimeUnsubscribe(realtimeCh);
  realtimeCh = realtimeSubscribeRound(id, remote => {
    if (remote?.game_state && remote.game_state.hole !== gameState.hole) {
      gameState = remote.game_state;
      renderScoreHeader(); renderHolePanel();
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

// ----------------------------------------------------------------
// ABANDON
// ----------------------------------------------------------------
document.getElementById('abandon-cancel')?.addEventListener('click', () => document.getElementById('modal-abandon').classList.remove('open'));
document.getElementById('abandon-confirm')?.addEventListener('click', async () => {
  document.getElementById('modal-abandon').classList.remove('open');
  if (roundId) { try { await roundAbandon(roundId); } catch {} }
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

  document.getElementById('er-format').textContent = fmtLabel(fmt);
  document.getElementById('er-result').textContent = summary.winner ?? 'Completed';
  document.getElementById('er-sub').textContent    = `${gameState.courseName} · ${gameState.teeName} Tees · ${gameState.log?.length ?? 0} holes`;

  // Podium
  const podiumEl = document.getElementById('er-podium');
  podiumEl.innerHTML = '';
  if (summary.scores?.length) {
    summary.scores.forEach((s, rank) => {
      const orig = gameState.names.indexOf(s.nm);
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

  document.getElementById('er-scorecard').innerHTML = buildScorecardHTML(gameState);
}

document.getElementById('btn-back-to-game')?.addEventListener('click', () => {
  showScreen('screen-game'); renderScoreHeader(); renderHolePanel();
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
// SCORECARD TABLE BUILDER
// ================================================================
function buildScorecardHTML(state) {
  const rows = buildScorecardRows(state);
  if (!rows.length) return '<p style="padding:0.5rem;color:var(--muted);">No holes recorded yet.</p>';

  const fmt      = state.format;
  const names    = state.names;
  const isPairs  = ['foursomes','greensomes'].includes(fmt);
  const dispNames = isPairs
    ? [`${names[0]} & ${names[1]}`, `${names[2] ?? ''} & ${names[3] ?? ''}`]
    : names;

  let html = '<table class="sc-table"><thead><tr>';
  html += '<th style="font-size:0.62rem;">H</th><th style="font-size:0.62rem;">Par</th><th style="font-size:0.62rem;">SI</th>';
  dispNames.forEach((nm, i) => {
    html += `<th style="color:${pHex(i)};font-size:0.7rem;">${nm.split(' ')[0]}</th>`;
    if (fmt === 'stableford') html += `<th class="sc-pts" style="color:${pHex(i)};font-size:0.7rem;">Pts</th>`;
    if (fmt === 'stroke')     html += `<th class="sc-net" style="color:${pHex(i)};font-size:0.7rem;">Net</th>`;
  });
  if (['match','betterball','csm','foursomes','greensomes'].includes(fmt)) html += '<th style="font-size:0.62rem;">Match</th>';
  if (['skins','itc','split6'].includes(fmt)) html += '<th style="font-size:0.62rem;">Result</th>';
  html += '</tr></thead><tbody>';

  let runMatch = 0;
  rows.forEach(row => {
    html += `<tr><td style="color:var(--muted);font-size:0.72rem;">${row.holeDisplay}</td><td style="font-size:0.72rem;">${row.par}</td><td style="font-size:0.72rem;color:var(--muted);">${row.si}</td>`;
    row.players.forEach((p, pi) => {
      const won = p.won || p.isBest;
      html += `<td style="font-size:0.85rem;font-weight:${won ? '700' : '500'};color:${won ? pHex(pi) : ''};">${p.gross ?? '—'}</td>`;
      if (fmt === 'stableford') html += `<td class="sc-pts" style="font-size:0.85rem;font-weight:600;">${p.pts ?? '—'}</td>`;
      if (fmt === 'stroke')     html += `<td class="sc-net" style="font-size:0.85rem;font-weight:600;">${p.net ?? '—'}</td>`;
    });
    if (row.matchStr) { runMatch += (row.result ?? 0); html += `<td class="sc-match">${row.matchStr}</td>`; }
    if (row.extra)    html += `<td style="color:var(--gold);font-size:0.7rem;">${row.extra}</td>`;
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
  html += '</tr></tbody></table>';
  return html;
}

// ================================================================
// PROFILE SCREEN
// ================================================================
function showProfile() {
  const p = currentProfile ?? {};
  document.getElementById('prof-fname').value  = p.first_name  ?? '';
  document.getElementById('prof-lname').value  = p.last_name   ?? '';
  document.getElementById('prof-email').value  = currentUser?.email ?? '';
  document.getElementById('prof-mobile').value = p.mobile      ?? '';
  document.getElementById('prof-hcp').value    = p.hcp         ?? '';
  document.getElementById('prof-whs').value    = p.whs ?? '';

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
  sel.innerHTML = '<option value="">— None —</option>';
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
    first_name: document.getElementById('prof-fname').value.trim(),
    last_name:  document.getElementById('prof-lname').value.trim(),
    mobile:     document.getElementById('prof-mobile').value.trim(),
    hcp:        parseFloat(document.getElementById('prof-hcp').value) || null,
    whs:        document.getElementById('prof-whs').value.trim(),
    home_course_id: document.getElementById('prof-course-select').value || null,
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
    listEl.innerHTML = '<div class="history-empty">No friends yet — add one above.</div>';
    return;
  }
  listEl.innerHTML = allFriends.map(f => {
    const init = f.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    return `
      <div class="friend-item">
        <div class="friend-avatar">${init}</div>
        <div class="friend-info">
          <div class="friend-name">${f.name}</div>
          <div class="friend-sub">HCP ${fmtHandicap(f.hcp)}</div>
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
        : '—';
      const state   = r.game_state;
      const summary = state ? getResultSummary(state) : null;
      return `
        <div class="history-item" data-rid="${r.id}">
          <div class="hi-icon">⛳</div>
          <div class="hi-body">
            <div class="hi-date">${date} · ${r.course_name ?? '—'}</div>
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
  document.getElementById('hd-title').textContent = `${r.course_name ?? '—'} · ${fmtLabel(r.game_format)}`;
  if (state) {
    const summary = getResultSummary(state);
    document.getElementById('hd-result').innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1rem;margin-bottom:1rem;">
        <div style="font-size:0.58rem;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted);margin-bottom:0.3rem;">${fmtLabel(r.game_format)} · ${r.tee_name} Tees</div>
        <div style="font-family:'Barlow Condensed',sans-serif;font-size:1.4rem;font-weight:700;color:var(--gold);">${summary.winner ?? 'Completed'}</div>
        <div style="font-size:0.72rem;color:var(--muted);margin-top:2px;">${summary.summary ?? ''}</div>
      </div>`;
    document.getElementById('hd-scorecard').innerHTML = buildScorecardHTML(state);
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
  show('modal-course-wizard');
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
          ${t.name} Tee — SI <span style="color:var(--gold);">${cwiz.holes[h].si[t.name] ?? '?'}</span>
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
    hide('modal-course-wizard');
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

document.getElementById('cwiz-cancel')?.addEventListener('click', () => hide('modal-course-wizard'));

// ================================================================
// JOIN FLOW
// ================================================================
async function handleJoinFlow(token) {
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
      <div style="font-size:0.72rem;color:var(--muted);">${invite.course_name ?? ''} · ${fmtLabel(invite.game_format ?? '')}</div>`;
    const user = await authGetUser();
    if (!user) {
      show('join-auth-prompt');
      document.getElementById('btn-join-auth').addEventListener('click', () => {
        sessionStorage.setItem('lb-join-token', token);
        showScreen('screen-auth');
      });
    } else {
      show('join-confirm-prompt');
      document.getElementById('btn-join-confirm').addEventListener('click', async () => {
        await smsInviteAccept(invite.id);
        window.history.replaceState({}, '', '/');
        await onSignedIn(user);
      });
    }
  } catch (err) {
    document.getElementById('join-invite-info').innerHTML =
      `<div style="color:var(--muted);">Error loading invite: ${err.message}</div>`;
  }
}

// ================================================================
// KICK OFF
// ================================================================
document.addEventListener('DOMContentLoaded', boot);
