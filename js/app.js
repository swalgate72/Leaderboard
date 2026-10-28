// ================================================================
// LEADERBOARD - app.js  (v3.2 · build 20261027a)
window.APP_BUILD = '20261026m';

// UI controller. Imports data.js (Supabase) and game.js (engine).
// ================================================================

import {
  authSignIn, authSignUp, authSignOut,
  authForgotPassword, authUpdatePassword, authOnStateChange, authGetUser,
  profileLoad, profileSave, profileFindByEmail, profileFindByUsername,
  coursesLoadAll, courseLoadById, courseSave, courseDelete, coursesEnsureDefaults, courseSubmitToLibrary,
  playersShareExport, playersShareImport,
  roundCreate, roundSaveState, roundPlayerClaimScorer, roundComplete, roundAbandon, roundReactivate, roundDelete,
  roundsLoadActive, roundLoadById, roundsLoadHistory,
  roundPlayersSave, roundPlayersLoad,
  pushSubscriptionSave, pushSubscriptionsLoadForUser, pushSubscriptionDelete,
  friendsLoad, friendRequestsLoadPending,
  guestProfileCreate, guestProfileUpdate, guestProfileLinkEmail, guestProfileDelete,
  friendRequestSend, friendRequestAccept, friendRequestDecline, friendRemove,
  smsInviteCreate, gameInviteLoad, gameInvitesPollPending, gameInvitesLoadHistory, smsInviteLookup, smsInviteAccept,
  smsInvitesDeleteMany, invitesForRoundLoad, invitesForTournamentRoundLoad,
  smsBuildInviteLink, smsBuildMessage,
  realtimeSubscribeRound, realtimeBroadcastRound, realtimeSubscribeFriendRequests, realtimeSubscribeGameInvites, realtimeUnsubscribe,
  realtimeSubscribeTournament,
  challengeCreate, challengeUpdate, challengesLoadPending, realtimeSubscribeChallenges,
  exportBackup, importBackup,
  competitionCreate, competitionFindBySharedId,
  MULTI_USER,
} from '../provider.js?v=20261021a';

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
} from '../game.js?v=20260704l';
import { idbSave, idbSaveSeq, idbLoad, idbMarkClean, idbClear, idbGetDirty, tournaments as idbTournaments } from '../db.js?v=20261021a';


// ================================================================
// PLAYER COLOURS
// ================================================================
const P_HEX = ['#d4a843','#5ba3d9','#d96b4a','#e8c96a'];

function pHex(i) { return P_HEX[i] ?? P_HEX[0]; }

// ================================================================
// PUSH NOTIFICATIONS
// ================================================================

const VAPID_PUBLIC_KEY = 'BEWv5mCYwxGTuobtK7RXYt8eCjDB-fEJQUAfaqRv-iFeL8K4x37Hh4VsD9UKBges4YmtUvGoHgQCB6WAc1Taih8';

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  // Non-blocking — if sw.js doesn't exist yet, silently skip
  try {
    const res = await fetch('/sw.js', { method: 'HEAD' }).catch(() => null);
    if (!res || !res.ok) { console.log('[sw] sw.js not found, skipping'); return null; }
    const reg = await navigator.serviceWorker.register('/sw.js');
    console.log('[sw] registered', reg.scope);
    return reg;
  } catch (err) {
    console.warn('[sw] registration failed (non-fatal)', err);
    return null;
  }
}

async function subscribeToPush(userId) {
  if (!('PushManager' in window)) return; // not supported
  try {
    const reg = await navigator.serviceWorker.ready;
    // Check existing subscription
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      // Request permission first
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        console.log('[push] permission denied');
        return;
      }
      sub = await reg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }
    // Save to Supabase
    await pushSubscriptionSave(userId, {
      endpoint: sub.endpoint,
      keys: {
        p256dh: arrayBufferToBase64(sub.getKey('p256dh')),
        auth:   arrayBufferToBase64(sub.getKey('auth')),
      },
    });
    console.log('[push] subscribed and saved');
  } catch (err) {
    console.warn('[push] subscribe failed', err);
  }
}

async function sendPushToUser(recipientProfileId, payload) {
  try {
    const subs = await pushSubscriptionsLoadForUser(recipientProfileId);
    if (!subs.length) return;

    const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ6a25qcWpud25mdXlmanJnYWNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAxODIxNjgsImV4cCI6MjA5NTc1ODE2OH0.Hy-eeXpw9yv_b3LpobYFrfEZ6OwW55dHIZc4G0pPA1k';

    await Promise.allSettled(subs.map(async sub => {
      const res = await fetch('/api/send-push', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${ANON}`,
        },
        body: JSON.stringify({
          subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        }),
      });
      if (res.status === 410) {
        // Subscription expired — clean up
        await pushSubscriptionDelete(sub.endpoint);
      }
    }));
  } catch (err) {
    console.warn('[push] sendPushToUser failed', err);
  }
}

// Utility — convert VAPID key
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

function arrayBufferToBase64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

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
  gameDate:        null,
  weather:         '',
  players:         [],
  pairs:           [],
  tournamentId:       null, // set when starting a tournament round
  tournRoundNumber:   null,
};

let roundId    = null;

// ================================================================
// SAVE-STATUS INDICATOR (Stage 1 — reliable persistence)
// ================================================================
// Monotonically increasing counter — each hole confirmation gets a
// higher seq than the last.  idbSaveSeq() uses this to prevent an
// older async write from overwriting a newer one.
let _saveSeq = 0;
function _nextSeq() { return ++_saveSeq; }

// Three states: 'saving' | 'saved' | 'failed'
let _saveStatusTimer = null;
function _setSaveStatus(state, retryFn) {
  const el    = document.getElementById('game-save-status');
  const dot   = document.getElementById('game-save-dot');
  const label = document.getElementById('game-save-label');
  if (!el || !dot || !label) return;

  clearTimeout(_saveStatusTimer);
  el.style.display = 'flex';
  el.onclick = null;

  if (state === 'saving') {
    el.dataset.state       = 'saving';
    dot.style.background   = '#fff';
    dot.style.animation    = 'pulse 1s infinite';
    label.textContent      = 'Saving…';
    el.style.background    = 'rgba(0,0,0,0.28)';
    el.style.cursor        = 'default';
  } else if (state === 'saved') {
    el.dataset.state       = 'saved';
    dot.style.background   = '#2ecc71';
    dot.style.animation    = '';
    label.textContent      = 'All scores saved';
    el.style.background    = 'rgba(0,0,0,0.28)';
    el.style.cursor        = 'default';
    // Auto-hide after 3 s
    _saveStatusTimer = setTimeout(() => { el.style.display = 'none'; }, 3000);
  } else if (state === 'failed') {
    el.dataset.state       = 'error';  // 'error' so Stage 3 guard can read it
    dot.style.background   = '#e74c3c';
    dot.style.animation    = 'pulse 1.2s infinite';
    label.textContent      = 'Save failed — Retry';
    el.style.background    = 'rgba(180,0,0,0.65)';
    el.style.cursor        = 'pointer';
    if (retryFn) el.onclick = () => { el.onclick = null; retryFn(); };
  }
}

// ================================================================
// CLOUDFLARE SYNC WORKER — game sharing, profile sharing, scores
// ================================================================
const SYNC_WORKER_URL = 'https://leaderboardsync.sw-77d.workers.dev';

/**
 * Low-level fetch wrapper — adds CORS headers + JSON parsing.
 */
async function _workerFetch(path, method = 'GET', body = null) {
  const url = SYNC_WORKER_URL + path;
  console.log('[_workerFetch]', method, url);
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  console.log('[_workerFetch] status=', r.status, 'ok=', r.ok);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('[_workerFetch] error body:', data); throw new Error(data.error || `HTTP ${r.status}`); }
  return data;
}

// ── Game sharing ─────────────────────────────────────────────────

/**
 * Publish current game setup to the Worker.
 * Returns { code, expiresAt }.
 */
async function shareGameSetup({ ttlHours = 48, expiresAt = null, name = null } = {}) {
  const course = allCourses.find(c => c.id === setup.courseId) ?? null;
  const tee    = course?.tees?.[setup.teeIdx] ?? null;
  if (!course || !tee) throw new Error('No course/tee selected');

  const payload = {
    course: {
      name:     course.name,
      location: course.location ?? null,
      tees: [{ name: tee.name, par: tee.par, si: tee.si,
               courseRating: tee.courseRating ?? null,
               slopeRating:  tee.slopeRating  ?? null }],
    },
    format: {
      type:       setup.scoring     ?? setup.format ?? 'stableford',
      teeIdx:     0,
      groups:     setup.numGroups   ?? setup.groups ?? 1,
      holesCount: setup.holes       ?? setup.holesCount ?? 18,
    },
    players:   (setup.players ?? []).map(p => ({
      name:      p.name,
      index:     p.hcpIndex   ?? null,
      courseHcp: p.courseHandicap ?? null,
    })),
    name:      name ?? null,
    organiser: currentProfile
      ? `${currentProfile.first_name ?? ''} ${currentProfile.last_name ?? ''}`.trim()
      : null,
    ...(expiresAt ? { expiresAt } : { ttlHours }),
  };

  return _workerFetch('/game', 'POST', payload);
}

/**
 * Fetch a game by code.
 * Returns the full game record or throws.
 */
async function fetchGameByCode(code) {
  return _workerFetch(`/game/${code.toUpperCase()}`);
}

/**
 * Import a fetched game record into the current setup.
 * Saves the course locally if not already present.
 */
async function importGameRecord(rec) {
  const courseData = rec.course;
  if (!courseData) throw new Error('No course in game record');

  // Find or create course
  let course = allCourses.find(c => c.name.toLowerCase() === courseData.name.toLowerCase());
  if (!course) {
    course = await courseSave({
      name:     courseData.name,
      location: courseData.location ?? '',
      tees:     courseData.tees ?? [],
    });
    allCourses = await coursesLoadAll();
  }

  // Match tee by name
  const teeIdx = course.tees?.findIndex(
    t => t.name.toLowerCase() === (courseData.tees?.[0]?.name ?? '').toLowerCase()
  ) ?? 0;

  setup.courseId = course.id;
  setup.teeIdx   = teeIdx >= 0 ? teeIdx : 0;
  setup.scoring  = rec.format?.type      ?? 'stableford';
  setup.numGroups = rec.format?.groups    ?? 1;
  setup.holes    = rec.format?.holesCount ?? 18;

  // Pre-fill players if provided and slots are empty
  if (rec.players?.length > 0 && (!setup.players || setup.players.every(p => !p.name))) {
    setup.players = rec.players.map(p => ({
      name:            p.name ?? '',
      hcpIndex:        p.index ?? 0,
      courseHandicap:  p.courseHcp ?? null,
      groupNumber:     1,
      profileId:       null,
      isScorer:        false,
    }));
  }
}

// ── Profile sharing ───────────────────────────────────────────────

/** Publish current profile as a 24-hour share code. Returns { code }. */
async function shareProfile() {
  if (!currentProfile) throw new Error('No profile loaded');
  const payload = {
    name:       `${currentProfile.first_name ?? ''} ${currentProfile.last_name ?? ''}`.trim(),
    index:      currentProfile.hcp ?? null,
    homeCourse: currentProfile.home_course ?? null,
    courseHcp:  currentProfile.course_hcp  ?? null,
  };
  return _workerFetch('/profile', 'POST', payload);
}

/** Fetch a profile by 6-character code. Returns profile record. */
async function fetchProfileByCode(code) {
  return _workerFetch(`/profile/${code.toUpperCase()}`);
}

// ── Score upload ──────────────────────────────────────────────────

/**
 * Upload completed round scores for the game code stored in the
 * current setup.  Called at end of round.
 * @param {string} gameCode  — the 6-char code used to set up this game
 * @param {Array}  roundsArr — array of { round, group, players:[...] }
 */
async function uploadScores(gameCode, roundsArr) {
  return _workerFetch(`/scores/${gameCode.toUpperCase()}`, 'PUT', { rounds: roundsArr });
}

/**
 * Build scores payload from current gameState and push to Worker.
 * btn — the button element to show feedback on.
 */
async function pushScoresToCloud(btn) {
  let code = null;
  try { code = localStorage.getItem('lb-game-code'); } catch {}
  console.log('[push] lb-game-code=', code, 'gameState?', !!gameState);
  if (!code) {
    // No game code yet — open the share modal so they can generate one, then push
    openShareGameModal().catch(() => {});
    return;
  }
  // Embed code in gameState so it persists in history
  if (gameState) gameState.gameCode = code;
  if (btn) { btn.textContent = '⏳ Pushing…'; btn.disabled = true; }
  try {
    const allStates = gameState.allGroupStates?.length > 1 ? gameState.allGroupStates : [gameState];
    const isStroke = (gs => (gs.format?.type ?? gs.scoring ?? 'stableford') === 'stroke')(gameState);
    // Use a stable groupId derived from sorted player names so two independent
    // devices pushing to the same game code don't collide on group: 1
    const makeGroupId = (gs) => (gs.names ?? []).slice().sort().join('|').toLowerCase().replace(/[^a-z0-9|]/g, '').slice(0, 40) || String(Date.now());
    // Hub tournaments store the round number on gameState directly; fall back to
    // the legacy lb-tourn-state for UUID tournaments.
    const tournRound = gameState?._hubTournRound
      ?? (() => { try { const ts = _tournState(); return (ts.active && ts.currentRound > 0) ? ts.currentRound : 1; } catch { return 1; } })();
    const rounds = allStates.map((gs, gi) => ({
      round: tournRound,
      group: makeGroupId(gs),
      players: (gs.names ?? []).map((nm, pi) => {
        const log      = gs.log ?? [];
        const grosses  = log.map(e => e.grosses?.[pi] ?? 0);
        const nets     = log.map(e => e.nets?.[pi] ?? e.grosses?.[pi] ?? 0);
        const pts      = log.reduce((sum, e) => sum + (e.holePts?.[pi] ?? e.sbPts?.[pi] ?? 0), 0);
        const grossTot = grosses.reduce((s, v) => s + v, 0);
        const netTot   = nets.reduce((s, v) => s + v, 0);
        const holesPlayed = log.length; // one entry per hole logged
        const playerId = gs.playerProfileIds?.[pi] ?? null;
        const rec = { name: nm, hcp: gs.hdcps?.[pi] ?? 0, scores: grosses, nets, grossTotal: grossTot, netTotal: netTot, pts, total: isStroke ? netTot : pts, holesPlayed };
        if (playerId) rec.playerId = playerId;
        return rec;
      }),
    }));
    await uploadScores(code, rounds);
    if (btn) { btn.textContent = '✓ Pushed!'; btn.style.color = '#48bb78'; setTimeout(() => restorePushBtn(btn), 2500); }
  } catch (e) {
    if (btn) { btn.textContent = '✗ Failed — retry?'; setTimeout(() => restorePushBtn(btn), 2500); }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function restorePushBtn(btn) {
  btn.textContent = '⬆ Push Scores to Leaderboard';
  btn.style.color = '';
}

/**
 * Update all hero-banner game-code pills across setup screens and the
 * scoring screen. Call whenever a code is set or cleared.
 * @param {string|null} code
 */
function updateHeroCodePills(code) {
  const ids = ['hero-code-pill-1','hero-code-pill-2','hero-code-pill-3','hero-code-pill-home'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (code) {
      el.textContent = code;
      el.style.display = '';
    } else {
      el.style.display = 'none';
    }
  }
  // Also update the scoring screen pill (different element, different style)
  const gamePill = document.getElementById('game-code-pill');
  if (gamePill) {
    if (code) {
      gamePill.textContent = code;
      gamePill.style.display = '';
    } else {
      gamePill.style.display = 'none';
    }
  }
}

// ── UI helpers ────────────────────────────────────────────────────

/**
 * Show the "Share Game" modal — generates a game code and displays it
 * with a live URL and expiry options.
 */
async function openShareGameModal({ expiresAt = null, ttlHours = 48, name = null } = {}) {
  // Build or reuse modal
  let modal = document.getElementById('modal-share-game');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-share-game';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:360px;padding:1.5rem;text-align:center;">
        <h3 style="margin:0 0 0.25rem;font-size:1.1rem;">👥 Multi-group Scorecard</h3>
        <p id="share-game-status" style="color:var(--text-muted,#a0aec0);font-size:0.85rem;margin:0 0 1rem;">
          Generating code…
        </p>
        <div id="share-game-code" style="font-size:2.5rem;font-weight:800;letter-spacing:0.2em;
          color:var(--gold,#d4a843);margin:0.5rem 0 0.25rem;"></div>
        <div id="share-game-expiry" style="font-size:0.75rem;color:#555;
          margin-bottom:1rem;"></div>
        <div style="font-size:0.78rem;color:var(--text-muted,#a0aec0);line-height:1.4;margin-bottom:1rem;">
          Share this code with other groups so everyone's scores show on the leaderboard together.
        </div>
        <div style="margin-bottom:0.75rem;">
          <label style="font-size:0.8rem;color:var(--text-muted,#a0aec0);">Expiry</label>
          <select id="share-game-expiry-sel" style="
            display:block;width:100%;margin-top:0.35rem;
            background:#fff;border:1px solid var(--gold-border,rgba(212,168,67,0.35));
            color:#1a1a1a;border-radius:0.5rem;padding:0.5rem 0.75rem;font-size:0.9rem;">
            <option value="48">48 hours (default)</option>
            <option value="168">1 week</option>
            <option value="720">30 days</option>
            <option value="2160">90 days</option>
            <option value="8760">1 year</option>
            <option value="custom">Pick a date…</option>
          </select>
          <input type="date" id="share-game-expiry-date" style="
            display:none;width:100%;margin-top:0.35rem;
            background:#fff;border:1px solid var(--gold-border,rgba(212,168,67,0.35));
            color:#1a1a1a;border-radius:0.5rem;padding:0.5rem 0.75rem;font-size:0.9rem;">
        </div>
        <button id="share-game-close" class="btn btn-ghost" style="width:100%;">Close</button>
      </div>`;
    document.body.appendChild(modal);

    document.getElementById('share-game-close').addEventListener('click', () => modal.classList.remove('open'));
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
    document.getElementById('share-game-expiry-sel').addEventListener('change', e => {
      const dateInput = document.getElementById('share-game-expiry-date');
      dateInput.style.display = e.target.value === 'custom' ? 'block' : 'none';
    });
  }

  modal.classList.add('open');
  const statusEl  = document.getElementById('share-game-status');
  const codeEl    = document.getElementById('share-game-code');
  const expiryEl  = document.getElementById('share-game-expiry');

  codeEl.textContent    = '…';
  expiryEl.textContent  = '';
  statusEl.textContent  = 'Generating code…';

  try {
    const result = await shareGameSetup({ ttlHours, expiresAt, name });
    const code    = result.code;
    const exp     = new Date(result.expiresAt);

    codeEl.textContent   = code;
    expiryEl.textContent = `Expires ${exp.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })}`;
    statusEl.textContent = 'Share this code with your group';

    // Store for score upload later, and embed in gameState for history
    try { localStorage.setItem('lb-game-code', code); } catch {}
    if (gameState) gameState.gameCode = code;
    updateHeroCodePills(code);

  } catch (err) {
    codeEl.textContent   = '–';
    statusEl.textContent = '❌ ' + (err.message ?? 'Could not generate code');
  }
}

/**
 * Show the "Join Tournament" modal — code input + active/recent tournaments.
 * On success, imports course + format into setup.
 */
function openJoinGameModal() {
  // Always rebuild so tournament state is fresh
  const existing = document.getElementById('modal-join-game');
  if (existing) existing.remove();

  const ts = _tournState();
  const hasActiveTournament = ts.active && ts.code && ts.code !== '__error__';

  // Build active tournament section
  let tournSection = '';
  if (hasActiveTournament) {
    const roundsLeft = ts.rounds - ts.currentRound;
    const statusText = roundsLeft > 0
      ? `Round ${ts.currentRound} of ${ts.rounds} · ${roundsLeft} round${roundsLeft !== 1 ? 's' : ''} remaining`
      : `All ${ts.rounds} round${ts.rounds !== 1 ? 's' : ''} complete`;
    const canStartNext = ts.currentRound < ts.rounds;

    tournSection = `
      <div style="border:1px solid rgba(212,168,67,0.35);border-radius:0.6rem;padding:0.85rem;margin-bottom:1rem;text-align:left;background:rgba(212,168,67,0.06);">
        <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.35rem;">
          <span style="font-size:1rem;">🏆</span>
          <span style="font-weight:700;font-size:0.9rem;color:var(--text);">Active Tournament</span>
          <span style="margin-left:auto;font-family:monospace;font-size:0.85rem;font-weight:800;letter-spacing:0.12em;color:var(--gold,#d4a843);">${ts.code}</span>
        </div>
        <div style="font-size:0.78rem;color:var(--muted,#6b7280);margin-bottom:0.75rem;">${statusText}</div>
        <div style="display:flex;flex-direction:column;gap:0.45rem;">
          <button id="join-modal-rejoin-btn" class="btn" style="width:100%;padding:0.55rem 0.75rem;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:var(--text);font-size:0.88rem;text-align:left;display:flex;align-items:center;gap:0.5rem;border-radius:0.45rem;">
            <span style="font-size:1.1rem;">🔄</span><span>Rejoin current game</span>
          </button>
          ${canStartNext ? `<button id="join-modal-next-round-btn" class="btn" style="width:100%;padding:0.55rem 0.75rem;background:rgba(212,168,67,0.12);border:1px solid rgba(212,168,67,0.4);color:var(--gold,#d4a843);font-size:0.88rem;text-align:left;display:flex;align-items:center;gap:0.5rem;border-radius:0.45rem;">
            <span style="font-size:1.1rem;">▶</span><span>Start Round ${ts.currentRound + 1} of ${ts.rounds}</span>
          </button>` : ''}
          <button id="join-modal-live-btn" class="btn" style="width:100%;padding:0.55rem 0.75rem;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:var(--text);font-size:0.88rem;text-align:left;display:flex;align-items:center;gap:0.5rem;border-radius:0.45rem;">
            <span style="font-size:1.1rem;">📊</span><span>Go to Live Leaderboard</span>
          </button>
        </div>
      </div>`;
  }

  const modal = document.createElement('div');
  modal.id = 'modal-join-game';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box" style="max-width:340px;padding:1.5rem;text-align:center;">
      <h3 style="margin:0 0 0.25rem;font-size:1.1rem;">🏆 Join Tournament</h3>
      <p style="color:var(--text-muted,#a0aec0);font-size:0.85rem;margin:0 0 1rem;line-height:1.5;">
        Enter a code to join a game, or continue your tournament below
      </p>
      ${tournSection}
      <input id="join-game-input" maxlength="6" autocomplete="off" spellcheck="false"
        placeholder="Enter 6-char code"
        style="display:block;width:100%;background:#1a2535 !important;
          border:1px solid rgba(212,168,67,0.5);
          color:#f0f4f8 !important;border-radius:0.5rem;padding:0.65rem 0.75rem;
          font-size:1.4rem;font-weight:700;letter-spacing:0.2em;text-align:center;
          text-transform:uppercase;margin-bottom:0.75rem;outline:none;
          -webkit-text-fill-color:#f0f4f8 !important;">
      <div id="join-game-status" style="font-size:0.82rem;color:var(--text-muted,#a0aec0);
        min-height:1.2em;margin-bottom:0.75rem;"></div>
      <div style="display:flex;gap:0.5rem;">
        <button id="join-game-btn" class="btn btn-gold" style="flex:1;" disabled>Join</button>
        <button id="join-game-close" class="btn btn-ghost" style="flex:0 0 auto;padding:0.5rem 1rem;">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const inp    = document.getElementById('join-game-input');
  const btn    = document.getElementById('join-game-btn');
  const status = document.getElementById('join-game-status');

  document.getElementById('join-game-close').addEventListener('click', () => modal.classList.remove('open'));
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });

  // Active tournament action buttons
  document.getElementById('join-modal-rejoin-btn')?.addEventListener('click', () => {
    modal.classList.remove('open');
    // If game is already live in memory, go straight back to scoring
    if (gameState) {
      enterGameScreen();
      return;
    }
    // Otherwise let the home screen's Active Games recovery card handle it
    // (it reads IndexedDB + lb-game-state-cache and offers resume)
    showHome();
  });

  document.getElementById('join-modal-next-round-btn')?.addEventListener('click', () => {
    modal.classList.remove('open');
    tournNewRound();
  });

  document.getElementById('join-modal-live-btn')?.addEventListener('click', () => {
    modal.classList.remove('open');
    openLiveLeaderboard();
  });

  inp.addEventListener('input', () => {
    const v = inp.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6);
    inp.value = v;
    btn.disabled = v.length !== 6;
    status.textContent = '';
  });
  inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !btn.disabled) btn.click(); });

  btn.addEventListener('click', async () => {
    const code = inp.value.toUpperCase().slice(0, 6);
    if (code.length !== 6) return;
    btn.disabled = true;
    btn.textContent = '⏳';
    status.textContent = 'Looking up code…';
    try {
      const rec = await fetchGameByCode(code);
      await importGameRecord(rec);

      // Store for later score upload, and embed in gameState for history
      try { localStorage.setItem('lb-game-code', code); } catch {}
      if (gameState) gameState.gameCode = code;

      status.textContent = `✅ Joined: ${rec.course?.name ?? 'game'}`;
      modal.classList.remove('open');

      // Re-render course select to reflect imported course
      await populateCourseSelect();
      showScreen('screen-setup-course');

    } catch (err) {
      status.textContent = '❌ ' + (err.message ?? 'Code not found');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Join';
    }
  });

  modal.classList.add('open');
  setTimeout(() => inp?.focus(), 100);
}

/**
 * Show the "Share Profile" modal — generates a 24h code.
 */
async function openShareProfileModal() {
  let modal = document.getElementById('modal-share-profile');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-share-profile';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:320px;padding:1.5rem;text-align:center;">
        <h3 style="margin:0 0 0.25rem;font-size:1.1rem;">👤 Share My Profile</h3>
        <p id="share-profile-status" style="color:var(--text-muted,#a0aec0);font-size:0.85rem;
          margin:0 0 0.75rem;line-height:1.5;">Generating code…</p>
        <div id="share-profile-code" style="font-size:2.5rem;font-weight:800;letter-spacing:0.2em;
          color:var(--gold,#d4a843);margin:0.5rem 0;"></div>
        <div style="font-size:0.75rem;color:var(--text-muted,#a0aec0);margin-bottom:1rem;">
          Valid for 24 hours
        </div>
        <button id="share-profile-copy" class="btn btn-gold" style="width:100%;margin-bottom:0.5rem;">
          📋 Copy Code
        </button>
        <button id="share-profile-close" class="btn btn-ghost" style="width:100%;">Close</button>
      </div>`;
    document.body.appendChild(modal);
    document.getElementById('share-profile-close').addEventListener('click', () => modal.classList.remove('open'));
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
  }

  modal.classList.add('open');
  const statusEl = document.getElementById('share-profile-status');
  const codeEl   = document.getElementById('share-profile-code');
  const copyBtn  = document.getElementById('share-profile-copy');
  codeEl.textContent = '…';

  try {
    const result = await shareProfile();
    const code = result.code;
    codeEl.textContent   = code;
    statusEl.textContent = 'Give this code to a friend — they can add you to their friends list';

    copyBtn.onclick = async () => {
      try { await navigator.clipboard.writeText(code); }
      catch { prompt('Profile code:', code); return; }
      copyBtn.textContent = '✅ Copied!';
      setTimeout(() => { copyBtn.textContent = '📋 Copy Code'; }, 2000);
    };
  } catch (err) {
    codeEl.textContent   = '–';
    statusEl.textContent = '❌ ' + (err.message ?? 'Could not generate code');
  }
}

// ================================================================
// PLAYER SHARE — Stage 8
// ================================================================

/** Generic helper: close any modal by id. */
function closeModal(id) {
  document.getElementById(id)?.classList.remove('open');
}

/** Open the Share Players modal and populate the player list. */
async function openSharePlayersModal() {
  // Reset state
  document.getElementById('share-players-error').style.display = 'none';
  document.getElementById('share-code-result').style.display   = 'none';
  document.getElementById('btn-generate-share-code').disabled  = false;

  // Populate own-profile label
  try {
    const owner = await profileLoad();
    if (owner) {
      const name = [owner.first_name, owner.last_name].filter(Boolean).join(' ') || 'My Profile';
      document.getElementById('share-self-label').textContent = name + ' (me)';
    }
  } catch { /* ignore */ }

  // Populate guest players list
  const list = document.getElementById('share-players-list');
  list.innerHTML = '';
  try {
    const players = await friendsLoad();
    if (!players || !players.length) {
      list.innerHTML = '<p style="font-size:0.88rem;opacity:0.6;text-align:center;padding:0.5rem 0;">No saved players yet.</p>';
    } else {
      players.forEach(p => {
        const label = document.createElement('label');
        label.style.cssText = 'display:flex;align-items:center;gap:0.6rem;padding:0.55rem 0;border-bottom:1px solid var(--border);cursor:pointer;';
        label.innerHTML = `
          <input type="checkbox" data-player-id="${p.id}" style="width:1.1rem;height:1.1rem;accent-color:var(--gold);">
          <span style="flex:1;font-size:0.93rem;">${p.name || (p.firstName + ' ' + (p.lastName || '')).trim()}</span>
          <span style="font-size:0.82rem;opacity:0.55;">${p.hcp != null ? 'HCP '+p.hcp : ''}</span>`;
        list.appendChild(label);
      });
    }
  } catch (e) {
    list.innerHTML = '<p style="font-size:0.88rem;color:#fc8181;padding:0.5rem 0;">Could not load players.</p>';
  }

  document.getElementById('modal-share-players').classList.add('open');
}

/** Generate and display the share code. */
async function _generateShareCode() {
  const errEl = document.getElementById('share-players-error');
  const resultEl = document.getElementById('share-code-result');
  const btn = document.getElementById('btn-generate-share-code');
  errEl.style.display = 'none';
  resultEl.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Generating…';

  const includeSelf = document.getElementById('share-include-self').checked;
  const checkedBoxes = document.querySelectorAll('#share-players-list input[data-player-id]:checked');
  const playerIds = [...checkedBoxes].map(cb => cb.dataset.playerId);

  if (!includeSelf && playerIds.length === 0) {
    errEl.textContent = 'Please select at least one player to share.';
    errEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Generate Code';
    return;
  }

  try {
    const code = await playersShareExport(playerIds, includeSelf);
    document.getElementById('share-code-value').textContent = code;
    const expiry = new Date(Date.now() + 24 * 3600 * 1000);
    document.getElementById('share-code-expiry').textContent =
      'Expires: ' + expiry.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
    resultEl.style.display = 'block';
    btn.textContent = 'Generate New Code';
    btn.disabled = false;
  } catch (e) {
    errEl.textContent = e.message || 'Failed to generate code. Check your connection.';
    errEl.style.display = 'block';
    btn.textContent = 'Generate Code';
    btn.disabled = false;
  }
}

/** Copy share code to clipboard. */
function _copyShareCode() {
  const code = document.getElementById('share-code-value').textContent;
  navigator.clipboard.writeText(code).then(() => {
    const btn = document.querySelector('#modal-share-players .btn-outline');
    if (btn) { btn.textContent = '✅ Copied!'; setTimeout(() => { btn.textContent = '📋 Copy Code'; }, 2000); }
  }).catch(() => {});
}

// ── Import Players ───────────────────────────────────────────

let _importedPlayers = [];

/** Open the Import Players modal. */
function openImportPlayersModal() {
  document.getElementById('import-players-entry').style.display       = '';
  document.getElementById('import-players-list-section').style.display = 'none';
  document.getElementById('import-code-input').value = '';
  document.getElementById('import-players-error').style.display = 'none';
  _importedPlayers = [];
  document.getElementById('modal-import-players').classList.add('open');
  setTimeout(() => document.getElementById('import-code-input').focus(), 300);
}

/** Fetch players from a share code. */
async function _fetchImportCode() {
  const code = document.getElementById('import-code-input').value.trim().toUpperCase();
  const errEl = document.getElementById('import-players-error');
  errEl.style.display = 'none';
  if (code.length < 6) {
    errEl.textContent = 'Please enter a 6-character code.';
    errEl.style.display = 'block';
    return;
  }

  try {
    _importedPlayers = await playersShareImport(code);
  } catch (e) {
    errEl.textContent = e.message || 'Could not find that code. Please check and try again.';
    errEl.style.display = 'block';
    return;
  }

  // Load existing players for duplicate detection
  let existing = [];
  try {
    const friends = await friendsLoad();
    const owner = await profileLoad();
    if (owner) {
      existing.push([owner.first_name, owner.last_name].filter(Boolean).join(' ').toLowerCase());
    }
    (friends || []).forEach(f => {
      existing.push((f.name || (f.firstName + ' ' + (f.lastName || '')).trim()).toLowerCase());
    });
  } catch { /* ignore */ }

  // Build the list UI
  const listEl = document.getElementById('import-players-list');
  listEl.innerHTML = '';
  _importedPlayers.forEach((p, i) => {
    const isDupe = existing.includes(p.name.toLowerCase());
    const div = document.createElement('div');
    div.style.cssText = 'border-bottom:1px solid var(--border);padding:0.55rem 0;';
    div.innerHTML = `
      <label style="display:flex;align-items:flex-start;gap:0.6rem;cursor:pointer;">
        <input type="checkbox" data-import-index="${i}" ${isDupe ? '' : 'checked'}
          style="width:1.1rem;height:1.1rem;margin-top:0.15rem;accent-color:var(--gold);">
        <span style="flex:1;">
          <span style="font-weight:700;font-size:0.95rem;">${p.name}</span>
          ${p.handicapIndex != null ? `<span style="font-size:0.82rem;opacity:0.6;margin-left:0.4rem;">HCP ${p.handicapIndex}</span>` : ''}
          ${p.homeCourse ? `<br><span style="font-size:0.82rem;opacity:0.55;">${p.homeCourse}</span>` : ''}
          ${isDupe ? `<br><span style="font-size:0.8rem;color:#f6ad55;">⚠️ Already in your list</span>` : ''}
        </span>
      </label>`;
    listEl.appendChild(div);
  });

  document.getElementById('import-players-entry').style.display        = 'none';
  document.getElementById('import-players-list-section').style.display = '';
  document.getElementById('import-players-list-error').style.display   = 'none';
}

function _backToCodeEntry() {
  document.getElementById('import-players-entry').style.display        = '';
  document.getElementById('import-players-list-section').style.display = 'none';
}

/** Import the selected players into local storage. */
async function _importSelectedPlayers() {
  const errEl = document.getElementById('import-players-list-error');
  errEl.style.display = 'none';

  const checked = [...document.querySelectorAll('#import-players-list input[data-import-index]:checked')];
  if (!checked.length) {
    errEl.textContent = 'Please select at least one player.';
    errEl.style.display = 'block';
    return;
  }

  // Load existing for duplicate check
  let existingNames = [];
  try {
    const friends = await friendsLoad();
    existingNames = (friends || []).map(f =>
      (f.name || (f.firstName + ' ' + (f.lastName || '')).trim()).toLowerCase()
    );
  } catch { /* ignore */ }

  let imported = 0, skipped = 0;
  for (const cb of checked) {
    const p = _importedPlayers[parseInt(cb.dataset.importIndex, 10)];
    if (!p) continue;

    const isDupe = existingNames.includes(p.name.toLowerCase());
    if (isDupe) {
      // Check if the checkbox was manually checked by user despite duplicate warning
      // We import anyway if checked (user chose to overwrite)
      try {
        const friends = await friendsLoad();
        const existing = (friends || []).find(f =>
          (f.name || (f.firstName + ' ' + (f.lastName || '')).trim()).toLowerCase() === p.name.toLowerCase()
        );
        if (existing) {
          // Update existing player
          const updated = { ...existing };
          if (p.handicapIndex != null) updated.hcp = p.handicapIndex;
          if (p.homeCourse) updated.homeCourse = p.homeCourse;
          await guestProfileUpdate(existing.id, updated);
          imported++;
        }
      } catch { skipped++; continue; }
    } else {
      try {
        const nameParts = p.name.trim().split(/\s+/);
        const firstName = nameParts[0] || p.name;
        const lastName  = nameParts.slice(1).join(' ') || '';
        await guestProfileCreate({
          name:      p.name,
          firstName, lastName,
          hcp:       p.handicapIndex ?? null,
          homeCourse: p.homeCourse ?? null,
        });
        existingNames.push(p.name.toLowerCase());
        imported++;
      } catch { skipped++; continue; }
    }
  }

  document.getElementById('modal-import-players').classList.remove('open');

  const msg = imported > 0
    ? `✅ Imported ${imported} player${imported > 1 ? 's' : ''}${skipped ? ` (${skipped} skipped)` : ''}.`
    : '⚠️ No players were imported.';
  const _t = document.createElement('div');
  _t.textContent = msg;
  _t.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:var(--green);color:#fff;padding:0.65rem 1.25rem;border-radius:20px;font-weight:800;font-size:0.9rem;z-index:9999;pointer-events:none;white-space:nowrap;';
  document.body.appendChild(_t);
  setTimeout(() => _t.remove(), 2800);

  // Refresh players list if visible
  if (typeof renderFriendsSection === 'function') renderFriendsSection().catch(() => {});
}

/**
 * Show the "Add Friend by Code" modal.
 */
function openAddFriendByCodeModal() {
  let modal = document.getElementById('modal-add-friend-code');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-add-friend-code';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:320px;padding:1.5rem;text-align:center;">
        <h3 style="margin:0 0 0.25rem;font-size:1.1rem;">➕ Add Friend by Code</h3>
        <p style="color:var(--text-muted,#a0aec0);font-size:0.85rem;margin:0 0 1rem;line-height:1.5;">
          Ask your friend to share their profile code and enter it here
        </p>
        <input id="friend-code-input" maxlength="6" autocomplete="off" spellcheck="false"
          placeholder="e.g. X7K2AB"
          style="display:block;width:100%;background:var(--surface2,#243045);
            border:1px solid var(--gold-border,rgba(212,168,67,0.35));
            color:var(--text,#f0f4f8);border-radius:0.5rem;padding:0.65rem 0.75rem;
            font-size:1.4rem;font-weight:700;letter-spacing:0.2em;text-align:center;
            text-transform:uppercase;margin-bottom:0.75rem;outline:none;">
        <div id="friend-code-status" style="font-size:0.82rem;color:var(--text-muted,#a0aec0);
          min-height:1.2em;margin-bottom:0.75rem;"></div>
        <div style="display:flex;gap:0.5rem;">
          <button id="friend-code-btn" class="btn btn-gold" style="flex:1;" disabled>Add Friend</button>
          <button id="friend-code-close" class="btn btn-ghost" style="flex:0 0 auto;padding:0.5rem 1rem;">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const inp    = document.getElementById('friend-code-input');
    const btn    = document.getElementById('friend-code-btn');
    const status = document.getElementById('friend-code-status');

    document.getElementById('friend-code-close').addEventListener('click', () => modal.classList.remove('open'));
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });

    inp.addEventListener('input', () => {
      const v = inp.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6);
      inp.value = v;
      btn.disabled = v.length !== 6;
      status.textContent = '';
    });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !btn.disabled) btn.click(); });

    btn.addEventListener('click', async () => {
      const code = inp.value.toUpperCase().slice(0, 6);
      btn.disabled = true; btn.textContent = '⏳';
      status.textContent = 'Looking up profile…';
      try {
        const profile = await fetchProfileByCode(code);
        // Save to local friends list
        await guestProfileCreate({
          first_name: profile.name.split(' ')[0] ?? profile.name,
          last_name:  profile.name.split(' ').slice(1).join(' ') ?? '',
          hcp:        profile.index ?? null,
          home_course: profile.homeCourse ?? null,
          course_hcp:  profile.courseHcp ?? null,
          source:      'code-share',
        });
        allFriends = await friendsLoad(currentUser?.id ?? null);
        status.textContent = `✅ Added: ${profile.name}`;
        modal.classList.remove('open');
      } catch (err) {
        status.textContent = '❌ ' + (err.message ?? 'Code not found or expired');
      } finally {
        btn.disabled = false; btn.textContent = 'Add Friend';
      }
    });
  }

  const inp = document.getElementById('friend-code-input');
  const btn = document.getElementById('friend-code-btn');
  if (inp) { inp.value = ''; btn.disabled = true; }
  document.getElementById('friend-code-status').textContent = '';
  modal.classList.add('open');
  setTimeout(() => inp?.focus(), 100);
}

// Expose for button wiring in HTML
window.openShareGameModal   = openShareGameModal;
window.openLiveLeaderboard  = function() {
  let code = null;
  try {
    code = gameState?.gameCode ?? localStorage.getItem('lb-game-code') ?? null;
    if (!code) {
      const ts = _tournState();
      if (ts.active && ts.code && ts.code !== '__error__') code = ts.code;
    }
  } catch {}
  if (code) {
    const a = document.createElement('a');
    a.href = `${APP_BASE_URL}live?code=${code}`; a.target = '_blank'; a.rel = 'noreferrer';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  } else {
    openShareGameModal();
  }
};
window.openJoinGameModal    = openJoinGameModal;
window.openShareProfileModal = openShareProfileModal;
window.openAddFriendByCodeModal = openAddFriendByCodeModal;

// ================================================================
// TOURNAMENT MODE
// ================================================================

/**
 * Returns the persisted tournament mode state from localStorage.
 */
function _tournState() {
  try {
    return JSON.parse(localStorage.getItem('lb-tourn-state') ?? 'null') ?? {
      active: false,
      rounds: 1,
      currentRound: 1,
      code: null,
    };
  } catch { return { active: false, rounds: 1, currentRound: 1, code: null }; }
}

function _saveTournState(s) {
  try { localStorage.setItem('lb-tourn-state', JSON.stringify(s)); } catch {}
}

/**
 * Refresh all tournament mode UI from current state.
 */
function refreshTournamentUI() {
  const s = _tournState();

  const btnWrap = document.getElementById('btn-tourn-mode-wrap');
  const btnLabel = document.getElementById('btn-tourn-mode');
  const statusLine = document.getElementById('tourn-status-line');
  const roundBadge = document.getElementById('tourn-round-badge');
  const newRoundBtn = document.getElementById('btn-tourn-new-round');
  const heroBlock = document.getElementById('hero-tourn-code-block');
  const heroPill = document.getElementById('hero-code-pill-review');

  if (s.active) {
    // Halo the button
    if (btnWrap) {
      btnWrap.style.border = '1.5px solid var(--gold,#d4a843)';
      btnWrap.style.background = 'rgba(212,168,67,0.1)';
    }
    if (btnLabel) btnLabel.style.color = 'var(--gold,#d4a843)';

    // Status line under label
    if (statusLine) {
      const hasRealCode = s.code && s.code !== '__error__';
      const isError = s.code === '__error__';
      statusLine.style.display = '';
      if (isError) {
        statusLine.textContent = 'Code error — tap to retry';
        statusLine.style.color = 'var(--muted,#6b7280)';
        if (btnWrap) btnWrap.onclick = () => _tournRetryCode();
      } else if (hasRealCode) {
        statusLine.textContent = `${s.rounds} round${s.rounds !== 1 ? 's' : ''} · ${s.sameClub ? 'Same club' : 'Multi-club'}`;
        statusLine.style.color = 'var(--gold,#d4a843)';
        if (btnWrap) btnWrap.onclick = toggleTournamentMode;
      } else {
        statusLine.textContent = 'Generating code…';
        statusLine.style.color = 'var(--muted,#6b7280)';
        if (btnWrap) btnWrap.onclick = toggleTournamentMode;
      }
    }

    // Round badge
    if (roundBadge) {
      roundBadge.textContent = `Round ${s.currentRound} of ${s.rounds}`;
      roundBadge.style.display = '';
    }

    // Next round button
    const hasRealCode2 = s.code && s.code !== '__error__';
    if (newRoundBtn) {
      newRoundBtn.style.display = (hasRealCode2 && s.currentRound < s.rounds) ? '' : 'none';
    }

    // Hero code block — large white text in the green banner
    if (hasRealCode2) {
      if (heroPill) heroPill.textContent = s.code;
      if (heroBlock) heroBlock.style.display = '';
    } else {
      if (heroBlock) heroBlock.style.display = 'none';
    }

    // Also push to other hero pills (scoring screens etc.)
    if (hasRealCode2) updateHeroCodePills(s.code);

  } else {
    if (btnWrap) {
      btnWrap.style.border = '';
      btnWrap.style.background = '';
      btnWrap.onclick = toggleTournamentMode;
    }
    if (btnLabel) btnLabel.style.color = '';
    if (statusLine) statusLine.style.display = 'none';
    if (roundBadge) roundBadge.style.display = 'none';
    if (newRoundBtn) newRoundBtn.style.display = 'none';
    if (heroBlock) heroBlock.style.display = 'none';
  }
}

/**
 * Show the Tournament setup popup — choose rounds count and same/multi-club.
 * Called when pressing Tournament Mode button while inactive.
 */
function _showTournamentSetupModal() {
  const s = _tournState();
  let pendingRounds = s.rounds ?? 2;
  let pendingSameClub = s.sameClub !== false; // default same club
  let pendingTtlHours = s.ttlHours ?? 168; // default 1 week

  const overlay = document.createElement('div');
  overlay.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.72);
    z-index:9999;display:flex;align-items:center;justify-content:center;padding:1rem;`;

  const render = () => {
    overlay.innerHTML = `
      <div style="background:var(--surface,#1e2a3a);border:1.5px solid rgba(212,168,67,0.4);
        border-radius:0.85rem;padding:1.5rem;max-width:320px;width:100%;">
        <div style="display:flex;align-items:center;gap:0.6rem;margin-bottom:1rem;">
          <span style="font-size:1.5rem;">🏆</span>
          <span style="font-weight:800;font-size:1.1rem;color:var(--text);">Tournament Mode</span>
        </div>

        <div style="margin-bottom:1rem;">
          <div style="font-size:0.72rem;font-weight:700;color:var(--muted);letter-spacing:0.05em;
            text-transform:uppercase;margin-bottom:0.5rem;">Number of Rounds</div>
          <div style="display:flex;align-items:center;gap:0.5rem;">
            <button id="tp-rounds-dec" style="width:36px;height:36px;border-radius:50%;
              background:var(--surface2,#273447);border:1px solid var(--border,#374151);
              color:var(--text);font-size:1.2rem;font-weight:700;cursor:pointer;line-height:1;">−</button>
            <button id="tp-rounds-inc" style="width:36px;height:36px;border-radius:50%;
              background:var(--surface2,#273447);border:1px solid var(--border,#374151);
              color:var(--text);font-size:1.2rem;font-weight:700;cursor:pointer;line-height:1;">+</button>
            <span id="tp-rounds-val" style="font-size:1.6rem;font-weight:900;color:var(--text);
              min-width:2ch;text-align:center;margin-left:0.25rem;">${pendingRounds}</span>
            <span style="font-size:0.85rem;color:var(--muted);align-self:center;">rounds</span>
          </div>
        </div>

        <div style="margin-bottom:1.25rem;">
          <div style="font-size:0.72rem;font-weight:700;color:var(--muted);letter-spacing:0.05em;
            text-transform:uppercase;margin-bottom:0.5rem;">Venue</div>
          <div style="display:flex;flex-direction:column;gap:0.4rem;">
            <label style="display:flex;align-items:center;gap:0.6rem;cursor:pointer;
              padding:0.55rem 0.75rem;border-radius:0.5rem;
              background:${pendingSameClub ? 'rgba(212,168,67,0.12)' : 'var(--surface2,#273447)'};
              border:1.5px solid ${pendingSameClub ? 'rgba(212,168,67,0.5)' : 'var(--border,#374151)'};
              transition:all 0.15s;">
              <input type="radio" name="tp-venue" id="tp-same" value="same" ${pendingSameClub ? 'checked' : ''}
                style="accent-color:var(--gold,#d4a843);">
              <div>
                <div style="font-weight:700;font-size:0.9rem;color:var(--text);">Same Club</div>
                <div style="font-size:0.75rem;color:var(--muted);">Players carry over automatically</div>
              </div>
            </label>
            <label style="display:flex;align-items:center;gap:0.6rem;cursor:pointer;
              padding:0.55rem 0.75rem;border-radius:0.5rem;
              background:${!pendingSameClub ? 'rgba(212,168,67,0.12)' : 'var(--surface2,#273447)'};
              border:1.5px solid ${!pendingSameClub ? 'rgba(212,168,67,0.5)' : 'var(--border,#374151)'};
              transition:all 0.15s;">
              <input type="radio" name="tp-venue" id="tp-multi" value="multi" ${!pendingSameClub ? 'checked' : ''}
                style="accent-color:var(--gold,#d4a843);">
              <div>
                <div style="font-weight:700;font-size:0.9rem;color:var(--text);">Multi-Club Tour</div>
                <div style="font-size:0.75rem;color:var(--muted);">Choose a different course each round</div>
              </div>
            </label>
          </div>
        </div>

        <div style="margin-bottom:1.25rem;">
          <div style="font-size:0.72rem;font-weight:700;color:var(--muted);letter-spacing:0.05em;
            text-transform:uppercase;margin-bottom:0.5rem;">Keep scores for</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.4rem;">
            ${[
              { label: '1 Week',   hours: 168  },
              { label: '1 Month',  hours: 720  },
              { label: '3 Months', hours: 2160 },
              { label: '6 Months', hours: 4380 },
              { label: '1 Year',   hours: 8760 },
            ].map(opt => `
              <label style="display:flex;align-items:center;justify-content:center;gap:0.4rem;
                cursor:pointer;padding:0.5rem 0.4rem;border-radius:0.5rem;text-align:center;
                background:${pendingTtlHours === opt.hours ? 'rgba(212,168,67,0.15)' : 'var(--surface2,#273447)'};
                border:1.5px solid ${pendingTtlHours === opt.hours ? 'rgba(212,168,67,0.6)' : 'var(--border,#374151)'};
                transition:all 0.15s;">
                <input type="radio" name="tp-ttl" value="${opt.hours}" ${pendingTtlHours === opt.hours ? 'checked' : ''}
                  style="display:none;">
                <span style="font-weight:${pendingTtlHours === opt.hours ? '800' : '600'};
                  font-size:0.85rem;color:${pendingTtlHours === opt.hours ? 'var(--gold)' : 'var(--text)'};">${opt.label}</span>
              </label>`).join('')}
          </div>
        </div>

        <div style="display:flex;gap:0.5rem;">
          <button id="tp-cancel" class="btn btn-ghost" style="flex:1;">Cancel</button>
          <button id="tp-start" class="btn btn-gold" style="flex:1;">Start Tournament</button>
        </div>
      </div>`;

    overlay.querySelector('#tp-rounds-dec').onclick = () => {
      pendingRounds = Math.max(1, pendingRounds - 1); render();
    };
    overlay.querySelector('#tp-rounds-inc').onclick = () => {
      pendingRounds = Math.min(10, pendingRounds + 1); render();
    };
    overlay.querySelectorAll('input[name="tp-venue"]').forEach(r => {
      r.onchange = () => { pendingSameClub = r.value === 'same'; render(); };
    });
    overlay.querySelectorAll('input[name="tp-ttl"]').forEach(r => {
      r.onchange = () => { pendingTtlHours = Number(r.value); render(); };
    });
    // Allow clicking the label itself (since radio is hidden)
    overlay.querySelectorAll('label[style*="tp-ttl"], label').forEach(lbl => {
      const radio = lbl.querySelector('input[name="tp-ttl"]');
      if (radio) lbl.onclick = () => { pendingTtlHours = Number(radio.value); render(); };
    });
    overlay.querySelector('#tp-cancel').onclick = () => overlay.remove();
    overlay.querySelector('#tp-start').onclick = async () => {
      overlay.remove();
      _saveTournState({ ...s, active: true, rounds: pendingRounds, sameClub: pendingSameClub,
        currentRound: 1, code: null, ttlHours: pendingTtlHours, startedAt: new Date().toISOString() });
      refreshTournamentUI();
      try {
        const code = await _tournGenerateCode(pendingTtlHours);
        const newState = { ..._tournState(), code };
        _saveTournState(newState);
        try { localStorage.setItem('lb-game-code', code); } catch {}
        if (gameState) gameState.gameCode = code;
      } catch (e) {
        console.warn('Tournament code generation failed:', e.message ?? e);
        _saveTournState({ ..._tournState(), code: '__error__' });
      }
      refreshTournamentUI();
    };
  };

  render();
  document.body.appendChild(overlay);
  // Close on backdrop click
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

/**
 * Toggle tournament mode on/off (called by button click).
 */
async function toggleTournamentMode() {
  const s = _tournState();
  if (s.active) {
    // Turn off — ask for confirmation
    if (!confirm('End tournament mode? The code will be cleared.')) return;
    _saveTournState({ active: false, rounds: 1, currentRound: 1, code: null, sameClub: true });
    updateHeroCodePills(null);
    try { localStorage.removeItem('lb-game-code'); } catch {}
    refreshTournamentUI();
  } else {
    _showTournamentSetupModal();
  }
}

/**
 * Adjust number of rounds — kept for any legacy calls.
 */
function tournRoundsAdj(delta) {
  const s = _tournState();
  const newRounds = Math.max(1, Math.min(10, (s.rounds ?? 1) + delta));
  _saveTournState({ ...s, rounds: newRounds });
  refreshTournamentUI();
}

/**
 * Start the next round in the tournament — keeps same code, increments round counter.
 * Prompts organiser to verify/change course before proceeding.
 */
// Carry players (and setup fields) from the just-finished round into setup for the next round.
function _tournCarryPlayers() {
  // Restore scoring/course from the snapshot saved at end-of-round
  try {
    const ts = _tournState();
    if (ts._lastScoring  && !setup.scoring)  setup.scoring  = ts._lastScoring;
    if (ts._lastCourseId && !setup.courseId) setup.courseId = ts._lastCourseId;
    if (ts._lastTeeIdx   != null)            setup.teeIdx   = ts._lastTeeIdx;
    if (ts._lastHoles    != null)            setup.holes    = ts._lastHoles;
  } catch {}

  try {
    const gs = gameState;
    if (gs?.names?.length > 0) {
      // Re-use the player objects from the finished round's setup data if available,
      // otherwise build minimal objects from names alone.
      const existingByName = {};
      (setup.players ?? []).forEach(p => { if (p.name) existingByName[p.name] = p; });

      setup.players = gs.names.map(name => {
        // Try to find the rich player object from the previous setup pass
        const prev = existingByName[name];
        return prev ? { ...prev } : { name };
      });
      return;
    }
  } catch {}
  // gameState gone — prefill from currentProfile just like the course-next button does
  if (!setup.players?.some(p => p.name)) {
    try {
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
    } catch {}
  }
}

function tournNewRound() {
  const s = _tournState();
  if (!s.active || !s.code) return;
  if (s.currentRound >= s.rounds) {
    alert('All rounds complete for this tournament.');
    return;
  }
  const next = s.currentRound + 1;

  // Show a friendly info notice (not a blocking confirm)
  const notice = document.createElement('div');
  notice.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);
    z-index:9999;display:flex;align-items:center;justify-content:center;padding:1rem;`;
  const goesToCourse = !s.sameClub; // multi-club: pick course; same club: skip to players
  notice.innerHTML = `
    <div style="background:var(--surface,#1e2a3a);border:1px solid rgba(212,168,67,0.4);
      border-radius:0.75rem;padding:1.5rem;max-width:320px;text-align:center;">
      <div style="font-size:2rem;margin-bottom:0.5rem;">🏆</div>
      <div style="font-weight:800;font-size:1.1rem;margin-bottom:0.4rem;color:var(--text);">
        Starting Round ${next} of ${s.rounds}
      </div>
      <div style="font-size:0.85rem;color:var(--muted,#6b7280);margin-bottom:0.25rem;line-height:1.5;">
        Tournament code <strong style="color:var(--gold,#d4a843);letter-spacing:0.1em;">${s.code}</strong> stays the same.
      </div>
      <div style="font-size:0.82rem;color:var(--muted,#6b7280);margin-bottom:1.1rem;line-height:1.5;">
        ${goesToCourse ? 'Choose the course for this round.' : 'Players carry straight over — check the list on the next screen.'}
      </div>
      <div style="display:flex;gap:0.5rem;">
        <button id="tourn-next-cancel" class="btn btn-ghost" style="flex:1;">Cancel</button>
        <button id="tourn-next-go" class="btn btn-gold" style="flex:1;">Let's Go →</button>
      </div>
    </div>`;
  document.body.appendChild(notice);

  document.getElementById('tourn-next-cancel').onclick = () => notice.remove();
  document.getElementById('tourn-next-go').onclick = async () => {
    notice.remove();
    _saveTournState({ ...s, currentRound: next });
    refreshTournamentUI();
    if (goesToCourse) {
      // Multi-club: let them pick a new course
      await populateCourseSelect();
      showScreen('screen-setup-course');
    } else {
      // Same club: skip straight to players, carrying last round's players forward
      _tournCarryPlayers();
      renderSetupPlayerList();
      showScreen('screen-setup-players');
    }
  };
}

async function _tournGenerateCode(ttlHours = 168) {
  // Try shareGameSetup first (needs course selected); fall back to a minimal worker call
  try {
    const result = await shareGameSetup({ ttlHours });
    if (!result?.code) throw new Error('No code returned');
    return result.code;
  } catch (e1) {
    console.warn('shareGameSetup failed:', e1.message ?? e1);
    // Fallback: post minimal payload directly to worker
    try {
      const result = await _workerFetch('/game', 'POST', {
        course:  { name: 'Tournament', tees: [{ name: 'White', par: 72, si: [] }] },
        format:  { type: setup.scoring ?? 'stableford', groups: setup.numGroups ?? 1, holesCount: setup.holes ?? 18 },
        players: [],
        ttlHours,
      });
      if (!result?.code) throw new Error('No code from fallback');
      return result.code;
    } catch (e2) {
      console.warn('Fallback worker call failed:', e2.message ?? e2);
      throw e2;
    }
  }
}

async function _tournRetryCode() {
  const s = _tournState();
  if (!s.active) return;
  _saveTournState({ ...s, code: null });
  refreshTournamentUI();
  try {
    const code = await _tournGenerateCode();
    _saveTournState({ ..._tournState(), code });
    try { localStorage.setItem('lb-game-code', code); } catch {}
    if (gameState) gameState.gameCode = code;
  } catch (e) {
    console.warn('Tournament code retry failed:', e.message ?? e);
    _saveTournState({ ..._tournState(), code: '__error__' });
  }
  refreshTournamentUI();
}

window.toggleTournamentMode = toggleTournamentMode;
window.tournRoundsAdj = tournRoundsAdj;
window.tournNewRound = tournNewRound;

// ================================================================
// LOCAL-FIRST SYNC — IndexedDB primary, Supabase every 30s
// ================================================================
let _syncTimer     = null;   // setInterval handle
let _syncInFlight  = false;  // prevent overlapping pushes
const SYNC_INTERVAL = 30_000; // 30 seconds

// Build the stateToSave object (same logic as saveRoundState)
function _buildStateToSave() {
  if (!roundId || !gameState) return null;
  const { allGroupStates, ...myGroupState } = gameState;
  if (!allGroupStates || allGroupStates.length <= 1) return myGroupState;

  const myGroupNumber = gameState.groupNumber ?? 1;
  const mergedGroupStates = allGroupStates.map(gs => {
    const { allGroupStates: _, ...stripped } = gs;
    return (gs.groupNumber ?? 1) === myGroupNumber
      ? { ...myGroupState }
      : stripped;
  });
  const topGroup = mergedGroupStates.find(gs => (gs.groupNumber ?? 1) === 1) ?? mergedGroupStates[0];
  return { ...topGroup, allGroupStates: mergedGroupStates };
}

// Push one dirty record to Supabase. Called by sync loop and force-flush.
async function _pushToSupabase(rec) {
  try {
    await roundSaveState(rec.roundId, rec.state, rec.state.names);
    await idbMarkClean(rec.roundId);
    console.log('[sync] pushed to Supabase:', rec.roundId);
    document.getElementById('offline-banner')?.remove();
    return true;
  } catch (err) {
    console.warn('[sync] Supabase push failed:', err.message);
    return false;
  }
}

// The 30-second sync tick
// Ping Supabase with a strict 2-second timeout.
// Only returns true if the server responds fast enough to trust a full sync.
async function _pingSupabase() {
  if (!navigator.onLine) return false;
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000); // 2s hard cutoff
    const t0    = Date.now();
    await fetch('https://fzknjqjnwnfuyfjrgacf.supabase.co/rest/v1/', {
      method: 'HEAD',
      signal: ctrl.signal,
      cache:  'no-store',
    });
    clearTimeout(timer);
    console.log(`[sync] ping OK in ${Date.now() - t0}ms`);
    return true;
  } catch {
    console.log('[sync] ping failed or timed out — skipping sync');
    return false;
  }
}

async function _syncTick() {
  if (_syncInFlight) return;
  const reachable = await _pingSupabase();
  if (!reachable) return; // silent skip — try again next tick
  _syncInFlight = true;
  try {
    const dirty = await idbGetDirty();
    for (const rec of dirty) {
      await _pushToSupabase(rec);
    }
  } catch (err) {
    console.warn('[sync] tick error:', err);
  } finally {
    _syncInFlight = false;
  }
}

// Persist current round state to the active data provider immediately.
// Called at round end, abandon and on dirty-flag detection.
// Previously named flushToSupabase — the underlying call routes to
// local.js (IndexedDB) when MULTI_USER = false.
async function _persistNow() {
  if (!roundId || !gameState) return;
  const state = _buildStateToSave();
  if (!state) return;
  const rec = { roundId, state };
  await _pushToSupabase(rec);
}

// Start the sync loop (called when entering game screen)
function startSyncLoop() {
  if (!MULTI_USER) return; // local mode: no Supabase sync
  stopSyncLoop();
  _syncTimer = setInterval(_syncTick, SYNC_INTERVAL);
  // Also sync immediately when network comes back
  window.addEventListener('online', _onOnline);
}

// Stop the sync loop (called when leaving game)
function stopSyncLoop() {
  if (_syncTimer) { clearInterval(_syncTimer); _syncTimer = null; }
  window.removeEventListener('online', _onOnline);
}

async function _onOnline() {
  console.log('[sync] network restored — syncing now');
  // Show brief "syncing" toast
  const t = document.createElement('div');
  t.textContent = '📶 Back online — syncing scores…';
  t.style.cssText = `position:fixed;bottom:90px;left:50%;transform:translateX(-50%);
    background:var(--green);color:#fff;padding:0.6rem 1.2rem;border-radius:20px;
    font-weight:800;font-size:0.85rem;z-index:9999;pointer-events:none;`;
  document.body.appendChild(t);
  await _syncTick();
  setTimeout(() => t.remove(), 2500);
}
let gameState  = null;
const _sessionId = Math.random().toString(36).slice(2);
let realtimeCh = null;
const cwiz = {
  courseId: null, name: '', location: '', tees: [], holes: [],
  holeIdx: 0, returnTo: null,
};

let fpCallback    = null;
let historyFilter = 'all';
let theme = localStorage.getItem('lb-theme') || localStorage.getItem('lb_theme') || 'light';

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
  'screen-tournament-new',   // new 4-step wizard
];

const BOTTOM_NAV_SCREENS = [
  'screen-home', 'screen-history', 'screen-friends', 'screen-profile',
  'screen-tournament-hub',   // Tournament tab
];

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) { el.classList.add('active'); window.scrollTo(0, 0); }

  const bottomNav = document.getElementById('bottom-nav');
  if (bottomNav) bottomNav.style.display = BOTTOM_NAV_SCREENS.includes(id) ? 'flex' : 'none';

  // Update Share QR button visibility on course and players screens
  if (id === 'screen-setup-course' || id === 'screen-setup-players') updateShareQRButtonVisibility();

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
  // Always write the full draft including setup object so Active Games can restore it.
  // Get the current screen from lb-setup-state or the active DOM screen.
  try {
    const saved      = restoreSetupState();
    const screenId   = saved?.screen
      ?? document.querySelector('.screen.active')?.id
      ?? null;
    const course     = allCourses.find(c => c.id === setup.courseId);
    localStorage.setItem('lb-setup-draft', JSON.stringify({
      screen:     screenId,
      setup:      setup,
      scoring:    setup.scoring,
      courseName: course?.name ?? null,
      teeName:    course?.tees?.[setup.teeIdx]?.name ?? null,
      players:    (setup.players || []).filter(p => p.name).map(p => p.name),
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

// Safe assign into setup — strips read-only getter keys (e.g. format)
function assignToSetup(src) {
  if (!src) return;
  const { format: _drop, ...rest } = src;
  Object.assign(setup, rest);
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
  assignToSetup(saved.setup);

  try {
    if (saved.screen === 'screen-setup-format') {
      showHome(); // format picker is no longer used
    } else if (saved.screen === 'screen-setup-course') {
      const fmt = setup.scoring;
      document.getElementById('setup-course-format-label').textContent = FORMAT_LABELS[fmt] ?? fmt;
  updateCourseScreenForFormat(fmt);
      populateCourseSelect();
      populateNumPlayerSelect();
      populateNumGroupSelect();
      if (setup.gameDate) document.getElementById('setup-game-date').value = setup.gameDate;
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
      // Groups screen removed — send straight to review
      renderSetupGroupCards();
      buildSetupReview();
      showScreen('screen-setup-review');
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
    assignToSetup(draft.setup);
    if (draft.screen === 'screen-setup-course') {
      document.getElementById('setup-course-format-label').textContent = FORMAT_LABELS[setup.scoring] ?? setup.scoring;
      populateCourseSelect();
      populateNumPlayerSelect();
      populateNumGroupSelect();
      if (setup.gameDate) document.getElementById('setup-game-date').value = setup.gameDate;
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
      // Groups screen removed — send straight to review
      renderSetupGroupCards();
      buildSetupReview();
      showScreen('screen-setup-review');
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

function playerHcpBoxes(p) {
  const idx     = fmtHandicap(p.hcpIndex ?? 0);
  const gameHcp = fmtHandicap(p.gameHandicap ?? p.courseHandicap ?? p.hcpIndex ?? 0);
  const src     = p.hcpSource ?? 'course';
  const srcLabel = src === 'index' ? 'Idx' : src === 'playing' ? 'Ply' : 'Crs';
  return `<div style="display:flex;gap:0.25rem;align-items:center;flex-shrink:0;">
    <div style="display:flex;flex-direction:column;align-items:center;
                border:1px solid var(--border);border-radius:6px;
                padding:0.15rem 0.4rem;min-width:2.2rem;line-height:1.2;">
      <span style="font-size:0.55rem;color:var(--muted);letter-spacing:0.05em;text-transform:uppercase;">Idx</span>
      <span style="font-size:0.9rem;font-weight:600;color:var(--muted2);">${idx}</span>
    </div>
    <div style="display:flex;flex-direction:column;align-items:center;
                border:2px solid var(--gold);border-radius:6px;
                padding:0.15rem 0.4rem;min-width:2.2rem;line-height:1.2;
                background:rgba(184,148,42,0.08);">
      <span style="font-size:0.55rem;color:var(--gold);letter-spacing:0.05em;text-transform:uppercase;font-weight:700;">${srcLabel}</span>
      <span style="font-size:0.9rem;font-weight:800;color:var(--gold);">${gameHcp}</span>
    </div>
  </div>`;
}

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

// Small inline cowboy hat icon for Texas Scramble labels (text-height, inline)
const TEXAS_HAT_SMALL = `<svg viewBox="0 0 36 28" width="18" height="14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:inline-block;vertical-align:-0.15em;margin-right:3px;"><ellipse cx="18" cy="22" rx="16" ry="4.5" fill="currentColor" opacity="0.18"/><path d="M4 22c0 0 2-1 14-1s14 1 14 1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10 22V14c0-5 2.5-9 8-9s8 4 8 9v8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10 14H4.5C3 14 2 15.2 2 16.5c0 2 1.5 4 3.5 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M26 14h5.5c1.5 0 2.5 1.2 2.5 2.5c0 2-1.5 4-3.5 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M14 10c0-1 0.5-2.5 4-2.5s4 1.5 4 2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
function shortName(fullName) {
  if (!fullName) return '';
  const parts = fullName.trim().split(' ').filter(Boolean);
  if (parts.length === 1) return parts[0];
  return parts[0] + ' ' + parts[parts.length - 1][0].toUpperCase();
}

// Returns initials: "Steve W" → "SW", "Alex" → "A"
function toInitials(fullName) {
  if (!fullName) return '';
  return fullName.trim().split(' ').filter(Boolean).map(w => w[0].toUpperCase()).join('');
}


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
  // Restore game code pill if a code was active from a previous session
  try {
    const ts = _tournState();
    const savedCode = ts.active ? ts.code : localStorage.getItem('lb-game-code');
    if (savedCode) updateHeroCodePills(savedCode);
  } catch {}


  const params      = new URLSearchParams(window.location.search);
  const joinToken   = params.get('join');
  const tournViewId = params.get('tournament');
  const troundParam = params.get('tround');
  const groupParam  = params.get('group');

  if (tournViewId) { await handleTournamentViewLink(tournViewId); return; }
  if (joinToken) {
    // Competition QR payloads are base64url-encoded JSON with v:1
    // SMS invite tokens are short UUIDs — route them differently
    let isCompPayload = false;
    try {
      const b64 = joinToken.replace(/-/g, '+').replace(/_/g, '/');
      const pad = (4 - (b64.length % 4)) % 4;
      const obj = JSON.parse(atob(b64 + '='.repeat(pad)));
      if (obj && obj.v === 1 && obj.cid) isCompPayload = true;
    } catch {}

    if (!isCompPayload) {
      await handleJoinFlow(joinToken, troundParam, groupParam);
      return;
    }
    // Competition payload is handled by the competition join handler below (line ~2995)
    // — fall through to normal app init so showHome() fires lb-app-ready
  }

  // Register service worker for push notifications (non-blocking)
  registerServiceWorker().catch(() => {});

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
  if (MULTI_USER) showScreen('screen-home');
  // In local mode: auth state change to SIGNED_OUT does not occur
  // (local authOnStateChange always fires SIGNED_IN with the local owner)
}


let _joiningViaInvite = false;

async function onSignedIn(user) {
  currentUser = user;

  // Subscribe to push notifications (non-blocking — won't delay sign-in)
  if (MULTI_USER) subscribeToPush(user.id).catch(() => {});

  // ── IndexedDB health check ─────────────────────────────────────
  // iOS Safari clears IDB under low-storage conditions — warn early
  // so users know scoring reliability may be affected.
  try {
    const testKey  = '__idb_health__';
    const testDb   = indexedDB.open('_lb_health_test', 1);
    await new Promise((resolve, reject) => {
      testDb.onerror   = () => reject(testDb.error);
      testDb.onsuccess = e => {
        const db  = e.target.result;
        const tx  = db.transaction ? null : null; // just opening is enough
        db.close();
        // Try a quick write to localStorage as secondary check
        try { localStorage.setItem(testKey, '1'); localStorage.removeItem(testKey); } catch {}
        resolve();
      };
      testDb.onupgradeneeded = () => {}; // new DB, that's fine
    });
    console.log('[idb] health check passed');
  } catch (idbErr) {
    console.warn('[idb] health check FAILED:', idbErr);
    // Show a persistent warning banner
    const existing = document.getElementById('idb-warning-banner');
    if (!existing) {
      const banner = document.createElement('div');
      banner.id = 'idb-warning-banner';
      banner.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:99999;
        background:#b45309;color:#fff;padding:0.5rem 1rem;text-align:center;
        font-family:'Plus Jakarta Sans',sans-serif;font-size:0.85rem;font-weight:700;
        letter-spacing:0.03em;line-height:1.4;`;
      banner.innerHTML = `⚠️ Local storage unavailable — scores will only save if connected.
        <span onclick="this.parentElement.remove()" 
          style="margin-left:0.75rem;cursor:pointer;opacity:0.7;">✕</span>`;
      document.body.prepend(banner);
    }
  }

  try {
    await coursesEnsureDefaults(user.id);
    currentProfile = await profileLoad(user.id);
    allCourses     = await coursesLoadAll();
    allFriends     = await friendsLoad(user.id);
    if (MULTI_USER) subscribeToFriendRequests();
    if (MULTI_USER) subscribeToGameInvites();

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

    // Stage 2: use _collectRecoverableRounds to merge all sources
    const actives = await _collectRecoverableRounds(user.id);

    if (actives.length > 0) {
      await resumeRound(actives[0].id);
    } else {
      const restored = await tryRestoreSetupState();
      if (!restored) await showHome();
    }
  } catch (err) {
    console.error('onSignedIn error', err);
    await showHome();
  }
}


// ================================================================
// HOME SCREEN
// ================================================================
// Track whether we've shown the first-launch restore prompt this session
let _firstLaunchRestoreShown = false;

async function showHome() {
  showScreen('screen-home');
  renderLogos();
  setActiveBottomNav('nav-play');
  // Signal that the app is ready (used by the ?join= URL handler)
  window.dispatchEvent(new Event('lb-app-ready'));

  // Show no-profile modal if no profile is loaded yet
  const noProfileModal = document.getElementById('no-profile-modal');
  if (noProfileModal) {
    if (!currentProfile) {
      noProfileModal.style.display = '';
    } else {
      noProfileModal.style.display = 'none';
    }
  }

  // First-launch restore prompt — show once per session if no user courses exist
  if (!_firstLaunchRestoreShown) {
    _firstLaunchRestoreShown = true;
    const hasUserCourses = allCourses.some(c => !c.isDefault);
    const hasSeenPrompt  = (() => { try { return !!localStorage.getItem('lb-restore-prompted'); } catch { return false; } })();
    if (!hasUserCourses && !hasSeenPrompt) {
      try { localStorage.setItem('lb-restore-prompted', '1'); } catch {}
      _promptRestore();
    }
  }

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
  const heroSubEl = document.getElementById('home-hero-subline');
  if (heroSubEl) heroSubEl.textContent = [
    myName,
    currentProfile?.hcp != null ? `HCP ${fmtHandicap(currentProfile.hcp)}` : '',
  ].filter(Boolean).join(' · ');

  const hcpEl = document.getElementById('home-stat-hcp');
  if (hcpEl) hcpEl.textContent = currentProfile?.hcp != null
    ? fmtHandicap(currentProfile.hcp) : '--';

  try {
    // Stage 2: use unified collector so IDB-only rounds appear in badge/card
    await _collectRecoverableRounds(currentUser.id);
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
          // On failure, leave draft intact so Active Games can still show it
          if (!ok) showHome();
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

// ── Hold-delay for setup buttons ─────────────────────────────────
// Adds a short press-and-hold requirement to touch events on an element
// so accidental brushes don't trigger navigation.
// Does NOT affect mouse/click events — desktop works unchanged.
// Usage: holdTouch(el)  — wraps existing click handler, 150 ms default
//        holdTouch(el, fn, 200)  — fires fn instead of click
function holdTouch(el, fn, ms = 100) {
  if (!el) return;
  let timer = null;
  let startX = 0, startY = 0;

  const cancel = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    el.classList.remove('is-pressing');
  };

  el.addEventListener('touchstart', (e) => {
    // Only handle single-finger taps
    if (e.touches.length !== 1) return;
    e.preventDefault(); // suppress synthetic click
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    el.classList.add('is-pressing');
    timer = setTimeout(() => {
      timer = null;
      el.classList.remove('is-pressing');
      if (fn) {
        fn(e);
      } else {
        el.click(); // fire existing click handler
      }
    }, ms);
  }, { passive: false });

  el.addEventListener('touchmove', (e) => {
    if (!timer) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) cancel(); // finger moved — scroll intent
  }, { passive: true });

  el.addEventListener('touchend',    cancel, { passive: true });
  el.addEventListener('touchcancel', cancel, { passive: true });
}

// Apply hold-delay to all setup-screen action buttons
// Runs after DOM is ready (we're at module top-level, DOM is parsed)
[
  'btn-setup-course-next',
  'btn-setup-players-next',
  'btn-setup-groups-next',
  'btn-setup-pairs-next',
  'btn-setup-add-new-player',
  'btn-setup-add-from-friends',
  'btn-tee-off',
].forEach(id => holdTouch(document.getElementById(id)));

// Static holes-count buttons (18 / Front 9 / Back 9) on the course setup screen
document.querySelectorAll('[data-holes]').forEach(btn => holdTouch(btn));

// Home screen three-button handlers
// Single Game button → show format picker (both solo and team)
// Home screen format buttons — direct format selection, no intermediate screen
document.querySelectorAll('.fmt-btn').forEach(btn => {
  const handleFmtSelect = () => {
    const fmt = btn.dataset.fmt;
    if (!fmt) return;
    setup.tournamentId     = null;
    setup.tournRoundNumber = null;
    setup.scoring  = fmt;
    setup.courseId = null; setup.teeIdx = 0; setup.holes = 18;
    setup.gameDate = null; setup.pairs  = []; setup.players = [];
    setup.texasMode        = 'average';
    setup.texasScoringFmt  = 'stableford';
    setup.texasTeamSize    = 2;
    setup.teamScoringMode  = 'stableford';
    setup.texasDrivesTotal = null;
    setup.texasDrivesPar3  = null;
    if (fmt === 'split6')                                                { setup.numPlayers = 3; setup.numGroups = 1; setup.playersPerGroup = null; }
    else if (['betterball','csm','foursomes','greensomes'].includes(fmt)){ setup.numPlayers = 4; setup.numGroups = 1; setup.playersPerGroup = null; }
    else if (fmt === 'best2')                                            { setup.numPlayers = 8; setup.numGroups = 2; setup.playersPerGroup = 4;   }
    else if (fmt === 'match')                                            { setup.numPlayers = 2; setup.numGroups = 1; setup.playersPerGroup = null; }
    else if (fmt === 'texas')                                            { setup.numPlayers = (setup.texasTeamSize ?? 2) * 2; setup.numGroups = 1; setup.playersPerGroup = null; }
    else                                                                 { setup.numPlayers = 1; setup.numGroups = 1; setup.playersPerGroup = null; }
    startSetup();
  };
  holdTouch(btn, handleFmtSelect);
  btn.addEventListener('click', (e) => {
    if (e.sourceCapabilities?.firesTouchEvents) return;
    handleFmtSelect();
  });
});

// ── Category tile expand/collapse ────────────────────────────────
(function initCategoryTiles() {
  // Tiles that expand a format list
  const expandTiles = [
    { tileId: 'cat-solo',       formatsId: 'cat-solo-formats' },
    { tileId: 'cat-h2h',        formatsId: 'cat-h2h-formats' },
    { tileId: 'cat-2v2',        formatsId: 'cat-2v2-formats' },
    { tileId: 'cat-team',       formatsId: 'cat-team-formats' },
  ];

  expandTiles.forEach(({ tileId, formatsId }) => {
    const tile    = document.getElementById(tileId);
    const formats = document.getElementById(formatsId);
    if (!tile || !formats) return;

    const toggle = (e) => {
      e.preventDefault();
      const open = tile.getAttribute('aria-expanded') === 'true';
      // Close all other tiles first
      expandTiles.forEach(({ tileId: otherId, formatsId: otherFmtId }) => {
        if (otherId === tileId) return;
        const ot = document.getElementById(otherId);
        const of = document.getElementById(otherFmtId);
        if (ot) ot.setAttribute('aria-expanded', 'false');
        if (of) of.hidden = true;
      });
      tile.setAttribute('aria-expanded', String(!open));
      formats.hidden = open;
    };

    holdTouch(tile, toggle);
    tile.addEventListener('click', (e) => {
      if (e.sourceCapabilities?.firesTouchEvents) return;
      toggle(e);
    });
  });

  // Tournament tile — navigates directly, no expand
  const tournTile = document.getElementById('cat-tournament');
  if (tournTile) {
    const goToTournament = () => showTournamentHub();
    holdTouch(tournTile, goToTournament);
    tournTile.addEventListener('click', (e) => {
      if (e.sourceCapabilities?.firesTouchEvents) return;
      goToTournament();
    });
  }
})();

// ── 2v2 inline accordion — partner format → scoring mode ─────────
(function init2v2Accordion() {
  const container = document.getElementById('cat-2v2-formats');
  if (!container) return;

  container.querySelectorAll('.p2v2-row').forEach(row => {
    const fmt      = row.dataset.fmt;
    const fmtBtn   = row.querySelector('.p2v2-fmt-btn');
    const modesDiv = row.querySelector('.p2v2-modes');
    if (!fmtBtn || !modesDiv) return;

    // Tap partner-format button → toggle its scoring-mode row
    const toggleModes = (e) => {
      e.preventDefault();
      const open = !modesDiv.hidden;
      // Close all other mode rows first
      container.querySelectorAll('.p2v2-modes').forEach(m => { m.hidden = true; });
      container.querySelectorAll('.p2v2-fmt-btn').forEach(b => b.setAttribute('aria-expanded', 'false'));
      if (!open) {
        modesDiv.hidden = false;
        fmtBtn.setAttribute('aria-expanded', 'true');
      }
    };

    holdTouch(fmtBtn, toggleModes);
    fmtBtn.addEventListener('click', (e) => {
      if (e.sourceCapabilities?.firesTouchEvents) return;
      toggleModes(e);
    });

    // Tap a scoring-mode pill → set setup and go
    modesDiv.querySelectorAll('.p2v2-mode-btn').forEach(modeBtn => {
      const handleMode = (e) => {
        e.preventDefault();
        const mode = modeBtn.dataset.mode;
        setup.tournamentId     = null;
        setup.tournRoundNumber = null;
        setup.scoring          = fmt;
        setup.teamScoringMode  = mode;
        setup.courseId = null; setup.teeIdx = 0; setup.holes = 18;
        setup.gameDate = null; setup.pairs  = []; setup.players = [];
        setup.texasMode        = 'average';
        setup.texasScoringFmt  = mode === 'match' ? 'match' : mode;
        setup.texasTeamSize    = 2;
        setup.texasDrivesTotal = null;
        setup.texasDrivesPar3  = null;
        if (['betterball','csm','foursomes','greensomes'].includes(fmt)) {
          setup.numPlayers = 4; setup.numGroups = 1; setup.playersPerGroup = null;
        } else if (fmt === 'texas') {
          setup.numPlayers = 2; setup.numGroups = 1; setup.playersPerGroup = null;
        }
        startSetup();
      };
      holdTouch(modeBtn, handleMode);
      modeBtn.addEventListener('click', (e) => {
        if (e.sourceCapabilities?.firesTouchEvents) return;
        handleMode(e);
      });
    });
  });
})();

// ── Bottom nav ────────────────────────────────────────────────────
document.getElementById('nav-profile')   ?.addEventListener('click', () => { setActiveBottomNav('nav-profile');    showProfile(); });
document.getElementById('nav-friends')   ?.addEventListener('click', () => { setActiveBottomNav('nav-friends');    showFriends(); });
document.getElementById('nav-history')   ?.addEventListener('click', () => { setActiveBottomNav('nav-history');    showHistory(); });
document.getElementById('nav-play')      ?.addEventListener('click', () => { setActiveBottomNav('nav-play');       showHome(); });
// nav-tournament hidden in nav but kept for back-compat; tile on home screen drives navigation now
document.getElementById('nav-tournament')?.addEventListener('click', () => { showTournamentHub(); });

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
  { key: 'texas',      icon: '<svg viewBox="0 0 36 28" width="32" height="28" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><ellipse cx="18" cy="22" rx="16" ry="4.5" fill="currentColor" opacity="0.18"/><path d="M4 22c0 0 2-1 14-1s14 1 14 1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10 22V14c0-5 2.5-9 8-9s8 4 8 9v8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10 14H4.5C3 14 2 15.2 2 16.5c0 2 1.5 4 3.5 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M26 14h5.5c1.5 0 2.5 1.2 2.5 2.5c0 2-1.5 4-3.5 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M14 10c0-1 0.5-2.5 4-2.5s4 1.5 4 2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>', label: 'Texas Scramble', desc: 'All play from best drive · one team score per hole · 2-4 players' },
];

const TEAM_SCORING_FORMATS = ['foursomes','greensomes','texas'];

function updateCourseScreenForFormat(fmt) {
  const teamHcpField = document.getElementById('setup-team-hcp-field');
  if (teamHcpField) teamHcpField.classList.toggle('hidden', fmt !== 'texas');
}


function renderDrivesGrids() {
  const teamSize  = setup.texasTeamSize ?? 2;
  const holesVal  = setup.holes ?? 18;
  const numHoles  = (holesVal === 18) ? 18 : 9;

  // Count par-3s from current tee
  const course    = allCourses.find(c => c.id === setup.courseId);
  const tee       = course?.tees?.[setup.teeIdx ?? 0];
  let par3s       = 0;
  if (tee?.par) {
    const { offset, count } = holeRange(holesVal);
    par3s = tee.par.slice(offset, offset + count).filter(p => p === 3).length;
  }

  const maxTotal = Math.floor(numHoles / teamSize);
  const maxPar3  = Math.floor(par3s  / teamSize);

  function buildGrid(containerId, max, currentVal, onSelect) {
    const grid = document.getElementById(containerId);
    if (!grid) return;
    grid.innerHTML = '';
    for (let i = 0; i <= max; i++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'holes-btn' + (i === currentVal ? ' active' : '');
      btn.style.cssText = 'padding:0.45rem 0.3rem;font-size:1rem;';
      btn.textContent = i;
      btn.addEventListener('click', () => { onSelect(i); renderDrivesGrids(); saveSetupState('screen-setup-course'); });
      grid.appendChild(btn);
    }
  }

  buildGrid('texas-drives-total-grid', maxTotal, setup.texasDrivesTotal ?? 0,
    v => { setup.texasDrivesTotal = v || null; });
  buildGrid('texas-drives-par3-grid',  maxPar3,  setup.texasDrivesPar3  ?? 0,
    v => { setup.texasDrivesPar3  = v || null; });

  // Update hints with computed maxes
  const totalHint = document.getElementById('texas-drives-total-hint');
  const par3Hint  = document.getElementById('texas-drives-par3-hint');
  if (totalHint) totalHint.textContent = `Min. tee shots each player must use · max ${maxTotal} (${numHoles} holes ÷ ${teamSize} players)`;
  if (par3Hint)  par3Hint.textContent  = par3s
    ? `Min. tee shots on par 3s · max ${maxPar3} (${par3s} par 3s ÷ ${teamSize} players)`
    : 'Select a course to calculate par 3 max';
}

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
      setup.gameDate = null; setup.pairs = [];
      // Clear stale game code so scores are never pushed to a previous game
      try { localStorage.removeItem('lb-game-code'); } catch {}
      // Only clear players and tournament context if NOT in tournament mode
      if (!setup.tournamentId) {
        setup.players = [];
      }
      // Clear tournament context if this is a fresh single game
      if (!activeTournament) {
        setup.tournamentId     = null;
        setup.tournRoundNumber = null;
      }
      setup.texasMode        = 'average';
      setup.texasScoringFmt  = 'stableford';
      setup.texasTeamSize    = 2;
      setup.teamScoringMode  = 'stableford';
      setup.texasDrivesTotal = null;
      setup.texasDrivesPar3  = null;
      if (fmt === 'split6')                                                { setup.numPlayers = 3; setup.numGroups = 1; setup.playersPerGroup = null; }
      else if (['betterball','csm','foursomes','greensomes'].includes(fmt)){ setup.numPlayers = 4; setup.numGroups = 1; setup.playersPerGroup = null; }
      else if (fmt === 'best2')                                            { setup.numPlayers = 8; setup.numGroups = 2; setup.playersPerGroup = 4; }
      else if (fmt === 'match')                                            { setup.numPlayers = 2; setup.numGroups = 1; setup.playersPerGroup = null; }
      else if (fmt === 'texas')                                            { setup.numPlayers = (setup.texasTeamSize ?? 2) * 2; setup.numGroups = 1; setup.playersPerGroup = null; }
      else                                                                 { setup.numPlayers = 1; setup.numGroups = 1; setup.playersPerGroup = null; }
      startSetup();
    });
  });

  showScreen('screen-setup-format');
}

document.getElementById('setup-format-back')?.addEventListener('click', () => {
  clearSetupState(); clearSetupDraft(); showHome();
});

// ================================================================
// SETUP -- STEP 1: COURSE
// ================================================================
function startSetup() {
  const fmt = setup.scoring;
  document.getElementById('setup-course-format-label').textContent = FORMAT_LABELS[fmt] ?? fmt;
  updateCourseScreenForFormat(fmt);

  // Show Texas Scramble options card only for that format
  // When coming from the 2v2 play screen the team size and scoring format are pre-set —
  // hide the whole card so the user isn't shown redundant choices.
  const texasCard = document.getElementById('texas-options-card');
  const texas2v2 = fmt === 'texas' && (setup.texasTeamSize ?? 2) === 2;
  if (texasCard) texasCard.classList.toggle('hidden', fmt !== 'texas' || texas2v2);

  if (fmt === 'texas') {
    const setHcpMode = (v) => {
      setup.texasMode = v;
      document.getElementById('texas-hcp-mode').value = v;
      document.getElementById('texas-hcp-average').classList.toggle('active', v === 'average');
      document.getElementById('texas-hcp-weighted').classList.toggle('active', v === 'weighted');
      document.getElementById('texas-hcp-hint').textContent = v === 'weighted'
        ? '25% + 20% + 15% + 10% of player indexes'
        : 'Average of all player indexes';
    };
    const updateTexasScoring = () => {
      const sz   = setup.texasTeamSize ?? 2;
      const mode = setup.texasScoringFmt ?? 'stableford';
      // Scoring format field is always hidden — chosen on the play screen
      document.getElementById('texas-scoring-field')?.setAttribute('hidden', '');
      const matchBtn = document.getElementById('texas-scoring-match');
      if (matchBtn) matchBtn.style.display = sz > 2 ? 'none' : '';
      if (sz > 2 && mode === 'match') setup.texasScoringFmt = 'stableford';
      const m = setup.texasScoringFmt ?? 'stableford';
      document.getElementById('texas-scoring-stableford')?.classList.toggle('active', m === 'stableford');
      document.getElementById('texas-scoring-stroke')?.classList.toggle('active', m === 'stroke');
      if (matchBtn) matchBtn.classList.toggle('active', m === 'match');
      document.getElementById('texas-scoring-fmt').value = m;
      const hint = document.getElementById('texas-scoring-hint');
      if (hint) hint.textContent = m === 'match' ? '2v2 matchplay' : `Multiple teams of ${sz}`;
      document.querySelectorAll('.texas-team-size-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.size) === sz));
    };
    if (!texasCard?._wired) {
      document.querySelectorAll('.texas-team-size-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          setup.texasTeamSize = parseInt(btn.dataset.size);
          setup.numPlayers = setup.texasTeamSize * 2;
          updateTexasScoring();
          renderDrivesGrids();
          saveSetupState('screen-setup-course');
        });
      });
      document.getElementById('texas-scoring-stableford')?.addEventListener('click', () => { setup.texasScoringFmt = 'stableford'; updateTexasScoring(); saveSetupState('screen-setup-course'); });
      document.getElementById('texas-scoring-stroke')?.addEventListener('click', () => { setup.texasScoringFmt = 'stroke'; updateTexasScoring(); saveSetupState('screen-setup-course'); });
      document.getElementById('texas-scoring-match')?.addEventListener('click', () => {
        if ((setup.texasTeamSize??2) > 2) return;
        setup.texasScoringFmt = 'match'; updateTexasScoring(); saveSetupState('screen-setup-course');
      });
      document.getElementById('texas-hcp-average')?.addEventListener('click', () => setHcpMode('average'));
      document.getElementById('texas-hcp-weighted')?.addEventListener('click', () => setHcpMode('weighted'));
      if (texasCard) texasCard._wired = true;
    }
    updateTexasScoring();
    setHcpMode(setup.texasMode ?? 'average');
    renderDrivesGrids();
  }

  populateCourseSelect();
  populateNumPlayerSelect();
  populateNumGroupSelect();
  // Default date to today if not already set
  const datePicker = document.getElementById('setup-game-date');
  if (datePicker && !datePicker.value) {
    datePicker.value = new Date().toISOString().slice(0, 10);
  }
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
  if (setup.scoring === 'texas') renderDrivesGrids();
});
document.getElementById('setup-tee-select')?.addEventListener('change', e => {
  setup.teeIdx = parseInt(e.target.value, 10);
  const course = allCourses.find(c => c.id === setup.courseId);
  if (course) renderSIPreview(course, setup.teeIdx);
  if (setup.scoring === 'texas') renderDrivesGrids();
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
      <div style="display:flex;justify-content:space-between;font-family:'Plus Jakarta Sans',sans-serif;font-weight:400;font-size:0.96rem;color:var(--muted2);line-height:1;">
        <span>${offset+i+1}</span><span>SI ${si}</span>
      </div>
      <div style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:400;font-size:1.4rem;color:var(--white);line-height:1.3;">Par ${parSlice[i]}</div>
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
    if (setup.scoring === 'texas') renderDrivesGrids();
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
  clearSetupState(); clearSetupDraft(); showHome();
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
  setup.gameDate  = document.getElementById('setup-game-date').value || new Date().toISOString().slice(0, 10);
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
  _ensurePlayerCardStyles();
  const listEl  = document.getElementById('setup-player-list');
  const countEl = document.getElementById('setup-player-count-label');
  if (!listEl) return;
  const filled = setup.players.filter(p => p.name);
  const count  = filled.length;
  if (countEl) countEl.textContent = `${count} player${count !== 1 ? 's' : ''} added`;

  // Dynamic "Add N more" hint
  const hintEl = document.getElementById('setup-players-hint');
  if (hintEl) {
    const minNeeded = setup.scoring === 'split6' ? 3
      : ['betterball','csm','foursomes','greensomes'].includes(setup.scoring) ? 4
      : setup.scoring === 'match' ? 2
      : 0;
    const remaining = Math.max(0, minNeeded - count);
    if (remaining > 0) {
      hintEl.textContent = `Add ${remaining} more player${remaining > 1 ? 's' : ''}${remaining === 1 ? '…' : ''}`;
      hintEl.style.display = '';
    } else {
      hintEl.style.display = 'none';
    }
  }

  if (!count) {
    listEl.innerHTML = `<div style="padding:1rem;text-align:center;color:var(--muted);font-size:0.95rem;">No players yet.</div>`;
    return;
  }

  listEl.innerHTML = `<div class="pp-grid">${setup.players.filter(p => p.name).map((p, i) => {
    const pi     = setup.players.indexOf(p);
    const vals   = playerHcpValues(p);
    // Normalise legacy 'playing' source → 'course'
    if (p.hcpSource === 'playing') { p.hcpSource = 'course'; p.gameHandicap = null; }
    const source = p.hcpSource ?? 'course';
    const gameHcp = p.gameHandicap ?? Math.round(vals[source] ?? vals.course);

    const pillStyle = (active) => active
      ? `border:2px solid var(--gold);color:var(--gold);font-weight:800;background:rgba(212,160,23,0.08);`
      : `border:1px solid var(--border);color:var(--muted);font-weight:600;background:transparent;`;

    const indexPill  = `<button class="hcp-pill" data-pi="${pi}" data-src="index"
      style="${pillStyle(source==='index')}font-family:'Plus Jakarta Sans',sans-serif;font-size:0.7rem;
             padding:0.15rem 0.45rem;border-radius:6px;cursor:pointer;
             display:flex;flex-direction:column;align-items:center;min-width:2.8rem;line-height:1.2;">
        <span style="font-size:0.5rem;letter-spacing:0.06em;text-transform:uppercase;">Index</span>
        <span>${fmtHandicap(vals.index)}</span>
      </button>`;

    const coursePill = `<button class="hcp-pill" data-pi="${pi}" data-src="course"
      style="${pillStyle(source==='course')}font-family:'Plus Jakarta Sans',sans-serif;font-size:0.7rem;
             padding:0.15rem 0.45rem;border-radius:6px;cursor:pointer;
             display:flex;flex-direction:column;align-items:center;min-width:2.8rem;line-height:1.2;">
        <span style="font-size:0.5rem;letter-spacing:0.06em;text-transform:uppercase;">Course</span>
        <span>${fmtHandicap(vals.course)}</span>
      </button>`;

    // Nudge controls — shown when source is course and user taps again
    const showNudge = source === 'course' && p._hcpNudgeOpen;
    const nudgeHtml = showNudge ? `
      <div style="display:flex;align-items:center;gap:0.4rem;margin-top:0.5rem;border-top:1px solid rgba(255,255,255,0.07);padding-top:0.5rem;" class="hcp-nudge" data-pi="${pi}">
        <button class="hcp-nudge-btn" data-pi="${pi}" data-dir="-1"
          style="width:1.8rem;height:1.8rem;border-radius:50%;border:1px solid var(--border);
                 background:var(--surface2);font-size:1rem;cursor:pointer;
                 display:flex;align-items:center;justify-content:center;">−</button>
        <span style="font-family:'Plus Jakarta Sans',sans-serif;font-size:1.2rem;font-weight:800;
                     color:var(--gold);min-width:2rem;text-align:center;">${gameHcp}</span>
        <button class="hcp-nudge-btn" data-pi="${pi}" data-dir="1"
          style="width:1.8rem;height:1.8rem;border-radius:50%;border:1px solid var(--border);
                 background:var(--surface2);font-size:1rem;cursor:pointer;
                 display:flex;align-items:center;justify-content:center;">+</button>
        <span style="font-size:0.65rem;color:var(--muted);">Game HCP</span>
      </div>` : '';

    return `<div class="pp-card" style="position:relative;">
      ${pi > 0 ? `<button class="btn btn-ghost" data-remove="${pi}"
        style="position:absolute;top:4px;right:4px;font-size:0.75rem;color:var(--red);
               padding:0.1rem 0.35rem;line-height:1;z-index:1;">✕</button>` : ''}
      <div class="pp-name" style="padding-right:${pi > 0 ? '1.4rem' : '0'};font-size:14px;">${_esc(p.name)}</div>
      <div class="pp-bottom" style="margin-top:auto;">
        <div class="pp-stat">
          <div class="pp-stat-label">Course HCP</div>
          <div class="pp-stat-value">${gameHcp}</div>
        </div>
        <div style="display:flex;gap:0.25rem;align-items:flex-end;">
          ${indexPill}${coursePill}
        </div>
      </div>
      ${nudgeHtml}
    </div>`;
  }).join('')}</div>`;

  // HCP pill click: first tap selects source, second tap on course/playing opens nudge
  listEl.querySelectorAll('.hcp-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const pi  = parseInt(btn.dataset.pi);
      const src = btn.dataset.src;
      const p   = setup.players[pi];
      if (!p) return;

      if (p.hcpSource === src && src !== 'index') {
        // Second tap — toggle nudge open/closed
        p._hcpNudgeOpen = !p._hcpNudgeOpen;
      } else {
        // First tap — select source, close nudge
        p.hcpSource     = src;
        p._hcpNudgeOpen = false;
        // Set gameHandicap to the base value for that source
        const vals = playerHcpValues(p);
        p.gameHandicap  = Math.round(vals[src] ?? vals.course);
        // Auto-propagate to matched-handicap opponents (same as old modal)
      }
      saveSetupState('screen-setup-players');
      saveSetupDraft();
      renderSetupPlayerList();
    });
  });

  // Nudge +/- buttons
  listEl.querySelectorAll('.hcp-nudge-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pi  = parseInt(btn.dataset.pi);
      const dir = parseInt(btn.dataset.dir);
      const p   = setup.players[pi];
      if (!p) return;
      p.gameHandicap = Math.max(0, Math.min(54, (p.gameHandicap ?? 0) + dir));
      saveSetupState('screen-setup-players');
      saveSetupDraft();
      renderSetupPlayerList();
    });
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
// FRIENDS PICKER MODAL (multi-select with HCP pills)
// ================================================================

let _friendsPickerSelected = []; // array of friend objects with _pickerSrc/_pickerVals

function openFriendsPickerModal() {
  _friendsPickerSelected = [];
  const modal   = document.getElementById('modal-add-from-friends');
  const listEl  = document.getElementById('friends-picker-list');
  const addBtn  = document.getElementById('btn-add-selected-friends');
  if (!modal || !listEl) return;

  // Get already-added profile IDs to exclude
  const addedIds = new Set(setup.players.filter(p=>p.profileId).map(p=>p.profileId));

  // friendsLoad already sorts by play frequency then alphabetically
  const friends = [...allFriends]
    .filter(f => !addedIds.has(f.profileId));

  if (!friends.length) {
    listEl.innerHTML = `<div style="padding:2rem;text-align:center;color:var(--muted);">
      No friends to add. Add friends in the Friends tab first.</div>`;
    modal.classList.add('open');
    return;
  }

  const initVals = (f) => f._pickerVals ?? (() => {
    const v = playerHcpValues(f);
    return { index: v.index, course: v.course };
  })();

  const renderFriendsList = () => {
    _ensurePlayerCardStyles();
    listEl.innerHTML = `<div class="pp-grid">` + friends.map((f, fi) => {
      const isSelected = _friendsPickerSelected.some(s => s.profileId === f.profileId);
      const vals  = f._pickerVals ?? initVals(f);
      // Normalise legacy 'playing' source → 'course'
      if (f._pickerSrc === 'playing') f._pickerSrc = 'course';
      const src   = f._pickerSrc ?? 'course';
      const gameHcp = vals[src] ?? vals.course;

      const pill = (label, key) => {
        const active = src === key && isSelected;
        const border = active ? '2px solid var(--gold)' : '1px solid var(--border)';
        const col    = active ? 'var(--gold)' : 'var(--muted)';
        const fw     = active ? '800' : '600';
        const bg2    = active ? 'background:rgba(184,148,42,0.08);' : '';
        return `<button class="fp-pill" data-fi="${fi}" data-key="${key}"
          style="background:transparent;${bg2}border:${border};color:${col};font-weight:${fw};
                 font-family:'Plus Jakarta Sans',sans-serif;font-size:1.3rem;
                 padding:0.3rem 0;border-radius:8px;cursor:pointer;width:3.4rem;flex-shrink:0;
                 display:flex;flex-direction:column;align-items:center;line-height:1.2;">
          <span style="font-size:0.6rem;letter-spacing:0.06em;text-transform:uppercase;">${label}</span>
          <span style="font-variant-numeric:tabular-nums;">${fmtHandicap(vals[key])}</span>
        </button>`;
      };

      // Nudge row — shown when a non-index pill is tapped a second time
      const showNudge = isSelected && f._nudgeOpen && src !== 'index';
      const nudgeHtml = showNudge ? `
        <div style="display:flex;align-items:center;gap:0.5rem;padding:0.5rem 0 0.1rem;"
             onclick="event.stopPropagation()">
          <button class="fp-nudge" data-fi="${fi}" data-dir="-1"
            style="width:2.8rem;height:2.8rem;border-radius:50%;border:1px solid var(--border);
                   background:var(--surface2);font-size:1.6rem;cursor:pointer;
                   display:flex;align-items:center;justify-content:center;">−</button>
          <span style="font-family:'Plus Jakarta Sans',sans-serif;font-size:2rem;font-weight:800;
                       color:var(--gold);min-width:2.5rem;text-align:center;">${gameHcp}</span>
          <button class="fp-nudge" data-fi="${fi}" data-dir="1"
            style="width:2.8rem;height:2.8rem;border-radius:50%;border:1px solid var(--border);
                   background:var(--surface2);font-size:1.6rem;cursor:pointer;
                   display:flex;align-items:center;justify-content:center;">+</button>
          <span style="font-size:0.85rem;color:var(--muted);margin-left:2px;">
            Course HCP
          </span>
          <button class="fp-nudge-update" data-fi="${fi}"
            style="margin-left:auto;padding:0.3rem 0.65rem;background:var(--green);color:#fff;
                   border:none;border-radius:8px;font-size:0.8rem;font-weight:700;cursor:pointer;
                   font-family:'Plus Jakarta Sans',sans-serif;">
            Update profile
          </button>
        </div>` : '';

      const nameStr = f.name || `${f.first_name ?? ''} ${f.last_name ?? ''}`.trim() || f.username || 'Friend';
      const playBadge = f.playCount > 0
        ? `<span style="font-size:0.55rem;color:var(--muted);margin-left:3px;font-weight:600;">⛳${f.playCount}</span>` : '';

      const fpPillStyle = (active) => active
        ? `border:2px solid var(--gold);color:var(--gold);font-weight:800;background:rgba(212,160,23,0.08);`
        : `border:1px solid var(--border);color:var(--muted);font-weight:600;background:transparent;`;

      const fpPill = (label, key) => `<button class="fp-pill" data-fi="${fi}" data-key="${key}"
        style="${fpPillStyle(src===key && isSelected)}font-family:'Plus Jakarta Sans',sans-serif;font-size:0.7rem;
               padding:0.15rem 0.4rem;border-radius:6px;cursor:pointer;
               display:flex;flex-direction:column;align-items:center;min-width:2.8rem;line-height:1.2;">
          <span style="font-size:0.5rem;letter-spacing:0.06em;text-transform:uppercase;">${label}</span>
          <span style="font-variant-numeric:tabular-nums;">${fmtHandicap(vals[key])}</span>
        </button>`;

      return `<div class="fp-row pp-card${isSelected ? ' pp-paired' : ''}" data-fi="${fi}"
        style="cursor:pointer;">
        <div style="display:flex;align-items:flex-start;gap:4px;margin-bottom:2px;">
          <span class="dot" style="background:${pHex(fi%8)};flex-shrink:0;margin-top:3px;"></span>
          <div class="pp-name" style="font-size:14px;flex:1;min-width:0;">
            ${_esc(nameStr)}${playBadge}
          </div>
        </div>
        <div class="pp-bottom" style="margin-top:auto;">
          <div class="pp-stat">
            <div class="pp-stat-label">Course HCP</div>
            <div class="pp-stat-value">${gameHcp}</div>
          </div>
          <div style="display:flex;gap:0.2rem;align-items:flex-end;">
            ${fpPill('Index','index')}${fpPill('Course','course')}
          </div>
        </div>
        ${nudgeHtml}
      </div>`;
    }).join('') + `</div>`;

    // Update add button
    const count = _friendsPickerSelected.length;
    addBtn.textContent = count ? `✓ Add Selected (${count})` : 'Add Selected (0)';
    addBtn.disabled    = count === 0;
    addBtn.style.opacity = count ? '1' : '0.4';

    // Update "Add N more" hint
    const pickerHintEl = document.getElementById('friends-picker-hint');
    if (pickerHintEl) {
      const alreadyAdded = setup.players.filter(p => p.name).length;
      const minNeeded = setup.scoring === 'split6' ? 3
        : ['betterball','csm','foursomes','greensomes'].includes(setup.scoring) ? 4
        : setup.scoring === 'match' ? 2
        : 0;
      const remaining = Math.max(0, minNeeded - alreadyAdded - count);
      if (remaining > 0) {
        pickerHintEl.textContent = `Add ${remaining} more player${remaining > 1 ? 's' : ''}${remaining === 1 ? '…' : ''}`;
        pickerHintEl.style.display = '';
      } else {
        pickerHintEl.style.display = 'none';
      }
    }

    // Row click — toggle selection
    listEl.querySelectorAll('.fp-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.fp-pill') || e.target.closest('.fp-nudge') ||
            e.target.closest('.fp-nudge-update')) return;
        const fi = parseInt(row.dataset.fi);
        const f  = friends[fi];
        const idx2 = _friendsPickerSelected.findIndex(s=>s.profileId===f.profileId);
        if (idx2 === -1) {
          // Check format player cap (already-added + currently selected + this one)
          const capMsg = playerCapAlert(1, _friendsPickerSelected.length);
          if (capMsg) { alert(capMsg); return; }
          f._pickerVals = f._pickerVals ?? initVals(f);
          f._pickerSrc  = f._pickerSrc  ?? 'course';
          _friendsPickerSelected.push(f);
        } else {
          _friendsPickerSelected.splice(idx2, 1);
          f._nudgeOpen = false;
        }
        renderFriendsList();
      });
    });

    // Pill click — select source, second tap opens nudge
    listEl.querySelectorAll('.fp-pill').forEach(pill => {
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        const fi  = parseInt(pill.dataset.fi);
        const key = pill.dataset.key;
        const f   = friends[fi];
        if (!_friendsPickerSelected.find(s=>s.profileId===f.profileId)) {
          f._pickerVals = f._pickerVals ?? initVals(f);
          _friendsPickerSelected.push(f);
        }
        if (f._pickerSrc === key && key !== 'index') {
          f._nudgeOpen = !f._nudgeOpen;
        } else {
          f._pickerSrc = key;
          f._nudgeOpen = false;
        }
        renderFriendsList();
      });
    });

    // Nudge +/- buttons
    listEl.querySelectorAll('.fp-nudge').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const fi  = parseInt(btn.dataset.fi);
        const dir = parseInt(btn.dataset.dir);
        const f   = friends[fi];
        f._pickerVals = f._pickerVals ?? initVals(f);
        const src2 = f._pickerSrc ?? 'course';
        f._pickerVals[src2] = Math.max(0, Math.min(54, (f._pickerVals[src2] ?? 0) + dir));
        renderFriendsList();
      });
    });

    // Guest: link email to real account
    listEl.querySelectorAll('.fp-guest-link-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const fi    = parseInt(btn.dataset.fi);
        const f     = friends[fi];
        const email = listEl.querySelectorAll('.fp-guest-email')[fi]?.value.trim();
        if (!email) { alert('Enter an email address first.'); return; }
        try {
          await guestProfileLinkEmail(f.profileId, email);
          f.email = email;
          btn.textContent = '✓';
          btn.style.background = 'var(--muted)';
          setTimeout(() => renderFriendsList(), 1500);
        } catch(err) {
          alert('Could not link email: ' + err.message);
        }
      });
    });

    // Guest: delete guest friend
    listEl.querySelectorAll('.fp-guest-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const fi = parseInt(btn.dataset.fi);
        const f  = friends[fi];
        if (!confirm(`Remove ${f.name} from your friends list?`)) return;
        try {
          await guestProfileDelete(currentUser?.id, f.profileId, f.friendshipId);
          friends.splice(fi, 1);
          allFriends = allFriends.filter(x => x.profileId !== f.profileId);
          _friendsPickerSelected = _friendsPickerSelected.filter(x => x.profileId !== f.profileId);
          renderFriendsList();
        } catch(err) {
          alert('Could not delete guest: ' + err.message);
        }
      });
    });

    // Update profile button — send in-app message to friend asking if they want to update
    listEl.querySelectorAll('.fp-nudge-update').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const fi  = parseInt(btn.dataset.fi);
        const f   = friends[fi];
        const vals2 = f._pickerVals ?? initVals(f);
        const src2  = f._pickerSrc ?? 'course';
        const newVal = vals2[src2];
        const myName = currentProfile
          ? `${currentProfile.first_name ?? ''} ${currentProfile.last_name ?? ''}`.trim()
          : 'Your playing partner';
        const label = 'Course HCP';

        // Send push notification to friend asking if they want to update
        if (f.profileId) {
          sendPushToUser(f.profileId, {
            title: '⛳ Handicap update suggestion',
            body:  `${myName} played you off ${label} ${newVal}. Want to save this to your profile?`,
            tag:   `hcp-update-${f.profileId}`,
            data:  { url: '/', hcpSuggestion: newVal, hcpLabel: label },
          }).catch(() => {});
        }

        btn.textContent = '✓ Sent!';
        btn.style.background = 'var(--muted)';
        setTimeout(() => {
          btn.textContent = 'Update profile';
          btn.style.background = 'var(--green)';
        }, 2000);
      });
    });
  };

  renderFriendsList();
  modal.classList.add('open');
}

// ================================================================
// PLAYER HCP PICKER MODAL
// ================================================================

// Resolves the three base values for a player (before any manual adjustment)
function playerHcpValues(p) {
  const idx = p.hcpIndex ?? p.hcp ?? 0;

  // Check if player's home course matches current game course
  const gameCourseId  = setup.courseId;
  const tee           = (() => { try { return allCourses?.find(c=>c.id===gameCourseId)?.tees?.[setup.teeIdx??0]; } catch{return null;} })();
  const teeName       = tee?.name ?? null;
  const homeHcps      = p.home_course_handicaps ?? {};
  const homeCourseId  = p.home_course_id ?? null;

  // Home course matches — use stored tee handicaps
  if (homeCourseId && gameCourseId && homeCourseId === gameCourseId && teeName && homeHcps[teeName]) {
    const teeData = homeHcps[teeName];
    const crs = typeof teeData === 'object' ? (teeData.course  ?? Math.round(idx)) : Number(teeData);
    return { index: idx, course: crs };
  }

  // Different course — calculate from slope/rating if available, else round index
  if (tee?.courseRating && tee?.slopeRating) {
    const par = tee.par?.reduce((a,b)=>a+b,0) ?? 72;
    const crs = Math.max(0, Math.round(idx * tee.slopeRating / 113 + (tee.courseRating - par)));
    return { index: idx, course: crs };
  }

  // Fallback — use stored courseHandicap or round index
  const crs = p.courseHandicap ?? Math.round(idx);
  return { index: idx, course: crs };
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
    index:  (p.hcpSource === 'index'  && p.gameHandicap != null) ? p.gameHandicap : Math.round(vals.index),
    course: (p.hcpSource === 'course' && p.gameHandicap != null) ? p.gameHandicap : Math.round(vals.course),
  };

  // Normalise legacy 'playing' → 'course'
  _hcpPickerSource = (p.hcpSource === 'playing' || !p.hcpSource) ? 'course' : p.hcpSource;

  // Fill profile-default labels under each row title
  document.getElementById('hcp-index-profile').textContent   = `Profile: ${fmtHandicap(vals.index)}`;
  document.getElementById('hcp-course-profile').textContent  = `Profile: ${fmtHandicap(vals.course)}`;

  _renderHcpPickerRows();
  document.getElementById('modal-player-hcp').classList.add('open');
}

function _renderHcpPickerRows() {
  ['index','course'].forEach(src => {
    const row       = document.getElementById(`hcp-row-${src}`);
    const counter   = document.getElementById(`hcp-counter-${src}`);
    const preview   = document.getElementById(`hcp-preview-${src}`);
    const valSpan   = document.getElementById(`hcp-val-${src}`);
    const isActive  = src === _hcpPickerSource;
    if (!row) return;

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
        q.gameHandicap = source === 'index' ? Math.round(qv.index) : Math.round(qv.course);
      }
    });
  }

  modal.classList.remove('open');
  renderSetupPlayerList();
});

// Open add-player modal (for adding a NEW player)
// ── Add Players screen handlers ──────────────────────────────────

// New Player button → open modal
// ── New Player Modal: tee table ─────────────────────────────────
function renderNewPlayerTeeTable() {
  const courseId  = document.getElementById('game-manual-course-select')?.value || null;
  const section   = document.getElementById('game-manual-tee-section');
  const rowsEl    = document.getElementById('game-manual-tee-rows');
  if (!section || !rowsEl) return;

  const course = courseId ? allCourses.find(c => c.id === courseId) : null;
  if (!course || !course.tees?.length) {
    section.classList.add('hidden');
    rowsEl.innerHTML = '';
    return;
  }
  section.classList.remove('hidden');

  rowsEl.innerHTML = (course.tees ?? []).map(t => {
    return `
      <div style="display:grid;grid-template-columns:1fr auto;gap:0.3rem 0.5rem;
                  align-items:center;margin-bottom:0.3rem;">
        <div style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:700;
                    font-size:1rem;color:var(--white);">${t.name}</div>
        <input data-tee="${t.name}" data-type="course" class="np-tee-input"
          type="number" step="1" min="0" max="54" placeholder="--"
          style="text-align:center;padding:0.4rem;border-radius:6px;
                 border:1px solid var(--border);background:var(--surface2);
                 color:var(--white);font-size:0.95rem;width:3.5rem;">
      </div>`;
  }).join('');

  // Fields default to empty (--) — user fills them in manually
}

document.getElementById('game-manual-course-select')?.addEventListener('change', () => {
  // Skip tee table render when modal is in edit mode (tee section is hidden)
  const modal = document.getElementById('modal-add-game-player');
  if (modal?.dataset.friendsMode === '1') return;
  renderNewPlayerTeeTable();
});

// Returns an alert string if adding `adding` more players would exceed the format cap, else null.
// `pending` = friends already ticked in the picker but not yet in setup.players
function playerCapAlert(adding = 1, pending = 0) {
  const current = setup.players.filter(p => p.name).length;
  const after   = current + pending + adding;
  if (setup.scoring === 'match'  && after > 2) return 'Match play is 1 vs 1 — only 2 players allowed.';
  if (setup.scoring === 'split6' && after > 3) return 'Split 6 needs exactly 3 players — no more can be added.';
  if (setup.scoring === 'texas') {
    // 2v2 scramble: 2 teams × texasTeamSize players each
    const maxTexas = (setup.texasTeamSize ?? 2) * 2;
    if (after > maxTexas) return `Texas Scramble team size is ${setup.texasTeamSize ?? 2} — max ${maxTexas} players (2 teams).`;
  }
  if (after > 4) return 'Maximum 4 players per game.';
  return null;
}

document.getElementById('btn-setup-add-new-player')?.addEventListener('click', () => {
  const capMsg = playerCapAlert(1);
  if (capMsg) { alert(capMsg); return; }
  // Pre-fill course/playing HCP from tee data if available
  const tee = (() => {
    try {
      const course = allCourses?.find(c => c.id === setup.courseId);
      return course?.tees?.[setup.teeIdx ?? 0] ?? null;
    } catch { return null; }
  })();

  document.getElementById('game-manual-first').value  = '';
  document.getElementById('game-manual-last').value   = '';
  document.getElementById('game-manual-hcp').value    = '';
  document.getElementById('game-manual-chcp').value   = '';
  document.getElementById('game-manual-phcp').value   = '';
  document.getElementById('game-manual-email').value  = '';
  document.getElementById('game-manual-name').value   = '';
  const saveGuestEl = document.getElementById('game-manual-save-guest');
  if (saveGuestEl) saveGuestEl.checked = false;

  // Populate course select
  const crsSelect = document.getElementById('game-manual-course-select');
  if (crsSelect) {
    crsSelect.innerHTML = '<option value="">— No home course —</option>' +
      (allCourses ?? []).map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    // Default to current game course if set
    if (setup.courseId) crsSelect.value = setup.courseId;
  }
  renderNewPlayerTeeTable();

  const modal = document.getElementById('modal-add-game-player');
  delete modal.dataset.editIdx;
  modal.classList.add('open');
  document.getElementById('game-manual-first').focus();
});

// Auto-fill course/playing when index is entered
document.getElementById('game-manual-hcp')?.addEventListener('input', function() {
  const idx = parseFloat(this.value);
  if (isNaN(idx)) return;
  const tee    = (() => { try { return allCourses?.find(c=>c.id===setup.courseId)?.tees?.[setup.teeIdx??0]; } catch{return null;} })();
  const cr     = tee?.courseRating ?? 72;
  const sr     = tee?.slopeRating  ?? 113;
  const chcp   = Math.round(idx * sr / 113 + (cr - (tee?.par ?? 72)));
  const phcp   = Math.round(chcp);
  const chcpEl = document.getElementById('game-manual-chcp');
  const phcpEl = document.getElementById('game-manual-phcp');
  if (chcpEl && !chcpEl.value) chcpEl.value = Math.max(0, chcp);
  if (phcpEl && !phcpEl.value) phcpEl.value = Math.max(0, phcp);
});

document.getElementById('modal-add-game-player-close')?.addEventListener('click', () => {
  const modal = document.getElementById('modal-add-game-player');
  delete modal.dataset.editIdx;
  delete modal.dataset.editGuestId;
  delete modal.dataset.editRealFriendId;
  modal.classList.remove('open');
  // Restore title, save-guest checkbox, tee section and email field
  const titleEl = document.querySelector('#modal-add-game-player .modal-header div');
  if (titleEl) titleEl.textContent = 'New Player';
  const sg = document.getElementById('game-manual-save-guest');
  if (sg) {
    sg.disabled = false;
    const row = sg.closest('label') || sg.parentElement;
    if (row) row.style.display = '';
  }
  const teeSectionEl = document.getElementById('game-manual-tee-section');
  if (teeSectionEl) { teeSectionEl.style.display = ''; teeSectionEl.classList.remove('hidden'); }
  const emailFieldEl = document.getElementById('game-manual-email')?.closest('.field');
  if (emailFieldEl) emailFieldEl.style.display = '';
});

// From Friends button → open friends picker
document.getElementById('btn-setup-add-from-friends')?.addEventListener('click', () => {
  const capMsg = playerCapAlert(1);
  if (capMsg) { alert(capMsg); return; }
  openFriendsPickerModal();
});

// Friends picker modal close
document.getElementById('btn-friends-modal-close')?.addEventListener('click', () => {
  document.getElementById('modal-add-from-friends').classList.remove('open');
});

// Add Guest Friend from Friends tab — opens same new player modal, guest mode
document.getElementById('btn-add-guest-friend')?.addEventListener('click', () => {
  // Reset modal fields
  document.getElementById('game-manual-first').value  = '';
  document.getElementById('game-manual-last').value   = '';
  document.getElementById('game-manual-hcp').value    = '';
  document.getElementById('game-manual-chcp').value   = '';
  document.getElementById('game-manual-phcp').value   = '';
  document.getElementById('game-manual-email').value  = '';
  document.getElementById('game-manual-name').value   = '';

  // Pre-tick "save as guest" — that's the whole point here
  const saveGuestEl = document.getElementById('game-manual-save-guest');
  if (saveGuestEl) saveGuestEl.checked = true;

  // Populate course dropdown
  const crsSelect = document.getElementById('game-manual-course-select');
  if (crsSelect) {
    crsSelect.innerHTML = '<option value="">— No home course —</option>' +
      (allCourses ?? []).map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    crsSelect.value = ''; // no default course when adding outside a game
  }
  renderNewPlayerTeeTable();

  // Ensure save row visible and re-enabled
  if (saveGuestEl) {
    const row = saveGuestEl.closest('label') || saveGuestEl.parentElement;
    if (row) row.style.display = '';
    saveGuestEl.disabled = false;
  }

  // Reset modal title and clear any lingering edit-mode flags
  const titleEl = document.querySelector('#modal-add-game-player .modal-header div');
  if (titleEl) titleEl.textContent = 'New Player';
  const modal = document.getElementById('modal-add-game-player');
  delete modal.dataset.editGuestId;
  delete modal.dataset.editRealFriendId;
  modal.dataset.friendsMode = '1';
  modal.classList.add('open');
  document.getElementById('game-manual-first').focus();
});

// Add Selected Friends button
document.getElementById('btn-add-selected-friends')?.addEventListener('click', async () => {
  const capMsg = playerCapAlert(_friendsPickerSelected.length);
  if (capMsg) { alert(capMsg); return; }
  const selected = [..._friendsPickerSelected];
  for (const f of selected) {
    const fv   = f._pickerVals ?? {};
    const src  = f._pickerSrc ?? 'course';
    const idx  = fv.index  ?? f.hcp ?? 0;
    const chcp = fv.course ?? f.hcp ?? 0;
    const ply  = fv.playing ?? chcp;
    const name = f.name || `${f.first_name ?? ''} ${f.last_name ?? ''}`.trim() || 'Friend';

    addSetupPlayer(name, idx, chcp, f.profileId ?? null);

    const addedP = setup.players.find(p => p.profileId === f.profileId);
    if (addedP) {
      addedP.hcpSource             = src;
      addedP.gameHandicap          = Math.round(fv[src] ?? chcp);
      addedP.home_course_id        = f.home_course_id ?? null;
      addedP.home_course_handicaps = f.home_course_handicaps ?? {};
      addedP.isGuest               = f.isGuestTable ?? f.is_guest ?? false;
    }

    // Auto-save HCPs if playing on their home course and values have changed
    const isSameCourse = f.home_course_id && setup.courseId && f.home_course_id === setup.courseId;
    if (isSameCourse && f.profileId && currentUser?.id) {
      const gameTee  = allCourses?.find(c=>c.id===setup.courseId)?.tees?.[setup.teeIdx??0];
      const teeName  = gameTee?.name;
      if (teeName) {
        const savedTee = f.home_course_handicaps?.[teeName] ?? {};
        const savedCrs = typeof savedTee === 'object' ? (savedTee.course ?? null) : savedTee;
        const hcpChanged = Math.round(idx) !== Math.round(f.hcp ?? 0);
        const crsChanged = Math.round(chcp) !== Math.round(savedCrs ?? 0);
        if (hcpChanged || crsChanged) {
          try {
            const updatedHcps = { ...(f.home_course_handicaps ?? {}), [teeName]: { course: Math.round(chcp) } };
            if (MULTI_USER) {
              // Supabase path: update remote profile directly
              await sb.from('profiles').update({ hcp: idx, home_course_handicaps: updatedHcps }).eq('id', f.profileId);
            } else {
              // Local path: update the player record in IDB
              await guestProfileUpdate(f.profileId, { hcp: idx, home_course_handicaps: updatedHcps });
            }
            f.hcp = idx; f.home_course_handicaps = updatedHcps;
            console.log('[guest] Auto-saved HCPs for', name);
          } catch(err) { console.warn('[guest] Auto-save failed:', err.message); }
        }
      }
    }
  }
  _friendsPickerSelected = [];
  document.getElementById('modal-add-from-friends').classList.remove('open');
  renderSetupPlayerList();
});


document.getElementById('btn-game-confirm-player')?.addEventListener('click', async (e) => {
  const confirmBtn = e.currentTarget;
  if (confirmBtn._busy) return;
  confirmBtn._busy = true;
  confirmBtn.disabled = true;

  const first   = document.getElementById('game-manual-first')?.value.trim() ?? '';
  const last    = document.getElementById('game-manual-last')?.value.trim()  ?? '';
  const email   = document.getElementById('game-manual-email')?.value.trim() ?? '';
  const hcpRaw  = document.getElementById('game-manual-hcp').value.trim();
  const name    = first ? `${first} ${last}`.trim() : document.getElementById('game-manual-name').value.trim();
  if (!name) {
    alert('Please enter a player name.');
    confirmBtn._busy = false; confirmBtn.disabled = false;
    return;
  }

  // Close modal immediately — before async work
  const modal = document.getElementById('modal-add-game-player');
  modal?.classList.remove('open');
  // Reset button state so next player can be added
  confirmBtn._busy = false;
  confirmBtn.disabled = false;
  const hcp  = hcpRaw ? parseFloat(hcpRaw) : 0;

  // Collect tee table data (home course handicaps)
  const homeCourseId = document.getElementById('game-manual-course-select')?.value || null;
  const homeCourseHcps = {};
  document.querySelectorAll('.np-tee-input').forEach(inp => {
    const tee  = inp.dataset.tee;
    const type = inp.dataset.type;
    const v    = inp.value.trim();
    if (v) {
      if (!homeCourseHcps[tee]) homeCourseHcps[tee] = {};
      homeCourseHcps[tee][type] = parseFloat(v);
    }
  });

  // For playerHcpValues: use the tee matching the current game tee
  const gameTee     = allCourses?.find(c=>c.id===setup.courseId)?.tees?.[setup.teeIdx??0];
  const gameTeeData = gameTee && homeCourseId === setup.courseId
    ? homeCourseHcps[gameTee.name] : null;
  const chcp = gameTeeData?.course ?? null;
  const phcp = gameTeeData?.playing ?? null;
  // Update hidden name field for back-compat
  document.getElementById('game-manual-name').value = name;
  // Save as guest friend if checkbox checked
  // Check if we're editing an existing guest
  const editGuestId = modal?.dataset?.editGuestId;
  if (editGuestId) {
    delete modal.dataset.editGuestId;
    try {
      const homeCourseHcpsFull = {};
      document.querySelectorAll('.np-tee-input').forEach(inp => {
        const tee = inp.dataset.tee, type = inp.dataset.type, v = inp.value.trim();
        if (v) { if (!homeCourseHcpsFull[tee]) homeCourseHcpsFull[tee] = {}; homeCourseHcpsFull[tee][type] = parseFloat(v); }
      });
      await guestProfileUpdate(editGuestId, {
        first_name:            first || name,
        last_name:             last  || '',
        hcp:                   hcp,
        email:                 email || null,
        home_course_id:        homeCourseId || null,
        home_course_handicaps: Object.keys(homeCourseHcpsFull).length ? homeCourseHcpsFull : null,
      });
    } catch(err) {
      console.error('[guest] Update failed:', err.message);
      alert('⚠️ Could not update player: ' + err.message);
    }
    // Restore UI
    const saveGuestEl2 = document.getElementById('game-manual-save-guest');
    if (saveGuestEl2) {
      saveGuestEl2.disabled = false;
      const row2 = saveGuestEl2.closest('label') || saveGuestEl2.parentElement;
      if (row2) row2.style.display = '';
    }
    const titleEl2 = document.querySelector('#modal-add-game-player .modal-header div');
    if (titleEl2) titleEl2.textContent = 'New Player';
    allFriends = await friendsLoad(currentUser.id);
    await showFriends();
    return;
  }

  const saveAsGuest = document.getElementById('game-manual-save-guest')?.checked;
  let guestProfileId = null;
  if (saveAsGuest && currentUser?.id) {
    try {
      console.log('[guest] Creating:', first || name, 'userId:', currentUser.id);
      guestProfileId = await guestProfileCreate(currentUser.id, {
        first_name:            first || name,
        last_name:             last  || '',
        hcp:                   hcp,
        home_course_id:        homeCourseId,
        home_course_handicaps: Object.keys(homeCourseHcps).length ? homeCourseHcps : null,
      });
      console.log('[guest] Created, id:', guestProfileId);
      allFriends = await friendsLoad(currentUser.id);
      console.log('[guest] Friends count:', allFriends.length);
      // If opened from friends tab: refresh and return
      if (modal?.dataset?.friendsMode === '1') {
        delete modal.dataset.friendsMode;
        await showFriends();
        return;
      }
    } catch (err) {
      console.error('[guest] FAILED:', err.message);
      alert('⚠️ Could not save guest: ' + err.message);
    }
  }

  // If email provided — send invite in background (multi-user mode only)
  if (email && MULTI_USER) {
    const myName = currentProfile
      ? `${currentProfile.first_name ?? ''} ${currentProfile.last_name ?? ''}`.trim()
      : 'A friend';
    fetch('/api/invite-friend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inviterProfileId: currentUser?.id, inviterName: myName, recipientEmail: email }),
    }).catch(() => {});
  }

  const editIdx = modal?.dataset.editIdx != null && modal?.dataset.editIdx !== ''
    ? parseInt(modal.dataset.editIdx) : -1;

  if (editIdx >= 0 && setup.players[editIdx]) {
    // Edit existing player
    setup.players[editIdx] = { ...setup.players[editIdx], name, hcpIndex: hcp, courseHandicap: chcp ?? hcp };
    delete modal.dataset.editIdx;
    saveSetupState('screen-setup-players');
    renderSetupPlayerList();
  } else {
    // Add new player
    delete modal?.dataset?.editIdx;
    const effectivePhcp = phcp ?? chcp ?? hcp;
    addSetupPlayer(name, hcp, chcp ?? hcp, guestProfileId);
    // Store home course handicaps on the player for smart HCP lookup
    const addedP = setup.players.slice().reverse().find(p => p.name === name);
    if (addedP) {
      addedP.home_course_id        = homeCourseId;
      addedP.home_course_handicaps = homeCourseHcps;
      addedP.isGuest               = !!guestProfileId; // guest if we just created one
      if (chcp != null) { addedP.hcpSource = 'course'; addedP.gameHandicap = chcp; }
    }

  }
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
  const vals = { index: Math.round(hcpIndex ?? 0), course: Math.round(courseHandicap ?? hcpIndex ?? 0) };
  newPlayer.gameHandicap = inheritedSource === 'index' ? vals.index : vals.course;

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
  const minPlayers = setup.scoring === 'split6' ? 3
    : ['betterball','csm','foursomes','greensomes'].includes(setup.scoring) ? 4
    : setup.scoring === 'texas' ? (setup.texasTeamSize ?? 2) * 2
    : ['match','best2','skins','itc'].includes(setup.scoring) ? 2
    : 1;
  if (filled.length < minPlayers) { alert(`Add at least ${minPlayers} player${minPlayers > 1 ? 's' : ''}.`); return; }

  // Formats that need the Arrange Groups / Pair Up screen
  const NEEDS_GROUPS = ['match','betterball','csm','foursomes','greensomes','texas'];
  // Texas match play (2v2) also needs pairing; other texas modes go straight to review
  const isPairs = ['betterball','csm','foursomes','greensomes'].includes(setup.scoring)
    || (setup.scoring === 'texas' && setup.texasScoringFmt === 'match');

  if (isPairs) {
    initSetupPairs();
    showScreen('screen-setup-pairs');
  } else {
    // All formats (including match, texas, best2, stableford, stroke, skins, etc.)
    // go straight to review — the groups screen has been removed from the flow
    renderSetupGroupCards(); // ensure group data is initialised
    buildSetupReview();
    showScreen('screen-setup-review');
  }
});

// ================================================================
// SHARE COMPETITION QR — button on Add Players screen
// ================================================================

// Lazy-loaded QR module (avoids importing the 25kB library until needed)
let _qrMod = null;
async function getQRMod() {
  if (!_qrMod) _qrMod = (await import('./qr.js')).default;
  return _qrMod;
}

const APP_BASE_URL = 'https://ldrbd.app/';

// Show / hide the Share QR button — visible whenever a course has been selected
function updateShareQRButtonVisibility() {
  const btn = document.getElementById('btn-share-competition-qr');
  if (!btn) return;
  btn.style.display = setup.courseId ? 'block' : 'none';
  const courseBtn = document.getElementById('btn-share-course-qr');
  if (courseBtn) courseBtn.style.display = setup.courseId && setup.teeIdx != null ? 'block' : 'none';
}

// ── Course Info QR ─────────────────────────────────────────────────────────

// ── Compact SI encoding: store as 18-char base-36 string ──────────
// siArr[i] = SI rank of hole i+1. We invert: rank->hole, encode each hole as base36 char.
// e.g. SI [1,3,5,...] -> inv=[hole with SI1, hole with SI2,...] -> '1a2b...'
// This saves ~26 chars vs comma-separated, shrinking the QR from version 14 to 8.
function _encodeSI(siArr) {
  const holes = siArr.length;
  const inv   = new Array(holes);
  siArr.forEach((rank, holeIdx) => { inv[rank - 1] = holeIdx + 1; });
  return inv.map(h => h.toString(36)).join('');
}
function _decodeSI(s, holes) {
  const inv   = s.split('').map(c => parseInt(c, 36));
  const siArr = new Array(holes);
  inv.forEach((hole, rankIdx) => { if (hole >= 1 && hole <= holes) siArr[hole - 1] = rankIdx + 1; });
  return siArr;
}

function buildCourseQRPayload() {
  const course = allCourses.find(c => c.id === setup.courseId) ?? null;
  const tee    = course?.tees?.[setup.teeIdx] ?? null;
  if (!course || !tee) return null;
  return {
    v:  2,
    cn: course.name,
    t: {
      n: tee.name,
      s: _encodeSI(tee.si  ?? []),   // compact SI
      p: (tee.par ?? []).join(''),    // compact par: '443443354...' no commas
      ...(tee.courseRating != null ? { cr: tee.courseRating } : {}),
      ...(tee.slopeRating  != null ? { sr: tee.slopeRating  } : {}),
    },
  };
}

function decodeCourseQRPayload(raw) {
  try {
    const trimmed = (raw || '').trim();
    const b64 = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    const pad  = (4 - (b64.length % 4)) % 4;
    const obj  = JSON.parse(atob(b64 + '='.repeat(pad)));
    if (obj.v !== 2 || !obj.cn || !obj.t) return null;
    // Support both compact (t.s / t.p as strings) and legacy (t.si / t.p as comma strings)
    let par, si;
    if (obj.t.s != null) {
      // Compact format: p is digit string '443...', s is base36 SI
      par = (obj.t.p || '').split('').map(Number).filter(n => n >= 3 && n <= 6);
      si  = _decodeSI(obj.t.s, par.length || 18);
    } else {
      // Legacy comma-separated format
      par = (obj.t.p  || '').split(',').map(Number).filter(n => !isNaN(n));
      si  = (obj.t.si || '').split(',').map(Number).filter(n => !isNaN(n));
    }
    return {
      courseName: obj.cn,
      tee: {
        name: obj.t.n ?? '',
        si,
        par,
        ...(obj.t.cr != null ? { courseRating: obj.t.cr } : {}),
        ...(obj.t.sr != null ? { slopeRating:  obj.t.sr } : {}),
      },
    };
  } catch { return null; }
}

async function openCourseQRModal() {
  const modal  = document.getElementById('modal-course-qr');
  if (!modal) return;
  const payload = buildCourseQRPayload();
  if (!payload) return;

  const course = allCourses.find(c => c.id === setup.courseId);
  const tee    = course?.tees?.[setup.teeIdx];
  const nameEl = document.getElementById('modal-course-qr-name');
  const teeEl  = document.getElementById('modal-course-qr-tee');
  const svgEl  = document.getElementById('modal-course-qr-svg');

  if (nameEl) nameEl.textContent = course?.name ?? '';
  if (teeEl)  teeEl.textContent  = tee?.name ? `Tee: ${tee.name}  ·  ${(tee.par ?? []).length} holes` : '';
  if (svgEl)  svgEl.innerHTML = '<span style="opacity:0.5">Generating QR…</span>';
  modal.classList.add('open');

  const json    = JSON.stringify(payload);
  const b64url  = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  // Encode as a full URL so native iOS camera can scan it directly
  const qrUrl   = APP_BASE_URL + '?qr=' + b64url;

  // Wire copy button — copies the full URL for sharing via iMessage/AirDrop
  const copyBtn = document.getElementById('btn-copy-course-code');
  if (copyBtn) {
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(qrUrl);
        copyBtn.textContent = '✅ Copied!';
        setTimeout(() => { copyBtn.textContent = '📋 Copy course link'; }, 2000);
      } catch { prompt('Copy this course link:', qrUrl); }
    };
  }

  try {
    const qr  = await getQRMod();
    const svg = await qr.toSVG(qrUrl, {
      errorCorrectionLevel: 'M',
      width: 280,
      margin: 2,
    });
    if (svgEl) svgEl.innerHTML = svg;
  } catch (err) {
    if (svgEl) svgEl.innerHTML = '<span style="color:var(--error,#e53e3e)">QR generation failed</span>';
  }
}

document.getElementById('btn-share-course-qr')?.addEventListener('click', openCourseQRModal);
document.getElementById('btn-modal-course-qr-close')?.addEventListener('click', () => {
  document.getElementById('modal-course-qr')?.classList.remove('open');
});
document.getElementById('modal-course-qr')?.addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
});

// Import course toggle
document.getElementById('import-course-toggle')?.addEventListener('click', () => {
  const section  = document.getElementById('import-course-section');
  const chevron  = document.getElementById('import-course-chevron');
  if (!section) return;
  const open = section.style.display !== 'none';
  section.style.display = open ? 'none' : 'block';
  if (chevron) chevron.style.transform = open ? '' : 'rotate(90deg)';
});

function importCourseFromCode(raw) {
  const statusEl = document.getElementById('import-course-status');
  const data = decodeCourseQRPayload(raw);
  if (!data) {
    if (statusEl) { statusEl.textContent = '❌ Could not read that code.'; statusEl.style.color = 'var(--error,#e53e3e)'; }
    return;
  }

  // Check if course already exists (by name, case-insensitive)
  const existing = allCourses.find(c => c.name.toLowerCase() === data.courseName.toLowerCase());
  if (existing) {
    // Just select it and pick the matching tee
    const teeIdx = existing.tees?.findIndex(t => t.name.toLowerCase() === data.tee.name.toLowerCase()) ?? -1;
    setup.courseId = existing.id;
    setup.teeIdx   = teeIdx >= 0 ? teeIdx : 0;
    const sel = document.getElementById('setup-course-select');
    if (sel) sel.value = existing.id;
    populateCourseSelect();
    const teeSel = document.getElementById('setup-tee-select');
    if (teeSel) teeSel.value = String(setup.teeIdx);
    if (statusEl) { statusEl.textContent = `✅ Selected: ${existing.name}`; statusEl.style.color = 'var(--green,#48bb78)'; }
    const inp = document.getElementById('import-course-input');
    if (inp) inp.value = '';
    updateShareQRButtonVisibility();
    return;
  }

  // Save as new course via courseSave (async)
  const newCourse = {
    name: data.courseName,
    tees: [{
      name:         data.tee.name,
      si:           data.tee.si,
      par:          data.tee.par,
      ...(data.tee.courseRating != null ? { courseRating: data.tee.courseRating } : {}),
      ...(data.tee.slopeRating  != null ? { slopeRating:  data.tee.slopeRating  } : {}),
    }],
  };
  return courseSave(newCourse).then(async saved => {
    allCourses = await coursesLoadAll();
    setup.courseId = saved.id;
    setup.teeIdx   = 0;
    const sel = document.getElementById('setup-course-select');
    if (sel) sel.value = saved.id;
    populateCourseSelect();
    const teeSel = document.getElementById('setup-tee-select');
    if (teeSel) teeSel.value = '0';
    if (statusEl) { statusEl.textContent = `✅ Imported: ${data.courseName}`; statusEl.style.color = 'var(--green,#48bb78)'; }
    const inp = document.getElementById('import-course-input');
    if (inp) inp.value = '';
    updateShareQRButtonVisibility();
  }).catch(err => {
    if (statusEl) { statusEl.textContent = `❌ Save failed: ${err.message}`; statusEl.style.color = 'var(--error,#e53e3e)'; }
  });
}

document.getElementById('btn-import-course')?.addEventListener('click', () => {
  importCourseFromCode(document.getElementById('import-course-input')?.value);
});
document.getElementById('import-course-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') importCourseFromCode(e.target.value);
});

// Build the QR payload object from the current setup.
// Uses short keys and compressed arrays to keep QR as small as possible.
function buildQRPayload(competitionRec) {
  const course = allCourses.find(c => c.id === setup.courseId) ?? null;
  const tee    = course?.tees?.[setup.teeIdx] ?? null;

  // Compress tee data: si and par as comma-joined strings, short keys
  const teePayload = tee ? {
    n:  tee.name,
    si: (tee.si  ?? []).join(','),
    p:  (tee.par ?? []).join(','),
    ...(tee.courseRating != null ? { cr: tee.courseRating } : {}),
    ...(tee.slopeRating  != null ? { sr: tee.slopeRating  } : {}),
  } : null;

  return {
    v:   1,
    cid: competitionRec.competitionId,
    cn:  competitionRec.name,
    c:   course ? { n: course.name, t: teePayload } : null,
  };
}

// Expand a compressed v2-style payload back to the full shape decodeJoinPayload expects
function expandQRPayload(obj) {
  if (obj.course) return obj; // already full format (v1 legacy)
  if (!obj.c) return null;
  const t = obj.c.t;
  return {
    v:      obj.v,
    cid:    obj.cid,
    cn:     obj.cn,
    course: {
      name:  obj.c.n,
      location: null,
      tees: t ? [{
        name:         t.n,
        color:        null,
        si:           (t.si || '').split(',').map(Number),
        par:          (t.p  || '').split(',').map(Number),
        ...(t.cr != null ? { courseRating: t.cr } : {}),
        ...(t.sr != null ? { slopeRating:  t.sr } : {}),
      }] : [],
    },
    ti: 0,
  };
}

// Encode payload as base64url and append to the app URL
function buildQRURL(payload) {
  const json    = JSON.stringify(payload);
  const b64url  = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return APP_BASE_URL + '?join=' + b64url;
}

// Open the QR modal and render the code
async function openQRShareModal(competitionRec) {
  const modal = document.getElementById('modal-qr-share');
  if (!modal) return;

  // Update modal text
  const nameEl   = document.getElementById('modal-qr-comp-name');
  const courseEl = document.getElementById('modal-qr-course-name');
  const svgEl    = document.getElementById('modal-qr-svg');
  if (nameEl)   nameEl.textContent   = competitionRec.name ?? 'Competition';
  if (courseEl) {
    const course = allCourses.find(c => c.id === setup.courseId);
    const tee    = course?.tees?.[setup.teeIdx];
    courseEl.textContent = [course?.name, tee?.name].filter(Boolean).join(' — ');
  }

  // Show spinner while generating
  if (svgEl) svgEl.innerHTML = '<span style="opacity:0.5">Generating QR…</span>';
  modal.classList.add('open');
  // Preserve setup state so closing and re-opening works
  saveSetupState('screen-setup-players');

  try {
    const payload = buildQRPayload(competitionRec);
    const url     = buildQRURL(payload);
    console.log('[QR] URL length:', url.length);

    // Extract the base64url code (everything after ?join=)
    const joinCode = url.split('?join=')[1] ?? '';

    // Share join link button
    const shareBtn = document.getElementById('btn-share-join-link');
    if (shareBtn) {
      shareBtn.onclick = async () => {
        if (navigator.share) {
          try { await navigator.share({ title: 'Join competition', url }); } catch {}
        } else {
          try {
            await navigator.clipboard.writeText(url);
            shareBtn.textContent = '✅ Copied!';
            setTimeout(() => { shareBtn.textContent = '📤 Share join link'; }, 2000);
          } catch { prompt('Copy this link:', url); }
        }
      };
    }

    // Copy competition code button (just the base64url payload — for paste into Join field)
    const codeBtn = document.getElementById('btn-copy-join-code');
    if (codeBtn) {
      codeBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(joinCode);
          codeBtn.textContent = '✅ Code copied!';
          setTimeout(() => { codeBtn.textContent = '📋 Copy competition code'; }, 2000);
        } catch {
          prompt('Copy this code:', joinCode);
        }
      };
    }

    const qr  = await getQRMod();
    const svg = await qr.toSVG(url, {
      errorCorrectionLevel: 'M',
      width: 280,
      margin: 2,
    });
    if (svgEl) svgEl.innerHTML = svg;
  } catch (err) {
    console.error('[QR] generation failed:', err);
    if (svgEl) svgEl.innerHTML = '<span style="color:var(--error,#e53e3e)">QR generation failed</span>';
  }
}

// Button click: get-or-create competition record, then show QR
document.getElementById('btn-share-competition-qr')?.addEventListener('click', async () => {
  if (!setup.courseId) return;

  const btn = document.getElementById('btn-share-competition-qr');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Generating…'; }

  try {
    // Stable competition UUID for this setup session.
    // We store it in localStorage alongside the setup draft so that
    // re-opening the Add Players screen reuses the same UUID.
    // Key: lb-comp-qr-id (one per device — a new round setup replaces it)
    const COMP_QR_KEY = 'lb-comp-qr-id';
    let sharedId = null;
    try { sharedId = localStorage.getItem(COMP_QR_KEY); } catch {}

    // Get-or-create a competition record for this shared UUID.
    let compRec = null;
    if (sharedId) {
      const existing = await competitionFindBySharedId(sharedId);
      compRec = existing?.[0] ?? null;
    }

    if (!compRec) {
      // First time (or no matching record): generate a new UUID and create.
      sharedId = crypto.randomUUID();
      try { localStorage.setItem(COMP_QR_KEY, sharedId); } catch {}
      const course = allCourses.find(c => c.id === setup.courseId);
      const tee    = course?.tees?.[setup.teeIdx];
      compRec = await competitionCreate({
        competitionId:  sharedId,
        name:           'Competition',
        courseId:       setup.courseId,
        courseName:     course?.name ?? null,
        teeName:        tee?.name ?? null,
        courseSnapshot: tee ?? null,
        isOrganiser:    true,
      });
    }

    await openQRShareModal(compRec);
  } catch (err) {
    console.error('[QR] error:', err);
    alert('Could not generate QR code. Please try again.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📲 Share Competition QR'; }
  }
});

// Close QR modal
document.getElementById('btn-modal-qr-close')?.addEventListener('click', () => {
  document.getElementById('modal-qr-share')?.classList.remove('open');
});
document.getElementById('modal-qr-share')?.addEventListener('click', e => {
  if (e.target === e.currentTarget) {
    e.currentTarget.classList.remove('open');
  }
});

// ================================================================
// STAGE C — JOIN COMPETITION VIA QR SCAN
// ================================================================

(function () {
  // ── State ──────────────────────────────────────────────────────
  let pendingJoin  = null;   // decoded payload waiting for confirmation

  // ── Helpers ────────────────────────────────────────────────────
  function b64urlDecode(str) {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const pad  = (4 - (b64.length % 4)) % 4;
    return atob(b64 + '='.repeat(pad));
  }

  function decodeJoinPayload(raw) {
    try {
      const json = b64urlDecode(raw);
      const obj  = JSON.parse(json);
      if (obj.v !== 1 || !obj.cid || !obj.cn) return null;
      // Expand compressed payload (short keys) to full shape
      const full = expandQRPayload(obj);
      if (!full || !full.course) return null;
      return full;
    } catch { return null; }
  }

  // ── Show join confirmation ──────────────────────────────────────
  function showJoinConfirm(payload) {
    pendingJoin = payload;
    const modal      = document.getElementById('modal-join-confirm');
    const nameEl     = document.getElementById('modal-join-comp-name');
    const courseEl   = document.getElementById('modal-join-course-name');
    const errorEl    = document.getElementById('modal-join-course-error');
    const confirmBtn = document.getElementById('btn-join-confirm');
    if (!modal) return;

    if (nameEl)   nameEl.textContent   = payload.cn;
    if (courseEl) courseEl.textContent = payload.course?.name ?? '';

    // Hard-check: course must already be on this device
    const existing = allCourses.find(c =>
      c.name?.trim().toLowerCase() === payload.course?.name?.trim().toLowerCase()
    );
    if (errorEl && confirmBtn) {
      if (existing) {
        errorEl.style.display = 'none';
        confirmBtn.style.display = 'block';
      } else {
        const courseName = payload.course?.name ?? 'this course';
        errorEl.style.display = 'block';
        errorEl.innerHTML = `⚠️ Course <strong>"${courseName}"</strong> not found on this device.<br><br>Ask the organiser to share the <em>Course Info QR</em> first, then scan that before joining.`;
        confirmBtn.style.display = 'none';
      }
    }

    modal.classList.add('open');
  }

  // ── Show course QR confirmation ─────────────────────────────────
  let _pendingCourseRaw = null;
  // ── Safari→PWA bridge prompt ───────────────────────────────────
  // Shown after saving a course in Safari (not the installed PWA).
  // Replaces the page content with a clear instruction to open the app.
  function _showOpenAppPrompt() {
    document.body.innerHTML = `
      <div style="
        min-height:100dvh; display:flex; flex-direction:column;
        align-items:center; justify-content:center; gap:1.5rem;
        padding:2rem; text-align:center;
        background:var(--bg,#0f1923); color:var(--text,#f0f4f8);
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      ">
        <div style="font-size:3rem">⛳</div>
        <h2 style="font-size:1.4rem; font-weight:700; margin:0">Course saved!</h2>
        <p style="font-size:1rem; color:var(--text-muted,#a0aec0); margin:0; max-width:280px; line-height:1.5">
          Now open the <strong>Leaderboard</strong> app from your home screen — the course will be there waiting.
        </p>
        <div style="
          background:var(--surface,#1a2535); border-radius:1rem;
          padding:1.25rem 1.5rem; max-width:300px; line-height:1.6;
          font-size:0.9rem; color:var(--text-muted,#a0aec0);
        ">
          Look for the Leaderboard icon on your home screen and tap it to continue.
        </div>
      </div>`;
  }

  function showCourseConfirm(raw, courseData) {
    _pendingCourseRaw = raw;
    const modal    = document.getElementById('modal-course-confirm');
    const nameEl   = document.getElementById('modal-course-confirm-name');
    const teeEl    = document.getElementById('modal-course-confirm-tee');
    const holesEl  = document.getElementById('modal-course-confirm-holes');
    const noticeEl = document.getElementById('modal-course-confirm-existing');
    const saveBtn  = document.getElementById('btn-course-confirm-save');
    if (!modal) return;

    if (nameEl)  nameEl.textContent  = courseData.courseName;
    if (teeEl)   teeEl.textContent   = `Tee: ${courseData.tee.name}`;
    if (holesEl) holesEl.textContent = `${courseData.tee.par?.length ?? 18} holes`;

    // Check if course already exists
    const existing = allCourses.find(c =>
      c.name?.trim().toLowerCase() === courseData.courseName?.trim().toLowerCase()
    );
    if (noticeEl) {
      if (existing) {
        noticeEl.style.display = 'block';
        noticeEl.textContent   = 'This course is already saved on your device.';
        if (saveBtn) saveBtn.textContent = '✅ Already Saved';
      } else {
        noticeEl.style.display = 'none';
        if (saveBtn) saveBtn.textContent = '💾 Save to My Courses';
      }
    }

    modal.classList.add('open');
  }

  // ── Confirm join: pre-fill setup (course must already exist) ────
  async function confirmJoin() {
    if (!pendingJoin) return;
    const payload = pendingJoin;
    pendingJoin   = null;
    document.getElementById('modal-join-confirm')?.classList.remove('open');

    const { cid, cn, course: cp, ti } = payload;

    // Course must already be on device (checked in showJoinConfirm)
    const courseRec = allCourses.find(c =>
      c.name?.trim().toLowerCase() === cp?.name?.trim().toLowerCase()
    );
    if (!courseRec) {
      alert('Course not found. Please scan the Course Info QR first.');
      return;
    }

    // Pre-fill setup — use stableford as default scoring format
    setup.category   = 'solo';
    setup.scoring    = 'stableford';
    setup.courseId   = courseRec.id;
    setup.teeIdx     = (typeof ti === 'number' && ti >= 0 && ti < (courseRec.tees?.length ?? 0)) ? ti : 0;
    setup.holes      = 18;
    setup.numPlayers = 1;
    setup.players    = [];
    setup.pairs      = [];
    setup.tournamentId = null;

    // Store the competition join info so the round can be linked
    try { localStorage.setItem('lb-comp-qr-id', cid); } catch {}

    // Go to setup-course so user can confirm course/tee, then add players
    showScreen('screen-setup-course');
    populateCourseSelect?.();
    updateShareQRButtonVisibility?.();
  }

  // ── Wire up buttons ────────────────────────────────────────────
  // Paste field — accept either a raw code or a full ?join= URL
  document.getElementById('btn-modal-join-close')?.addEventListener('click', () => {
    pendingJoin = null;
    document.getElementById('modal-join-confirm')?.classList.remove('open');
  });
  document.getElementById('modal-join-confirm')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) {
      pendingJoin = null;
      e.currentTarget.classList.remove('open');
    }
  });
  document.getElementById('btn-join-confirm')?.addEventListener('click', confirmJoin);

  // ── Course confirm modal ────────────────────────────────────────
  function closeCourseConfirmModal() {
    _pendingCourseRaw = null;
    document.getElementById('modal-course-confirm')?.classList.remove('open');
  }
  document.getElementById('btn-modal-course-confirm-close')?.addEventListener('click', closeCourseConfirmModal);
  document.getElementById('modal-course-confirm')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeCourseConfirmModal();
  });
  document.getElementById('btn-course-confirm-dismiss')?.addEventListener('click', closeCourseConfirmModal);
  document.getElementById('btn-course-confirm-save')?.addEventListener('click', async () => {
    const raw = _pendingCourseRaw;
    if (!raw) return;
    closeCourseConfirmModal();
    await importCourseFromCode(raw);

    // If running in Safari (not the installed PWA), show a prompt to open the app.
    // navigator.standalone is true only inside an installed iOS PWA.
    const isStandalone = window.navigator.standalone === true
      || window.matchMedia('(display-mode: standalone)').matches;
    const fromQR = new URLSearchParams(window.location.search).has('qr');
    if (!isStandalone && fromQR) {
      _showOpenAppPrompt();
    }
  });

  // ── Handle ?join= in URL on page load ─────────────────────────
  // Allows sharing the URL directly (e.g. via iMessage) as well as QR
  const urlJoin = new URLSearchParams(window.location.search).get('join');
  if (urlJoin) {
    const payload = decodeJoinPayload(urlJoin);
    if (payload) {
      // Wait for app to finish initialising before showing the modal
      window.addEventListener('lb-app-ready', () => showJoinConfirm(payload), { once: true });
    }
  }

  // ── Handle ?qr= in URL on page load ───────────────────────────
  // Course info QR encodes as a full URL with ?qr= so native iOS
  // camera scans it directly. On open, decode and show course modal.
  const urlQR = new URLSearchParams(window.location.search).get('qr');
  if (urlQR) {
    const courseData = decodeCourseQRPayload(urlQR);
    if (courseData) {
      window.addEventListener('lb-app-ready', () => showCourseConfirm(urlQR, courseData), { once: true });
    }
  }
})();

// ================================================================
// SETUP -- PAIRS SCREEN (for betterball/csm/foursomes/greensomes)
// ================================================================

function initSetupPairs() {
  const named = setup.players.filter(p => p.name);
  // Start everyone unpaired — player drags to choose their partner
  setup.pairs = [];
  named.forEach(p => { p.pairIndex = -1; });
  if (setup.scoring === 'texas' && (setup.texasScoringFmt ?? 'stableford') !== 'match') {
    const teamSz = setup.texasTeamSize ?? 2;
    setup.numGroups = Math.ceil(named.length / teamSz);
    named.forEach((p, i) => { p.groupNumber = Math.floor(i / teamSz) + 1; });
  }
  renderSetupPairsScreen();
}

function renderSetupPairsScreen() {
  _ensurePlayerCardStyles();
  const poolCard = document.getElementById('setup-pairs-pool-card');
  const pairsEl  = document.getElementById('setup-pair-cards');
  if (!pairsEl) return;

  // Hide the legacy pool card — PairPicker manages all cards in one grid
  if (poolCard) poolCard.style.display = 'none';

  const named = setup.players.filter(p => p.name);

  // Convert setup.pairs (rich objects) → PairPicker flat format [[piA, piB|null], ...]
  // Players not yet in any pair slot are added as solo entries at the end.
  const inPairs = new Set();
  const ppPairs = setup.pairs.map(pair => {
    const [piA, piB] = [...new Set(pair.playerIndices)].slice(0, 2);
    if (piA != null) inPairs.add(piA);
    if (piB != null) inPairs.add(piB);
    return [piA ?? null, piB ?? null];
  });
  named.forEach(p => {
    const pi = setup.players.indexOf(p);
    if (!inPairs.has(pi)) ppPairs.push([pi, null]);
  });

  // Optional pair HCP function for foursomes/greensomes
  const isHcpFmt = ['foursomes', 'greensomes'].includes(setup.scoring);
  const pairHcpFn = isHcpFmt ? (piA, piB) => {
    const hcp0 = setup.players[piA]?.courseHandicap ?? setup.players[piA]?.hcpIndex ?? 0;
    const hcp1 = setup.players[piB]?.courseHandicap ?? setup.players[piB]?.hcpIndex ?? 0;
    return setup.scoring === 'greensomes'
      ? greensomesPairHandicap(hcp0, hcp1)
      : foursomedPairHandicap(hcp0, hcp1);
  } : null;

  // Build player list for PairPicker — show HCP index on left, course HCP on right
  const ppPlayers = setup.players.map(p => ({
    name:      p.name,
    hcpIndex:  p.hcpIndex ?? 0,
    hcpIndex2: p.courseHandicap ?? p.gameHandicap ?? p.hcpIndex ?? 0,
  }));

  const _updateSetupPairs = (updatedPairs) => {
    // Write PairPicker result back to setup.pairs
    const newPairs = [];
    updatedPairs.forEach(([piA, piB]) => {
      if (piA == null) return;
      const p = setup.players[piA];
      if (!p) return;
      if (piB != null) {
        // Completed pair — preserve existing rich pair object if present
        const existing = setup.pairs.find(sp =>
          sp.playerIndices.includes(piA) && sp.playerIndices.includes(piB)
        );
        const nameA = setup.players[piA]?.name.split(' ')[0] ?? '';
        const nameB = setup.players[piB]?.name.split(' ')[0] ?? '';
        newPairs.push({
          _uid: existing?._uid ?? `p${Date.now()}_${newPairs.length}_${Math.random().toString(36).slice(2,7)}`,
          name: existing?.name ?? `${nameA} & ${nameB}`,
          teamName: existing?.teamName ?? null,
          playerIndices: [piA, piB],
          groupNumber: existing?.groupNumber ?? 1,
        });
        setup.players[piA].pairIndex = newPairs.length - 1;
        setup.players[piB].pairIndex = newPairs.length - 1;
      } else {
        // Solo — leave pairIndex = -1
        setup.players[piA].pairIndex = -1;
      }
    });
    setup.pairs = newPairs;

    // Validate next button
    const allPaired  = named.every(p => p.pairIndex !== -1);
    const validPairs = setup.pairs.every(pair => pair.playerIndices.length === 2);
    const btn = document.getElementById('btn-setup-pairs-next');
    if (btn) {
      const ok = allPaired && validPairs && setup.pairs.length > 0;
      btn.disabled      = !ok;
      btn.style.opacity = ok ? '' : '0.5';
    }
  };

  new PairPicker(pairsEl, ppPlayers, ppPairs, _updateSetupPairs, { pairHcpFn });
  // Trigger initial validation
  _updateSetupPairs(ppPairs);
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
        style="padding:1rem;font-size:1.1rem;font-weight:800;font-family:'Plus Jakarta Sans',sans-serif;">
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
      const teamHcp = texasTeamHandicap(idxArr, setup.texasMode ?? 'average', 100);
      texasHcpBadge = `
        <div style="text-align:right;flex-shrink:0;">
          <div style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;
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
                <span style="flex:1;font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.1rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.name}</span>
                ${playerHcpBoxes(p)}
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
                <span style="flex:1;font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.1rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.name}</span>
                ${playerHcpBoxes(p)}
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
                  <div style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;
                              font-size:1.1rem;color:var(--gold);">${pair.name}</div>
                  <div style="font-size:0.82rem;color:var(--muted2);">
                    ${p0?.name ?? '?'} · HCP ${fmtHandicap(p0?.hcpIndex ?? 0)} &nbsp;
                    ${p1?.name ?? '?'} · HCP ${fmtHandicap(p1?.hcpIndex ?? 0)}
                  </div>
                </div>
                <div style="text-align:right;flex-shrink:0;">
                  <div style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;
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
  // Skip the groups screen — go straight to review
  renderSetupGroupCards();
  buildSetupReview();
  showScreen('screen-setup-review');
});

// Returns the user's saved Course Handicap for the currently-selected
// course/tee, if their home club + tee matches one with a saved value.
function getMyCourseHandicapDefault() {
  try {
    const course = allCourses.find(c => c.id === setup.courseId);
    const tee    = course?.tees?.[setup.teeIdx];
    const saved  = currentProfile?.home_course_handicaps ?? {};
    if (tee && saved[tee.name] != null) {
      const val = saved[tee.name];
      // home_course_handicaps stores { course, playing } objects — extract the number
      if (typeof val === 'object' && val !== null) return val.course ?? null;
      return val; // legacy: raw number
    }
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
      const noSurname3 = f.name && !f.name.trim().includes(' ');
      document.getElementById('fp-selected-name').textContent =
        `${f.name}${noSurname3 ? ' ⚠️' : ''} · HCP ${fmtHandicap(f.hcp)}`;
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
  _ensurePlayerCardStyles();
  console.log('[review] scoring:', setup.scoring, 'pairs:', setup.pairs?.length, 'pairs:', JSON.stringify(setup.pairs?.slice(0,2)));
  const course   = allCourses.find(c => c.id === setup.courseId);
  const tee      = course?.tees?.[setup.teeIdx];
  const { offset, count } = holeRange(setup.holes);
  const isPairs  = ['betterball','csm','foursomes','greensomes'].includes(setup.scoring);
  const isBest2  = setup.scoring === 'best2';
  const isTexas  = setup.scoring === 'texas';
  const named    = setup.players.filter(p => p.name);
  // Use gameHandicap (picker-adjusted) if set, otherwise fall back to hcpIndex
  const hcpArr   = named.map(p => p.gameHandicap ?? p.hcpIndex ?? 0);
  const hcpObj   = calcHandicaps(hcpArr, 100);

  // Formats where match handicap (scratch reduction) is meaningful
  const showScratch = ['match','betterball','csm','foursomes','greensomes','split6','skins','itc'].includes(setup.scoring);

  // Build per-player HCP summary: index, playing, match (scratch points)
  const hcpSummary = (p, hi) => {
    const hcp = hcpObj[hi] ?? { playingHandicap: 0, matchHandicap: 0 };
    const index   = fmtHandicap(p.hcpIndex ?? 0);
    const playing = hcp.playingHandicap ?? 0;
    const match   = hcp.matchHandicap   ?? 0;
    const scratchLabel = match === 0 ? 'Scratch' : `SI 1–${match}`;
    return { index, playing, match, scratchLabel };
  };

  // Renders the HCP detail line for a player row
  const hcpDetailHtml = (p, hi) => {
    const h = hcpSummary(p, hi);
    // data-adj-playing lets the async roster fetch patch this value with the
    // tournament-adjusted playing handicap once it arrives (hub tournaments only).
    const adjAttr = `data-adj-playing="${(p.name ?? '').trim().toLowerCase()}"`;
    return `
      <div style="display:grid;grid-template-columns:${showScratch ? '1fr 1fr 1fr' : '1fr 1fr'};
                  gap:0.15rem 0.6rem;text-align:right;font-size:0.8rem;font-weight:600;
                  color:var(--muted2);margin-top:0.15rem;">
        <span>Index <strong style="color:var(--white)">${h.index}</strong></span>
        <span>Playing <strong ${adjAttr} style="color:var(--white)">${h.playing}</strong></span>
        ${showScratch ? `<span>Shots <strong style="color:var(--gold)">${h.scratchLabel}</strong></span>` : ''}
      </div>`;
  };

  // Texas: compute team HCP per group for display
  const texasGroupHcps = isTexas ? (() => {
    const numGroups = Math.max(1, ...named.map(p => p.groupNumber ?? 1));
    const result = {};
    for (let g = 1; g <= numGroups; g++) {
      const gPlayers = named.filter(p => (p.groupNumber ?? 1) === g);
      result[g] = texasTeamHandicap(gPlayers.map(p => p.hcpIndex || 0), setup.texasMode ?? 'average', 100);
    }
    return result;
  })() : {};

  // Scoring mode for team formats
  const isTeamFmt2    = ['foursomes','greensomes','texas'].includes(setup.scoring);
  const teamScoreMode2 = setup.scoring === 'texas'
    ? (setup.texasScoringFmt ?? 'stableford')
    : (setup.teamScoringMode ?? 'stableford');
  const teamScoreLabel2 = teamScoreMode2 === 'stroke' ? 'Strokeplay'
    : teamScoreMode2 === 'match' ? 'Match Play' : 'Stableford';

  const reviewDateStr = (() => {
    const d = setup.gameDate;
    if (!d) return '';
    try { return new Date(d).toLocaleDateString(undefined, { weekday:'short', day:'numeric', month:'short', year:'numeric' }); }
    catch { return d; }
  })();
  const reviewOrganiser = currentProfile
    ? `${currentProfile.first_name ?? ''} ${currentProfile.last_name ?? ''}`.trim()
    : '';

  const ts = _tournState();
  const tournActive = ts.active && ts.code && ts.code !== '__error__';
  const roundOfY = tournActive
    ? `<div style="display:flex;justify-content:space-between;">
         <span style="color:var(--muted2);">Round</span>
         <span style="color:var(--gold,#d4a843);font-weight:800;">${ts.currentRound} of ${ts.rounds}</span>
       </div>` : '';

  let html = `
    <div style="display:grid;gap:0.5rem;font-size:1.05rem;font-weight:700;margin-bottom:1rem;">
      ${course ? `<div style="display:flex;justify-content:space-between;"><span style="color:var(--muted2);">Course</span><span style="text-align:right;max-width:60%;">${course.name}</span></div>` : ''}
      ${tee    ? `<div style="display:flex;justify-content:space-between;"><span style="color:var(--muted2);">Tees</span><span>${tee.name}</span></div>` : ''}
      ${reviewDateStr ? `<div style="display:flex;justify-content:space-between;"><span style="color:var(--muted2);">Date</span><span>${reviewDateStr}</span></div>` : ''}
      ${reviewOrganiser ? `<div style="display:flex;justify-content:space-between;"><span style="color:var(--muted2);">Organiser</span><span>${reviewOrganiser}</span></div>` : ''}
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted2);">Format</span><span>${fmtLabel(setup.scoring)}</span></div>
      ${roundOfY}
      ${isTeamFmt2 ? `
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted2);">Scoring</span><span>${teamScoreLabel2}</span></div>
      ${isTexas ? `
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted2);">HCP Mode</span><span>${setup.texasMode === 'weighted' ? 'Weighted' : 'Average'}</span></div>
      ` : ''}
      ` : ''}
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted2);">Holes</span><span>${count === 18 ? '18' : count === 9 && offset === 0 ? 'Front 9' : 'Back 9'}</span></div>
    </div>
    <div style="border-top:1px solid var(--border);padding-top:0.75rem;">`;

  if (isTexas && setup.texasScoringFmt === 'match' && setup.pairs?.length >= 2) {
    // 2v2 Scramble Match Play — show two teams from setup.pairs with combined HCP + shots difference
    const rawTeamHcps = setup.pairs.map(pair => {
      const [pi0, pi1] = pair.playerIndices;
      const p0 = setup.players[pi0], p1 = setup.players[pi1];
      const hcp0 = p0?.courseHandicap ?? p0?.hcpIndex ?? 0;
      const hcp1 = p1?.courseHandicap ?? p1?.hcpIndex ?? 0;
      return Math.round((hcp0 + hcp1) / 2); // foursomes-style average
    });
    const minTeamHcp  = Math.min(...rawTeamHcps);
    const shotsArr    = rawTeamHcps.map(h => h - minTeamHcp);
    setup.pairs.forEach((pair, ti) => {
      const [pi0, pi1] = pair.playerIndices;
      const p0 = setup.players[pi0], p1 = setup.players[pi1];
      const hi0 = named.indexOf(p0), hi1 = named.indexOf(p1);
      const teamHcp  = rawTeamHcps[ti];
      const shots    = shotsArr[ti];
      const shotsLbl = shots === 0 ? 'Scratch' : `+${shots} shots`;
      html += `<div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);
                            padding:0.65rem 0.85rem;margin-bottom:0.5rem;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.35rem;">
          <span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.1rem;color:var(--gold);">
            ${TEXAS_HAT_SMALL} Team ${ti + 1}
          </span>
          <span style="font-size:0.9rem;font-weight:700;color:var(--muted2);">
            Team HCP ${teamHcp}
            <span style="color:${shots === 0 ? 'var(--muted2)' : 'var(--gold)'};margin-left:0.5rem;">${shotsLbl}</span>
          </span>
        </div>
        ${[p0, p1].map((p, si) => {
          const hi_tx = si === 0 ? hi0 : hi1;
          return `<div style="padding:0.25rem 0;border-bottom:0.5px solid rgba(255,255,255,0.04);">
            <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.95rem;font-weight:700;">
              <span style="display:flex;align-items:center;gap:6px;">
                <span class="dot" style="background:${pHex(hi_tx % 8)};"></span>${_esc(p?.name ?? '')}
              </span>
            </div>
            ${hcpDetailHtml(p, hi_tx)}
          </div>`;
        }).join('')}
      </div>`;
    });
  } else if (isTexas) {
    // Multi-team scramble (3 or 4 players per team) — show groups with team HCP
    const numGroups = Math.max(1, ...named.map(p => p.groupNumber ?? 1));
    for (let g = 1; g <= numGroups; g++) {
      const gPlayers = named.filter(p => (p.groupNumber ?? 1) === g);
      const teamHcp  = texasGroupHcps[g] ?? 0;
      html += `<div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);
                            padding:0.65rem 0.85rem;margin-bottom:0.5rem;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.35rem;">
          <span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.1rem;color:var(--gold);">
            ${TEXAS_HAT_SMALL} Team ${g}
          </span>
          <span style="font-size:0.9rem;font-weight:700;color:var(--muted2);">Team HCP ${teamHcp}</span>
        </div>
        ${gPlayers.map((p, si) => {
          const hi_tx = named.indexOf(p);
          return `<div style="padding:0.25rem 0;border-bottom:0.5px solid rgba(255,255,255,0.04);">
            <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.95rem;font-weight:700;">
              <span style="display:flex;align-items:center;gap:6px;">
                <span class="dot" style="background:${pHex(hi_tx % 8)};"></span>${p.name}
              </span>
            </div>
            ${hcpDetailHtml(p, hi_tx)}
          </div>`;
        }).join('')}
      </div>`;
    }
  } else if (isPairs && setup.pairs?.length > 0) {
    const isSharedBall  = ['foursomes','greensomes'].includes(setup.scoring);
    const numGroups = Math.max(...setup.pairs.map(p => p.groupNumber ?? 1));

    // For shared ball formats: pre-calculate all team HCPs
    const reviewTeamMode = setup.teamScoringMode ?? 'stableford';
    const isMatchReview  = reviewTeamMode === 'match';
    let teamHcpMap = {}; // pairIdx -> shots value
    if (isSharedBall) {
      const rawMap = {};
      setup.pairs.forEach((pair, pairIdx) => {
        const [pi0, pi1] = pair.playerIndices;
        const p0 = setup.players[pi0], p1 = setup.players[pi1];
        const h0 = named.indexOf(p0), h1 = named.indexOf(p1);
        const hcp0 = hcpObj[h0]?.playingHandicap ?? 0;
        const hcp1 = hcpObj[h1]?.playingHandicap ?? 0;
        rawMap[pairIdx] = setup.scoring === 'greensomes'
          ? greensomesPairHandicap(hcp0, hcp1)
          : Math.round((hcp0 + hcp1) / 2);
      });
      if (isMatchReview) {
        // Match play: subtract lowest (lower team plays off scratch)
        const minTeamHcp = Math.min(...Object.values(rawMap));
        Object.keys(rawMap).forEach(k => { teamHcpMap[k] = rawMap[k] - minTeamHcp; });
      } else {
        // Stableford/Stroke: use raw team HCP directly
        teamHcpMap = { ...rawMap };
      }
    }
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
        const hcp0 = hcpObj[h0]?.playingHandicap ?? 0;
        const hcp1 = hcpObj[h1]?.playingHandicap ?? 0;

        // Shots label from teamHcpMap (already adjusted for match vs stableford/stroke)
        const pairIdx2   = setup.pairs.indexOf(pair);
        const teamShots  = isSharedBall ? (teamHcpMap[pairIdx2] ?? 0) : 0;
        const shotsLabel = teamShots === 0 ? 'Plays off Scratch' : `Shots SI 1–${teamShots}`;


        // Team header line: pair name + team HCP + shots
        html += `
          <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);
                      padding:0.65rem 0.85rem;margin-bottom:0.5rem;">
            <!-- Header row: pair name | shots -->
            <div style="display:flex;align-items:baseline;justify-content:space-between;
                        margin-bottom:0.5rem;flex-wrap:wrap;gap:0.25rem;">
              <div style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.1rem;
                          color:var(--gold);">${pair.name}</div>
              ${isSharedBall ? `
                <span style="font-size:0.9rem;font-weight:800;color:var(--gold);">
                  ${shotsLabel}
                </span>` : ''}
            </div>
            <!-- Player rows: name + playing HCP only -->
            ${[p0, p1].map((p, si) => {
              const pi  = si === 0 ? pi0 : pi1;
              const hi  = si === 0 ? h0  : h1;
              const plyHcp = hcpObj[hi]?.playingHandicap ?? 0;
              return `<div style="display:flex;align-items:center;justify-content:space-between;
                                  padding:0.25rem 0;border-bottom:0.5px solid rgba(255,255,255,0.06);">
                <div style="display:flex;align-items:center;gap:6px;font-size:0.95rem;font-weight:700;">
                  <span class="dot" style="background:${pHex(pi % 8)};"></span>${p?.name ?? '?'}
                </div>
                <div style="font-size:0.85rem;font-weight:700;color:var(--muted2);">
                  ${isSharedBall
                    ? `Playing <strong style="color:var(--white)">${plyHcp}</strong>`
                    : hcpSummary(p, hi).scratchLabel
                      ? `Playing <strong style="color:var(--white)">${plyHcp}</strong>
                         &nbsp;<span style="color:var(--gold);">Shots ${hcpSummary(p,hi).scratchLabel}</span>`
                      : ''
                  }
                </div>
              </div>`;
            }).join('')}
          </div>`;
      });
    }
  } else {
    const isTeamFmt   = ['best2'].includes(setup.scoring);
    const isSharedBall2 = ['foursomes','greensomes'].includes(setup.scoring);
    const numGroups = Math.max(1, ...named.map(p => p.groupNumber ?? 1));

    // For foursomes/greensomes with no pairs data, build pairs from player order
    if (isSharedBall2 && named.length >= 2) {
      const syntheticPairs = [];
      for (let i = 0; i + 1 < named.length; i += 2) {
        const p0 = named[i], p1 = named[i+1];
        const h0 = i, h1 = i+1;
        const hcp0 = hcpObj[h0]?.playingHandicap ?? 0;
        const hcp1 = hcpObj[h1]?.playingHandicap ?? 0;
        const rawTeamHcp = setup.scoring === 'greensomes'
          ? greensomesPairHandicap(hcp0, hcp1)
          : Math.round((hcp0 + hcp1) / 2);
        const pairName = `${p0.name.split(' ')[0]} & ${p1.name.split(' ')[0]}`;
        syntheticPairs.push({ p0, p1, h0, h1, hcp0, hcp1, rawTeamHcp, pairName, pi0: setup.players.indexOf(p0), pi1: setup.players.indexOf(p1) });
      }
      // Shots label: match = subtract lowest; stableford/stroke = raw team HCP
      const minSynHcp = isMatchReview ? Math.min(...syntheticPairs.map(p => p.rawTeamHcp)) : 0;
      syntheticPairs.forEach(pair => {
        const teamShots2  = isMatchReview ? pair.rawTeamHcp - minSynHcp : pair.rawTeamHcp;
        const shotsLabel2 = teamShots2 === 0 ? 'Plays off Scratch' : `Shots SI 1–${teamShots2}`;
        html += `
          <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);
                      padding:0.65rem 0.85rem;margin-bottom:0.5rem;">
            <div style="display:flex;align-items:baseline;justify-content:space-between;
                        margin-bottom:0.5rem;flex-wrap:wrap;gap:0.25rem;">
              <div style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.1rem;
                          color:var(--gold);">${pair.pairName}</div>
              <span style="font-size:0.9rem;font-weight:800;color:var(--gold);">${shotsLabel2}</span>
            </div>
            ${[[pair.p0, pair.h0, pair.pi0, pair.hcp0], [pair.p1, pair.h1, pair.pi1, pair.hcp1]].map(([p, hi, pi, plyHcp]) => `
              <div style="display:flex;align-items:center;justify-content:space-between;
                          padding:0.25rem 0;border-bottom:0.5px solid rgba(255,255,255,0.06);">
                <div style="display:flex;align-items:center;gap:6px;font-size:0.95rem;font-weight:700;">
                  <span class="dot" style="background:${pHex(pi % 8)};"></span>${p?.name ?? '?'}
                </div>
                <div style="font-size:0.85rem;font-weight:700;color:var(--muted2);">
                  Playing <strong style="color:var(--white)">${plyHcp}</strong>
                </div>
              </div>`).join('')}
          </div>`;
      });
    } else {
      for (let g = 1; g <= numGroups; g++) {
        const groupPlayers = named.filter(p => (p.groupNumber ?? 1) === g);
        if (numGroups > 1) {
          html += `<div style="font-size:0.8rem;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;
            color:var(--muted);margin:0.75rem 0 0.35rem;">${isTeamFmt ? `Team ${g}` : `Group ${g}`}</div>`;
        }
        html += `<div class="pp-grid" style="margin-bottom:0.35rem;">`;
        groupPlayers.forEach(p => {
          const hi  = named.indexOf(p);
          const pi  = setup.players.indexOf(p);
          const h   = hcpSummary(p, hi);
          html += `
            <div class="pp-card">
              <div class="pp-name" style="font-size:13px;">${_esc(p.name)}</div>
              <div class="pp-bottom">
                <div class="pp-stat">
                  <div class="pp-stat-label">Index</div>
                  <div class="pp-stat-value">${h.index}</div>
                </div>
                <div class="pp-stat pp-stat-right">
                  <div class="pp-stat-label">Course HCP</div>
                  <div class="pp-partner pp-partner-active">${h.playing}</div>
                </div>
              </div>
              ${showScratch && h.match > 0 ? `<div style="font-size:0.65rem;font-weight:700;color:var(--gold);margin-top:3px;text-align:right;">${h.scratchLabel}</div>` : ''}
            </div>`;
        });
        html += `</div>`;
      }
    }
  }

  html += '</div>';

  // ── Hub tournament: full-roster section placeholder ────────────
  // Detect hub tournament context: non-UUID tournamentId means hub code
  const _hubTournCode = (setup.tournamentId && !/^[0-9a-f-]{36}$/.test(setup.tournamentId))
    ? setup.tournamentId : null;
  if (_hubTournCode) {
    html += `
      <div id="review-full-roster" style="margin-top:1rem;">
        <div style="font-size:0.8rem;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;
          color:var(--muted);margin-bottom:0.5rem;">All Tournament Players</div>
        <div id="review-full-roster-body" style="color:var(--muted2);font-size:0.85rem;text-align:center;
          padding:0.5rem 0;">Loading roster…</div>
      </div>`;
  }

  document.getElementById('review-content').innerHTML = html;

  // ── Hub tournament: async full-roster load ─────────────────────
  if (_hubTournCode) {
    (async () => {
      const bodyEl = document.getElementById('review-full-roster-body');
      if (!bodyEl) return;
      try {
        const data = await _tournWorkerFetch(`/roster/${_hubTournCode}`);
        const allPlayers = Array.isArray(data) ? data
          : Array.isArray(data?.players) ? data.players : [];
        if (!allPlayers.length) {
          bodyEl.textContent = 'No players found.';
          return;
        }

        // Build a lookup: normalised name → adjustedHcp from the roster
        const adjByName = {};
        for (const p of allPlayers) {
          if (p.name) adjByName[p.name.trim().toLowerCase()] = p.adjustedHcp ?? p.originalHcp ?? p.hcpIndex ?? 0;
        }

        // Patch the group-player "Playing" values using the roster's adjustedHcp.
        // Each group player card has a data-player-name attribute we stamp below
        // (handled in the group-player HTML generated above).
        // We update by finding elements with data-adj-playing attribute.
        document.querySelectorAll('[data-adj-playing]').forEach(el => {
          const nm = (el.dataset.adjPlaying ?? '').toLowerCase();
          if (nm && adjByName[nm] !== undefined) {
            el.textContent = adjByName[nm];
          }
        });

        // Names in the current group (this phone's scorers)
        const groupNames = new Set(setup.players.map(p => (p.name ?? '').trim().toLowerCase()).filter(Boolean));
        // Sort: group players first (starred), then others alphabetically
        const sorted = [...allPlayers].sort((a, b) => {
          const aIn = groupNames.has((a.name ?? '').trim().toLowerCase());
          const bIn = groupNames.has((b.name ?? '').trim().toLowerCase());
          if (aIn !== bIn) return aIn ? -1 : 1;
          return (a.name ?? '').localeCompare(b.name ?? '');
        });
        bodyEl.innerHTML = sorted.map(p => {
          const nm     = p.name ?? '?';
          const inGrp  = groupNames.has(nm.trim().toLowerCase());
          const idx    = p.hcpIndex ?? p.originalHcp ?? 0;
          const adjHcp = p.adjustedHcp ?? p.originalHcp ?? idx;
          return `<div style="display:flex;align-items:center;justify-content:space-between;
                    padding:0.45rem 0;border-bottom:1px solid rgba(255,255,255,0.04);">
            <div style="display:flex;align-items:center;gap:6px;font-size:0.95rem;font-weight:${inGrp ? '800' : '600'};
              color:${inGrp ? 'var(--white)' : 'var(--muted2)'};">
              ${inGrp ? '<span style="color:var(--gold);">★</span>' : '<span style="display:inline-block;width:1em;"></span>'}
              ${_esc(nm)}
            </div>
            <div style="font-size:0.8rem;font-weight:700;color:var(--muted2);text-align:right;">
              <span>Index <strong style="color:var(--white)">${fmtHandicap(idx)}</strong></span>
              &nbsp;
              <span>Playing <strong style="color:var(--gold)">${adjHcp}</strong></span>
            </div>
          </div>`;
        }).join('');
      } catch (err) {
        const bodyEl2 = document.getElementById('review-full-roster-body');
        if (bodyEl2) bodyEl2.textContent = 'Could not load roster.';
        console.warn('[review] roster fetch failed:', err);
      }
    })();
  }

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

  refreshTournamentUI();
}

function reviewBackScreen() {
  const isPairs = ['betterball','csm','foursomes','greensomes'].includes(setup.scoring);
  if (isPairs) return 'screen-setup-pairs';
  return 'screen-setup-players';
}
document.getElementById('setup-review-back') ?.addEventListener('click', () => showScreen(reviewBackScreen()));
document.getElementById('btn-review-back')   ?.addEventListener('click', () => showScreen(reviewBackScreen()));
document.getElementById('btn-tee-off')       ?.addEventListener('click', async () => await teeOff());
document.getElementById('review-weather')    ?.addEventListener('input', function() { setup.weather = this.value; });

async function teeOff() {
  // ── Hub tournament: stash context then fall straight through to the
  //    normal game-start path below. Hub tournament codes are non-UUID strings.
  if (setup.tournamentId && !/^[0-9a-f-]{36}$/.test(setup.tournamentId)) {
    setup._hubTournamentCode = setup.tournamentId;
    setup._hubTournRound     = setup.tournRoundNumber ?? 1;
    setup.tournamentId       = null;
    setup.tournRoundNumber   = null;
    // fall through to normal game-start code ↓
  }

  // ── Legacy UUID tournament mode ──────────────────────────────────
  if (setup.tournamentId) {
    const btn = document.getElementById('btn-tee-off');
    try {
      const course = allCourses.find(c => c.id === setup.courseId);
      const tee    = course?.tees?.[setup.teeIdx];
      if (!course || !tee) { alert('Please select a course and tee.'); return; }

      if (!activeTournPlayers?.length) {
        activeTournPlayers = await tournamentPlayersLoad(setup.tournamentId).catch(() => []);
      }

      const namedPlayers = setup.players.filter(p => p.name);
      const maxGroup     = Math.max(1, ...namedPlayers.map(p => p.groupNumber ?? 1));
      const isPairsFmt   = ['betterball','csm','foursomes','greensomes'].includes(setup.scoring);

      const localTournGroups = Array.from({ length: maxGroup }, (_, g) => {
        const groupNum = g + 1;
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

      if (!localTournGroups.some(g => g.players.length > 0)) {
        alert('Could not match players to tournament roster. Please go back and check the player list.');
        return;
      }

      // Save group state for next round
      localStorage.setItem(`lb-tround-${setup.tournamentId}`, JSON.stringify({
        courseId: setup.courseId, teeName: tee.name,
        date: new Date().toISOString().split('T')[0],
        numGroups: maxGroup, groups: localTournGroups,
      }));

      // Legacy path complete — legacy _teeOffRound is no longer available;
      // fall through to normal game-start below for now.
      // TODO: restore legacy tournament round-start via API call if needed.
    } catch (err) {
      console.error('[teeOff] tournament branch failed:', err);
      alert('Could not start the round: ' + (err.message || 'Unknown error. Please try again.'));
      if (btn) { btn.disabled = false; btn.textContent = '⛳ TEE OFF →'; }
      return;
    }
    // fall through to normal game-start code ↓
  }

  const course = allCourses.find(c => c.id === setup.courseId);
  const tee    = course?.tees?.[setup.teeIdx];
  if (!course || !tee) return;
  const { offset, count } = holeRange(setup.holes);
  const siSlice  = tee.si.slice(offset, offset + count);
  const parSlice = tee.par.slice(offset, offset + count);
  const fmt      = setup.scoring;
  const isPairs  = ['betterball','csm','foursomes','greensomes'].includes(fmt)
    || (fmt === 'texas' && (setup.texasScoringFmt ?? 'stableford') === 'match');

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
  const hcpObj = calcHandicaps(hcpArr, 100);

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
    const gHcpObj = calcHandicaps(gHcpArr, 100);
    // For foursomes/greensomes: pass playing HCPs so engine computes raw pair HCPs
    const isFoursomeFmt = ['foursomes','greensomes'].includes(fmt);
    const gMatchHcps    = isFoursomeFmt
      ? gHcpObj.map(h => h.playingHandicap)
      : gHcpObj.map(h => h.matchHandicap);


    const gs = buildInitialState({
      format:          fmt,
      names:           gNames,
      handicapIndexes: gHcpArr,
      playingHandicaps: gHcpObj.map(h => h.playingHandicap),
      matchHandicaps:   gMatchHcps,
      allowancePct:    100,
      si:              siSlice,
      par:             parSlice,
      numHoles:        count,
      holeOffset:      offset,
      courseName:      course.name,
      teeName:         tee.name,
      groupNumber:     g + 1,
      totalGroups:     setup.numGroups,
      longestDriveHoles: [],
      nearestPinHoles:   [],
      teamScoringMode:   setup.teamScoringMode ?? 'match',
      texasScoringFmt:   setup.texasScoringFmt ?? 'stableford',
    });

    if (['foursomes','greensomes'].includes(fmt)) {
      gs.teamScoringMode = setup.teamScoringMode ?? 'match';
      const grpPairs = (setup.pairs ?? []).filter(p => (p.groupNumber ?? 1) === g + 1);
      if (grpPairs.length > 0) gs.pairName = grpPairs[0].name;
    }
    // Texas Scramble: compute and store team handicap and options
    if (fmt === 'texas') {
      gs.texasMode       = setup.texasMode ?? 'average';
      gs.texasScoringFmt = setup.texasScoringFmt ?? 'stableford';
      gs.teamName        = `Team ${g + 1}`;

      if (setup.texasScoringFmt === 'match') {
        // Texas matchplay: compute pair match handicaps like foursomes
        // Team A = players 0,1; Team B = players 2,3
        const rawA = Math.round((gHcpArr[0] + gHcpArr[1]) * 0.5);
        const rawB = Math.round((gHcpArr[2] + gHcpArr[3]) * 0.5);
        const minH = Math.min(rawA, rawB);
        gs.matchHandicaps = [rawA - minH, rawB - minH];
        gs.matchScore     = 0;
      } else {
        gs.teamHcp         = texasTeamHandicap(gHcpArr, setup.texasMode ?? 'average', 100);
        gs.grossTotal      = 0;
        gs.texasPts        = 0;
        gs.driverUsage     = { par3: [], par4: [], par5: [] };
        gs.texasDrivesTotal = setup.texasDrivesTotal ?? null;
        gs.texasDrivesPar3  = setup.texasDrivesPar3  ?? null;
      }
    }

    groupStates.push(gs);
  }

  // Active state is always group 0 (the scorer's group)
  gameState = groupStates[0];
  gameState.allGroupStates = groupStates;

  // Carry tournament code into gameState so end-round screen can show push/live buttons
  try {
    const ts = _tournState();
    if (ts.active && ts.code && ts.code !== '__error__') {
      gameState.gameCode = ts.code;
      localStorage.setItem('lb-game-code', ts.code);
    }
  } catch {}

  // Carry hub tournament context into gameState for end-round handling
  if (setup._hubTournamentCode) {
    gameState._hubTournamentCode = setup._hubTournamentCode;
    gameState._hubTournRound     = setup._hubTournRound ?? 1;
    // Also use the hub code as the game code for score pushing
    if (!gameState.gameCode) {
      gameState.gameCode = setup._hubTournamentCode;
      try { localStorage.setItem('lb-game-code', setup._hubTournamentCode); } catch {}
    }
  }

  // Store profileIds per group. scorerProfileId starts as '__unclaimed__' —
  // first person to tap Score in the invite banner claims it.
  for (let g = 0; g < setup.numGroups; g++) {
    const groupNum     = g + 1;
    const groupPlayers = setup.players.filter(p => p.groupNumber === groupNum);
    groupStates[g].playerProfileIds = groupPlayers
      .map(p => p.profileId ?? null)
      .filter(id => id !== null);
    groupStates[g].playerIsGuest = groupPlayers.map(p => p.isGuest ?? false);
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
  gameState.playerIsGuest = setup.players.filter(p => p.groupNumber === 1).map(p => p.isGuest ?? false);

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
      hcpAllowance: 100,
      gameDate:     setup.gameDate ?? new Date().toISOString().slice(0, 10),
      si:           siSlice,
      par:          parSlice,
      numHoles:     count,
      holeOffset:   offset,
      numGroups:    setup.numGroups,
      playerNames:  setup.players.map(p => p.name || 'Player'),
      weather:      setup.weather ?? null,
      gameState:    stateToSave,
    });
    await roundPlayersSave(roundId, setup.players.map((p, i) => ({
      profileId:       p.isGuest ? null : (p.profileId ?? null),
      name:            p.name || `Player ${i+1}`,
      handicapIndex:   p.hcpIndex || 0,
      playingHandicap: hcpObj[i].playingHandicap,
      groupNumber:     p.groupNumber,
      isScorer:        p.isScorer ?? false,
      mobile:          p.mobile ?? null,
      isGuest:         p.isGuest ?? false,
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
          // Push notification — fire and forget
          sendPushToUser(p.profileId, {
            title: '⛳ Game Invite',
            body:  `${myName} invited you to play`,
            tag:   `invite-${roundId}`,
            data:  { url: '/' },
          }).catch(() => {});
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
          // Push notification — fire and forget
          sendPushToUser(p.profileId, {
            title: '⛳ Game Invite',
            body:  `${myName} invited you to play`,
            tag:   `invite-${roundId}`,
            data:  { url: '/' },
          }).catch(() => {});
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
// RECOVERY — Stage 2
// ================================================================

// Merge all recoverable rounds from every source into one deduplicated list.
// Sources consulted independently:
//   A. rounds store (active + paused)          — via roundsLoadActive()
//   B. active_rounds IDB                        — via idbGetDirty()
//   C. lb-active-round localStorage pointer     — cross-checked against A & B
//
// Each returned item has the shape the rest of the UI expects:
//   { id, status, game_state, course_name?, tee_name?, _source }
//
// Malformed records are skipped without hiding valid ones.
// A round in active_rounds that has no rounds-store record is surfaced
// as a recoverable item with status='active' and _source='idb-only'.
async function _collectRecoverableRounds(userId) {
  // ── Source A: rounds store ──────────────────────────────────────
  let fromRoundsStore = [];
  try {
    fromRoundsStore = await roundsLoadActive(userId);
    if (!Array.isArray(fromRoundsStore)) fromRoundsStore = [];
  } catch (e) {
    console.warn('[recovery] roundsLoadActive failed:', e);
  }

  // ── Source B: active_rounds IDB ────────────────────────────────
  let fromIdb = [];
  try {
    const dirty = await idbGetDirty();
    fromIdb = (dirty ?? []).filter(rec => rec?.roundId && rec?.state);
  } catch (e) {
    console.warn('[recovery] idbGetDirty failed:', e);
  }

  // ── Source C: localStorage pointer ────────────────────────────
  let storedRoundId = null;
  try { storedRoundId = localStorage.getItem('lb-active-round'); } catch {}

  // ── Merge ───────────────────────────────────────────────────────
  // Build a map keyed by roundId; prefer rounds-store records as the base,
  // augmented with active_rounds state when IDB is newer (more holes OR
  // same holes but higher savedAt — captures edits to earlier holes).
  const map = new Map();

  for (const r of fromRoundsStore) {
    if (!r?.id) continue;
    try {
      map.set(r.id, { ...r, _source: 'rounds' });
    } catch {}
  }

  for (const rec of fromIdb) {
    const id = rec.roundId;
    const existing = map.get(id);
    if (!existing) {
      // Orphan: exists in active_rounds but not in rounds store
      map.set(id, {
        id,
        status:     'active',
        game_state: rec.state,
        course_name: rec.state?.courseName ?? null,
        tee_name:    rec.state?.teeName ?? null,
        _source:     'idb-only',
        _savedAt:    rec.savedAt ?? 0,
      });
    } else {
      // Both sources have the round — pick the more up-to-date game_state
      const idbHoles    = rec.state?.log?.length ?? 0;
      const storeHoles  = existing.game_state?.log?.length ?? 0;
      const idbSavedAt  = rec.savedAt ?? 0;
      // Use IDB state if it has strictly more holes, OR same holes but
      // was saved more recently (edit to an earlier hole without advancing log)
      if (idbHoles > storeHoles ||
          (idbHoles === storeHoles && idbSavedAt > (existing._savedAt ?? 0))) {
        map.set(id, { ...existing, game_state: rec.state, _source: 'idb-wins', _savedAt: idbSavedAt });
      }
    }
  }

  // ── Honour localStorage pointer ────────────────────────────────
  // If the pointer references a round not yet in the map, try to load it
  // from the rounds store (it may be paused/active but not returned above
  // because roundsLoadActive is user-scoped in MULTI_USER mode).
  if (storedRoundId && !map.has(storedRoundId)) {
    try {
      const stored = await roundLoadById(storedRoundId);
      if (stored?.id && ['active','paused'].includes(stored.status)) {
        map.set(stored.id, { ...stored, _source: 'localStorage-ptr' });
      } else if (!stored) {
        // localStorage pointer is stale — clean it up
        try { localStorage.removeItem('lb-active-round'); } catch {}
      }
    } catch (e) {
      // rounds store unavailable; try localStorage cache as last resort
      try {
        const cached = JSON.parse(localStorage.getItem('lb-game-state-cache') ?? 'null');
        if (cached?.roundId === storedRoundId && cached?.state) {
          map.set(storedRoundId, {
            id:         storedRoundId,
            status:     'active',
            game_state: cached.state,
            course_name: cached.state?.courseName ?? null,
            _source:    'ls-cache',
          });
        }
      } catch {}
    }
  }

  // ── Return sorted list ────────────────────────────────────────
  // Pointer round first, then by most-recently-updated
  const list = [...map.values()];
  list.sort((a, b) => {
    if (a.id === storedRoundId) return -1;
    if (b.id === storedRoundId) return 1;
    return (b._savedAt ?? 0) - (a._savedAt ?? 0);
  });
  return list;
}

// ================================================================
// RESUME
// ================================================================
async function resumeRound(id) {
  try {
    let round    = null;
    let fromIdb  = false;

    // 1. Check IndexedDB first — instant, works offline
    try {
      const local = await idbLoad(id);
      if (local?.state) {
        round   = { id, status: 'active', game_state: local.state };
        fromIdb = true;
        console.log('[idb] loaded round from IndexedDB', id);
      }
    } catch (idbErr) {
      console.warn('[idb] load failed, falling back to Supabase', idbErr);
    }

    // 2. Try rounds store (local.js) — compare carefully with IDB state
    // Use whichever source has MORE holes played OR the same holes with a
    // more recent savedAt (to preserve edits to earlier holes, not just new holes).
    try {
      const remote = await roundLoadById(id);
      if (remote?.game_state) {
        const remoteHoles = remote.game_state?.log?.length ?? 0;
        const localHoles  = round?.game_state?.log?.length ?? 0;
        const idbSavedAt  = (await idbLoad(id))?.savedAt ?? 0;
        // Prefer rounds store if: no IDB state, more holes, or same holes
        // but rounds store was saved after IDB (rounds store is the write-through)
        // Prefer IDB if it has more holes OR same holes + newer savedAt
        if (!fromIdb) {
          round   = remote;
        } else if (remoteHoles > localHoles) {
          round   = remote;
          fromIdb = false;
        } else if (remoteHoles === localHoles && idbSavedAt === 0) {
          // IDB has nothing; use rounds store
          round   = remote;
          fromIdb = false;
        }
        // else: IDB has same or more holes and was saved more recently — keep IDB state
      }
    } catch (roundsErr) {
      console.warn('resumeRound: rounds store read failed, using active_rounds state', roundsErr);
    }

    // 3. Fall back to old localStorage cache if IDB and Supabase both failed
    if (!round) {
      try {
        const cached = JSON.parse(localStorage.getItem('lb-game-state-cache') ?? 'null');
        if (cached?.roundId === id && cached?.state) {
          round = { id, status: 'active', game_state: cached.state };
        }
      } catch {}
    }

    if (!round) return;

    // Offline banner removed — app is local-only (IndexedDB), no sync needed
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

    // Recompute matchScore from log entries to correct any stored corruption
    if (['betterball','csm','foursomes','greensomes','match'].includes(gs?.format) && gs?.log?.length > 0) {
      const recomputed = gs.log.reduce((acc, entry) => acc + (entry.result ?? 0), 0);
      if (recomputed !== gs.matchScore) {
        console.warn(`resumeRound: correcting matchScore from ${gs.matchScore} to ${recomputed}`);
        gameState.matchScore = recomputed;
      }
    }

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
        activeTournament     = null;
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
  try { localStorage.removeItem('lb-game-state-cache'); } catch {}
  showScreen('screen-game');
  renderGameTopBar();
  renderScoreHeader();
  renderHolePanel();
  document.getElementById('scorecard-overlay')?.classList.remove('open');
  subscribeChallenges();
  if (MULTI_USER) startSyncLoop();
  updateAmendBtn();
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

  // Show game code pill if we have one
  const codePill = document.getElementById('game-code-pill');
  if (codePill) {
    let code = null;
    try { code = localStorage.getItem('lb-game-code'); } catch {}
    if (code) {
      codePill.textContent = code;
      codePill.style.display = '';
    } else {
      codePill.style.display = 'none';
    }
  }
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
  } else if (fmt === 'texas' && (gameState.texasScoringFmt ?? 'stableford') !== 'match') {
    renderTexasScoreBar();
  } else if (fmt === 'match') {
    renderMatchBar(); // only 1v1 match still uses the bar
  } else if (['betterball','csm','foursomes','greensomes'].includes(fmt)
             || (fmt === 'texas' && (gameState.texasScoringFmt ?? '') === 'match')) {
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
      ? shortName(nm)
      : shortName(nm).slice(0, 10);

    let rawLabel = '';
    if (fmt === 'split6' && gameState.log?.length > 0) {
      const rawTotal = gameState.log.reduce((sum, e) => sum + (e.holePts?.[i] ?? 0), 0);
      rawLabel = `<div style="font-family:'Plus Jakarta Sans',sans-serif;font-size:1.1rem;font-weight:700;color:rgba(255,255,255,0.6);margin-top:1px;">(${rawTotal})</div>`;
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

function renderTexasScoreBar() {
  const bar         = document.getElementById('game-totals-bar');
  const isStableford = (gameState.texasScoringFmt ?? 'stableford') === 'stableford';
  const holesPlayed = gameState.log?.length ?? 0;
  const teamName    = gameState.teamName ?? 'Team';
  const score       = isStableford ? (gameState.texasPts ?? 0) : (gameState.grossTotal ?? 0);
  const label       = isStableford ? 'pts' : 'gross';
  const teamHcp     = gameState.teamHcp ?? 0;

  bar.style.gridTemplateColumns = '1fr';
  bar.innerHTML = `
    <div class="total-cell" style="grid-column:1/-1;">
      <div class="tc-name" style="font-size:0.7rem;letter-spacing:0.12em;">${TEXAS_HAT_SMALL} ${teamName.toUpperCase()} · HCP ${teamHcp}</div>
      <div style="display:flex;align-items:baseline;justify-content:center;gap:4px;">
        <div class="tc-pts" style="color:var(--gold);font-size:3rem;">${score}</div>
        <span style="font-size:1rem;font-weight:600;color:var(--gold);">${label}</span>
      </div>
      <div style="font-size:0.72rem;color:var(--muted);margin-top:2px;">${holesPlayed} hole${holesPlayed !== 1 ? 's' : ''} played</div>
    </div>`;
  bar.classList.remove('hidden');
}

function renderMatchBar() {
  const bar       = document.getElementById('game-match-bar');
  const fmt       = gameState.format;
  const ms        = gameState.matchScore ?? 0;
  const played    = gameState.log?.length ?? 0;
  const total     = gameState.numHoles ?? 18;
  const holesLeft = total - played;
  const up        = Math.abs(ms);
  const dormie    = up > holesLeft;

  const isPairs = ['betterball','csm','foursomes','greensomes'].includes(fmt);
  const nameA = isPairs
    ? `${shortName(gameState.names[0])} & ${shortName(gameState.names[1])}`
    : gameState.names[0].split(' ')[0];
  const nameB = isPairs
    ? `${shortName(gameState.names[2]??'')} & ${shortName(gameState.names[3]??'')}`
    : (gameState.names[1]??'').split(' ')[0];

  // Names with coloured dots
  const dotA = `<span class="dot" style="background:${pHex(0)};flex-shrink:0;"></span>`;
  const dotB = `<span class="dot" style="background:${pHex(isPairs?2:1)};flex-shrink:0;"></span>`;
  document.getElementById('mb-names-a').innerHTML = dotA + nameA;
  document.getElementById('mb-names-b').innerHTML = nameB + dotB;

  const scoreElA = document.getElementById('mb-score-a');
  const labelElA = document.getElementById('mb-label-a');
  const scoreElB = document.getElementById('mb-score-b');
  const labelElB = document.getElementById('mb-label-b');

  // Helpers — safe setters in case HTML hasn't updated yet
  const setA = (txt, col) => {
    if (scoreElA) { scoreElA.textContent = txt; scoreElA.style.color = col; }
    if (labelElA) { labelElA.textContent = ''; }
  };
  const setB = (txt, col) => {
    if (scoreElB) { scoreElB.textContent = txt; scoreElB.style.color = col; }
    if (labelElB) { labelElB.textContent = ''; }
  };
  const setLabel = (el, txt, col) => {
    if (!el) return;
    el.textContent = txt;
    el.style.color = col;
  };

  const DIM = 'rgba(255,255,255,0.65)'; // trailing side — bright enough on dark green
  if (ms === 0) {
    setA('A/S', 'var(--gold)');
    setB('A/S', 'var(--gold)');
  } else if (ms > 0) {
    setA(up, 'var(--gold)');
    setLabel(labelElA, dormie ? `&${holesLeft}` : 'UP', 'var(--gold)');
    setB(up, DIM);
    setLabel(labelElB, dormie ? `&${holesLeft}` : 'DOWN', DIM);
  } else {
    setA(up, DIM);
    setLabel(labelElA, dormie ? `&${holesLeft}` : 'DOWN', DIM);
    setB(up, 'var(--p1)');
    setLabel(labelElB, dormie ? `&${holesLeft}` : 'UP', 'var(--p1)');
  }

  bar.classList.remove('hidden');
}

function renderSkinsBar() {
  const bar = document.getElementById('game-skins-bar');
  const n   = gameState.names.length;
  const nameFontSize = n <= 2 ? '1.5rem' : n === 3 ? '1.2rem' : '1rem';
  bar.style.gridTemplateColumns = `repeat(${gameState.names.length}, 1fr)`;
  bar.innerHTML = gameState.names.map((nm, i) => {
    const sk = gameState.skins?.[i] ?? 0;
    return `
    <div class="total-cell">
      <div class="tc-name" style="font-size:${nameFontSize};">
        <span class="dot" style="background:${pHex(i)};"></span>${shortName(nm).toUpperCase()}
      </div>
      <div style="display:flex;align-items:baseline;justify-content:center;gap:3px;">
        <div class="tc-pts" style="color:#fff;">${sk}</div>
        <span style="font-size:0.9rem;font-weight:600;color:rgba(255,255,255,0.7);">skin${sk !== 1 ? 's' : ''}</span>
      </div>
    </div>`;
  }).join('');
  bar.classList.remove('hidden');
}

function renderITCBar() {
  const bar     = document.getElementById('game-itc-bar');
  const pts     = gameState.pts ?? [];
  const names   = gameState.names ?? [];
  const nPlayers = names.length;
  const maxPts  = Math.max(...pts);
  const holesLeft = (gameState.numHoles ?? 18) - (gameState.log?.length ?? 0);

  // ITC bar: always show simple pts total for each player (consistent with other formats)
  const nameFontSizeItc = nPlayers <= 2 ? '1.5rem' : nPlayers === 3 ? '1.2rem' : '1rem';
  bar.style.gridTemplateColumns = `repeat(${nPlayers}, 1fr)`;
  bar.innerHTML = names.map((nm, i) => {
    const inChair  = gameState.chair === i;
    const ptsVal   = pts[i] ?? 0;
    const numCol   = ptsVal > 0 ? 'var(--gold)' : 'var(--white)';
    return `
      <div class="total-cell${inChair ? ' itc-in-chair' : ''}">
        <div class="tc-name" style="font-size:${nameFontSizeItc};">
          <span class="dot" style="background:${pHex(i)};"></span>${shortName(nm).toUpperCase()}
        </div>
        <div class="tc-pts" style="color:#fff;font-size:2em;">${ptsVal}<span style="font-size:0.55em;font-weight:600;color:#fff;opacity:0.75;margin-left:4px;">pts</span></div>
        ${inChair ? `<div style="font-size:0.75rem;color:var(--gold);font-weight:700;margin-top:2px;">🪑 Chair</div>` : ''}
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
  if (gameState?.format && ['betterball','csm','foursomes','greensomes'].includes(gameState.format)) {
    }

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
    `<span class="si-big">Par ${par}</span><span class="si-pill">SI ${si}</span>`;
  const holeSubEl = document.getElementById('game-hole-sub');
  if (holeSubEl) {
    const left = total - h;
    holeSubEl.innerHTML = badgeHtml || (left === 1 ? 'Final hole' : `${left} holes to play`);
  }
  const pagerEl = document.getElementById('game-hole-pager-text');
  if (pagerEl) pagerEl.textContent = `${h + 1} / ${total}`;

  const backBtn = document.getElementById('btn-amend-scores');
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
  // 1–2 players: big Stitch-style cards. 3+: compact one-row cards so the hole fits on one screen.
  const _nPlayers = gameState.names?.filter(Boolean).length ?? 0;
  const _tallPhone = window.innerHeight > 760; // iPhone SE-size screens keep 3 players on one-row cards
  const _stack3   = _nPlayers === 3 && _tallPhone;
  inputsEl.classList.toggle('gi-roomy', _nPlayers <= 2 || _stack3);
  inputsEl.classList.toggle('gi-n3', _stack3);

  const recordBtn  = document.getElementById('btn-record-hole');
  const backHoleBtn = document.getElementById('btn-amend-scores');

  if (recordBtn) {
    const isPast = h < (gameState.log?.length ?? 0);
    recordBtn.textContent = isPast ? 'Confirm Update →'
      : (h === total - 1 ? 'Confirm & Finish ✓' : 'Confirm & Next →');
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
    const _ar = document.getElementById('game-action-row');
    if (_ar) { _ar.style.display = 'none'; _ar.classList.add('hidden'); }
    return;
  }

  // ── Scorer mode — show Pass scoring button ───────────────────────
  // Restore buttons
  if (recordBtn)   recordBtn.style.display   = '';
  if (backHoleBtn) backHoleBtn.style.display  = '';

  // Add Pass scoring button below inputs (injected after makePlayerInputRow calls)
  // We'll add it at the end after inputs are rendered

  const isFoursome = fmt === 'foursomes' || fmt === 'greensomes'
    || (fmt === 'texas' && (gameState.texasScoringFmt ?? 'stableford') === 'match');
  const isPairs    = ['betterball','csm','foursomes','greensomes'].includes(fmt);
  const isTexas    = fmt === 'texas';

  if (isTexas && !isFoursome) {
    // Texas Scramble: inline up/down arrows (same UX as other formats) + driver selector
    const teamName   = gameState.teamName ?? 'Team';
    const teamHcp    = gameState.teamHcp  ?? 0;
    const existEntry = gameState.log[h];
    const existGross = existEntry?.gross ?? null;
    const teamExtra  = (() => { const si = gameState.si[h]; return teamHcp <= 0 ? 0 : Math.floor(teamHcp / 18) + (si <= (teamHcp % 18) ? 1 : 0); })();

    const discColor   = existGross != null ? scoreColorForRelToPar(existGross - par, existGross) : 'transparent';
    const discText    = existGross != null ? String(existGross) : String(par);
    const discBorder  = existGross != null ? `2px solid ${discColor}` : '2px solid var(--border2)';
    const discBg      = existGross != null ? discColor : 'var(--surface3)';
    const discFgColor = existGross != null ? '#fff' : 'var(--muted)';

    const row = document.createElement('div');
    row.className = 'gi-row';
    row.style.cssText = 'flex-direction:column;align-items:stretch;gap:0.65rem;';

    row.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div style="flex:1;min-width:0;">
          <div class="gi-name" style="font-size:1.35rem;">${TEXAS_HAT_SMALL} ${teamName}</div>
          <div class="gi-hcp" style="font-size:1rem;font-weight:800;">Team HCP ${teamHcp}${teamExtra > 0 ? ` · +${teamExtra} this hole` : ''}</div>
        </div>
        <div class="gi-score-ctrl" style="display:flex;align-items:center;gap:5px;flex-shrink:0;">
          <button class="gi-arr gi-arr-dn-texas"
            style="width:40px;height:40px;border-radius:50%;border:2px solid var(--border2);
                   background:rgba(255,255,255,0.06);color:var(--white);font-size:1.4rem;
                   display:flex;align-items:center;justify-content:center;
                   touch-action:manipulation;user-select:none;cursor:pointer;">⬇</button>
          <div id="cv-texas" class="score-btn gi-score-disc"
            data-value="${existGross ?? ''}"
            style="width:52px;height:52px;border-radius:50%;
                   border:${discBorder};background:${discBg};color:${discFgColor};
                   font-family:'Plus Jakarta Sans',sans-serif;font-size:1.55rem;font-weight:800;
                   display:flex;align-items:center;justify-content:center;flex-direction:column;
                   touch-action:manipulation;user-select:none;cursor:pointer;
                   transition:background 0.12s,border-color 0.12s;">${discText}</div>
          <button class="gi-arr gi-arr-up-texas"
            style="width:40px;height:40px;border-radius:50%;border:2px solid #38a169;
                   background:rgba(56,161,105,0.15);color:#38a169;font-size:1.4rem;
                   display:flex;align-items:center;justify-content:center;
                   touch-action:manipulation;user-select:none;cursor:pointer;">⬆</button>
        </div>
      </div>
      <div>
        <div style="font-size:1rem;font-weight:800;color:var(--muted2);margin-bottom:0.4rem;">Tee shot used:</div>
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

    // Helper to update the cv-texas disc
    function _texasSetScore(val) {
      const el = row.querySelector('#cv-texas');
      if (!el) return;
      el.dataset.value = String(val);
      const color = scoreColorForRelToPar(val - par, val);
      el.style.background  = color;
      el.style.borderColor = color;
      el.style.color       = '#fff';
      el.style.fontSize    = '1.55rem';
      el.textContent       = String(val);
    }
    function _texasCurrentScore() {
      const v = parseInt(row.querySelector('#cv-texas')?.dataset?.value, 10);
      return isNaN(v) ? null : v;
    }
    const TX_MIN = 1, TX_MAX = par + teamExtra + 5;

    // DOWN arrow
    row.querySelector('.gi-arr-dn-texas').addEventListener('touchstart', (e) => {
      if (_pageScrolling) return;
      e.preventDefault();
      const cur = _texasCurrentScore();
      const next = cur != null ? cur - 1 : par - 1;
      if (next < TX_MIN) return;
      _texasSetScore(next);
    }, { passive: false });
    row.querySelector('.gi-arr-dn-texas').addEventListener('click', (e) => {
      if (e.sourceCapabilities?.firesTouchEvents) return;
      const cur = _texasCurrentScore();
      const next = cur != null ? cur - 1 : par - 1;
      if (next < TX_MIN) return;
      _texasSetScore(next);
    });

    // UP arrow
    row.querySelector('.gi-arr-up-texas').addEventListener('touchstart', (e) => {
      if (_pageScrolling) return;
      e.preventDefault();
      const cur = _texasCurrentScore();
      const next = cur != null ? cur + 1 : par + 1;
      if (next > TX_MAX) return;
      _texasSetScore(next);
    }, { passive: false });
    row.querySelector('.gi-arr-up-texas').addEventListener('click', (e) => {
      if (e.sourceCapabilities?.firesTouchEvents) return;
      const cur = _texasCurrentScore();
      const next = cur != null ? cur + 1 : par + 1;
      if (next > TX_MAX) return;
      _texasSetScore(next);
    });

    // Centre disc — tap to reset to par
    row.querySelector('#cv-texas').addEventListener('touchstart', (e) => {
      if (_pageScrolling) return;
      e.preventDefault();
      _texasSetScore(par);
    }, { passive: false });
    row.querySelector('#cv-texas').addEventListener('click', (e) => {
      if (e.sourceCapabilities?.firesTouchEvents) return;
      _texasSetScore(par);
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
    const fmtGs     = gameState.format;
    const tsMode    = gameState.teamScoringMode ?? 'match';
    const isTeamSb  = tsMode === 'stableford';
    const isTeamStr = tsMode === 'stroke';
    const isTeamMatch = !isTeamSb && !isTeamStr;

    // Raw team HCPs (used for stableford/stroke)
    const mh = gameState.matchHandicaps ?? [];
    const pairAHcpRaw = fmtGs === 'greensomes'
      ? greensomesPairHandicap(mh[0]??0, mh[1]??0)
      : foursomedPairHandicap(mh[0]??0, mh[1]??0);
    const pairBHcpRaw = fmtGs === 'greensomes'
      ? greensomesPairHandicap(mh[2]??0, mh[3]??0)
      : foursomedPairHandicap(mh[2]??0, mh[3]??0);

    // For match play: allowance = difference from lowest
    const lowestPairHcp = Math.min(pairAHcpRaw, pairBHcpRaw);
    const pairAllowance = { A: pairAHcpRaw - lowestPairHcp, B: pairBHcpRaw - lowestPairHcp };
    const pairRawHcp    = { A: pairAHcpRaw, B: pairBHcpRaw };

    [['A', 0, 1, ms], ['B', 2, 3, -ms]].forEach(([label, p0, p1, teamMs]) => {
      const pairIdx = label === 'A' ? 0 : 1;

      // Status shown next to pair name
      let teamStatus = '';
      if (isTeamMatch) {
        teamStatus = ms === 0
          ? 'All Square'
          : teamMs > 0
            ? `${up > holesLeft ? `${up}&${holesLeft}` : `${up} Up`}`
            : `${up > holesLeft ? `${up}&${holesLeft}` : `${up} Down`}`;
      } else if (isTeamSb) {
        const pts = gameState.teamPts?.[pairIdx] ?? 0;
        teamStatus = `${pts} pt${pts !== 1 ? 's' : ''}`;
      } else {
        const net = gameState.teamNets?.[pairIdx] ?? 0;
        teamStatus = `${net} net`;
      }

      const statusColor = isTeamMatch
        ? (ms === 0 ? 'var(--muted2)' : teamMs > 0 ? 'var(--gold)' : 'var(--muted2)')
        : 'var(--gold)';

      const pairDisplayName = setup.pairs?.[pairIdx]?.teamName?.trim()
        || `${gameState.names[p0]?.split(' ')[0] ?? 'P'+(p0+1)} & ${gameState.names[p1]?.split(' ')[0] ?? 'P'+(p1+1)}`;

      const header = document.createElement('div');
      header.style.cssText = 'padding:0.65rem 0 0.35rem;border-top:1px solid var(--border);margin-top:0.25rem;display:flex;align-items:center;justify-content:space-between;';
      header.innerHTML = `
        <span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.5rem;
                     color:var(--white);">${pairDisplayName}</span>
        <span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.5rem;
                     color:${statusColor};">${teamStatus}</span>`;
      inputsEl.appendChild(header);

      const existingEntry = gameState.log?.[h];
      const existingGross = existingEntry?.grosses?.[pairIdx];
      const hasExisting   = existingGross != null;
      const effectiveGross = hasExisting ? existingGross : par;

      // HCP / shots this hole
      const rawHcp    = pairRawHcp[label];
      const allowance = pairAllowance[label];
      const hcpLineTxt = isTeamMatch
        ? (allowance === 0 ? 'Plays off Scratch' : `Receives ${allowance} shot${allowance === 1 ? '' : 's'}`)
        : `Team HCP ${rawHcp}`;
      // Shots on this hole for the pair (match play allowance)
      const pairExtra = isTeamMatch
        ? (() => { const si = gameState.si[h]; return allowance <= 0 ? 0 : Math.floor(allowance / 18) + (si <= (allowance % 18) ? 1 : 0); })()
        : 0;

      // Disc styling — dashed border when no score yet (same as gi-card)
      const parColor   = scoreColorForRelToPar(0, par);
      const discColor  = scoreColorForRelToPar(effectiveGross - par, effectiveGross);
      const discOpacity = hasExisting ? '' : 'opacity:0.7;';
      const discBorder  = hasExisting ? `2px solid ${discColor}` : `2px dashed ${parColor}`;

      // ── Pair scorer card — identical visual to makePlayerInputRow but one
      //    shared disc for the pair (scramble: both players, one ball) ──
      // Shot badge (30% bigger than solo) shown in gi-id; Net pill under disc
      const shotBadgeHtml = pairExtra > 0
        ? `<span class="gi-shot-badge" style="font-size:1.17em;padding:0.2em 0.5em;">` +
          `<span class="gi-shot-num">${pairExtra}</span>` +
          `<span class="gi-shot-lbl">shot${pairExtra > 1 ? 's' : ''}</span></span>`
        : ``;
      const netVal = effectiveGross - pairExtra;
      // Net pill sits below the disc circle (inside gi-disc-wrap), updated alongside gi-rel
      const netPillHtml = pairExtra > 0
        ? `<span id="gi-pair-net-${label}" style="margin-top:0.2em;font-size:0.78rem;font-weight:700;color:var(--muted);text-align:center;display:block;">Net ${netVal}</span>`
        : ``;

      const row = document.createElement('div');
      row.className = 'gi-row gi-card';
      row.dataset.extra = String(pairExtra);
      row.dataset.par   = String(par);
      row.dataset.pair  = label;

      row.innerHTML = `
        <div class="gi-top">
          <div class="gi-id">
            <div class="gi-name">
              <span class="dot" style="background:${pHex(p0)};"></span>
              <span class="gi-name-txt">${shortName(gameState.names[p0])}</span>
            </div>
            <div class="gi-name" style="margin-top:2px;">
              <span class="dot" style="background:${pHex(p1)};"></span>
              <span class="gi-name-txt">${shortName(gameState.names[p1])}</span>
            </div>
            ${shotBadgeHtml ? `<div style="margin-top:0.3em;">${shotBadgeHtml}</div>` : ''}
            <div class="gi-prev" id="gi-pair-prev-${label}"></div>
          </div>
          <div class="gi-calc">
            <div class="gi-calc-lbl">This hole</div>
            <div class="gi-calc-val" id="gi-pair-calc-${label}">—</div>
          </div>
        </div>
        <div class="gi-score-ctrl">
          <button class="gi-arr gi-arr-dn-pair" data-pair="${label}" aria-label="One less">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
          <div class="gi-disc-wrap">
            <div id="cv-pair-${label}" class="score-btn gi-score-disc has-score${hasExisting ? '' : ' par-default'}"
              data-value="${effectiveGross}" data-pickup="0" data-pair="${label}"
              style="--sc:${_giRingColor(hasExisting ? discColor : parColor)};${discOpacity}">${effectiveGross}</div>
            <div class="gi-rel" id="gi-pair-rel-${label}">${_giRelWord(effectiveGross, par, false)}</div>
            ${netPillHtml}
          </div>
          <button class="gi-arr gi-arr-up-pair" data-pair="${label}" aria-label="One more">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
        </div>`;
      inputsEl.appendChild(row);

      // Tee shot used — inline row: label left, compact buttons right
      const existDriverIdx = existingEntry?.grosses?.[label === 'A' ? 2 : 3] ?? -1;
      const driverSection = document.createElement('div');
      driverSection.style.cssText = 'margin-top:0.4rem;margin-bottom:0.25rem;display:flex;align-items:center;gap:0.5rem;';
      driverSection.innerHTML = `
        <div style="font-size:0.75rem;font-weight:700;color:var(--muted2);text-transform:uppercase;letter-spacing:0.06em;white-space:nowrap;flex-shrink:0;">Tee shot used</div>
        <div style="display:flex;gap:0.35rem;flex:1;" id="pair-driver-btns-${label}">
          ${[p0, p1].map(pi => `
            <button class="pair-driver-btn ${existDriverIdx === pi ? 'holes-btn active' : 'btn-outline'}"
              data-pair-driver="${label}" data-pi="${pi}"
              style="flex:1;padding:0.4rem 0.25rem;font-size:0.85rem;font-weight:800;">
              ${gameState.names[pi]?.split(' ')[0] ?? `P${pi+1}`}
            </button>`).join('')}
        </div>`;
      inputsEl.appendChild(driverSection);

      // Live calc update for pair
      function _pairUpdateCalc(val) {
        const calcEl = row.querySelector(`#gi-pair-calc-${label}`);
        const relEl  = row.querySelector(`#gi-pair-rel-${label}`);
        const netEl  = row.querySelector(`#gi-pair-net-${label}`);
        if (relEl) relEl.textContent = _giRelWord(val, par, false);
        const net = val - pairExtra;
        if (netEl) netEl.textContent = `Net ${net}`;
        if (!calcEl) return;
        const sb  = isTeamSb;
        if (sb) {
          const pts = Math.max(0, 2 + par - net);
          calcEl.textContent = `Net ${net} (${pts} pt${pts === 1 ? '' : 's'})`;
          calcEl.dataset.tone = pts >= 3 ? 'good' : pts === 2 ? 'ok' : 'muted';
        } else {
          calcEl.textContent = `Net ${net}`;
          calcEl.dataset.tone = net < par ? 'good' : net === par ? 'ok' : 'muted';
        }
      }
      queueMicrotask(() => _pairUpdateCalc(effectiveGross));

      function _pairCurrentScore() {
        const v = parseInt(document.getElementById(`cv-pair-${label}`)?.dataset?.value, 10);
        return isNaN(v) ? par : v;
      }
      function _pairSetScore(val) {
        setPairScoreValue(label, h, par, val, false);
        const disc = document.getElementById(`cv-pair-${label}`);
        if (disc) {
          disc.classList.add('has-score');
          disc.classList.remove('par-default');
          disc.style.opacity = '';
          const col = scoreColorForRelToPar(val - par, val);
          disc.style.setProperty('--sc', _giRingColor(col));
        }
        _pairUpdateCalc(val);
      }

      const MIN_GROSS = 1, MAX_GROSS = par + pairExtra + 5;

      row.querySelector('.gi-arr-dn-pair').addEventListener('touchstart', (e) => {
        if (_pageScrolling) return;
        e.preventDefault();
        const next = _pairCurrentScore() - 1;
        if (next < MIN_GROSS) return;
        _pairSetScore(next);
      }, { passive: false });
      row.querySelector('.gi-arr-dn-pair').addEventListener('click', (e) => {
        if (e.sourceCapabilities?.firesTouchEvents) return;
        const next = _pairCurrentScore() - 1;
        if (next < MIN_GROSS) return;
        _pairSetScore(next);
      });
      row.querySelector('.gi-arr-up-pair').addEventListener('touchstart', (e) => {
        if (_pageScrolling) return;
        e.preventDefault();
        const next = _pairCurrentScore() + 1;
        if (next > MAX_GROSS) return;
        _pairSetScore(next);
      }, { passive: false });
      row.querySelector('.gi-arr-up-pair').addEventListener('click', (e) => {
        if (e.sourceCapabilities?.firesTouchEvents) return;
        const next = _pairCurrentScore() + 1;
        if (next > MAX_GROSS) return;
        _pairSetScore(next);
      });

      // Driver button toggle
      driverSection.querySelectorAll('.pair-driver-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const alreadyActive = btn.classList.contains('active');
          driverSection.querySelectorAll('.pair-driver-btn').forEach(b => {
            b.classList.remove('active', 'holes-btn');
            b.classList.add('btn-outline');
          });
          if (!alreadyActive) {
            btn.classList.add('active', 'holes-btn');
            btn.classList.remove('btn-outline');
          }
        });
      });

    });  // end forEach pairs

  } else if (isPairs) {
    const ms        = gameState.matchScore ?? 0;
    const played    = gameState.log?.length ?? 0;
    const holesLeft = (gameState.numHoles ?? 18) - played;
    const up        = Math.abs(ms);
    const nameA     = `${shortName(gameState.names[0]??'')} & ${shortName(gameState.names[1]??'')}`;
    const nameB     = `${shortName(gameState.names[2]??'')} & ${shortName(gameState.names[3]??'')}`;

    [[[0,1], nameA, ms], [[2,3], nameB, -ms]].forEach(([pis, teamName, teamMs]) => {
      // Bold team name + status above each pair's players
      const teamStatus = ms === 0
        ? 'All Square'
        : teamMs > 0
          ? `${up > holesLeft ? `${up}&${holesLeft}` : `${up} Up`}`
          : `${up > holesLeft ? `${up}&${holesLeft}` : `${up} Down`}`;

      const header = document.createElement('div');
      header.style.cssText = 'padding:0.65rem 0 0.35rem;border-top:1px solid var(--border);margin-top:0.25rem;display:flex;align-items:center;justify-content:space-between;';
      header.innerHTML = `
        <span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.5rem;
                     color:${ms === 0 ? 'var(--white)' : teamMs > 0 ? 'var(--gold)' : 'var(--muted2)'};">
          ${teamName}
        </span>
        <span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.5rem;
                     color:${ms === 0 ? 'var(--muted2)' : teamMs > 0 ? 'var(--gold)' : 'var(--muted2)'};">
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

  // Action row removed from scoring screen — push/view scores via Leaderboard button

  // Texas Scramble: show running driver usage tally (below Confirm & Next)
  if (isTexas) {
    const tallyEl = document.getElementById('tee-shots-chart');
    const driverWrap = document.createElement('div');

    const names = gameState.names ?? [];
    const quotaTotal = gameState.texasDrivesTotal ?? null;
    const quotaPar3  = gameState.texasDrivesPar3  ?? null;

    // Per-player counts
    const totalCounts = {};
    const par3Counts  = {};

    if (isFoursome) {
      // 2v2 match: driver data in log entries as grosses[2] (pair A driver pi) / grosses[3] (pair B driver pi)
      (gameState.log ?? []).forEach((entry, hIdx) => {
        if (!entry || !Array.isArray(entry.grosses)) return;
        const hPar = gameState.pars?.[hIdx] ?? 4;
        const driverA = entry.grosses[2];
        const driverB = entry.grosses[3];
        [driverA, driverB].forEach(pi => {
          if (pi == null || pi < 0) return;
          totalCounts[pi] = (totalCounts[pi] ?? 0) + 1;
          if (hPar === 3) par3Counts[pi] = (par3Counts[pi] ?? 0) + 1;
        });
      });
    } else {
      // Regular Texas: driverUsage object
      const usage = gameState.driverUsage ?? { par3: [], par4: [], par5: [] };
      [...(usage.par3 ?? []), ...(usage.par4 ?? []), ...(usage.par5 ?? [])].forEach(pi => {
        totalCounts[pi] = (totalCounts[pi] ?? 0) + 1;
      });
      (usage.par3 ?? []).forEach(pi => {
        par3Counts[pi] = (par3Counts[pi] ?? 0) + 1;
      });
    }

    const headers = names.map((name) =>
      `<th style="text-align:center;padding:0.4rem 0.35rem;font-size:0.9rem;font-weight:800;color:var(--muted2);">
        ${name.split(' ')[0]}
      </th>`
    ).join('');

    const totalRow = names.map((_, pi) => {
      const count = totalCounts[pi] ?? 0;
      const met   = quotaTotal != null && count >= quotaTotal;
      const color = met ? 'var(--green)' : 'var(--red, #d64545)';
      const lbl   = quotaTotal != null ? `${count}/${quotaTotal}` : String(count);
      return `<td style="text-align:center;padding:0.5rem 0.35rem;
                font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.15rem;
                color:${color};">${lbl}</td>`;
    }).join('');

    const par3Row = names.map((_, pi) => {
      const count = par3Counts[pi] ?? 0;
      const met   = quotaPar3 != null && count >= quotaPar3;
      const color = met ? 'var(--green)' : 'var(--red, #d64545)';
      const lbl   = quotaPar3 != null ? `${count}/${quotaPar3}` : String(count);
      return `<td style="text-align:center;padding:0.5rem 0.35rem;
                font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.15rem;
                color:${color};">${lbl}</td>`;
    }).join('');

    driverWrap.innerHTML = `
      <div style="font-size:0.9rem;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;
                  color:var(--muted);margin-bottom:0.35rem;">Tee Shots Used</div>
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

    if (tallyEl) {
      tallyEl.innerHTML = '';
      tallyEl.appendChild(driverWrap);
      tallyEl.style.display = '';
    } else {
      inputsEl.appendChild(driverWrap);
    }
  } else {
    const tallyEl = document.getElementById('tee-shots-chart');
    if (tallyEl) tallyEl.style.display = 'none';
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
            <div style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.1rem;">${title}</div>
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
          <div style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.1rem;">${title}</div>
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
  const titleEl   = `<div style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.05rem;margin-bottom:0.65rem;">🏌️ Longest Drive</div>`;

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
        font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:0.9rem;
        text-align:center;transition:all 0.2s;${teeStyle}">
        ${teeMarked ? '✓ Tee Marked' : '📍 Mark Tee Position'}
      </button>
      <button id="ld-btn-ball" ${!teeMarked ? 'disabled' : ''} style="flex:1;padding:0.75rem 0.4rem;border-radius:var(--radius-sm);
        font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:0.9rem;
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
             margin-bottom:0.4rem;font-family:'Plus Jakarta Sans',sans-serif;font-weight:700;
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
             margin-bottom:0.4rem;font-family:'Plus Jakarta Sans',sans-serif;font-weight:700;font-size:1.05rem;
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


// ── Scoring card helpers (Stitch-style player cards) ─────────────
function _giRingColor(color) {
  // Near-black "worse than double" colour vanishes on dark surfaces — use text colour instead
  return color === '#2a2a2a' ? 'var(--white)' : color;
}

function _giRelWord(value, par, isPickup) {
  if (isPickup) return 'Pick up';
  if (value === 1) return 'Ace!';
  const d = value - par;
  if (d <= -3) return 'Albatross';
  if (d === -2) return 'Eagle';
  if (d === -1) return 'Birdie';
  if (d === 0)  return 'Par';
  if (d === 1)  return 'Bogey';
  if (d === 2)  return 'Double';
  if (d === 3)  return 'Triple';
  return `+${d}`;
}

function _giIsStablefordFmt() {
  return ['stableford', 'best2'].includes(gameState?.format);
}

function _giRunningTotal(pi) {
  const log = gameState?.log ?? [];
  if (_giIsStablefordFmt()) {
    const pts = log.reduce((t, e) => t + (e?.holePts?.[pi] ?? 0), 0);
    return `${pts} pts`;
  }
  let rel = 0;
  log.forEach((e, k) => {
    const g = e?.grosses?.[pi];
    if (g != null && gameState.par?.[k] != null) rel += g - gameState.par[k];
  });
  return rel === 0 ? 'E' : rel > 0 ? `+${rel}` : String(rel);
}

function _giUpdateCalc(pi, value, isPickup, rowEl) {
  const row = rowEl ?? document.getElementById(`cv${pi}`)?.closest('.gi-card');
  if (!row) return;
  const extra = parseInt(row.dataset.extra, 10) || 0;
  const par   = parseInt(row.dataset.par, 10);
  const calcEl = row.querySelector(`#gi-calc-${pi}`);
  const relEl  = row.querySelector(`#gi-rel-${pi}`);
  if (relEl) relEl.textContent = _giRelWord(value, par, isPickup);
  if (!calcEl) return;
  const sb = _giIsStablefordFmt();
  if (isPickup) {
    calcEl.textContent = sb ? 'Pick up · 0 pts' : 'Pick up';
    calcEl.dataset.tone = 'muted';
    return;
  }
  const net = value - extra;
  if (sb) {
    const pts = Math.max(0, 2 + par - net);
    calcEl.textContent = `Net ${net} (${pts} pt${pts === 1 ? '' : 's'})`;
    calcEl.dataset.tone = pts >= 3 ? 'good' : pts === 2 ? 'ok' : 'muted';
  } else {
    calcEl.textContent = `Net ${net}`;
    calcEl.dataset.tone = net < par ? 'good' : net === par ? 'ok' : 'muted';
  }
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
  // When no existing score, pre-fill with par so players can just tap Next
  const effectiveGross = hasExisting ? existingGross : par;
  const isPickup    = existingEntry?.pickups?.[pi] ?? false;
  const scoreBtnVal   = hasExisting
    ? (isPickup ? `<span style="font-size:0.75rem;font-weight:800;display:block;line-height:1.1;">P.Up</span><span style="font-size:0.85rem;font-weight:700;">(${existingGross})</span>` : String(existingGross))
    : 'Score';
  let scoreBtnStyle;
  if (!hasExisting) {
    scoreBtnStyle = 'border:2px solid var(--border);background:var(--surface2);color:var(--muted);';
  } else if (isPickup) {
    scoreBtnStyle = 'border:2px solid var(--gold);background:var(--gold);color:#fff;';
  } else {
    const color = scoreColorForRelToPar(existingGross - par, existingGross);
    scoreBtnStyle = `border:2px solid ${color};background:${color};color:${existingGross === 1 ? '#000' : '#fff'};`;
  }

  // Build the inline scoring control.
  // cv${pi} remains the canonical score DOM node — recordHole() still reads
  // cv${pi}.dataset.value and cv${pi}.dataset.pickup, unchanged.
  // All scoring, pickup, and Scorecard Edit paths are unaffected.

  const row = document.createElement('div');
  row.className = `gi-row${inChair ? ' in-chair' : ''}`;

  // Score colour / content for the centre disc
  // When no score yet, show par in the disc with a faint "par" colour so the
  // user can see the default and just tap Next without touching anything.
  const parColor   = scoreColorForRelToPar(0, par); // always the par (green) colour
  const discColor  = isPickup ? 'var(--gold)'
    : scoreColorForRelToPar(effectiveGross - par, effectiveGross);
  const discText   = isPickup
    ? `<span style="font-size:0.72rem;font-weight:800;line-height:1.1;display:block;">P.Up</span><span style="font-size:0.82rem;font-weight:700;opacity:0.85;">(${existingGross})</span>`
    : String(effectiveGross);
  const discTextColor = effectiveGross === 1 ? 'var(--white)' : '#fff';
  // New hole: show par colour with dashed border + dimmed to signal "default, not yet confirmed"
  const discOpacity = hasExisting ? '' : 'opacity:0.7;';
  const discBorder = hasExisting ? `2px solid ${discColor}` : `2px dashed ${parColor}`;

  const shotPill = extra > 0
    ? `<span class="gi-shot-badge"><span class="gi-shot-num">${extra}</span><span class="gi-shot-lbl">shot${extra > 1 ? 's' : ''}</span></span>`
    : extra < 0
      ? `<span class="gi-pill gi-pill-plus">−${-extra}</span>`
      : ``;
  row.classList.add('gi-card');
  row.dataset.pi    = String(pi);
  row.dataset.extra = String(extra);
  row.dataset.par   = String(par);

  row.innerHTML = `
    <div class="gi-top">
      <div class="gi-id">
        <div class="gi-name">
          <span class="dot" style="background:${pHex(pi)};"></span>
          <span class="gi-name-txt">${shortName(gameState.names[pi])}</span>
          ${shotPill}
          ${inChair ? '<span class="gi-chair">🪑</span>' : ''}
        </div>
        <div class="gi-hcp"><span class="gi-hcp-long">${hcpLine}</span><span class="gi-hcp-short">HCP ${isIndiv ? gameState.playingHandicaps[pi] : gameState.matchHandicaps[pi]}</span> · <b>${_giRunningTotal(pi)}</b></div>
        <div class="gi-prev" id="gi-prev-${pi}">${prevLabel}</div>
      </div>
      <div class="gi-calc">
        <div class="gi-calc-lbl">This hole</div>
        <div class="gi-calc-val" id="gi-calc-${pi}">—</div>
      </div>
    </div>
    <div class="gi-score-ctrl">
      <button class="gi-arr gi-arr-dn" data-pi="${pi}" aria-label="One less">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
      <div class="gi-disc-wrap">
        <!-- Centre score disc — always has a value (defaults to par for new holes) -->
        <div id="cv${pi}" class="score-btn gi-score-disc has-score${hasExisting ? '' : ' par-default'}${isPickup ? ' is-pickup' : ''}" data-pi="${pi}"
          data-value="${effectiveGross}" data-pickup="${isPickup ? '1' : '0'}"
          style="--sc:${_giRingColor(hasExisting ? discColor : parColor)};${discOpacity}">${discText}</div>
        <div class="gi-rel" id="gi-rel-${pi}">${_giRelWord(effectiveGross, par, isPickup)}</div>
      </div>
      <button class="gi-arr gi-arr-up" data-pi="${pi}" aria-label="One more">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
      <!-- Pickup button -->
      <button class="gi-pickup-btn${isPickup ? ' is-on' : ''}" data-pi="${pi}">Pick<br>up</button>
    </div>`;

  // Fill the "This hole" calc — always shown (defaults to par for new holes)
  queueMicrotask(() => _giUpdateCalc(pi, effectiveGross, isPickup, row));

  // ── Wire the new inline controls ──────────────────────────────────
  // Touch model: touchstart fires immediately with e.preventDefault() to
  // suppress the synthetic click (no double-fire). _pageScrolling guard
  // prevents accidental taps while the user is scrolling.

  function _liveSetScore(newVal, newIsPickup) {
    setScoreValue(pi, h, par, newVal, newIsPickup);
  }

  function _currentScore() {
    const el = document.getElementById(`cv${pi}`);
    const v = parseInt(el?.dataset?.value, 10);
    return isNaN(v) ? null : v;
  }

  function _currentIsPickup() {
    return document.getElementById(`cv${pi}`)?.dataset?.pickup === '1';
  }

  const MIN_GROSS = 1;
  const MAX_GROSS = par + extra + 5; // sensible ceiling

  // DOWN arrow — decrease by 1
  row.querySelector('.gi-arr-dn').addEventListener('touchstart', (e) => {
    if (_pageScrolling) return;
    e.preventDefault();
    const cur = _currentScore();
    const next = cur != null ? cur - 1 : par - 1;
    if (next < MIN_GROSS) return;
    _liveSetScore(next, false);
  }, { passive: false });
  row.querySelector('.gi-arr-dn').addEventListener('click', (e) => {
    if (e.sourceCapabilities?.firesTouchEvents) return; // already handled
    const cur = _currentScore();
    const next = cur != null ? cur - 1 : par - 1;
    if (next < MIN_GROSS) return;
    _liveSetScore(next, false);
  });

  // UP arrow — increase by 1
  row.querySelector('.gi-arr-up').addEventListener('touchstart', (e) => {
    if (_pageScrolling) return;
    e.preventDefault();
    const cur = _currentScore();
    const next = cur != null ? cur + 1 : par + 1;
    if (next > MAX_GROSS) return;
    _liveSetScore(next, false);
  }, { passive: false });
  row.querySelector('.gi-arr-up').addEventListener('click', (e) => {
    if (e.sourceCapabilities?.firesTouchEvents) return;
    const cur = _currentScore();
    const next = cur != null ? cur + 1 : par + 1;
    if (next > MAX_GROSS) return;
    _liveSetScore(next, false);
  });

  // Centre disc — tap to set par
  row.querySelector('.gi-score-disc').addEventListener('touchstart', (e) => {
    if (_pageScrolling) return;
    e.preventDefault();
    if (_currentIsPickup()) {
      // Un-pickup: restore to par
      _liveSetScore(par, false);
    } else {
      _liveSetScore(par, false);
    }
  }, { passive: false });
  row.querySelector('.gi-score-disc').addEventListener('click', (e) => {
    if (e.sourceCapabilities?.firesTouchEvents) return;
    _liveSetScore(par, false);
  });

  // Pickup button
  row.querySelector('.gi-pickup-btn').addEventListener('touchstart', (e) => {
    if (_pageScrolling) return;
    e.preventDefault();
    if (_currentIsPickup()) {
      // Un-pickup: restore to par
      _liveSetScore(par, false);
    } else {
      // Use existing pickup value: net double bogey
      const morePickupVal = par + extra + 2;
      _liveSetScore(morePickupVal, true);
    }
  }, { passive: false });
  row.querySelector('.gi-pickup-btn').addEventListener('click', (e) => {
    if (e.sourceCapabilities?.firesTouchEvents) return;
    if (_currentIsPickup()) {
      _liveSetScore(par, false);
    } else {
      const morePickupVal = par + extra + 2;
      _liveSetScore(morePickupVal, true);
    }
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
      <span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.3rem;color:var(--white);">${net}</span>
      <span style="display:flex;align-items:center;justify-content:center;width:54px;height:54px;margin:0 auto;
                    border-radius:50%;background:${circleColor};color:#fff;
                    font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.7rem;">${v}</span>
      <span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.3rem;color:var(--muted2);">${pts > 0 ? pts : '-'}</span>
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


// ── Score picker scroll guard ──────────────────────────────────
// Tracks whether a scroll happened during a touch sequence.
// If yes, suppress the button action on touchend.
let _spScrolling = false;
let _spTouchStartY = 0;
const SCROLL_THRESHOLD = 10; // px — rapid tap is <10px; deliberate scroll is ≥10px

// Page-level scroll tracker — prevents picker opening mid-scroll
let _pageScrolling = false;
let _pageScrollTimer = null;
let _pageTouchStartY = 0;
document.addEventListener('touchstart', (e) => {
  _pageTouchStartY = e.touches[0]?.clientY ?? 0;
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (Math.abs((e.touches[0]?.clientY ?? 0) - _pageTouchStartY) > 8) {
    _pageScrolling = true;
    clearTimeout(_pageScrollTimer);
    _pageScrollTimer = setTimeout(() => { _pageScrolling = false; }, 300);
  }
}, { passive: true });
document.addEventListener('touchend', () => {
  clearTimeout(_pageScrollTimer);
  _pageScrollTimer = setTimeout(() => { _pageScrolling = false; }, 150);
}, { passive: true });

function attachScrollGuard(gridEl) {
  // Guard: only attach once per gridEl — prevents listener accumulation
  // across repeated picker opens (each open calls this function).
  if (gridEl._scrollGuardAttached) return;
  gridEl._scrollGuardAttached = true;

  gridEl.addEventListener('touchstart', (e) => {
    _spScrolling   = false;
    _spTouchStartY = e.touches[0]?.clientY ?? 0;
  }, { passive: true });

  gridEl.addEventListener('touchmove', (e) => {
    const dy = Math.abs((e.touches[0]?.clientY ?? 0) - _spTouchStartY);
    if (dy > SCROLL_THRESHOLD) _spScrolling = true;
  }, { passive: true });
}

function openScorePicker(pi, h, par) {
  _spScrolling = false; // always reset before opening picker
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
      <span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.3rem;color:${v === 1 ? 'var(--gold)' : relToPar < 0 ? '#d64545' : 'var(--white)'};">${net}</span>
      <span style="display:flex;align-items:center;justify-content:center;width:54px;height:54px;margin:0 auto;
                    border-radius:50%;background:${circleColor};color:${v === 1 ? '#000' : '#fff'};
                    font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.7rem;">${v}</span>
      <span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.3rem;color:var(--muted2);">${pts > 0 ? pts : '-'}</span>
    </button>`;
  };

  const gridEl = document.getElementById('sp-grid');
  const morePickupVal = par + extra + 2; // gross that gives net double bogey = 0 pts

  gridEl.innerHTML =
    Array.from({ length: max - min + 1 }, (_, i) => buildBtn(min + i)).join('')
    + `<button id="sp-pickup" class="btn"
        style="width:100%;font-size:0.95rem;font-weight:700;padding:0.85rem;margin-top:0.2rem;
               background:var(--gold);border:none;color:#000;">
        🏌️ Pick Up / DNF
      </button>`;

  attachScrollGuard(gridEl);
  gridEl.querySelectorAll('.sp-num-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      // Desktop/mouse fallback only. On touch devices this is always
      // suppressed by e.preventDefault() in the touchend handler below.
      e.stopPropagation();
      if (_spScrolling) { _spScrolling = false; return; }
      const v = parseInt(btn.dataset.val, 10);
      setScoreValue(pi, h, par, v, false);
      closeScorePicker();
    });
    btn.addEventListener('touchend', (e) => {
      // e.preventDefault() is called FIRST, unconditionally.
      // This suppresses the iOS synthetic click that fires ~300ms later,
      // preventing a second call to setScoreValue() via the click handler.
      // Without this, if the touchend exits early (scroll detected),
      // the synthetic click fires later and can call setScoreValue() at an
      // unexpected time — causing delayed/duplicate score commits.
      e.preventDefault();
      e.stopPropagation();
      if (_spScrolling) { _spScrolling = false; return; }
      const v = parseInt(btn.dataset.val, 10);
      setScoreValue(pi, h, par, v, false);
      closeScorePicker();
    }, { passive: false });
  });

  document.getElementById('sp-pickup').onclick = (e) => {
    e.stopPropagation();
    if (_spScrolling) { _spScrolling = false; return; }
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

// ── Score picker ghost-click guard ───────────────────────────────
// iOS fires a synthetic click ~300ms after touchend. We block it
// with a flag that is set on touchend and cleared after the click
// has been fully consumed — no timing dependency.
let _pickerJustClosed = false;

function closeScorePicker() {
  _amendPickerMode = false; // cancel amend pick if user dismisses without selecting
  document.getElementById('modal-score-picker').classList.remove('open');
  _pickerJustClosed = true;
  // Clear after a generous window — 600ms covers all iOS devices
  setTimeout(() => { _pickerJustClosed = false; }, 600);
}

// Foursomes / Greensomes: one shared score per pair (alternate shot — single
// ball), so this writes to cv-pair-A/B instead of an individual cv${pi}.
// Net/points shown in the picker use the pair's combined match handicap.
function openPairScorePicker(label, h, par, anchorPi) {
  const cvEl    = document.getElementById(`cv-pair-${label}`);
  const current = cvEl?.dataset.value;

  const p0 = label === 'A' ? 0 : 2, p1 = label === 'A' ? 1 : 3;
  const pairNames = `${shortName(gameState.names[p0]??'')} & ${shortName(gameState.names[p1]??'')}`;

  document.getElementById('sp-player-name').textContent = `Pair ${label} — ${pairNames}`;
  document.getElementById('sp-context').textContent = `Hole ${h + 1} · Par ${par}`;

  const fmt     = gameState.format;
  const mh      = gameState.matchHandicaps ?? [];
  const pairHcp = fmt === 'greensomes'
    ? greensomesPairHandicap(mh[p0] ?? 0, mh[p1] ?? 0)
    : foursomedPairHandicap(mh[p0] ?? 0, mh[p1] ?? 0);
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
      <span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.3rem;color:${v === 1 ? 'var(--gold)' : relToPar < 0 ? '#d64545' : 'var(--white)'};">${net}</span>
      <span style="display:flex;align-items:center;justify-content:center;width:54px;height:54px;margin:0 auto;
                    border-radius:50%;background:${circleColor};color:${v === 1 ? '#000' : '#fff'};
                    font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.7rem;">${v}</span>
      <span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.3rem;color:var(--muted2);">${pts > 0 ? pts : '-'}</span>
    </button>`;
  };

  const gridEl = document.getElementById('sp-grid');
  const pickupVal = par + extra + 2; // gross that gives net double bogey = 0 pts

  gridEl.innerHTML =
    Array.from({ length: max - min + 1 }, (_, i) => buildBtn(min + i)).join('')
    + `<button id="sp-pickup" class="btn"
        style="width:100%;font-size:0.95rem;font-weight:700;padding:0.85rem;margin-top:0.2rem;
               background:var(--gold);border:none;color:#000;">
        🏌️ Pick Up / Concede Hole
      </button>`;

  attachScrollGuard(gridEl);
  gridEl.querySelectorAll('.sp-num-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (_spScrolling) { _spScrolling = false; return; }
      const v = parseInt(btn.dataset.val, 10);
      setPairScoreValue(label, h, par, v, false);
      closeScorePicker();
    });
    btn.addEventListener('touchend', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (_spScrolling) { _spScrolling = false; return; }
      const v = parseInt(btn.dataset.val, 10);
      setPairScoreValue(label, h, par, v, false);
      closeScorePicker();
    }, { passive: false });
  });

  document.getElementById('sp-cancel').onclick = closeScorePicker;
  document.getElementById('modal-score-picker').classList.add('open');

  document.getElementById('sp-pickup').onclick = (e) => {
    e.stopPropagation();
    if (_spScrolling) { _spScrolling = false; return; }
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

  const isCard = !!cvEl.closest('.gi-card');
  if (isCard) {
    // gi-card ring disc — styled via --sc CSS var, same as individual player scorer
    cvEl.classList.add('has-score');
    cvEl.classList.remove('par-default');
    cvEl.style.opacity = '';
    cvEl.classList.toggle('is-pickup', !!isPickup);
    if (isPickup) {
      cvEl.style.setProperty('--sc', 'var(--gold)');
      cvEl.innerHTML = `<span class="gi-pu-lbl">P.Up</span><span class="gi-pu-val">(${value})</span>`;
    } else {
      const color = scoreColorForRelToPar(value - par, value);
      cvEl.style.setProperty('--sc', _giRingColor(color));
      cvEl.textContent = String(value);
    }
  } else {
    // Legacy flat button (modal picker path)
    cvEl.textContent = String(value);
    if (isPickup) {
      cvEl.style.color       = '#fff';
      cvEl.style.background  = 'var(--gold)';
      cvEl.style.borderColor = 'var(--gold)';
      cvEl.innerHTML = `<span style="font-size:0.75rem;font-weight:800;display:block;line-height:1.1;">P.Up</span><span style="font-size:0.85rem;font-weight:700;color:rgba(255,255,255,0.8);">(${value})</span>`;
    } else {
      const color = scoreColorForRelToPar(value - par, value);
      cvEl.style.color       = value === 1 ? '#000' : '#fff';
      cvEl.style.background  = color;
      cvEl.style.borderColor = color;
    }
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
  // Amend-scorecard mode: apply edit immediately via editHole() and re-render
  if (_amendPickerMode && _amendPickerHIdx === h && _amendPickerPi === pi) {
    _amendPickerMode = false;
    const newGrosses = [...(gameState.log[h]?.grosses ?? [])];
    newGrosses[pi]   = value;
    const rebuilt    = editHole(gameState, h, newGrosses);
    rebuilt.allGroupStates = gameState.allGroupStates;
    rebuilt.organiserId    = gameState.organiserId;
    gameState = rebuilt;
      // Persist the change — awaited so save status is shown
    _setSaveStatus('saving');
    saveRoundState().then(() => _setSaveStatus('saved')).catch(() => {
      _setSaveStatus('failed', () => saveRoundState().then(() => _setSaveStatus('saved')).catch(() => {}));
    });
    // Refresh BOTH the score header AND the hole panel in the game screen.
    // renderHolePanel() is needed so the live match score / pair status
    // behind the overlay matches the updated gameState immediately.
    renderScoreHeader();
    renderHolePanel();
    // Re-render the amend scorecard synchronously — same gameState as main screen.
    _renderAmendScorecard();
    return;
  }

  const cvEl = document.getElementById(`cv${pi}`);
  if (!cvEl) return;
  cvEl.dataset.value  = String(value);
  cvEl.dataset.pickup = isPickup ? '1' : '0';

  const isCard = !!cvEl.closest('.gi-card');
  if (isCard) {
    // Stitch-style ring disc: colour via --sc, styling in CSS
    cvEl.classList.add('has-score');
    cvEl.classList.remove('par-default');
    cvEl.style.opacity = ''; // clear par-default dim
    cvEl.classList.toggle('is-pickup', !!isPickup);
    if (isPickup) {
      cvEl.style.setProperty('--sc', 'var(--gold)');
      cvEl.innerHTML = `<span class="gi-pu-lbl">P.Up</span><span class="gi-pu-val">(${value})</span>`;
    } else {
      cvEl.style.setProperty('--sc', _giRingColor(scoreColorForRelToPar(value - par, value)));
      cvEl.textContent = String(value);
    }
    cvEl.closest('.gi-card')?.querySelector('.gi-pickup-btn')?.classList.toggle('is-on', !!isPickup);
    _giUpdateCalc(pi, value, isPickup);
    return;
  }

  if (isPickup) {
    cvEl.style.color       = '#fff';
    cvEl.style.background  = 'var(--gold)';
    cvEl.style.borderColor = 'var(--gold)';
    cvEl.style.fontSize    = '1rem';
    cvEl.innerHTML = `<span style="font-size:0.72rem;font-weight:800;display:block;line-height:1.1;">P.Up</span><span style="font-size:0.82rem;font-weight:700;opacity:0.85;">(${value})</span>`;
  } else {
    const relToPar = value - par;
    const color = scoreColorForRelToPar(relToPar, value);
    cvEl.style.color       = value === 1 ? '#000' : '#fff';
    cvEl.style.background  = color;
    cvEl.style.borderColor = color;
    cvEl.style.fontSize    = '1.55rem';
    cvEl.textContent       = String(value);
  }

  // Update the pickup button style in the inline control (if present)
  const pickupBtn = cvEl.closest('.gi-row')?.querySelector('.gi-pickup-btn');
  if (pickupBtn) {
    if (isPickup) {
      pickupBtn.style.background  = 'var(--gold)';
      pickupBtn.style.color       = '#000';
      pickupBtn.style.borderColor = 'var(--gold)';
    } else {
      pickupBtn.style.background  = 'rgba(255,255,255,0.04)';
      pickupBtn.style.color       = 'var(--muted)';
      pickupBtn.style.borderColor = 'var(--border2)';
    }
  }

}

// ----------------------------------------------------------------
// RECORD HOLE
// ----------------------------------------------------------------
// ================================================================
// AMEND SCORECARD
// ================================================================
let _amendMode         = false;
let _amendFromHole     = null;
let _amendOriginalHole = null;

function openAmendOverlay() {
  if (!gameState?.log?.length) return;
  const overlay = document.getElementById('amend-overlay');
  if (!overlay) return;

  const sub = document.getElementById('amend-overlay-sub');
  if (sub) sub.textContent = `${gameState.courseName ?? ''} · ${fmtLabel(gameState.format)} · ${gameState.log.length} holes played`;

  _renderAmendScorecard();
  overlay.style.display = 'block';
}

// Build and render the edit scorecard table + live totals footer.
// Called on open and re-called after every score change.
function _renderAmendScorecard() {
  const listEl   = document.getElementById('amend-hole-list');
  const totalsEl = document.getElementById('amend-totals-inner');
  if (!listEl) return;

  const fmt    = gameState.format;
  const log    = gameState.log ?? [];
  const par    = gameState.par  ?? [];
  const si     = gameState.si   ?? [];
  const names  = gameState.names ?? [];
  const offset = gameState.holeOffset ?? 0;
  const numHoles = gameState.numHoles ?? 18;
  const byHole   = {};
  log.forEach(e => { byHole[e.hIdx] = e; });

  // ── ITC: build chair-entering map (who holds chair at start of each hole) ──
  // entry.newChair = player who won chair ON that hole → they hold it entering the NEXT hole.
  // itcChairEntering[h] = player index (held), or null (empty/up for grabs), or undefined (before game started)
  const itcChairEntering = {};  // h → player index | null | undefined
  let itcNextUnplayedHole = -1; // first hole with no log entry
  if (fmt === 'itc') {
    let currentChair = undefined; // undefined = game hasn't started yet (no chair concept)
    for (let h = 0; h < numHoles; h++) {
      itcChairEntering[h] = currentChair;
      const e = byHole[h];
      if (e) {
        if (e.pointScoredBy != null) { /* chair holder defended — currentChair stays */ }
        else if (e.newChair != null) currentChair = e.newChair;  // new player takes chair
        else currentChair = null;  // halved — chair becomes empty
      } else {
        // first unplayed hole
        if (itcNextUnplayedHole === -1) itcNextUnplayedHole = h;
      }
    }
  }

  // ── Determine columns ──────────────────────────────────────────
  // For pair formats the columns show pair nets; for individual formats one col per player.
  const isTexas   = fmt === 'texas';
  const isPairFmt = ['betterball','csm','foursomes','greensomes'].includes(fmt);
  const isMatch   = fmt === 'match';

  // Player columns: array of { label, color, getValue(entry) → { gross, shots, net, pts } }
  // For pair formats we use a richer pairCols structure instead.
  const isFoursomeFmt = fmt === 'foursomes' || fmt === 'greensomes';
  let cols;
  let pairCols = null; // used instead of cols for pair formats

  if (isPairFmt) {
    // pairCols: array of 2 pair objects, each describing both players + result disc
    pairCols = [
      {
        p: [0, 1],
        colors: [pHex(0), pHex(1)],
        labels: [shortName(names[0]??'P1'), shortName(names[1]??'P2')],
        getPlayers: (e) => {
          if (!e) return null;
          if (isFoursomeFmt) {
            // One gross per pair — grosses[0] = pair A score
            const gross = e.grosses?.[0];
            const net   = e.nets?.[0] ?? gross;
            const shots = gross != null ? gross - (net ?? gross) : 0;
            return { single: true, gross, shots, net };
          }
          return {
            p0: { gross: e.grosses?.[0], shots: e.extras?.[0] ?? 0,
                  net: e.nets?.[0], counted: e.bbA?.pi === 0 },
            p1: { gross: e.grosses?.[1], shots: e.extras?.[1] ?? 0,
                  net: e.nets?.[1], counted: e.bbA?.pi === 1 },
          };
        },
        getResult: (e) => {
          if (!e) return null;
          const result = e.result ?? 0; // +1 = pair A won, -1 = pair B won
          const won = result > 0;
          const halved = result === 0;
          if (fmt === 'betterball') return { score: e.bbA?.net, label: 'net', won, halved };
          if (fmt === 'csm')        return { score: e.totalA,  label: 'pts', won, halved };
          // foursomes/greensomes
          const net = e.nets?.[0] ?? e.grosses?.[0];
          return { score: net, label: 'net', won, halved };
        },
      },
      {
        p: [2, 3],
        colors: [pHex(2), pHex(3)],
        labels: [shortName(names[2]??'P3'), shortName(names[3]??'P4')],
        getPlayers: (e) => {
          if (!e) return null;
          if (isFoursomeFmt) {
            const gross = e.grosses?.[1];
            const net   = e.nets?.[1] ?? gross;
            const shots = gross != null ? gross - (net ?? gross) : 0;
            return { single: true, gross, shots, net };
          }
          return {
            p0: { gross: e.grosses?.[2], shots: e.extras?.[2] ?? 0,
                  net: e.nets?.[2], counted: e.bbA?.pi === 2 || e.bbB?.pi === 2 },
            p1: { gross: e.grosses?.[3], shots: e.extras?.[3] ?? 0,
                  net: e.nets?.[3], counted: e.bbA?.pi === 3 || e.bbB?.pi === 3 },
          };
        },
        getResult: (e) => {
          if (!e) return null;
          const result = e.result ?? 0;
          const won = result < 0; // pair B wins when result < 0
          const halved = result === 0;
          if (fmt === 'betterball') return { score: e.bbB?.net, label: 'net', won, halved };
          if (fmt === 'csm')        return { score: e.totalB,  label: 'pts', won, halved };
          const net = e.nets?.[1] ?? e.grosses?.[1];
          return { score: net, label: 'net', won, halved };
        },
      },
    ];
    cols = pairCols; // keep for iteration count; actual rendering uses pairCols branch
  } else if (isTexas) {
    cols = [{ label: gameState.teamName ?? 'Team', color: pHex(0),
      getValue: (e) => e ? { gross: e.gross, shots: e.teamExtra ?? 0, net: e.net, pts: e.pts } : null }];
  } else {
    cols = names.map((nm, pi) => ({
      label: nm, color: pHex(pi),
      getValue: (e) => {
        if (!e) return null;
        const gross = e.grosses?.[pi];
        if (gross == null) return null;
        const shots = e.extras?.[pi] ?? indivStrokesOnHole(gameState.playingHandicaps?.[pi] ?? 0, e.si);
        const net   = gross - shots;
        const pts   = e.holePts?.[pi] ?? e.sbPts?.[pi] ?? null;
        return { gross, shots, net, pts };
      },
    }));
  }

  // ── Build table ────────────────────────────────────────────────
  // Pair formats: 2 wide cols (each showing 2 players + result disc)
  // Individual formats: 1 col per player
  const numDataCols = pairCols ? 2 : cols.length;
  const colW    = Math.max(100, Math.floor(Math.min(window.innerWidth - 72, 520) / numDataCols));
  const holeColW = 60;

  const grossDisc = (gross, parH, size = 36, extraStyle = '') => {
    if (gross == null) return '';
    const r = gross - parH;
    const bg = gross === 1 ? 'var(--gold)' : r < 0 ? '#d64545' : r === 0 ? 'var(--green)' : r <= 2 ? '#3a7bd5' : '#555';
    return `<div style="display:inline-flex;align-items:center;justify-content:center;
      width:${size}px;height:${size}px;border-radius:50%;background:${bg};
      font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:${Math.round(size*0.44)}px;
      color:${gross===1?'#000':'#fff'};flex-shrink:0;${extraStyle}">${gross}</div>`;
  };

  // Header row
  let headerCells = `<th style="min-width:${holeColW}px;position:sticky;left:0;background:var(--surface);z-index:3;text-align:left;padding:0.4rem 0.5rem;font-size:0.8rem;color:var(--muted);font-weight:700;">HOLE</th>`;

  if (pairCols) {
    pairCols.forEach(pc => {
      if (isFoursomeFmt) {
        // Foursomes/greensomes: show "P1 & P2" as one header + match score
        const pairColIdx = pairCols.indexOf(pc);
        const ms   = gameState.matchScore ?? 0;
        const up   = Math.abs(ms);
        const leading = pairColIdx === 0 ? ms > 0 : ms < 0;
        const msTxt = ms === 0 ? 'All Sq' : leading ? `${up} Up` : `${up} Dn`;
        const msCol = ms === 0 ? 'var(--muted)' : leading ? 'var(--gold)' : '#5ba8d8';
        headerCells += `<th style="min-width:${colW}px;padding:0.3rem 0.4rem;text-align:center;">
          <div style="display:flex;align-items:center;justify-content:center;gap:4px;flex-wrap:wrap;">
            <span style="width:7px;height:7px;border-radius:50%;background:${pc.colors[0]};display:inline-block;flex-shrink:0;"></span>
            <span style="font-size:1.2rem;font-weight:800;color:${pc.colors[0]};">${pc.labels[0]}</span>
            <span style="font-size:0.9rem;color:var(--muted);">&</span>
            <span style="width:7px;height:7px;border-radius:50%;background:${pc.colors[1]};display:inline-block;flex-shrink:0;"></span>
            <span style="font-size:1.2rem;font-weight:800;color:${pc.colors[1]};">${pc.labels[1]}</span>
          </div>
          <div style="font-size:1.2rem;font-weight:800;color:${msCol};line-height:1.2;">${msTxt}</div>
        </th>`;
      } else {
        // BB/CSM: initials only, no dots, wider gap to align above discs
        const ini0 = toInitials(pc.labels[0]);
        const ini1 = toInitials(pc.labels[1]);
        // Match score from this pair's perspective (pairColIdx 0 → positive ms = winning)
        const pairColIdx = pairCols.indexOf(pc);
        const ms   = gameState.matchScore ?? 0;
        const up   = Math.abs(ms);
        const leading = pairColIdx === 0 ? ms > 0 : ms < 0;
        const msTxt = ms === 0 ? 'All Sq' : leading ? `${up} Up` : `${up} Dn`;
        const msCol = ms === 0 ? 'var(--muted)' : leading ? 'var(--gold)' : '#5ba8d8';
        headerCells += `<th style="min-width:${colW}px;padding:0.3rem 0.4rem;text-align:center;">
          <div style="display:flex;align-items:center;justify-content:center;gap:20px;">
            <span style="font-size:1.5rem;font-weight:800;color:${pc.colors[0]};white-space:nowrap;line-height:1;">${ini0}</span>
            <span style="font-size:1.5rem;font-weight:800;color:${pc.colors[1]};white-space:nowrap;line-height:1;">${ini1}</span>
          </div>
          <div style="font-size:1.2rem;font-weight:800;color:${msCol};line-height:1.2;">${msTxt}</div>
        </th>`;
      }
    });
  } else {
    cols.forEach((c, ci) => {
      const sn = shortName(c.label);
      const snParts = sn.split(' ');
      const snHtml = snParts.length >= 2
        ? `<div style="line-height:1.1;">${snParts[0]}</div><div style="line-height:1.1;">${snParts.slice(1).join(' ')}</div>`
        : `<div>${sn}</div>`;
      headerCells += `<th style="min-width:${colW}px;width:${colW}px;padding:0.3rem 0.2rem;font-size:1.3rem;font-weight:800;color:${c.color};text-align:center;" data-hdr-ci="${ci}">${snHtml}</th>`;
    });
  }

  // Data rows
  let bodyRows = '';
  for (let h = 0; h < numHoles; h++) {
    const entry   = byHole[h];
    const holeNum = h + offset + 1;
    const parH    = par[h] ?? 4;
    const siH     = si[h]  ?? h + 1;
    const played  = !!entry;
    const isCurrent = h === gameState.hole && !played;

    const rowBg = isCurrent ? 'background:rgba(212,168,67,0.07);'
      : played ? '' : 'opacity:0.38;';

    let cells = `<td class="asc-hole-cell" style="${rowBg}">
      <span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:2rem;color:var(--white);line-height:1;">${holeNum}</span>
      <div style="font-size:1.1rem;color:var(--muted);font-weight:600;white-space:nowrap;line-height:1.2;">P${parH} S${siH}</div>
    </td>`;

    if (pairCols) {
      pairCols.forEach((pc, ci) => {
        if (!entry) {
          cells += `<td class="asc-score-cell" data-h="${h}" data-ci="${ci}" style="${rowBg}padding:0.4rem 0.3rem;"></td>`;
          return;
        }
        const players = pc.getPlayers(entry);
        const result  = pc.getResult(entry);

        // Result disc colour
        const discBg    = result?.won ? 'var(--gold)' : result?.halved ? 'var(--surface3)' : 'var(--surface3)';
        const discBorder = result?.won ? 'var(--gold)' : 'var(--border)';
        const discTextCol = result?.won ? '#000' : 'var(--muted2)';
        const scoreStr  = result?.score != null ? String(result.score) : '–';
        const labelStr  = result?.label ?? '';

        let innerHtml;
        if (isFoursomeFmt && players?.single) {
          // One gross circle for the pair + net below + result disc
          const { gross, shots, net } = players;
          const shotDots = shots > 0 ? `<span style="color:var(--gold);font-size:0.65rem;margin-right:2px;">${'•'.repeat(Math.min(shots,2))}</span>` : '';
          innerHtml = `
            <div style="display:flex;flex-direction:column;align-items:center;gap:3px;">
              ${grossDisc(gross, parH, 38)}
              <div style="font-size:0.8rem;font-weight:700;color:var(--muted2);">${shotDots}${net ?? ''}</div>
            </div>`;
        } else if (players) {
          // Two individual gross circles + a result disc
          const { p0, p1 } = players;
          const disc0 = grossDisc(p0?.gross, parH, 34, p0?.counted ? 'box-shadow:0 0 0 2.5px var(--gold);' : 'opacity:0.7;');
          const disc1 = grossDisc(p1?.gross, parH, 34, p1?.counted ? 'box-shadow:0 0 0 2.5px var(--gold);' : 'opacity:0.7;');

          innerHtml = `
            <div style="display:flex;flex-direction:column;align-items:center;gap:4px;padding:0.1rem 0;">
              <div style="display:flex;gap:14px;align-items:center;">
                ${disc0}${disc1}
              </div>
              <div style="display:flex;align-items:baseline;justify-content:center;gap:4px;
                          background:${discBg};border:1.5px solid ${discBorder};border-radius:20px;
                          padding:4px 14px;min-width:52px;">
                <span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.2rem;color:${discTextCol};">${scoreStr}</span>
                <span style="font-size:0.74rem;font-weight:700;color:${discTextCol};opacity:0.85;">${labelStr}</span>
              </div>
            </div>`;
        } else {
          innerHtml = '';
        }

        cells += `<td class="asc-score-cell" data-h="${h}" data-ci="${ci}"
          style="${rowBg}cursor:pointer;-webkit-tap-highlight-color:rgba(0,0,0,0);padding:0.3rem 0.2rem;vertical-align:middle;text-align:center;">
          ${innerHtml}
        </td>`;
      });
    } else {
      cols.forEach((c, ci) => {
        const val = c.getValue(entry);
        if (!val) {
          // ITC: on the next unplayed hole, show empty chair in the first column
          const emptyChairHtml = (fmt === 'itc' && h === itcNextUnplayedHole && ci === 0 && itcChairEntering[h] === null)
            ? `<div style="font-size:1.2rem;opacity:0.45;line-height:1;padding:0.3rem 0;">🪑</div>` : '';
          cells += `<td class="asc-score-cell" data-h="${h}" data-ci="${ci}" style="${rowBg}">${emptyChairHtml}</td>`;
          return;
        }
        const relToPar = val.gross - parH;
        const grossCol = val.gross === 1 ? 'var(--gold)'
          : relToPar < 0 ? '#d64545'
          : relToPar === 0 ? 'var(--green)'
          : relToPar <= 2 ? '#3a7bd5' : 'var(--muted)';

        const netHtml  = val.net != null ? `<div style="font-size:1.4rem;font-weight:800;color:var(--muted2);margin-top:2px;">Net ${val.net}</div>` : '';
        const ptsHtml  = val.pts != null ? `<div style="font-size:0.7rem;font-weight:800;color:var(--gold);margin-top:1px;">${val.pts}pt</div>` : '';

        // ITC: show chair symbol if this player holds the chair entering this hole
        const chairHtml = (fmt === 'itc' && itcChairEntering[h] === ci)
          ? `<div style="font-size:0.8rem;line-height:1;margin-top:1px;">🪑</div>` : '';

        cells += `<td class="asc-score-cell" data-h="${h}" data-ci="${ci}" style="${rowBg}cursor:pointer;-webkit-tap-highlight-color:rgba(0,0,0,0);">
          <div style="display:inline-flex;align-items:center;justify-content:center;
                      width:36px;height:36px;border-radius:50%;background:${grossCol};
                      font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.2rem;
                      color:${val.gross===1?'#000':'#fff'};">${val.gross}</div>
          ${netHtml}${ptsHtml}${chairHtml}
        </td>`;
      });
    }

    bodyRows += `<tr>${cells}</tr>`;
  }

  // ── Totals row ─────────────────────────────────────────────────
  let totalCells = `<td class="asc-hole-cell" style="border-top:2px solid var(--border);font-weight:800;font-size:0.85rem;color:var(--gold);">TOTAL</td>`;
  const grandGross = new Array(numDataCols).fill(0);
  const grandNet   = new Array(numDataCols).fill(0);
  const grandPts   = new Array(numDataCols).fill(0);
  const hasNet     = new Array(numDataCols).fill(false);
  const hasPts     = new Array(numDataCols).fill(false);

  if (!pairCols) {
    for (let h = 0; h < numHoles; h++) {
      const entry = byHole[h];
      if (!entry) continue;
      cols.forEach((c, ci) => {
        const val = c.getValue(entry);
        if (!val) return;
        grandGross[ci] += val.gross ?? 0;
        if (val.net  != null) { grandNet[ci] += val.net;  hasNet[ci] = true; }
        if (val.pts  != null) { grandPts[ci] += val.pts;  hasPts[ci] = true; }
      });
    }
  }

  if (pairCols) {
    // Pair formats total row: match score + individual gross totals
    const ms = gameState.matchScore ?? 0;
    const up = Math.abs(ms);
    // Compute individual gross totals from log
    const pGross = names.map(() => 0);
    const pNet   = names.map(() => 0);
    log.forEach(e => {
      names.forEach((_, pi) => {
        if (e.grosses?.[pi] != null) {
          pGross[pi] += e.grosses[pi];
          pNet[pi]   += (e.nets?.[pi] ?? (e.grosses[pi] - (e.extras?.[pi] ?? 0)));
        }
      });
    });

    pairCols.forEach((pc, ci) => {
      const leading = ci === 0 ? ms > 0 : ms < 0;
      const halved  = ms === 0;
      const txt = halved ? 'All Sq' : leading ? `${up} Up` : `${up} Dn`;
      const col = halved ? 'var(--muted)' : leading ? 'var(--gold)' : '#5ba8d8';
      const [p0i, p1i] = pc.p;
      const ini0 = toInitials(names[p0i] ?? '');
      const ini1 = toInitials(names[p1i] ?? '');
      totalCells += `<td class="asc-score-cell" style="border-top:2px solid var(--border);text-align:center;padding:0.4rem 0.2rem;">
        <div style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.2rem;color:${col};margin-bottom:4px;">${txt}</div>
        <div style="display:flex;justify-content:center;gap:10px;">
          <div style="display:flex;flex-direction:column;align-items:center;">
            <span style="font-size:0.65rem;font-weight:800;color:${pc.colors[0]};">${ini0}</span>
            <span style="font-family:'Plus Jakarta Sans',sans-serif;font-size:0.95rem;font-weight:800;color:var(--white);">${pGross[p0i] || '–'}</span>
            <span style="font-size:0.62rem;color:var(--muted2);">${pNet[p0i] || ''} net</span>
          </div>
          <div style="display:flex;flex-direction:column;align-items:center;">
            <span style="font-size:0.65rem;font-weight:800;color:${pc.colors[1]};">${ini1}</span>
            <span style="font-family:'Plus Jakarta Sans',sans-serif;font-size:0.95rem;font-weight:800;color:var(--white);">${pGross[p1i] || '–'}</span>
            <span style="font-size:0.62rem;color:var(--muted2);">${pNet[p1i] || ''} net</span>
          </div>
        </div>
      </td>`;
    });
  } else {
    cols.forEach((c, ci) => {
      if (!grandGross[ci] && !hasNet[ci] && !hasPts[ci]) {
        totalCells += `<td class="asc-score-cell" style="border-top:2px solid var(--border);"></td>`;
        return;
      }
      const netLine = hasNet[ci] ? `<div style="font-size:0.72rem;font-weight:700;color:var(--muted2);">Net ${grandNet[ci]}</div>` : '';
      const ptsLine = hasPts[ci] ? `<div style="font-size:0.72rem;font-weight:800;color:var(--gold);">${grandPts[ci]}pt</div>` : '';
      totalCells += `<td class="asc-score-cell" style="border-top:2px solid var(--border);">
        <div style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.1rem;color:var(--white);">${grandGross[ci]}</div>
        ${netLine}${ptsLine}
      </td>`;
    });
  }

  listEl.innerHTML = `<table class="asc-table">
    <thead><tr>${headerCells}</tr></thead>
    <tbody>${bodyRows}<tr>${totalCells}</tr></tbody>
  </table>`;

  // ── Inject score sub-line into individual column headers ───────
  if (!pairCols) {
    // Determine display mode based on format
    const texSubFmt = gameState.texasScoringFmt ?? 'stableford';
    const isMatchHdr  = fmt === 'match' || fmt === 'itc'
      || (fmt === 'texas' && texSubFmt === 'match');
    const isStrokeHdr = fmt === 'stroke'
      || (fmt === 'texas' && texSubFmt === 'stroke');
    const isPtsHdr = !isMatchHdr && !isStrokeHdr; // stableford, skins, split6, best2, texas-stableford

    // For match/ITC: compute match score per player column
    const ms = gameState.matchScore ?? 0;
    const msAbs = Math.abs(ms);

    cols.forEach((c, ci) => {
      const th = listEl.querySelector(`th[data-hdr-ci="${ci}"]`);
      if (!th) return;
      let scoreHtml = '';
      let scoreColor = 'var(--white)';

      if (isMatchHdr) {
        if (fmt === 'match') {
          // 2-player: ci=0 leads if ms>0, ci=1 leads if ms<0
          const leading = ci === 0 ? ms > 0 : ms < 0;
          const halved  = ms === 0;
          const txt = halved ? 'All Sq' : leading ? `${msAbs} Up` : `${msAbs} Dn`;
          scoreColor = halved ? 'var(--muted)' : leading ? 'var(--gold)' : '#5ba8d8';
          scoreHtml = txt;
        } else if (fmt === 'itc') {
          // ITC: read authoritative pts from gameState.pts (not per-hole sum which may be incomplete)
          const pts = (gameState.pts ?? [])[ci] ?? 0;
          scoreHtml = `${pts}<span style="font-size:0.8rem;font-weight:600;color:var(--muted);margin-left:2px;">pts</span>`;
        } else {
          // texas-match: sum from holes
          const pts = grandPts[ci] || 0;
          scoreHtml = `${pts}<span style="font-size:0.8rem;font-weight:600;color:var(--muted);margin-left:2px;">pts</span>`;
        }
      } else if (isStrokeHdr) {
        const strokes = hasNet[ci] ? grandNet[ci] : grandGross[ci];
        if (strokes) {
          scoreHtml = `${strokes}<span style="font-size:0.8rem;font-weight:600;color:var(--muted);margin-left:2px;">str</span>`;
        }
      } else {
        // Pts-based (stableford, skins, split6, best2)
        const pts = grandPts[ci] || 0;
        if (pts) {
          scoreHtml = `${pts}<span style="font-size:0.8rem;font-weight:600;color:var(--muted);margin-left:2px;">pts</span>`;
        }
      }

      if (scoreHtml) {
        th.innerHTML = `<div style="font-size:1.5rem;font-weight:800;color:${c.color};line-height:1;">${shortName(c.label)}</div>
          <div style="font-size:1.2rem;font-weight:800;color:${scoreColor};line-height:1.1;">${scoreHtml}</div>`;
      }
    });
  }

  // ── Live totals footer bar ─────────────────────────────────────
  // Always derive from the cell totals (grandGross/grandNet/grandPts)
  // so the footer is guaranteed consistent with the table.
  // For formats with a running total that isn't a simple sum (split6, match,
  // skins, itc) we also read from gameState which is authoritative post-rebuild.
  if (totalsEl) {
    const fmt2  = gameState.format;
    const isS6  = fmt2 === 'split6';
    const isSk  = fmt2 === 'skins';
    const isItc = fmt2 === 'itc';
    const isMatchFmt = fmt2 === 'match' || isPairFmt;

    // Use pairCols labels/colors for pair formats
    const totCols = pairCols
      ? pairCols.map(pc => ({ label: `${pc.labels[0]} & ${pc.labels[1]}`, color: pc.colors[0] }))
      : cols;
    totalsEl.innerHTML = totCols.map((c, ci) => {
      let scoreHtml = '';
      if (isMatchFmt) {
        // Match/pairs: show running match score from gameState (authoritative)
        const ms = gameState.matchScore ?? 0;
        const up = Math.abs(ms);
        // For pair formats ci maps to pairCols index (0=pair A, 1=pair B)
        const leading = ci === 0 ? ms > 0 : ms < 0;
        const txt = ms === 0 ? 'All Sq' : leading ? `${up} Up` : `${up} Dn`;
        const col = ms === 0 ? 'var(--muted)' : leading ? 'var(--gold)' : '#5ba8d8';
        scoreHtml = `<div class="asc-tot-score" style="color:${col};">${txt}</div>`;
      } else if (isS6) {
        // Split 6: relative running pts from gameState
        const rp = gameState.runningPts?.[ci] ?? 0;
        scoreHtml = `<div class="asc-tot-score">${rp}</div><div class="asc-tot-label">pts</div>`;
      } else if (isSk) {
        scoreHtml = `<div class="asc-tot-score">${gameState.skins?.[ci] ?? 0}</div><div class="asc-tot-label">skins</div>`;
      } else if (isItc) {
        scoreHtml = `<div class="asc-tot-score">${gameState.pts?.[ci] ?? 0}</div><div class="asc-tot-label">pts</div>`;
      } else if (isTexas) {
        const isSbFmt = (gameState.texasScoringFmt ?? 'stableford') === 'stableford';
        const score   = isSbFmt ? (grandPts[ci] || 0) : (grandGross[ci] || 0);
        scoreHtml = `<div class="asc-tot-score">${score}</div><div class="asc-tot-label">${isSbFmt ? 'pts' : 'gross'}</div>`;
      } else if (hasPts[ci]) {
        // Stableford / best2 / csm / split6 individual — sum pts from cells
        scoreHtml = `<div class="asc-tot-score">${grandPts[ci]}</div><div class="asc-tot-label">pts</div>`;
      } else if (hasNet[ci]) {
        // Stroke play — sum nets from cells
        scoreHtml = `<div class="asc-tot-score">${grandNet[ci]}</div><div class="asc-tot-label">net</div>`;
      } else {
        // Fallback: show gross total
        scoreHtml = `<div class="asc-tot-score">${grandGross[ci] || '–'}</div><div class="asc-tot-label">gross</div>`;
      }
      return `<div class="asc-tot-cell" style="border-left-color:${c.color};">
        <div class="asc-tot-name" style="color:${c.color};">${shortName(c.label)}</div>
        ${scoreHtml}
      </div>`;
    }).join('');
  }

  // ── Names bar in header — no longer used; names+scores now live in column headers ──
  const namesBar = document.getElementById('amend-names-bar');
  if (namesBar) { namesBar.innerHTML = ''; }
  if (false && namesBar) {
    const fmt2  = gameState.format;
    const isS6  = fmt2 === 'split6';
    const isSk  = fmt2 === 'skins';
    const isItc = fmt2 === 'itc';
    const isMatchFmt2 = fmt2 === 'match' || isPairFmt;

    // Build one chip per player/pair
    const barCols = pairCols
      ? pairCols.map((pc, ci) => {
          const ms   = gameState.matchScore ?? 0;
          const up   = Math.abs(ms);
          const leading = ci === 0 ? ms > 0 : ms < 0;
          const txt  = ms === 0 ? 'All Sq' : leading ? `${up} Up` : `${up} Dn`;
          const col  = ms === 0 ? 'var(--muted)' : leading ? 'var(--gold)' : '#5ba8d8';
          return { name: `${pc.labels[0]} & ${pc.labels[1]}`, color: pc.colors[0], scoreHtml: `<span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.4rem;color:${col};">${txt}</span>` };
        })
      : cols.map((c, ci) => {
          let scoreHtml = '';
          if (isMatchFmt2) {
            const ms  = gameState.matchScore ?? 0;
            const up  = Math.abs(ms);
            const leading = ci === 0 ? ms > 0 : ms < 0;
            const txt = ms === 0 ? 'All Sq' : leading ? `${up} Up` : `${up} Dn`;
            const col = ms === 0 ? 'var(--muted)' : leading ? 'var(--gold)' : '#5ba8d8';
            scoreHtml = `<span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.4rem;color:${col};">${txt}</span>`;
          } else if (isS6) {
            scoreHtml = `<span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.4rem;color:var(--white);">${gameState.runningPts?.[ci] ?? 0}</span><span style="font-size:0.8rem;color:var(--muted);margin-left:3px;">pts</span>`;
          } else if (isSk) {
            scoreHtml = `<span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.4rem;color:var(--white);">${gameState.skins?.[ci] ?? 0}</span><span style="font-size:0.8rem;color:var(--muted);margin-left:3px;">skins</span>`;
          } else if (isItc) {
            scoreHtml = `<span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.4rem;color:var(--white);">${gameState.pts?.[ci] ?? 0}</span><span style="font-size:0.8rem;color:var(--muted);margin-left:3px;">pts</span>`;
          } else if (isTexas) {
            const isSbFmt = (gameState.texasScoringFmt ?? 'stableford') === 'stableford';
            const score   = isSbFmt ? (grandPts[ci] || 0) : (grandGross[ci] || 0);
            scoreHtml = `<span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.4rem;color:var(--white);">${score}</span><span style="font-size:0.8rem;color:var(--muted);margin-left:3px;">${isSbFmt ? 'pts' : 'gross'}</span>`;
          } else if (hasPts[ci]) {
            scoreHtml = `<span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.4rem;color:var(--white);">${grandPts[ci]}</span><span style="font-size:0.8rem;color:var(--muted);margin-left:3px;">pts</span>`;
          } else if (hasNet[ci]) {
            scoreHtml = `<span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.4rem;color:var(--white);">${grandNet[ci]}</span><span style="font-size:0.8rem;color:var(--muted);margin-left:3px;">net</span>`;
          } else {
            scoreHtml = `<span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.4rem;color:var(--white);">${grandGross[ci] || '–'}</span>`;
          }
          return { name: shortName(c.label), color: c.color, scoreHtml };
        });

    namesBar.innerHTML = barCols.map(bc => `
      <div style="display:flex;flex-direction:column;gap:1px;">
        <span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.6rem;color:${bc.color};line-height:1;">${bc.name}</span>
        <div style="display:flex;align-items:baseline;gap:3px;">${bc.scoreHtml}</div>
      </div>`).join('');
  }

  // ── Wire cell taps ─────────────────────────────────────────────

  listEl.querySelectorAll('td.asc-score-cell[data-h]').forEach(td => {
    const h   = parseInt(td.dataset.h);
    const ci  = parseInt(td.dataset.ci);
    const entry = byHole[h];
    if (!entry) return; // unplayed hole — not editable

    td.addEventListener('click', (e) => {
          if (_pickerJustClosed) return;
      _openAmendScorePicker(h, ci);
    });
    td.addEventListener('touchend', (e) => {
          if (_pickerJustClosed) return;
      e.preventDefault();
      _openAmendScorePicker(h, ci);
    }, { passive: false });
  });
}

// Open the score picker for a specific hole+column in the amend scorecard.
// After score is confirmed, editHole() rebuilds state and the scorecard re-renders live.
function _openAmendScorePicker(hIdx, colIdx) {
  const fmt      = gameState.format;
  const entry    = gameState.log[hIdx];
  if (!entry) return;

  const par = gameState.par[hIdx];
  const isPairFmt = ['betterball','csm','foursomes','greensomes'].includes(fmt);
  const isTexas   = fmt === 'texas';

  if (isPairFmt || isTexas) {
    // For pair/texas formats, fall through to the existing openHoleEdit modal
    // (these need to enter both players' scores or the team score+driver)
    _holeEditFromScorecard = true;  // tell btn-hole-edit-confirm to skip diff modal
    openHoleEdit(hIdx + (gameState.holeOffset ?? 0) + 1);
    return;
  }

  // Individual player: work out which player index this column maps to
  const pi = colIdx; // for individual formats cols are 1-to-1 with players

  // Use the existing score picker — but wire its completion to editHole() + re-render
  _amendPickerHIdx = hIdx;
  _amendPickerPi   = pi;
  _amendPickerPar  = par;
  _amendPickerMode = true;

  // Set the cv element to the existing score so the picker shows it selected
  const cvEl = document.getElementById(`cv${pi}`);
  if (cvEl) {
    cvEl.dataset.value = String(entry.grosses?.[pi] ?? '');
    cvEl.textContent   = String(entry.grosses?.[pi] ?? '');
  }

  openScorePicker(pi, hIdx, par);
}

let _amendPickerHIdx = null;
let _amendPickerPi   = null;
let _amendPickerPar  = null;
let _amendPickerMode = false;
// Flag: true when openHoleEdit was opened from Scorecard Edit overlay.
// Used in btn-hole-edit-confirm to skip the diff modal for that path.
let _holeEditFromScorecard = false;
function closeAmendOverlay() {
  const overlay = document.getElementById('amend-overlay');
  if (overlay) overlay.style.display = 'none';
}

window.startAmendFromHole = startAmendFromHole; // expose for inline onclick in dynamic HTML
function startAmendFromHole(holeIdx) {
  closeAmendOverlay();
  _amendOriginalHole = gameState.log.length;
  _amendFromHole     = holeIdx;
  _amendMode         = true;
  gameState.hole     = holeIdx;

  // Amber record button
  const recBtn = document.getElementById('btn-record-hole');
  if (recBtn) { recBtn.textContent = 'CONFIRM HOLE →'; recBtn.style.background = '#b45309'; }

  // Banner
  document.getElementById('amend-banner')?.remove();
  const banner = document.createElement('div');
  banner.id = 'amend-banner';
  Object.assign(banner.style, {background:'#b45309',color:'#fff',padding:'0.5rem 1rem',fontFamily:'Plus Jakarta Sans,sans-serif',fontSize:'0.9rem',fontWeight:'800',letterSpacing:'0.04em',textAlign:'center'});
  banner.textContent = `✏️ AMEND MODE — Hole ${(gameState.holeOffset??0)+holeIdx+1} of ${gameState.log.length} · Confirm each hole to recalculate`;
  document.getElementById('screen-game')?.prepend(banner);

  renderScoreHeader();
  renderHolePanel();
}

function exitAmendMode() {
  _amendMode = false; _amendFromHole = null; _amendOriginalHole = null;
  const recBtn = document.getElementById('btn-record-hole');
  if (recBtn) { recBtn.textContent = 'Confirm & Next →'; recBtn.style.background = ''; }
  document.getElementById('amend-banner')?.remove();
  updateAmendBtn();
  renderScoreHeader();
  renderHolePanel();
}

document.getElementById('btn-amend-scores')?.addEventListener('click', openAmendOverlay);
document.getElementById('btn-amend-cancel')?.addEventListener('click', closeAmendOverlay);

document.getElementById('btn-record-hole')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-record-hole');
  if (btn?.disabled) return; // prevent double-tap
  if (btn) btn.disabled = true;
  try {
    // Instant — writes to IndexedDB first, Supabase syncs in background every 30s
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

  const isFoursome = fmt === 'foursomes' || fmt === 'greensomes'
    || (fmt === 'texas' && (gameState.texasScoringFmt ?? 'stableford') === 'match');
  const isTexas    = fmt === 'texas';

  if (isFoursome) {
    // texas 2v2 match play AND foursomes/greensomes — two pair scores
    const vA = parseInt(document.getElementById('cv-pair-A')?.dataset?.value, 10);
    const vB = parseInt(document.getElementById('cv-pair-B')?.dataset?.value, 10);
    if (!vA || !vB) { alert('Please enter scores for both pairs.'); return; }
    // For texas 2v2 match: also capture per-pair drivers if selected
    const driverA = parseInt(document.querySelector('[data-pair-driver="A"].active')?.dataset?.pi ?? '-1', 10);
    const driverB = parseInt(document.querySelector('[data-pair-driver="B"].active')?.dataset?.pi ?? '-1', 10);
    grosses = [vA, vB];
    if (!isNaN(driverA) && driverA >= 0) grosses.push(driverA);
    if (!isNaN(driverB) && driverB >= 0) grosses.push(driverB);
  } else if (isTexas) {
    const scoreEl  = document.getElementById('cv-texas');
    const gross    = parseInt(scoreEl?.dataset?.value, 10);
    const driverEl = document.querySelector('.texas-driver-btn.active');
    const driver   = driverEl ? parseInt(driverEl.dataset.pi, 10) : -1;
    if (!gross || gross < 1) { alert('Please enter a score for the team.'); return; }
    // If drive quotas are set, require a driver to be selected
    const hasQuota = (gameState.texasDrivesTotal != null) || (gameState.texasDrivesPar3 != null);
    if (hasQuota && driver === -1) {
      alert('Please select whose drive was used for this hole.');
      return;
    }
    grosses = [gross, driver === -1 ? 0 : driver];
  } else {
    for (let i = 0; i < gameState.names.length; i++) {
      const el = document.getElementById(`cv${i}`);
      const v  = parseInt(el?.dataset?.value, 10);
      if (!v || v < 1) { alert(`Please enter a score for ${gameState.names[i]}.`); return; }
      grosses.push(v);
    }
  }

  // Collect pickup flags from DOM before processHole overwrites the panel
  const pickupFlags = [];
  for (let i = 0; i < gameState.names.length; i++) {
    const el = document.getElementById(`cv${i}`);
    pickupFlags.push(el?.dataset?.pickup === '1');
  }
  const anyPickup = pickupFlags.some(Boolean);

  const prevGroupStates  = gameState.allGroupStates;
  const totalPlayedHoles = gameState.log?.length ?? 0;
  const isEditingPast    = h < totalPlayedHoles;

  if (isEditingPast) {
    gameState = editHole(gameState, h, grosses);
      gameState.hole = h + 1;
  } else {
    gameState = processHole(gameState, grosses);
  }

  // Stamp pickup flags onto the log entry so scorecard can display P.Up correctly
  if (anyPickup) {
    const entryIdx = isEditingPast ? h : gameState.log.length - 1;
    if (gameState.log[entryIdx]) {
      gameState.log[entryIdx].pickups = pickupFlags;
    }
  }

  if (prevGroupStates) {
    gameState.allGroupStates = prevGroupStates;
    gameState.allGroupStates[0] = gameState;
  }
  flashHoleResult(h);

  // ── AMEND MODE: advance through remaining played holes or exit ──
  if (_amendMode) {
    const nextHole   = h + 1;
    const lastPlayed = (gameState.log?.length ?? 0) - 1;
    if (nextHole <= lastPlayed) {
      gameState.hole = nextHole;
      const offset = gameState.holeOffset ?? 0;
      const banner = document.getElementById('amend-banner');
      if (banner) banner.textContent =
        `✏️ AMEND MODE — Hole ${offset+nextHole+1} of ${gameState.log.length} · Confirm each hole to recalculate`;
      const snap = _buildStateToSave();
      if (snap) idbSaveSeq(roundId, snap, _nextSeq()).catch(() => {});
      renderScoreHeader(); renderHolePanel();
      return;
    } else {
      gameState.hole = _amendOriginalHole ?? gameState.log.length;
      exitAmendMode();
      updateAmendBtn();
    }
  }

  // ── LOCAL-FIRST: await durable IndexedDB write before advancing UI ──
  // Stage 1: sequence-guarded, awaited save with visible status.
  const stateSnap = _buildStateToSave();
  if (stateSnap) {
    const seq = _nextSeq();
    _setSaveStatus('saving');
    try {
      await idbSaveSeq(roundId, stateSnap, seq);
      _setSaveStatus('saved');
    } catch (saveErr) {
      console.warn('[idb] hole save failed', saveErr);
      _setSaveStatus('failed', async () => {
        _setSaveStatus('saving');
        try {
          await idbSaveSeq(roundId, _buildStateToSave(), _nextSeq());
          _setSaveStatus('saved');
        } catch (retryErr) {
          console.error('[idb] retry save failed', retryErr);
          _setSaveStatus('failed', null);
        }
      });
    }
  }

  const matchFmts = ['match','betterball','csm','foursomes','greensomes'];
  if (matchFmts.includes(fmt)) {
    const played = gameState.log.length;
    const total  = gameState.numHoles ?? 18;
    if (matchPlayIsOver(gameState.matchScore, played, total) && !gameState.matchDecided) {
      gameState.matchDecided = true;
      showMatchWonModal();
      // Persist state at match end
      _persistNow().catch(e => console.warn('[sync] flush at match end failed', e));
      return;
    }
  }

  // Advance UI immediately — no waiting for network
  if (gameState.hole >= (gameState.numHoles ?? 18)) {
    await _persistNow(); // persist state before showing end screen
    showEndRound();
    return;
  }
  renderScoreHeader();
  renderHolePanel();
}

// Amend button — enabled once at least one hole is played
function updateAmendBtn() {
  const btn = document.getElementById('btn-amend-scores');
  if (!btn) return;
  btn.disabled = !(gameState?.log?.length > 0);
}

document.getElementById('btn-finish-early')?.addEventListener('click', () => showEndRound());
document.getElementById('btn-game-abandon')?.addEventListener('click', async () => {
  // "Home" — save the round as paused so it appears in Active Games, then go home
  await doAbandon(false);
});

document.getElementById('btn-game-leaderboard')?.addEventListener('click', () => showLeaderboard());
document.getElementById('leaderboard-back')   ?.addEventListener('click', () => showScreen('screen-game'));

let leaderboardChannel = null;
let _lbViewMode    = 'total';    // 'total' | 'byround'
let _lbCloudScores = null;       // last fetched cloud scores payload

// Wire leaderboard action buttons (once)
(function _wireLbActions() {
  document.getElementById('btn-lb-update')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-lb-update');
    if (btn) { btn.textContent = '⏳ Updating…'; btn.disabled = true; }
    try {
      // Hub tournament games push scores via the normal hole-by-hole sync;
      // pushing here hangs mid-round because pushScoresToCloud reads lb-game-code
      // (the share code) not the hub tournament code. Skip push for hub games;
      // for regular share-code games, push first then pull.
      const isHubRound = !!gameState?._hubTournamentCode;
      if (!isHubRound) {
        const pushBtn = { textContent: '', style: {}, disabled: false };
        await pushScoresToCloud(pushBtn);
      }
      // Pull cloud scores (works for both hub and regular games)
      const code = _lbGetCode();
      if (code) {
        const data = await _workerFetch(`/scores/${code.toUpperCase()}`);
        _lbCloudScores = data;
      }
      renderLeaderboard();
      if (btn) { btn.textContent = '✓ Updated'; setTimeout(() => { if (btn) btn.textContent = '⟳ Update'; }, 2000); }
    } catch (e) {
      if (btn) { btn.textContent = '✗ Failed'; setTimeout(() => { if (btn) btn.textContent = '⟳ Update'; }, 2000); }
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  document.getElementById('btn-lb-view-toggle')?.addEventListener('click', async () => {
    _lbViewMode = _lbViewMode === 'total' ? 'byround' : 'total';
    const btn = document.getElementById('btn-lb-view-toggle');
    // 'total' = per-round columns view (default); 'byround' = flat total only
    if (btn) btn.textContent = _lbViewMode === 'total' ? '📋 Total Only' : '📊 By Round';
    // If switching to per-round view and we have no cloud scores yet, fetch them now
    if (_lbViewMode === 'total' && !_lbCloudScores) {
      if (btn) { btn.textContent = '⏳…'; btn.disabled = true; }
      try {
        const code = _lbGetCode();
        if (code) {
          const data = await _workerFetch(`/scores/${code.toUpperCase()}`);
          _lbCloudScores = data;
        }
      } catch {}
      if (btn) { btn.textContent = '🏆 Total'; btn.disabled = false; }
    }
    renderLeaderboard();
  });

  document.getElementById('btn-lb-copy-url')?.addEventListener('click', async () => {
    const code = _lbGetCode();
    if (!code) return;
    const url = `${APP_BASE_URL}live?code=${code}`;
    try {
      await navigator.clipboard.writeText(url);
      const btn = document.getElementById('btn-lb-copy-url');
      if (btn) { btn.textContent = '✓ Copied!'; setTimeout(() => { if (btn) btn.textContent = '🔗 Copy URL'; }, 2000); }
    } catch {}
  });
})();

function _lbGetCode() {
  try {
    if (gameState?.gameCode) return gameState.gameCode;
    const stored = localStorage.getItem('lb-game-code');
    if (stored) return stored;
    const ts = _tournState();
    if (ts.active && ts.code && ts.code !== '__error__') return ts.code;
  } catch {}
  return null;
}

function showLeaderboard() {
  showScreen('screen-leaderboard');
  // Show/hide action bar buttons based on whether a code exists
  const code = _lbGetCode();
  const updateBtn = document.getElementById('btn-lb-update');
  const copyBtn   = document.getElementById('btn-lb-copy-url');
  const toggleBtn = document.getElementById('btn-lb-view-toggle');
  // Update button only relevant when scores are being shared (game has a code)
  if (updateBtn) updateBtn.style.display = code ? '' : 'none';
  if (copyBtn)   copyBtn.style.display   = code ? '' : 'none';
  // Show toggle in any active tournament — local tournament state OR hub game
  const ts = (() => { try { return _tournState(); } catch { return {}; } })();
  const isTournActive = ts.active || !!gameState.tournamentId || !!gameState._hubTournamentCode;
  console.log('[LB] showLeaderboard: code=', code, 'isTournActive=', isTournActive,
    'gameCode=', gameState?.gameCode, 'hubCode=', gameState?._hubTournamentCode,
    'tournamentId=', gameState?.tournamentId, 'ts.active=', ts?.active);
  // In tournament mode replace the toggle button with a static title above the table
  if (toggleBtn) toggleBtn.style.display = 'none';
  // Default to per-round columns view in tournaments
  _lbViewMode = isTournActive ? 'total' : 'byround';
  // In tournament mode, fetch all cloud scores so the leaderboard shows all rounds.
  // Push happens separately (Update button) — fetching alone is fast and safe mid-round.
  if (isTournActive && code) {
    _lbCloudScores = null;  // clear stale data
    const tableEl = document.getElementById('leaderboard-table');
    if (tableEl) tableEl.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--muted);">Loading tournament scores…</div>';
    console.log('[LB] Fetching /scores/' + code.toUpperCase());
    _workerFetch(`/scores/${code.toUpperCase()}`).then(data => {
      console.log('[LB] Cloud scores fetched OK:', JSON.stringify(data)?.slice(0, 200));
      _lbCloudScores = data;
      renderLeaderboard();
    }).catch(err => {
      console.error('[LB] Cloud scores fetch FAILED:', err);
      renderLeaderboard(); // fall back to live-only on network error
    });
  } else {
    console.log('[LB] No tournament or no code — skipping cloud fetch, rendering local only');
    renderLeaderboard();
  }
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
          <span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:700;font-size:0.95rem;color:var(--muted2);">
            Hole ${holeNum}
          </span>
        </div>
        ${r
          ? `<div style="text-align:right;">
              <span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.05rem;">${r.playerName}</span>
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
  // Use offline-first tournament state; fall back to Supabase tournamentId or hub code
  const _ts       = (() => { try { return _tournState(); } catch { return {}; } })();
  const isTourney = _ts.active || !!gameState.tournamentId || !!gameState._hubTournamentCode;
  const tableEl   = document.getElementById('leaderboard-table');
  const metaEl    = document.getElementById('leaderboard-meta');
  if (!tableEl) return;

  const TEAM_PAIR_FORMATS = ['betterball','csm','foursomes','greensomes','best2','texas'];
  const isTeamPairFmt = TEAM_PAIR_FORMATS.includes(fmt);
  const tournGameType = isTourney ? ((typeof activeTournament !== 'undefined' ? activeTournament : null)?.scoring_mode_team ?? 'individual') : null;
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

  // Update hero title and meta
  const titleEl = document.getElementById('leaderboard-title');
  if (titleEl) titleEl.textContent = fmtLabel(fmt);
  metaEl.textContent = `${gameState.courseName} · ${gameState.teeName}`.toUpperCase();

  // Hide names row by default — shown inside buildMatchLeaderboard for match formats
  const namesRow = document.getElementById('leaderboard-names-row');
  if (namesRow && !isMatch) namesRow.style.display = 'none';

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

    // Foursomes/greensomes team stableford/stroke leaderboard
    const teamMode = gameState.teamScoringMode ?? 'match';
    if (['foursomes','greensomes'].includes(fmt) && teamMode !== 'match') {
      const isTeamSb = teamMode === 'stableford';
      const pairRows = [];
      states.filter(s=>s?.names).forEach((s,i) => {
        const n0=s.names[0],n1=s.names[1],n2=s.names[2],n3=s.names[3];
        const namesA = [n0,n1].filter(Boolean).map(n=>shortName(n)).join(' & ');
        const namesB = [n2,n3].filter(Boolean).map(n=>shortName(n)).join(' & ');
        const scoreA = isTeamSb ? (s.teamPts?.[0]??0) : (s.teamNets?.[0]??0);
        const scoreB = isTeamSb ? (s.teamPts?.[1]??0) : (s.teamNets?.[1]??0);
        const thru   = s.log?.length ?? 0;
        pairRows.push({ label: s.pairName??namesA, sub: namesA, score: scoreA, thru });
        if (namesB) pairRows.push({ label: namesB, sub: '', score: scoreB, thru });
      });
      pairRows.sort((a,b) => isTeamSb ? b.score-a.score : a.score-b.score);
      tableEl.innerHTML = buildLeaderboardTable(pairRows.map((r,i)=>({rank:i+1,...r,isLead:i===0})), isTeamSb?'Pts':'Net', 'Shots');
      return;
    }

    // Match formats: use hole-by-hole leaderboard for single group
    if (isMatch) {
      const gs = states[0] ?? gameState;
      tableEl.innerHTML = buildMatchLeaderboard(gs);
      return;
    }

    // Texas matchplay — same hole-by-hole view as foursomes match
    if (isTexas && (gameState.texasScoringFmt ?? 'stableford') === 'match') {
      tableEl.innerHTML = buildMatchLeaderboard(states[0] ?? gameState);
      return;
    }

    // Non-match pairs (best2, texas): standard table
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
      scoreLabel,
      typeof sortedRows[0]?.score === 'number' ? 'Shots' : undefined
    );

    // In tournament team mode, also show a hint that the full tournament
    // standings (cumulative) are available via the tournament detail screen.
    return;
  }

  // ── Non-tournament, non-team format: live group scores ────────────
  if (!isTourney) {
    const states = gameState.allGroupStates ?? [gameState];

    // Match (1v1): use hole-by-hole leaderboard
    if (isMatch) {
      const gs = (gameState.allGroupStates ?? [gameState])[0] ?? gameState;
      tableEl.innerHTML = buildMatchLeaderboard(gs);
      return;
    }

    // ITC: read pts directly from authoritative gameState.pts (not totals, which may lag after edits)
    if (isItc) {
      const gs = states[0] ?? gameState;
      const names = gs.names ?? [];
      const pts   = gs.pts ?? [];
      const holesPlayed = gs.log?.length ?? 0;
      const itcRows = names.map((nm, i) => {
        const gross = (gs.log ?? []).reduce((s, e) => s + (e.grosses?.[i] ?? 0), 0);
        return {
          rank:       0,
          label:      nm,
          sub:        null,
          score:      pts[i] ?? 0,
          extraScore: gross || undefined,
          thru:       holesPlayed,
          isLead:     false,
        };
      });
      itcRows.sort((a, b) => b.score - a.score);
      itcRows.forEach((r, i) => { r.rank = i + 1; r.isLead = i === 0; });
      tableEl.innerHTML = buildLeaderboardTable(itcRows, 'Pts', 'Shots');
      return;
    }

    const rows = buildMultiGroupLeaderboard(states);

    if (!rows.length) {
      tableEl.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--muted);">No scores yet.</div>';
      return;
    }

    // All individual formats show Shots as a secondary column alongside their primary score
    const showShotsCol = !isMatch; // match already shows shots inside buildMatchLeaderboard

    tableEl.innerHTML = buildLeaderboardTable(
      rows.map((r, rank) => {
        let score;
        if (isStroke) score = r.net ?? '--';
        else          score = r.pts ?? '--';
        return {
          rank:       rank + 1,
          label:      r.name,
          sub:        null,
          score,
          extraScore: showShotsCol && r.gross != null ? r.gross : undefined,
          thru:       r.holesPlayed,
          isLead:     rank === 0,
        };
      }),
      scoreLabel,
      showShotsCol ? 'Shots' : undefined
    );
    return;
  }

  // ── Tournament mode, individual format ──────────────────────────
  const numHolesPerRound = gameState.numHoles ?? 18;
  const liveHoles        = gameState.log?.length ?? 0;
  const liveStates       = gameState.allGroupStates ?? [gameState];
  const ts               = (() => { try { return _tournState(); } catch { return {}; } })();

  // Build live scores from current round (all groups)
  const liveScoreByName = {};
  liveStates.forEach(gs => {
    (gs.names ?? []).forEach((name, pi) => {
      liveScoreByName[name] = {
        pts:  isPoints ? (gs.totals?.[pi] ?? 0) : null,
        net:  isStroke ? (gs.totals?.[pi] ?? 0) : null,
        holes: gs.log?.length ?? 0,
        group: String(gs.groupNumber ?? 1),
      };
    });
  });

  // Merge cloud scores + live scores for tournament total view
  // _lbCloudScores format: { rounds: [ { round, group, players: [{name,pts,net,gross,holesPlayed}] } ] }
  const byName   = {};  // name -> { pts, net, roundScores: {r: pts} }
  const cloudRounds = new Set();

  if (_lbCloudScores?.rounds) {
    for (const grp of _lbCloudScores.rounds) {
      const rn = grp.round ?? 1;
      cloudRounds.add(rn);
      for (const p of (grp.players ?? [])) {
        if (!p.name) continue;
        if (!byName[p.name]) byName[p.name] = { pts: 0, net: 0, roundScores: {} };
        // Cloud stores netTotal/grossTotal (from pushScoresToCloud); also accept net/gross as fallback
        const pNet   = p.netTotal   ?? p.net   ?? 0;
        const pGross = p.grossTotal ?? p.gross  ?? 0;
        const pPts   = p.pts ?? 0;
        byName[p.name].pts += pPts;
        byName[p.name].net += pNet;
        byName[p.name].roundScores[rn] = { pts: pPts, net: pNet, gross: pGross };
      }
    }
  }

  // Add live round scores on top (current round)
  // Hub games store round number on gameState._hubTournRound; local tournaments use ts.currentRound
  const liveRound = gameState._hubTournRound ?? ts.currentRound ?? 1;
  for (const [name, live] of Object.entries(liveScoreByName)) {
    if (!byName[name]) byName[name] = { pts: 0, net: 0, roundScores: {} };
    // Only add live if not already covered by cloud for this round
    if (!byName[name].roundScores[liveRound]) {
      byName[name].pts += isStroke ? (live.net ?? 0) : (live.pts ?? 0);
      byName[name].net += live.net ?? 0;
    }
    byName[name].roundScores[liveRound] = {
      pts:   live.pts ?? 0,
      net:   live.net ?? 0,
      holes: live.holes ?? 0,
    };
  }

  // If no cloud or live data, fall back to live-only
  if (!Object.keys(byName).length) {
    const rows2 = buildMultiGroupLeaderboard(liveStates);
    tableEl.innerHTML = rows2.length
      ? buildLeaderboardTable(rows2.map((r,rank) => ({
          rank: rank+1, label: r.name, sub: null,
          score: isStroke ? (r.net ?? '--') : (r.pts ?? '--'),
          extraScore: r.gross ?? undefined, thru: r.holesPlayed, isLead: rank===0,
        })), scoreLabel, 'Shots')
      : '<div style="padding:2rem;text-align:center;color:var(--muted);">No scores yet. Press ⟳ Update to load.</div>';
    return;
  }

  // Sort
  const sortedPlayers = Object.entries(byName)
    .map(([name, d]) => ({ name, ...d }))
    .sort((a, b) => isStroke ? a.net - b.net : b.pts - a.pts);

  // ── Tournament title above the table ──
  const tournTitleEl = document.getElementById('lb-tourn-title');
  if (tournTitleEl) {
    if (isTourney) {
      tournTitleEl.style.display = '';
      tournTitleEl.textContent = _lbViewMode === 'total'
        ? 'Round by Round'
        : 'Total Tournament Points';
    } else {
      tournTitleEl.style.display = 'none';
    }
  }

  // ── Tournament view: per-round columns + cumulative total ──
  // Default view shows per-round columns; flat total via toggle.
  if (_lbViewMode === 'total') {
    const allRounds = Array.from(new Set([...cloudRounds, liveRound])).sort((a,b)=>a-b);
    const colW      = `${Math.floor(56 / Math.max(allRounds.length, 1))}%`;
    const accent    = 'var(--accent,#3b82f6)';

    let html = `<div style="font-family:'Plus Jakarta Sans',sans-serif;">`;
    // Header row
    html += `<div style="display:grid;grid-template-columns:1fr ${allRounds.map(()=>colW).join(' ')} 3.5rem;
      gap:0;padding:0.35rem 0.75rem;border-bottom:1.5px solid var(--border2);
      font-size:0.6rem;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:var(--muted);">
      <div>Player</div>${allRounds.map(r => {
        const isLive = r === liveRound;
        const thruTxt = isLive && liveHoles < numHolesPerRound ? `<div style="font-size:0.55rem;opacity:0.75;">${liveHoles}H</div>` : '';
        return `<div style="text-align:center;${isLive ? `color:${accent};` : ''}">R${r}${thruTxt}</div>`;
      }).join('')}
      <div style="text-align:center">${scoreLabel}</div></div>`;

    sortedPlayers.forEach((p, i) => {
      const isLd  = i === 0;
      const total = isStroke ? p.net : p.pts;
      html += `<div style="display:grid;grid-template-columns:1fr ${allRounds.map(()=>colW).join(' ')} 3.5rem;
        gap:0;padding:0.6rem 0.75rem;border-bottom:1px solid var(--border2);
        background:${isLd ? 'rgba(212,168,67,0.07)' : 'transparent'};">
        <div style="font-size:0.85rem;font-weight:${isLd?'800':'600'};
          color:${isLd?'var(--gold)':'var(--text)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.name}</div>
        ${allRounds.map(r => {
          const rs    = p.roundScores[r];
          const s     = rs ? (isStroke ? rs.net : rs.pts) : '–';
          const isLive = r === liveRound;
          return `<div style="text-align:center;font-size:0.8rem;
            color:${isLive ? accent : 'var(--muted)'};">${s}</div>`;
        }).join('')}
        <div style="text-align:center;font-size:0.85rem;font-weight:800;
          color:${isLd?'var(--gold)':'var(--text)'};">${total}</div>
      </div>`;
    });

    // Legend — cumulative holes played
    const cumulHoles = (liveRound - 1) * numHolesPerRound + liveHoles;
    html += `<div style="padding:0.5rem 0.75rem;font-size:0.7rem;color:${accent};opacity:0.85;">
      R${liveRound} in progress · ${cumulHoles} holes played overall</div>`;
    html += '</div>';
    tableEl.innerHTML = html;
  } else {
    // ── Flat total view (toggle or non-tournament) ──
    // Thru = completed rounds × holes + current round holes played
    const completedRounds = liveRound - 1;
    const cumulativeThru  = completedRounds * numHolesPerRound + liveHoles;
    tableEl.innerHTML = buildLeaderboardTable(
      sortedPlayers.map((p, i) => ({
        rank:   i + 1,
        label:  p.name,
        sub:    null,
        score:  isStroke ? p.net : p.pts,
        thru:   cumulativeThru,
        isLead: i === 0,
      })),
      scoreLabel
    );
  }
}


// ================================================================
// MATCH LEADERBOARD — hole-by-hole view for match/betterball/pairs formats
// ================================================================
function buildMatchLeaderboard(state) {
  const fmt     = state.format;
  const isPairs = ['betterball','csm','foursomes','greensomes'].includes(fmt)
    || (fmt === 'texas' && (state.texasScoringFmt ?? 'stableford') === 'match');
  const isBB    = fmt === 'betterball';
  const isCSM   = fmt === 'csm';
  const isFG    = ['foursomes','greensomes'].includes(fmt);
  const log     = state.log ?? [];
  const si      = state.si  ?? [];
  const par     = state.par ?? [];
  const offset  = state.holeOffset ?? 0;
  const total   = state.numHoles ?? 18;

  // Name labels — pairs show both names
  const nameA = isPairs
    ? `${shortName(state.names[0]??'')} & ${shortName(state.names[1]??'')}`
    : (state.names[0] ?? 'Player 1');
  const nameB = isPairs
    ? `${shortName(state.names[2]??'')} & ${shortName(state.names[3]??'')}`
    : (state.names[1] ?? 'Player 2');

  // Score column label per format
  const scoreLabel = isCSM ? 'Pts' : 'Net';

  // Show names row in the HTML shell
  const namesRow = document.getElementById('leaderboard-names-row');
  const nameAEl  = document.getElementById('lb-name-a');
  const nameBEl  = document.getElementById('lb-name-b');
  if (namesRow) namesRow.style.display = '';
  // For pairs with no team name, stack the two player names vertically
  // so they don't overflow on a single line (e.g. "STEVE W & MARK C" wraps badly)
  if (nameAEl) {
    if (isPairs) {
      const partsA = nameA.split(' & ');
      nameAEl.innerHTML = partsA.map(n => `<div>${n}</div>`).join('');
    } else {
      nameAEl.textContent = nameA;
    }
  }
  if (nameBEl) {
    if (isPairs) {
      const partsB = nameB.split(' & ');
      nameBEl.innerHTML = partsB.map(n => `<div>${n}</div>`).join('');
    } else {
      nameBEl.textContent = nameB;
    }
  }

  // Grid: [net-A 2.8rem] [status-A flex] [hole-chip 3rem] [status-B flex] [net-B 2.8rem]
  const GRID = '2.8rem 1fr 3rem 1fr 2.8rem';

  // Header: team name (small) above NET/PTS label
  const teamAShort = isPairs
    ? `${shortName(state.names[0]??'')} & ${shortName(state.names[1]??'')}`
    : shortName(state.names[0]??'');
  const teamBShort = isPairs
    ? `${shortName(state.names[2]??'')} & ${shortName(state.names[3]??'')}`
    : shortName(state.names[1]??'');

  let html = `
    <div style="display:grid;grid-template-columns:${GRID};
                align-items:center;padding:0.5rem 0.25rem 0.4rem;
                border-bottom:1.5px solid var(--border2);font-family:'Plus Jakarta Sans',sans-serif;
                gap:0 0.25rem;">
      <div style="text-align:center;line-height:1.1;">
        ${teamAShort.split(' & ').map(n => `<div style="font-size:0.5rem;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;
                    color:var(--gold);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                    max-width:2.8rem;">${n}</div>`).join('')}
        <div style="font-size:0.65rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;
                    color:var(--muted);margin-top:1px;">${scoreLabel}</div>
      </div>
      <div></div>
      <div style="font-size:0.7rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;
                  color:var(--muted);text-align:center;">H</div>
      <div></div>
      <div style="text-align:center;line-height:1.1;">
        ${teamBShort.split(' & ').map(n => `<div style="font-size:0.5rem;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;
                    color:#5ba8d8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                    max-width:2.8rem;">${n}</div>`).join('')}
        <div style="font-size:0.65rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;
                    color:var(--muted);margin-top:1px;">${scoreLabel}</div>
      </div>
    </div>`;

  for (let h = 0; h < total; h++) {
    const entry   = log[h] ?? null;
    const holeNum = offset + h + 1;
    const played  = !!entry;

    let netA = '', netB = '';
    let result = 0, ms = 0, up = 0;
    let changed = false; // hole was won by someone (not halved)

    if (played) {
      if (isBB) {
        netA = entry.bbA?.net ?? '';
        netB = entry.bbB?.net ?? '';
      } else if (isCSM) {
        netA = entry.totalA ?? '';
        netB = entry.totalB ?? '';
      } else {
        netA = entry.nets?.[0] ?? '';
        netB = entry.nets?.[1] ?? '';
      }

      ms      = entry.matchAfter ?? 0;
      result  = entry.result ?? 0;
      up      = Math.abs(ms);
      changed = result !== 0;
    }

    const opacity    = played ? '1' : '0.28';
    const arrowColA  = result > 0 ? 'var(--gold)' : '#5ba8d8';
    const arrowColB  = result > 0 ? '#5ba8d8'     : 'var(--gold)';

    // Hole chip
    const holeChip = `
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;
                  text-align:center;padding:0.2rem 0;min-width:2.6rem;">
        <span style="font-family:'Plus Jakarta Sans',sans-serif;font-size:1.3rem;font-weight:800;
                     color:var(--white);line-height:1;">${holeNum}</span>
      </div>`;

    // Status column content:
    // - Changed hole: arrow + UP/DN in team colour, bold
    // - Halved hole: small muted "halved" note
    // - Unplayed: empty
    let statusHtmlA = '', statusHtmlB = '';

    if (played && changed) {
      // A leading after this hole
      const standingTxt = up === 0 ? 'A/S' : `${up} ${ms > 0 ? 'UP' : 'DN'}`;
      const standingTxtB = up === 0 ? 'A/S' : `${up} ${ms < 0 ? 'UP' : 'DN'}`;
      statusHtmlA = `
        <span style="font-size:0.85rem;color:${arrowColA};font-weight:800;margin-right:2px;">
          ${result > 0 ? '↑' : '↓'}
        </span>
        <span style="font-size:0.95rem;font-weight:800;color:${arrowColA};
                     letter-spacing:0.02em;white-space:nowrap;">${standingTxt}</span>`;
      statusHtmlB = `
        <span style="font-size:0.95rem;font-weight:800;color:${arrowColB};
                     letter-spacing:0.02em;white-space:nowrap;text-align:right;">${standingTxtB}</span>
        <span style="font-size:0.85rem;color:${arrowColB};font-weight:800;margin-left:2px;">
          ${result > 0 ? '↓' : '↑'}
        </span>`;
    } else if (played && !changed) {
      // Halved — just say "Halved", quiet and muted
      statusHtmlA = `<span style="font-size:0.8rem;font-weight:400;color:var(--muted);
                                  letter-spacing:0.01em;">Halved</span>`;
      statusHtmlB = `<span style="font-size:0.8rem;font-weight:400;color:var(--muted);
                                  letter-spacing:0.01em;text-align:right;">Halved</span>`;
    }

    html += `
      <div style="display:grid;grid-template-columns:${GRID};
                  align-items:center;padding:0.5rem 0.25rem;
                  border-bottom:0.5px solid var(--border);opacity:${opacity};
                  font-family:'Plus Jakarta Sans',sans-serif;gap:0 0.25rem;">
        <div style="font-size:1.6rem;font-weight:700;color:var(--white);
                    text-align:center;line-height:1;">${netA}</div>
        <div style="display:flex;align-items:center;justify-content:flex-start;gap:2px;
                    padding-left:0.3rem;">${statusHtmlA}</div>
        ${holeChip}
        <div style="display:flex;align-items:center;justify-content:flex-end;gap:2px;
                    padding-right:0.3rem;">${statusHtmlB}</div>
        <div style="font-size:1.6rem;font-weight:700;color:var(--white);
                    text-align:center;line-height:1;">${netB}</div>
      </div>`;
  }

  // Footer: final match status
  const ms      = state.matchScore ?? 0;
  const up      = Math.abs(ms);
  const left    = total - log.length;
  // Determine if match is concluded: won if margin > holes remaining, or dormie, or no holes left
  const matchWon    = up > 0 && up > left;
  const matchDormie = up > 0 && up === left && left > 0;
  const matchDone   = left === 0;

  let footerHtml;
  if (matchWon) {
    // e.g. "4&3" — winner leads by `up` with `left` holes remaining
    const scoreStr = `${up}&${left}`;
    const winnerName = ms > 0 ? nameA : nameB;
    const winCol  = ms > 0 ? 'var(--gold)' : '#5ba8d8';
    const loseCol = 'var(--muted)';
    footerHtml = `
      <div style="display:grid;grid-template-columns:1fr auto 1fr;align-items:center;
                  padding:0.85rem 0.25rem 0.5rem;border-top:2px solid var(--border2);
                  margin-top:0.15rem;font-family:'Plus Jakarta Sans',sans-serif;">
        <div style="font-size:1.6rem;font-weight:800;color:${ms > 0 ? winCol : loseCol};
                    letter-spacing:0.04em;text-align:left;">${ms > 0 ? 'WON' : ''}</div>
        <div style="font-size:2rem;font-weight:900;color:var(--white);
                    letter-spacing:0.04em;text-align:center;padding:0 0.5rem;">${scoreStr}</div>
        <div style="font-size:1.6rem;font-weight:800;color:${ms < 0 ? winCol : loseCol};
                    text-align:right;letter-spacing:0.02em;">${ms < 0 ? 'WON' : ''}</div>
      </div>`;
  } else if (matchDormie) {
    const dormieCol = ms > 0 ? 'var(--gold)' : '#5ba8d8';
    const dormieStr = `${up} UP (Dormie ${left})`;
    const dormieStrB = `${up} UP (Dormie ${left})`;
    footerHtml = `
      <div style="display:grid;grid-template-columns:1fr auto 1fr;align-items:center;
                  padding:0.85rem 0.25rem 0.5rem;border-top:2px solid var(--border2);
                  margin-top:0.15rem;font-family:'Plus Jakarta Sans',sans-serif;">
        <div style="font-size:1.1rem;font-weight:800;color:${ms > 0 ? dormieCol : 'var(--muted)'};
                    letter-spacing:0.02em;text-align:left;">${ms > 0 ? dormieStr : ''}</div>
        <div style="font-size:0.8rem;font-weight:700;color:var(--muted);
                    letter-spacing:0.08em;text-align:center;text-transform:uppercase;
                    padding:0 0.5rem;">${left} to play</div>
        <div style="font-size:1.1rem;font-weight:800;color:${ms < 0 ? dormieCol : 'var(--muted)'};
                    text-align:right;letter-spacing:0.02em;">${ms < 0 ? dormieStrB : ''}</div>
      </div>`;
  } else {
    const statusA = ms > 0 ? `${up} UP` : ms < 0 ? `${Math.abs(ms)} DOWN` : 'ALL SQ';
    const statusB = ms < 0 ? `${up} UP` : ms > 0 ? `${Math.abs(ms)} DOWN` : 'ALL SQ';
    const colA    = ms > 0 ? 'var(--gold)' : ms < 0 ? 'var(--muted)' : 'var(--muted)';
    const colB    = ms < 0 ? '#5ba8d8'     : ms > 0 ? 'var(--muted)' : 'var(--muted)';
    const midTxt  = matchDone ? 'FINAL' : `${left} to play`;
    footerHtml = `
      <div style="display:grid;grid-template-columns:1fr auto 1fr;align-items:center;
                  padding:0.85rem 0.25rem 0.5rem;border-top:2px solid var(--border2);
                  margin-top:0.15rem;font-family:'Plus Jakarta Sans',sans-serif;">
        <div style="font-size:1.6rem;font-weight:800;color:${colA};
                    letter-spacing:0.04em;text-align:left;">${statusA}</div>
        <div style="font-size:0.8rem;font-weight:700;color:var(--muted);
                    letter-spacing:0.08em;text-align:center;text-transform:uppercase;
                    padding:0 0.5rem;">${midTxt}</div>
        <div style="font-size:1.6rem;font-weight:800;color:${colB};
                    text-align:right;letter-spacing:0.02em;">${statusB}</div>
      </div>`;
  }

  html += footerHtml;

  // Final score banner at top for concluded matches
  let topBanner = '';
  if (matchWon) {
    const scoreStr = `${up}&${left}`;
    const winnerName = ms > 0 ? nameA : nameB;
    topBanner = `
      <div style="background:var(--surface2);border:1.5px solid var(--border2);border-radius:var(--radius-sm);
                  padding:0.6rem 0.85rem;margin-bottom:0.5rem;text-align:center;
                  font-family:'Plus Jakarta Sans',sans-serif;">
        <div style="font-size:0.6rem;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;
                    color:var(--muted);margin-bottom:2px;">FINAL RESULT</div>
        <div style="font-size:1.8rem;font-weight:900;color:var(--gold);letter-spacing:0.04em;">${scoreStr}</div>
        <div style="font-size:0.85rem;font-weight:700;color:var(--white);">${winnerName} wins</div>
      </div>`;
  } else if (matchDone && ms === 0) {
    topBanner = `
      <div style="background:var(--surface2);border:1.5px solid var(--border2);border-radius:var(--radius-sm);
                  padding:0.6rem 0.85rem;margin-bottom:0.5rem;text-align:center;
                  font-family:'Plus Jakarta Sans',sans-serif;">
        <div style="font-size:0.6rem;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;
                    color:var(--muted);margin-bottom:2px;">FINAL RESULT</div>
        <div style="font-size:1.6rem;font-weight:900;color:var(--white);">All Square</div>
      </div>`;
  }

  return topBanner + html;
}

// scoreLabel: primary score column header (e.g. 'Pts', 'Net')
// extraLabel: optional secondary column header (e.g. 'Shots') — shown before the primary col
// rows may include r.extraScore for the secondary column value
function buildLeaderboardTable(rows, scoreLabel, extraLabel) {
  if (!rows.length) return '<div style="padding:2rem;text-align:center;color:var(--muted);">No scores yet.</div>';

  const hasExtra = !!extraLabel;
  // Fixed-width right columns so they always align regardless of name length.
  // Name column uses minmax(0,1fr) to constrain overflow rather than pushing columns out.
  const gridCols = hasExtra
    ? '2rem minmax(0,1fr) 3.2rem 3.2rem 3rem'
    : '2rem minmax(0,1fr) 3.2rem 3rem';

  const HDR_STYLE = `font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:0.62rem;
                     color:var(--muted);letter-spacing:0.06em;text-transform:uppercase;`;
  const HDR_R = `${HDR_STYLE}text-align:right;`;

  let html = `
    <div style="display:grid;grid-template-columns:${gridCols};
                align-items:center;border-bottom:2px solid var(--border2);
                padding:0.5rem 0.75rem;margin-top:1rem;gap:0 0.25rem;">
      <div style="${HDR_STYLE}">#</div>
      <div style="${HDR_STYLE}">Name</div>
      ${hasExtra ? `<div style="${HDR_R}">${extraLabel.toUpperCase()}</div>` : ''}
      <div style="${HDR_R}">${scoreLabel.toUpperCase()}</div>
      <div style="${HDR_R}">Thru</div>
    </div>`;

  rows.forEach(r => {
    const gold = r.isLead ? 'var(--gold)' : 'var(--white)';
    const bg   = r.isLead ? 'background:rgba(212,168,67,0.06);' : '';

    // playerScores: [{initials, score, scoreColor?}] — show individual player columns under name
    let playerScoreHtml = '';
    if (r.playerScores?.length) {
      playerScoreHtml = `
        <div style="display:flex;gap:0.75rem;margin-top:0.3rem;">
          ${r.playerScores.map(ps => `
            <div style="text-align:center;min-width:2rem;">
              <div style="font-size:0.65rem;font-weight:700;color:var(--muted2);
                          letter-spacing:0.05em;text-transform:uppercase;">${ps.initials}</div>
              <div style="font-size:0.95rem;font-weight:800;color:${ps.scoreColor ?? 'var(--white)'};">
                ${ps.score ?? '-'}
              </div>
            </div>`).join('')}
        </div>`;
    }

    const extraCell = hasExtra
      ? `<div style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:600;
                    font-size:1.05rem;color:var(--muted2);text-align:right;">${r.extraScore ?? '–'}</div>`
      : '';

    html += `
      <div style="display:grid;grid-template-columns:${gridCols};
                  align-items:center;padding:0.75rem 0.75rem;
                  border-bottom:1px solid var(--border);${bg}gap:0 0.25rem;">
        <div style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;
                    font-size:1.2rem;color:var(--muted2);">${r.rank}</div>
        <div style="min-width:0;">
          <div style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;
                      font-size:1.15rem;color:${gold};line-height:1.2;
                      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${r.label}</div>
          ${r.sub ? `<div style="font-size:0.78rem;font-weight:700;color:var(--muted2);
                                 white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${r.sub}</div>` : ''}
          ${playerScoreHtml}
        </div>
        ${extraCell}
        <div style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;
                    font-size:1.5rem;color:${gold};text-align:right;">${r.score}</div>
        <div style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:700;
                    font-size:1.1rem;color:var(--muted2);text-align:right;">${r.thru}</div>
      </div>`;
  });

  return html;
}

document.getElementById('btn-game-scorecard')?.addEventListener('click', () => {
  renderScorecardOverlay();
  document.getElementById('scorecard-overlay')?.classList.add('open');
  if (MULTI_USER) _syncTick();
});

// ── Hole Navigation ────────────────────────────────────────────
window.closeHoleNav = function() {
  document.getElementById('hole-nav-panel')?.style.setProperty('display','none');
  document.getElementById('hole-nav-backdrop')?.style.setProperty('display','none');
};

function openHoleNav() {
  const panel    = document.getElementById('hole-nav-panel');
  const grid     = document.getElementById('hole-nav-grid');
  const backdrop = document.getElementById('hole-nav-backdrop');
  if (!panel || !grid || !gameState) return;

  const total   = gameState.numHoles ?? 18;
  const offset  = gameState.holeOffset ?? 0;
  const played  = gameState.log?.length ?? 0;
  const current = gameState.hole;
  const par     = gameState.par ?? [];

  grid.innerHTML = Array.from({ length: total }, (_, i) => {
    const hNum   = offset + i + 1;
    const isDone = i < played;
    const isCur  = i === current;
    const parH   = par[i] ?? '–';

    let bg, col, border;
    if (isCur)       { bg = 'var(--green)';   col = '#fff';           border = 'var(--green)'; }
    else if (isDone) { bg = 'var(--surface2)'; col = 'var(--muted2)'; border = 'var(--border)'; }
    else             { bg = 'var(--surface)';  col = 'var(--white)';  border = 'var(--border)'; }

    return `<button onclick="jumpToHole(${i})"
      style="display:flex;flex-direction:column;align-items:center;padding:0.5rem 0.2rem;
             border-radius:8px;border:1px solid ${border};background:${bg};cursor:pointer;gap:0.1rem;">
      <span style="font-family:'Plus Jakarta Sans',sans-serif;font-size:1.2rem;
                   font-weight:800;color:${col};line-height:1;">${hNum}</span>
      <span style="font-size:0.55rem;color:${isDone?'var(--muted)':'var(--muted2)'};font-weight:600;">P${parH}</span>
      ${isDone ? `<span style="font-size:0.65rem;color:var(--green);">✓</span>` : ''}
    </button>`;
  }).join('');

  panel.style.display = 'block';
  backdrop.style.display = 'block';
}

window.jumpToHole = function(holeIdx) {
  closeHoleNav();
  if (!gameState) return;
  const played = gameState.log?.length ?? 0;
  // Can only jump to played holes or the current next hole
  gameState.hole = Math.min(holeIdx, played);
  renderScoreHeader();
  renderHolePanel();
};

document.getElementById('btn-hole-nav')       ?.addEventListener('click', openHoleNav);
document.getElementById('btn-hole-pager')     ?.addEventListener('click', openHoleNav);
document.getElementById('btn-hole-nav-close') ?.addEventListener('click', closeHoleNav);
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
    const ms         = gameState.matchScore ?? 0;
    const holeResult = entry.result ?? 0;        // THIS hole: +1 A wins, -1 B wins, 0 halved
    const isPairsF   = ['betterball','csm','foursomes','greensomes'].includes(fmt);
    const nameA = isPairsF
      ? `${shortName(gameState.names[0])} & ${shortName(gameState.names[1])}`
      : gameState.names[0].split(' ')[0];
    const nameB = isPairsF
      ? `${shortName(gameState.names[2]??'')} & ${shortName(gameState.names[3]??'')}`
      : (gameState.names[1]??'').split(' ')[0];

    // Line 1: what happened on THIS hole
    let holeLine = '';
    if (holeResult === 0) {
      holeLine = `<span style="color:var(--green);font-weight:700;">Hole halved</span>`;
    } else {
      const holeWinner = holeResult > 0 ? nameA : nameB;
      const holeCol    = holeResult > 0 ? pHex(0) : pHex(2);
      holeLine = `<span style="color:${holeCol};font-weight:700;">${holeWinner} wins the hole</span>`;
      bg     = holeResult > 0 ? 'rgba(212,168,67,0.07)' : 'rgba(91,163,217,0.07)';
      border = holeResult > 0 ? 'rgba(212,168,67,0.25)' : 'rgba(91,163,217,0.25)';
    }

    // Line 2: overall match standing
    const up = Math.abs(ms);
    const standingLine = ms === 0
      ? `<span style="font-size:0.68rem;color:var(--muted);display:block;margin-top:2px;">Match All Square · ${(gameState.numHoles ?? 18) - gameState.log.length} to play</span>`
      : (() => {
          const leader = ms > 0 ? nameA : nameB;
          const col    = ms > 0 ? pHex(0) : pHex(2);
          return `<span style="font-size:0.68rem;color:${col};display:block;margin-top:2px;">${leader} ${up} UP · ${(gameState.numHoles ?? 18) - gameState.log.length} to play</span>`;
        })();

    msg = holeLine + standingLine;
  } else if (fmt === 'skins') {
    if (entry.winner === -1) {
      msg = `<span style="color:var(--green);font-weight:600;">Halved -- skins carry</span><span style="font-size:0.68rem;color:var(--muted);display:block;margin-top:2px;">Next hole worth <b style="color:var(--gold)">${gameState.pot}</b> skins</span>`;
    } else {
      const w = entry.winner;
      msg = `<span style="color:${pHex(w)};font-weight:600;">${gameState.names[w]} wins ${entry.potWon} skin${entry.potWon !== 1 ? 's' : ''}! 🏆</span>`;
      bg = 'rgba(212,168,67,0.07)'; border = 'rgba(212,168,67,0.25)';
    }
  } else if (fmt === 'itc') {
    const itcPts   = gameState.pts ?? [];
    const itcN     = gameState.names.length;
    const itcMax   = Math.max(...itcPts);

    // Hole result
    if (entry.pointScoredBy !== null && entry.pointScoredBy !== undefined) {
      msg = `<span style="color:${pHex(entry.pointScoredBy)};font-weight:700;">${shortName(gameState.names[entry.pointScoredBy])} scores! 🪑 +1</span>`;
      bg = 'rgba(212,168,67,0.07)'; border = 'rgba(212,168,67,0.25)';
    } else if (entry.newChair !== null && entry.newChair !== undefined) {
      msg = `<span style="color:${pHex(entry.newChair)};font-weight:700;">${shortName(gameState.names[entry.newChair])} takes the chair 🪑</span>`;
    } else {
      msg = `<span style="color:var(--green);font-weight:700;">Halved — chair empty</span>`;
    }

    // Standing line
    const itcLeft = (gameState.numHoles??18) - (gameState.log?.length??0);
    if (itcN === 2) {
      const d = itcPts[0] - itcPts[1];
      const standLine = d === 0 ? 'All Square'
        : `${gameState.names[d > 0 ? 0 : 1].split(' ')[0]} ${Math.abs(d)} UP`;
      msg += `<span style="font-size:0.75rem;color:var(--muted);display:block;margin-top:3px;">${standLine} · ${itcLeft} to play</span>`;
    } else {
      const leaderIdx = itcPts.indexOf(itcMax);
      const standLine = itcMax === 0 ? 'All square'
        : `${gameState.names[leaderIdx].split(' ')[0]} leads`;
      msg += `<span style="font-size:0.75rem;color:var(--muted);display:block;margin-top:3px;">${standLine} · ${itcLeft} to play</span>`;
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
  // betterball, csm, best2: own-ball formats — add Players tab for individual scores
  if (['betterball','csm','best2'].includes(fmt)) return ['points','strokes','detail','players'];
  if (['stableford','split6','texas'].includes(fmt)) return ['points','strokes','detail'];
  // match, foursomes, greensomes: add players tab to see individual shots
  if (['match','foursomes','greensomes'].includes(fmt)) return ['strokes','detail','players'];
  return ['strokes','detail'];
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
      // Strokes mode: show P.Up (N) for pickups, gross otherwise
      const isPickup = entry.pickups?.[pi] ?? false;
      if (isPickup) return { text: `P.Up (${gross})`, relToPar: 99, pickup: true };
      const relToPar = gross - entry.par;
      if (mode === 'detail') {
        // Show gross / shots-dot + net / pts stacked
        const hcp    = state.playingHandicaps?.[pi] ?? state.matchHandicaps?.[pi] ?? 0;
        const shots  = indivStrokesOnHole(hcp, entry.si);
        const net    = gross - shots;
        const pts    = entry.holePts?.[pi] ?? entry.sbPts?.[pi];
        const fmt2   = state.format;
        const hasPts = ['stableford','split6','best2'].includes(fmt2) && pts != null;
        return { text: String(gross), relToPar, detail: { shots, net, pts: hasPts ? pts : null } };
      }
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
        getCell: (entry, mode) => {
          if (!entry) return { text: '' };
          const gross = entry.grosses?.[pi];
          const net   = entry.nets?.[pi] ?? gross;
          if (gross == null) return { text: '' };
          if (mode === 'detail') {
            const shots = gross - (entry.nets?.[pi] ?? gross);
            return { text: String(gross), relToPar: gross - entry.par,
                     detail: { shots, net, pts: null } };
          }
          return { text: String(net), sub: gross !== net ? `Gross ${gross}` : null };
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
          if (entry.gross == null) return { text: '' };
          if (mode === 'detail') {
            const shots = entry.teamExtra ?? 0;
            const net   = entry.net ?? (entry.gross - shots);
            const pts   = entry.pts;
            return { text: String(entry.gross), relToPar: entry.gross - entry.par,
                     detail: { shots, net, pts: pts != null ? pts : null } };
          }
          // Strokes mode: show gross with par-relative colouring
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

  // Players mode: show every player's individual gross score regardless of format
  const INDIV_FORMATS = ['betterball','csm','best2','match','foursomes','greensomes'];
  const useIndivCols = mode === 'players' && INDIV_FORMATS.includes(state.format);

  let columns;
  if (useIndivCols) {
    const names = state.names ?? [];
    columns = names.map((_, pi) => ({
      label:    toInitials(names[pi] ?? `P${pi+1}`),
      dotColor: pHex(pi),
      getCell: (entry, mode) => {
        if (!entry) return { text: '' };
        const gross = entry.grosses?.[pi];
        if (gross == null) return { text: '' };
        const shots = entry.extras?.[pi] ?? indivStrokesOnHole(state.playingHandicaps?.[pi] ?? 0, entry.si);
        const net   = gross - shots;
        if (mode === 'detail') {
          const pts = entry.holePts?.[pi];
          return { text: String(gross), relToPar: gross - entry.par,
                   detail: { shots, net, pts: pts != null ? pts : null } };
        }
        return { text: String(gross), sub: shots > 0 ? `Net ${net}` : null, relToPar: gross - entry.par };
      },
    }));
  } else {
    columns = scorecardColumns(state);
  }
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
      // Extract numeric value — pickup shows as "P.Up (N)" so parse the bracketed number
      let numRaw = cell.text;
      const pickupMatch = cell.pickup ? cell.text.match(/\((\d+)\)/) : null;
      const num = pickupMatch
        ? parseInt(pickupMatch[1], 10)
        : (cell.text !== '' && cell.text !== '-' ? parseFloat(cell.text) : null);
      if (num != null && !isNaN(num)) {
        if (h < 9) { frontTotals[ci] += num; frontHas[ci] = true; }
        else       { backTotals[ci]  += num; backHas[ci]  = true; }
      }

      // Colour-coded border for strokes mode based on gross vs par
      // Pickup: show gold background, no par-relative border
      let inner = cell.text;
      if (cell.pickup && mode === 'strokes') {
        inner = `<span style="display:inline-block;background:var(--gold);color:#fff;
                   border-radius:4px;padding:1px 4px;font-size:0.75em;font-weight:800;
                   line-height:1.3;white-space:nowrap;">${cell.text}</span>`;
      } else if ((mode === 'strokes' || mode === 'detail') && cell.relToPar != null && cell.text !== '') {
        const r = cell.relToPar;
        const red  = '#d64545';
        const blue = '#3a7bd5';
        const single = (color, t) =>
          `<span style="display:inline-block;border:2px solid ${color};border-radius:2px;padding:1px 5px;line-height:1.2;">${t}</span>`;
        const double = (color, t) =>
          `<span style="display:inline-block;border:2px solid ${color};border-radius:4px;padding:3px 7px;line-height:1.2;">
             <span style="display:inline-block;border:2px solid ${color};border-radius:2px;padding:0 3px;line-height:1.2;">${t}</span>
           </span>`;
        if (r <= -2)       inner = double(red, cell.text);
        else if (r === -1) inner = single(red, cell.text);
        else if (r === 1)  inner = single(blue, cell.text);
        else if (r === 2)  inner = double(blue, cell.text);
      }

      // Detail mode: stacked gross / shots+net / pts
      let detailHtml = '';
      if (mode === 'detail' && cell.detail) {
        const d = cell.detail;
        const shotsDot = d.shots > 0
          ? `<span class="sc-shot-dot">${'•'.repeat(Math.min(d.shots, 2))}</span>`
          : '';
        const netCol = d.net < (entry?.par ?? 4) ? '#d64545' : d.net > (entry?.par ?? 4) ? '#3a7bd5' : 'var(--muted2)';
        detailHtml += `<div class="sc-detail-net">${shotsDot}<span style="color:${netCol};">${d.net}</span></div>`;
        if (d.pts != null) {
          const ptsCol = d.pts >= 3 ? '#d64545' : d.pts <= 1 ? '#3a7bd5' : 'var(--muted2)';
          detailHtml += `<div class="sc-detail-pts" style="color:${ptsCol};">${d.pts}pt</div>`;
        }
      }

      const sub = cell.sub ? `<div style="font-size:0.7em;color:var(--muted2);font-weight:500;margin-top:1px;">${cell.sub}</div>` : '';
      return `<td class="sc-score-cell${mode === 'detail' ? ' sc-detail-cell' : ''}">${inner}${detailHtml}${sub}</td>`;
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

  // In detail mode: show net total + pts total derived from hole cells
  const detailTotals = mode === 'detail' ? columns.map((c, ci) => {
    const entries = log.filter(e => e != null);
    let netSum = 0; let ptsSum = 0; let hasNet = false; let hasPts = false;
    for (let h = 0; h < totalHoles; h++) {
      const entry = byHole[h];
      if (!entry) continue;
      const cell = c.getCell(entry, 'detail');
      if (cell.detail) {
        netSum += cell.detail.net ?? 0; hasNet = true;
        if (cell.detail.pts != null) { ptsSum += cell.detail.pts; hasPts = true; }
      }
    }
    return { gross: grandTotals[ci], net: hasNet ? netSum : null, pts: hasPts ? ptsSum : null };
  }) : null;

  bodyRows += `
    <tr class="sc-total-row">
      <td>Total</td>
      ${columns.map((c, ci) => {
        if (mode === 'detail' && detailTotals?.[ci]) {
          const dt = detailTotals[ci];
          const netHtml = dt.net != null ? `<div class="sc-detail-net" style="color:var(--muted2);">Net ${dt.net}</div>` : '';
          const ptsHtml = dt.pts != null ? `<div class="sc-detail-pts" style="color:var(--gold);">${dt.pts}pt</div>` : '';
          return `<td class="sc-detail-cell">${dt.gross}${netHtml}${ptsHtml}</td>`;
        }
        return `<td>${grandTotals[ci]}</td>`;
      }).join('')}
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
          ${groups.length > 1 ? `<div style="text-align:center;padding:0.5rem 0;font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1rem;color:var(--muted2);">Group ${g.groupNumber ?? i+1}</div>` : ''}
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
      // Keep IDB in sync for admin actions (scorer transfer, LD/NTP, edit hole)
      idbSave(roundId, stateToSave, false).catch(() => {}); // dirty=false — already synced
      try { localStorage.setItem('lb-game-state-cache', JSON.stringify({ roundId, state: stateToSave })); } catch {}
      badge?.classList.add('hidden');
      return;
    } catch (err) {
      lastErr = err;
      console.error(`saveRoundState error (attempt ${attempt})`, err);
      if (attempt === 1) await new Promise(r => setTimeout(r, 600));
    }
  }

  badge?.classList.remove('hidden');  // keep badge visible — score is NOT saved
  badge?.setAttribute('title', 'Score not saved — tap Confirm again');
  // Non-blocking error toast — alert() blocks the UI which feels broken on mobile
  const errToast = document.createElement('div');
  errToast.textContent = '⚠️ Score not saved — poor signal. Tap Confirm to retry.';
  errToast.style.cssText = `position:fixed;bottom:90px;left:50%;transform:translateX(-50%);
    background:var(--red,#c0392b);color:#fff;padding:0.75rem 1.25rem;border-radius:20px;
    font-weight:800;font-size:0.85rem;z-index:9999;cursor:pointer;white-space:nowrap;
    box-shadow:0 4px 12px rgba(0,0,0,0.3);`;
  errToast.onclick = () => errToast.remove();
  document.body.appendChild(errToast);
  setTimeout(() => errToast.remove(), 6000);
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
      _collectRecoverableRounds(currentUser.id).catch(() => []),
    ]);

    // Active Games badge = active/paused rounds + any saved setup draft
    const _draft = readSetupDraft();
    const hasDraft = !!(_draft?.screen);
    const gamesBadge = document.getElementById('home-active-games-badge');
    const roundCount = activeRounds.length + (hasDraft ? 1 : 0);
    if (gamesBadge) {
      gamesBadge.textContent = String(roundCount);
      // The round card shows the latest round itself — only badge when there's more than one
      gamesBadge.style.display = roundCount > 1 ? 'inline-flex' : 'none';
    }
    _renderHomeRoundCard(activeRounds, hasDraft ? _draft : null);

    // Game Invites badge
    const gameInvites  = inviteRows.filter(r => r.round_id);
    const invitesBadge = document.getElementById('home-game-invites-badge');
    if (invitesBadge) {
      invitesBadge.textContent = String(gameInvites.length);
      invitesBadge.style.display = gameInvites.length > 0 ? 'inline-flex' : 'none';
    }
  } catch {}
}

// ── Home "Round in progress" card ───────────────────────────────
function _renderHomeRoundCard(activeRounds, draft) {
  const card     = document.getElementById('btn-home-active-games');
  const statusEl = document.getElementById('home-round-status');
  const courseEl = document.getElementById('home-round-course');
  const btnEl    = document.getElementById('home-round-btn');
  if (!card || !statusEl || !courseEl || !btnEl) return;
  const chevron = btnEl.querySelector('svg')?.outerHTML ?? '';
  const latest  = activeRounds?.[0];
  let state = 'idle', status, course, btn;

  if (latest) {
    const gs        = latest.game_state ?? {};
    const total     = gs.numHoles ?? 18;
    const played    = gs.log?.length ?? 0;
    const holeNo    = Math.min((gs.hole ?? played) + 1 + (gs.holeOffset ?? 0), total + (gs.holeOffset ?? 0));
    const paused    = latest.status === 'paused';
    state  = paused ? 'paused' : 'live';
    status = `<b>${paused ? 'Round paused' : 'Round in progress'}</b><i></i>Hole ${holeNo}`;
    const tee = latest.tee_name ? ` <em>(${latest.tee_name})</em>` : '';
    course = `${latest.course_name ?? fmtLabel(gs.format)}${tee}`;
    btn    = 'Resume';
  } else if (draft) {
    state  = 'draft';
    status = '<b>Setup in progress</b>';
    course = draft.courseName ?? fmtLabel(draft.scoring);
    btn    = 'Resume';
  } else {
    status = 'No round in progress';
    course = 'Choose a format below';
    btn    = 'View';
  }
  card.classList.remove('is-idle', 'is-live', 'is-paused', 'is-draft');
  card.classList.add(`is-${state}`);
  statusEl.innerHTML = status;
  courseEl.innerHTML = course;
  btnEl.innerHTML    = `${btn} ${chevron}`;
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
        isGuest:   gs.playerIsGuest?.[i] ?? false,
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
            <div style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.1rem;">${p.name}</div>
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
  try {
    // Stage 2: Load active rounds from all sources + pending game invites
    const [rounds, inviteRows] = await Promise.all([
      _collectRecoverableRounds(currentUser?.id).catch(() => []),
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
            if (su && Object.keys(su).length) assignToSetup(su);
            const ok = await tryRestoreSetupState() || await _restoreSetupFromDraft(savedDraft);
            if (!ok) {
              if (su && Object.keys(su).length) {
                assignToSetup(su);
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
      const isPaused  = r.status === 'paused';
      const isOrphan  = r._source === 'idb-only';
      const holesInfo = r.game_state?.log?.length
        ? ` · ${r.game_state.log.length} hole${r.game_state.log.length !== 1 ? 's' : ''} played`
        : '';
      const orphanNote = isOrphan ? ' · Recovered from local cache' : '';
      items.push({
        kind: 'round',
        roundId: r.id,
        icon: isOrphan ? '🔄' : isPaused ? '⏸️' : '⛳',
        title: r.course_name ?? r.game_state?.courseName ?? 'Round',
        sub: `${fmtLabel(r.game_state?.format ?? '')} · Group ${r.game_state?.groupNumber ?? 1}${isPaused ? ' · Saved' : ''}${holesInfo}${orphanNote}`,
        action: () => resumeRound(r.id),
        actionLabel: 'Resume',
        // Orphan rounds can't be deleted via normal path (no rounds store record)
        noDelete: isOrphan,
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
              <div style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.15rem;
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
            <div style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.05rem;">
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

  stopSyncLoop();
  if (targetRoundId) {
    if (shouldDelete) {
      // Explicit delete — clear all recovery data for this round
      idbClear(targetRoundId).catch(() => {});
      try { localStorage.removeItem('lb-active-round'); } catch {}
      try { localStorage.removeItem('lb-game-state-cache'); } catch {}
    } else {
      // Pause/abandon — keep IDB recovery data so the round can be resumed.
      // Only flush any unsynced dirty state to rounds store before leaving.
      try {
        const local = await idbLoad(targetRoundId);
        if (local?.dirty) await _persistNow();
      } catch {}
      // Keep lb-active-round pointer for recovery on next open.
      // Do NOT clear active_rounds IDB entry — it is the recovery record.
    }
  }
  realtimeUnsubscribe(realtimeCh); realtimeCh = null;
  roundId = null; gameState = null;
  if (shouldDelete) {
    try { localStorage.removeItem('lb-active-round'); } catch {}
  }
  try { localStorage.removeItem('lb-game-code'); } catch {}
  clearSetupState();
  clearSetupDraft();
  setup.tournamentId     = null;
  setup.tournRoundNumber = null;

  await showHome();
}

// ================================================================
// END ROUND SCREEN
// ================================================================
async function showEndRound() {
  // Snapshot setup fields into tournament state so next round can restore them
  try {
    const ts = _tournState();
    if (ts.active) {
      _saveTournState({
        ...ts,
        _lastScoring:  setup.scoring  ?? gameState?.format ?? ts._lastScoring ?? null,
        _lastCourseId: setup.courseId ?? gameState?.courseId ?? ts._lastCourseId ?? null,
        _lastTeeIdx:   setup.teeIdx   ?? ts._lastTeeIdx   ?? 0,
        _lastHoles:    setup.holes    ?? gameState?.holesCount ?? ts._lastHoles ?? 18,
      });
    }
  } catch {}

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

  // ── Round info panel ──────────────────────────────────────────
  const infoEl = document.getElementById('er-info');
  if (infoEl) {
    const dateStr = (() => {
      const d = setup.gameDate ?? gameState.gameDate;
      if (!d) return '';
      try { return new Date(d).toLocaleDateString(undefined, { weekday:'short', day:'numeric', month:'short', year:'numeric' }); }
      catch { return d; }
    })();
    const organiser = (() => {
      if (currentProfile) {
        const n = `${currentProfile.first_name ?? ''} ${currentProfile.last_name ?? ''}`.trim();
        if (n) return n;
      }
      return gameState.organiserName ?? '';
    })();
    const rows = [
      ['Course',    `${merged.courseName ?? '–'} · ${merged.teeName ?? ''} Tees`],
      ['Format',    fmtLabel(merged.format)],
      dateStr     ? ['Date',      dateStr]     : null,
      organiser   ? ['Organiser', organiser]   : null,
    ].filter(Boolean);
    infoEl.innerHTML = rows.map(([label, val]) =>
      `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:0.2rem 0;border-bottom:1px solid rgba(0,0,0,0.08);">
        <span style="font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted,#555);">${label}</span>
        <span style="font-size:0.85rem;font-weight:600;color:var(--text-dark,#1a1a1a);text-align:right;max-width:65%;">${val}</span>
      </div>`
    ).join('');
    infoEl.style.display = '';
  }

  // ── Player handicap panel ─────────────────────────────────────
  const playersEl = document.getElementById('er-players');
  if (playersEl) {
    const names   = merged.names ?? [];
    const phcps   = merged.playingHandicaps ?? [];
    const mhcps   = merged.matchHandicaps   ?? [];
    const hidxs   = merged.handicapIndexes  ?? [];
    const isMatchFmt = ['match','betterball','csm','split6','skins','itc','foursomes','greensomes','texas'].includes(merged.format);

    // For match formats: find scratch player (lowest matchHandicap = 0)
    const scratchIdx = isMatchFmt ? mhcps.indexOf(Math.min(...mhcps)) : -1;

    const rows = names.map((name, i) => {
      const idx      = hidxs[i] != null ? Number(hidxs[i]).toFixed(1) : '–';
      const crsHcp   = phcps[i] != null ? phcps[i] : '–';
      const matchHcp = mhcps[i];

      let matchCell = '';
      if (isMatchFmt && matchHcp != null) {
        if (i === scratchIdx) {
          matchCell = `<span style="font-size:0.82rem;font-weight:600;color:#1a1a1a;">SCRATCH</span>`;
        } else {
          matchCell = `<span style="font-size:0.82rem;font-weight:600;color:#1a1a1a;">+${matchHcp} shots</span>`;
        }
      }

      return `<div style="display:flex;align-items:center;gap:0.5rem;padding:0.55rem 0.75rem;border-bottom:1px solid rgba(0,0,0,0.08);">
        <span style="width:0.55rem;height:0.55rem;border-radius:50%;background:${pHex(i)};flex-shrink:0;"></span>
        <span style="flex:1;font-size:0.9rem;font-weight:700;color:#1a1a1a;">${name}</span>
        <span style="font-size:0.75rem;color:#555;white-space:nowrap;">Idx <b>${idx}</b></span>
        <span style="font-size:0.75rem;color:#555;white-space:nowrap;">Crs <b>${crsHcp}</b></span>
        ${matchCell ? `<span style="flex-shrink:0;">${matchCell}</span>` : ''}
      </div>`;
    }).join('');

    playersEl.innerHTML = rows
      ? `<div style="border:1px solid rgba(0,0,0,0.12);border-radius:12px;overflow:hidden;margin-bottom:1rem;">
           <div style="padding:0.4rem 0.75rem;background:rgba(0,0,0,0.04);font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:#555;">Players &amp; Handicaps</div>
           ${rows}
         </div>`
      : '';
  }

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

  // Clear highlights (removed)
  const highlightsEl = document.getElementById('er-highlights');
  if (highlightsEl) highlightsEl.innerHTML = '';

  // Wire push-scores button on end-round screen
  const pushEndBtn = document.getElementById('btn-push-scores-end');
  const code = (() => {
    try {
      if (gameState?.gameCode) return gameState.gameCode;
      const stored = localStorage.getItem('lb-game-code');
      if (stored) return stored;
      // Tournament fallback — code lives in tournament state even after round save
      const ts = _tournState();
      if (ts.active && ts.code && ts.code !== '__error__') return ts.code;
      return null;
    } catch { return null; }
  })();
  if (pushEndBtn) {
    pushEndBtn.onclick = () => pushScoresToCloud(pushEndBtn);
    pushEndBtn.style.display = code ? '' : 'none';
  }
  // Wire edit-scorecard button
  const editScEnd = document.getElementById('btn-edit-sc-end');
  if (editScEnd && !editScEnd._wired) {
    editScEnd._wired = true;
    editScEnd.addEventListener('click', () => {
      renderScorecardOverlay();
      document.getElementById('scorecard-overlay')?.classList.add('open');
    });
  }

  document.getElementById('er-scorecard').innerHTML = buildEndRoundScorecard(merged);

  const shareBtn = document.getElementById('er-share-btn');
  if (shareBtn) {
    const shareUrl  = `${location.origin}/view?r=${roundId}`;
    const titleStr  = `${merged.courseName ?? 'Golf'} · ${fmtLabel(merged.format)}`;
    shareBtn.onclick = async () => {
      // Show two options: image or link
      const choice = await showShareOptions();
      if (choice === 'image') {
        await shareScorecardImage(merged, titleStr);
      } else if (choice === 'link') {
        if (navigator.share) {
          try { await navigator.share({ title: titleStr, url: shareUrl }); } catch {}
        } else {
          await navigator.clipboard.writeText(shareUrl);
          shareBtn.textContent = '✅ Link copied!';
          setTimeout(() => { shareBtn.innerHTML = '🔗 Share Scorecard'; }, 2000);
        }
      }
    };
    shareBtn.style.display = 'block';
  }
}

document.getElementById('btn-back-to-game')?.addEventListener('click', () => {
  showScreen('screen-game'); renderScoreHeader(); renderHolePanel();
});

// ================================================================
// GROUP RESULT EXPORT / COMBINE
// ================================================================

function buildGroupExportCode(state) {
  // Strip to essentials needed for leaderboard rendering
  const { allGroupStates: _, ...s } = state;
  const payload = {
    v: 1,
    format:           s.format,
    courseName:       s.courseName    ?? '',
    teeName:          s.teeName       ?? '',
    names:            s.names         ?? [],
    playingHandicaps: s.playingHandicaps ?? [],
    matchHandicaps:   s.matchHandicaps   ?? [],
    totals:           s.totals           ?? [],
    par:              s.par              ?? [],
    si:               s.si               ?? [],
    holeOffset:       s.holeOffset       ?? 0,
    numHoles:         s.numHoles         ?? 18,
    groupNumber:      s.groupNumber      ?? 1,
    log: (s.log ?? []).map(e => ({
      grosses:  e.grosses  ?? [],
      extras:   e.extras   ?? [],
      holePts:  e.holePts  ?? [],
      result:   e.result   ?? null,
    })),
  };
  const json   = JSON.stringify(payload);
  const b64url = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return b64url;
}

function decodeGroupExportCode(raw) {
  try {
    const trimmed = (raw || '').trim();
    const b64 = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    const pad  = (4 - (b64.length % 4)) % 4;
    const obj  = JSON.parse(atob(b64 + '='.repeat(pad)));
    if (obj.v !== 1 || !obj.format || !obj.names?.length) return null;
    return obj;
  } catch { return null; }
}

// Export button on end-round screen
document.getElementById('btn-export-group-result')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-export-group-result');
  try {
    const code = buildGroupExportCode(gameState);
    await navigator.clipboard.writeText(code);
    btn.textContent = '✅ Code copied! Paste it on the organiser\'s device.';
    setTimeout(() => { btn.textContent = '📤 Export group result'; }, 3000);
  } catch {
    const code = buildGroupExportCode(gameState);
    prompt('Copy this result code:', code);
  }
});

// Combine results modal
// openCombineModal(organiserState, roundId, rounds) pre-loads the organiser's group
// and lets them paste in other groups' export codes.
let _combineRoundId  = null;
let _combineRounds   = null;
const _combineGroups = []; // mutable list of decoded group states

function _combineRenderGroups() {
  const listEl  = document.getElementById('combine-groups-list');
  const showBtn = document.getElementById('btn-combine-show');
  if (!listEl) return;
  if (!_combineGroups.length) {
    listEl.innerHTML = '<p style="font-size:0.8rem;opacity:0.5;margin:0;">No groups added yet.</p>';
    if (showBtn) showBtn.style.display = 'none';
    return;
  }
  listEl.innerHTML = _combineGroups.map((g, i) => {
    const isOrganiser = i === 0; // first entry is always the organiser's own group
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;
                  padding:0.5rem 0.6rem;border-radius:8px;background:rgba(255,255,255,0.06);
                  margin-bottom:0.35rem;font-size:0.85rem;">
        <span>${isOrganiser ? '📱 ' : ''}Group ${g.groupNumber} — ${(g.names ?? []).join(', ')}</span>
        ${isOrganiser ? '' : `<button onclick="_combineRemoveGroup(${i})"
          style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:1rem;padding:0 0.25rem;">✕</button>`}
      </div>`;
  }).join('');
  if (showBtn) showBtn.style.display = _combineGroups.length > 1 ? 'block' : 'none';
}

window._combineRemoveGroup = (i) => {
  _combineGroups.splice(i, 1);
  _combineRenderGroups();
  document.getElementById('combine-leaderboard').innerHTML = '';
};

function _combineAddCode(raw) {
  const group = decodeGroupExportCode(raw);
  if (!group) { alert('Could not read that code. Please copy it again from the other device.'); return; }
  const idx = _combineGroups.findIndex(g => g.groupNumber === group.groupNumber);
  if (idx >= 0) _combineGroups[idx] = group; else _combineGroups.push(group);
  _combineGroups.sort((a, b) => (a.groupNumber ?? 0) - (b.groupNumber ?? 0));
  const inp = document.getElementById('combine-paste-input');
  if (inp) inp.value = '';
  document.getElementById('combine-leaderboard').innerHTML = '';
  _combineRenderGroups();
}

function openCombineModal(organiserState, roundId, rounds) {
  // Reset
  _combineGroups.length = 0;
  _combineRoundId = roundId;
  _combineRounds  = rounds;
  document.getElementById('combine-leaderboard').innerHTML = '';

  // Pre-load organiser's own group(s)
  const ownGroups = organiserState.allGroupStates?.length > 1
    ? organiserState.allGroupStates
    : [{ ...organiserState, groupNumber: organiserState.groupNumber ?? 1 }];
  ownGroups.forEach(g => _combineGroups.push({ ...g, groupNumber: g.groupNumber ?? 1 }));
  _combineGroups.sort((a, b) => (a.groupNumber ?? 0) - (b.groupNumber ?? 0));

  _combineRenderGroups();
  document.getElementById('modal-combine-results')?.classList.add('open');
}

document.getElementById('btn-combine-add')?.addEventListener('click', () => {
  _combineAddCode(document.getElementById('combine-paste-input')?.value);
});
document.getElementById('combine-paste-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') _combineAddCode(e.target.value);
});

document.getElementById('btn-combine-show')?.addEventListener('click', async () => {
  const lbEl = document.getElementById('combine-leaderboard');
  if (!lbEl || _combineGroups.length < 2) return;

  // Ensure each group has totals — recompute from log if missing or all-zero
  const groupsWithTotals = _combineGroups.map(g => {
    const hasTotals = g.totals?.some(t => t != null && t !== 0);
    if (hasTotals) return g;
    // Recompute: sum holePts per player across all holes
    const n = (g.names ?? []).length;
    const totals = new Array(n).fill(0);
    (g.log ?? []).forEach(entry => {
      for (let pi = 0; pi < n; pi++) {
        const pts = entry.holePts?.[pi];
        if (pts != null) totals[pi] += pts;
      }
    });
    return { ...g, totals };
  });

  const merged  = mergeGroupStates(groupsWithTotals);
  const summary = getResultSummary(merged);
  const fmt     = merged.format;
  const scoreLabel = fmt === 'stroke' ? 'Net' : 'Pts';

  let html = `<div style="font-size:0.65rem;letter-spacing:0.12em;text-transform:uppercase;
                           color:var(--muted);font-weight:700;margin-bottom:0.75rem;">
                Combined — ${merged.courseName}
              </div>`;

  if (summary.scores?.length) {
    html += summary.scores.map((s, rank) => {
      const medals = ['🥇','🥈','🥉'];
      return `<div style="display:flex;align-items:center;justify-content:space-between;
                          padding:0.6rem 0.75rem;border-radius:10px;margin-bottom:0.35rem;
                          background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);">
        <div style="display:flex;align-items:center;gap:0.5rem;">
          <span style="font-size:1.1rem;">${medals[rank] ?? `${rank+1}.`}</span>
          <span style="font-weight:700;">${s.nm}</span>
        </div>
        <span style="font-weight:800;color:var(--accent,#b8963e);">${s.score} ${scoreLabel}</span>
      </div>`;
    }).join('');
  } else if (summary.winner) {
    html += `<div style="text-align:center;font-weight:800;color:var(--gold);font-size:1.1rem;padding:0.75rem 0;">
               🏆 ${summary.winner}
             </div>`;
  }

  // Save + Share buttons
  html += `
    <button id="btn-save-combined"
      style="width:100%;margin-top:0.75rem;padding:0.65rem;background:var(--accent,#b8963e);
             color:#fff;border:none;border-radius:10px;font-family:'Plus Jakarta Sans',sans-serif;
             font-size:0.9rem;font-weight:800;cursor:pointer;">
      💾 Save combined result
    </button>
    <button id="btn-share-combined"
      style="width:100%;margin-top:0.4rem;padding:0.65rem;background:var(--green,#48bb78);
             color:#fff;border:none;border-radius:10px;font-family:'Plus Jakarta Sans',sans-serif;
             font-size:0.9rem;font-weight:800;cursor:pointer;">
      📤 Share combined result
    </button>`;

  lbEl.innerHTML = html;

  // Save: write allGroupStates back to the round in IndexedDB
  document.getElementById('btn-save-combined')?.addEventListener('click', async () => {
    const saveBtn = document.getElementById('btn-save-combined');
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      const round = _combineRounds?.find(x => x.id === _combineRoundId);
      if (!round) throw new Error('Round not found');
      let state = round.game_state;
      if (typeof state === 'string') state = JSON.parse(state);
      // Embed combined groups into state
      const updatedState = {
        ...state,
        allGroupStates: _combineGroups.map(g => { const {allGroupStates:_, ...s} = g; return s; }),
        combinedGroups: _combineGroups.length,
      };
      await idbSave(_combineRoundId, updatedState, false);
      // Update in-memory rounds list so history refreshes correctly
      round.game_state = updatedState;
      saveBtn.textContent = '✅ Saved!';
      setTimeout(() => { saveBtn.disabled = false; saveBtn.textContent = '💾 Save combined result'; }, 2000);
    } catch (err) {
      saveBtn.disabled = false;
      alert('Could not save: ' + err.message);
    }
  });

  // Share as text
  document.getElementById('btn-share-combined')?.addEventListener('click', async () => {
    const text = summary.scores
      ? summary.scores.map((s, i) => `${i+1}. ${s.nm} — ${s.score} ${scoreLabel}`).join('\n')
      : summary.winner ?? 'Result';
    const shareText = `${fmtLabel(fmt)} · ${merged.courseName}\n\n${text}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Combined Leaderboard', text: shareText }); } catch {}
    } else {
      await navigator.clipboard.writeText(shareText);
      document.getElementById('btn-share-combined').textContent = '✅ Copied!';
    }
  });
});

document.getElementById('btn-modal-combine-close')?.addEventListener('click', () => {
  document.getElementById('modal-combine-results')?.classList.remove('open');
});
document.getElementById('modal-combine-results')?.addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
});

document.getElementById('btn-confirm-end')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-confirm-end');

  // Stage 3: If there is a pending save failure, warn before completing.
  // The golfer may have unconfirmed scores not yet safely stored.
  const statusEl = document.getElementById('game-save-status');
  if (statusEl && statusEl.dataset.state === 'error') {
    const proceed = confirm(
      '⚠️ Last save failed — some scores may not be safely stored.\n\n' +
      'Completing the round now may lose the most recent hole scores.\n\n' +
      'Tap Cancel to retry the save, or OK to complete anyway.'
    );
    if (!proceed) return;
  }

  btn.disabled = true; btn.textContent = 'Saving…';
  // Stop the background sync loop immediately so its in-flight IDB transaction
  // doesn't compete with roundComplete's write and cause a hang on iOS.
  stopSyncLoop();
  // Safety: re-enable button after 10s so the user is never permanently stuck
  const saveTimeout = setTimeout(() => {
    btn.disabled = false; btn.textContent = '✓ Save & Finish';
    alert('Save is taking longer than expected — please check your connection and try again.');
  }, 10000);
  try {
    if (!roundId) throw new Error('No active round ID — cannot save.');
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
    idbClear(roundId).catch(() => {});
    realtimeUnsubscribe(realtimeCh); realtimeCh = null;
    // Stage 1: clear lb-active-round now the round is durably completed
    try { localStorage.removeItem('lb-active-round'); } catch {}
    try { localStorage.removeItem('lb-game-state-cache'); } catch {}
    roundId = null;
    // Capture hub tournament context before clearing gameState
    const _hubCode  = gameState?._hubTournamentCode ?? setup?._hubTournamentCode ?? null;
    const _hubRound = gameState?._hubTournRound     ?? setup?._hubTournRound     ?? 1;
    console.log('[hub-end] _hubCode=', _hubCode, '_hubRound=', _hubRound,
      'gs._hubTournamentCode=', gameState?._hubTournamentCode,
      'setup._hubTournamentCode=', setup?._hubTournamentCode,
      'lb-game-code=', localStorage.getItem('lb-game-code'));
    // Auto-push scores for hub tournaments while gameState is still live.
    // Fire-and-forget — don't await; score push must not block the save flow.
    if (_hubCode) {
      const silentBtn = { textContent: '', style: {}, disabled: false };
      pushScoresToCloud(silentBtn)
        .then(() => console.log('[hub-end] pushScoresToCloud completed'))
        .catch(e  => console.error('[hub-end] pushScoresToCloud failed:', e));
    } else {
      console.warn('[hub-end] no _hubCode — will go to home instead of leaderboard');
    }
    const wasTournament = !!gameState.tournamentId;
    const tournId = gameState.tournamentId;
    gameState = null;
    // Clear game code so a new game never pushes scores to this completed game
    try { localStorage.removeItem('lb-game-code'); } catch {}
    // Clear the safety timeout BEFORE navigating away — showHome() can trigger
    // screen transitions that re-render DOM, and clearing afterwards risks the
    // timeout firing mid-navigation and showing a spurious alert.
    clearTimeout(saveTimeout);
    if (_hubCode) {
      // Hub tournament: go to tournament leaderboard instead of home
      showTournamentHubLeaderboard(_hubCode, _hubRound);
    } else {
      await showHome();
      // Prompt to back up after every completed round
      _promptBackup('Round saved! Back up your data to iCloud Drive or Google Drive?');
    }
  } catch (err) {
    clearTimeout(saveTimeout);
    alert('Could not save round: ' + err.message);
    btn.disabled = false; btn.textContent = '✓ Save & Finish';
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

// ================================================================
// SHARE OPTIONS MODAL
// ================================================================

function showShareOptions() {
  return new Promise(resolve => {
    // Remove any existing
    document.getElementById('_share-options-modal')?.remove();

    const modal = document.createElement('div');
    modal.id = '_share-options-modal';
    modal.style.cssText = `
      position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.55);
      display:flex;align-items:flex-end;justify-content:center;padding:0 0 env(safe-area-inset-bottom,0px);`;

    modal.innerHTML = `
      <div style="background:var(--bg);border-radius:16px 16px 0 0;width:100%;max-width:480px;
                  padding:1.25rem 1.25rem 1.5rem;">
        <div style="font-family:'Plus Jakarta Sans',sans-serif;font-size:1.1rem;font-weight:800;
                    color:var(--white);margin-bottom:1rem;letter-spacing:0.03em;">Share Scorecard</div>
        <button id="_share-img-btn" style="width:100%;padding:0.85rem;margin-bottom:0.5rem;
          font-family:'Plus Jakarta Sans',sans-serif;font-size:1rem;font-weight:800;
          background:var(--green);color:#fff;border:none;border-radius:10px;cursor:pointer;">
          📸 Share as Image (WhatsApp, Messages…)
        </button>
        <button id="_share-link-btn" style="width:100%;padding:0.85rem;margin-bottom:0.5rem;
          font-family:'Plus Jakarta Sans',sans-serif;font-size:1rem;font-weight:800;
          background:var(--surface2);color:var(--white);border:1px solid var(--border);
          border-radius:10px;cursor:pointer;">
          🔗 Share as Link
        </button>
        <button id="_share-cancel-btn" style="width:100%;padding:0.65rem;
          font-family:'Plus Jakarta Sans',sans-serif;font-size:0.9rem;font-weight:700;
          background:none;color:var(--muted);border:none;cursor:pointer;">
          Cancel
        </button>
      </div>`;

    document.body.appendChild(modal);

    const cleanup = (val) => { modal.remove(); resolve(val); };
    modal.addEventListener('click', e => { if (e.target === modal) cleanup(null); });
    document.getElementById('_share-img-btn')   .onclick = () => cleanup('image');
    document.getElementById('_share-link-btn')  .onclick = () => cleanup('link');
    document.getElementById('_share-cancel-btn').onclick = () => cleanup(null);
  });
}

// ================================================================
// SCORECARD IMAGE EXPORT
// ================================================================

async function shareScorecardImage(state, title) {
  try {
    const canvas = document.createElement('canvas');
    drawScorecardToCanvas(canvas, state, title);

    // Convert to blob
    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    const file = new File([blob], 'scorecard.png', { type: 'image/png' });

    // Try native share (iOS/Android) first
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({
        files: [file],
        title: title ?? 'Scorecard',
        text:  'Golf scorecard from Leaderboard',
      });
      return;
    }

    // Fallback: download the image
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = 'scorecard.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);

  } catch (err) {
    if (err.name !== 'AbortError') {
      alert('Could not share scorecard: ' + (err.message ?? err));
    }
  }
}

function drawScorecardToCanvas(canvas, state, title) {
  const rows    = buildScorecardRows(state);
  const fmt     = state.format;
  const names   = state.names ?? [];
  const par     = state.par   ?? [];
  const offset  = state.holeOffset ?? 0;
  const isPairs = ['foursomes','greensomes'].includes(fmt);
  const isMatch = ['match','betterball','csm','foursomes','greensomes'].includes(fmt);
  const isStableford = fmt === 'stableford';
  const isStroke     = fmt === 'stroke';

  const dispNames = isPairs
    ? [`${names[0]} & ${names[1]}`, `${names[2]??''} & ${names[3]??''}`]
    : names;

  // ── Layout constants ────────────────────────────────────────────
  const SCALE  = 2;   // retina
  const PAD    = 28;
  const ROW_H  = 36;
  const HERO_H = 90;
  const COL_HOLE  = 36;
  const COL_PAR   = 30;
  const COL_SI    = 30;
  const COL_SCORE = 48;
  const COL_PTS   = 38;
  const COL_MATCH = 60;
  const numPlayers = dispNames.length;

  // Calculate total width
  let colWidths = [COL_HOLE, COL_PAR, COL_SI];
  dispNames.forEach(() => {
    colWidths.push(COL_SCORE);
    if (isStableford) colWidths.push(COL_PTS);
    if (isStroke)     colWidths.push(COL_PTS);
  });
  if (isMatch) colWidths.push(COL_MATCH);

  const totalW = colWidths.reduce((a, b) => a + b, 0) + PAD * 2;
  const numHoles = rows.length;
  // Add subtotal rows for front/back
  const hasFrontBack = numHoles > 9;
  const extraRows    = hasFrontBack ? 2 : 0;
  const totalH = HERO_H + (numHoles + extraRows + 1) * ROW_H + PAD * 2;

  canvas.width  = totalW  * SCALE;
  canvas.height = totalH  * SCALE;
  canvas.style.width  = totalW  + 'px';
  canvas.style.height = totalH  + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);

  // ── Colours ──────────────────────────────────────────────────────
  const C = {
    bg:      '#f4f1eb',
    surface: '#edeae2',
    green:   '#1f4028',
    gold:    '#b8942a',
    blue:    '#5ba8d8',
    muted:   '#6b6560',
    dark:    '#1a1a1a',
    border:  '#ccc8be',
    red:     '#c0392b',
    white:   '#fff',
  };
  const playerColors = [C.gold, C.blue, '#7bc47b', '#e07b7b'];

  // ── Hero background ───────────────────────────────────────────────
  ctx.fillStyle = C.green;
  ctx.fillRect(0, 0, totalW, HERO_H);

  // Course + format title
  ctx.fillStyle = C.white;
  ctx.font      = 'bold 18px Barlow Condensed, Arial';
  ctx.fillText(title ?? (state.courseName ?? 'Scorecard'), PAD, 32);

  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font      = '12px Barlow Condensed, Arial';
  const metaStr = [
    state.teeName ? state.teeName + ' Tees' : '',
    fmtLabel(fmt),
    (state.log?.length ?? 0) + ' holes',
    state.weather ?? '',
  ].filter(Boolean).join(' · ').toUpperCase();
  ctx.fillText(metaStr, PAD, 52);

  // Player names in hero
  dispNames.forEach((nm, i) => {
    ctx.fillStyle = playerColors[i] ?? C.gold;
    ctx.font      = 'bold 14px Barlow Condensed, Arial';
    ctx.fillText(shortName(nm), PAD + i * 160, 76);
  });

  // ── Build column x positions ──────────────────────────────────────
  const colX = [];
  let cx = PAD;
  colWidths.forEach(w => { colX.push(cx); cx += w; });

  // ── Header row ────────────────────────────────────────────────────
  let y = HERO_H + PAD * 0.5;

  const drawRow = (rowData, isHeader, isSubtotal) => {
    // Row background
    if (isHeader) {
      ctx.fillStyle = C.surface;
      ctx.fillRect(0, y, totalW, ROW_H);
    } else if (isSubtotal) {
      ctx.fillStyle = '#e8e5dd';
      ctx.fillRect(0, y, totalW, ROW_H);
    }

    // Row border
    ctx.strokeStyle = C.border;
    ctx.lineWidth   = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y + ROW_H); ctx.lineTo(totalW, y + ROW_H);
    ctx.stroke();

    rowData.forEach((cell, ci) => {
      const x   = colX[ci];
      const w   = colWidths[ci];
      const txt = String(cell.text ?? '');
      ctx.fillStyle = cell.color ?? C.dark;
      ctx.font      = `${cell.bold ? 'bold' : 'normal'} ${cell.size ?? 13}px Barlow Condensed, Arial`;
      ctx.textAlign = cell.align ?? 'center';
      const tx = cell.align === 'left' ? x + 4 : cell.align === 'right' ? x + w - 4 : x + w / 2;
      ctx.fillText(txt, tx, y + ROW_H * 0.68);

      // Score decorations (birdie circle, bogey square etc)
      if (cell.relToPar != null && !isHeader && !isSubtotal && txt && txt !== '--') {
        const cx2 = x + w / 2, cy2 = y + ROW_H / 2, r = 12;
        ctx.strokeStyle = cell.relToPar <= -2 ? C.gold
          : cell.relToPar === -1 ? C.red
          : cell.relToPar === 1  ? C.blue
          : cell.relToPar >= 2   ? C.blue : 'transparent';
        ctx.lineWidth = cell.relToPar <= -2 ? 2 : 1.5;
        if (cell.relToPar <= -1) {
          ctx.beginPath(); ctx.arc(cx2, cy2, r, 0, Math.PI*2); ctx.stroke();
          if (cell.relToPar <= -2) {
            ctx.beginPath(); ctx.arc(cx2, cy2, r+3, 0, Math.PI*2); ctx.stroke();
          }
        } else if (cell.relToPar >= 1) {
          ctx.strokeRect(cx2-r, cy2-r, r*2, r*2);
          if (cell.relToPar >= 2) ctx.strokeRect(cx2-r-3, cy2-r-3, (r+3)*2, (r+3)*2);
        }
      }
    });

    ctx.textAlign = 'left'; // reset
    y += ROW_H;
  };

  // Header
  const headerCells = [
    { text: 'H',   color: C.muted, size: 11 },
    { text: 'Par', color: C.muted, size: 11 },
    { text: 'SI',  color: C.muted, size: 11 },
  ];
  dispNames.forEach((nm, i) => {
    headerCells.push({ text: nm.split(' ')[0].toUpperCase(), color: playerColors[i], bold: true, size: 12 });
    if (isStableford) headerCells.push({ text: 'Pts', color: playerColors[i], size: 11 });
    if (isStroke)     headerCells.push({ text: 'Net', color: playerColors[i], size: 11 });
  });
  if (isMatch) headerCells.push({ text: 'Match', color: C.muted, size: 11 });
  drawRow(headerCells, true, false);

  // Data rows
  let frontPts = new Array(numPlayers).fill(0);
  let backPts  = new Array(numPlayers).fill(0);
  let frontHas = false, backHas = false;
  let frontMatchStr = '', backMatchStr = '';

  rows.forEach((row, ri) => {
    const hNum = offset + ri + 1;

    // Front 9 subtotal
    if (hasFrontBack && ri === 9) {
      const subCells = [
        { text: 'Out', color: C.muted, bold: true, size: 12 },
        { text: frontPts.map((_, i) => par.slice(0,9).reduce((a,b)=>a+b,0)).join(''), color: C.muted, size: 11 },
        { text: '', color: C.muted, size: 11 },
      ];
      dispNames.forEach((_, i) => {
        subCells.push({ text: frontHas ? frontPts[i] : '', color: playerColors[i], bold: true, size: 13 });
        if (isStableford || isStroke) subCells.push({ text: '', size: 11 });
      });
      if (isMatch) subCells.push({ text: frontMatchStr, color: C.muted, size: 11 });
      drawRow(subCells, false, true);
    }

    const cells = [
      { text: hNum, color: C.muted, size: 12 },
      { text: row.par, color: C.muted, size: 12 },
      { text: row.si,  color: C.muted, size: 11 },
    ];

    row.players.forEach((p, pi) => {
      const gross  = p.gross ?? '';
      const relToPar = gross && row.par ? parseInt(gross) - row.par : null;
      cells.push({
        text: p.pickup ? `P.Up` : String(gross || '--'),
        color: p.won || p.isBest ? playerColors[pi] : C.dark,
        bold:  !!(p.won || p.isBest),
        size:  14,
        relToPar: p.pickup ? null : relToPar,
      });
      if (isStableford) cells.push({ text: p.pts ?? '', color: C.muted, size: 12 });
      if (isStroke)     cells.push({ text: p.net ?? '', color: C.muted, size: 12 });

      // Track totals
      const val = p.pts ?? p.gross ?? 0;
      if (ri < 9) { frontPts[pi] += (typeof val === 'number' ? val : 0); frontHas = true; }
      else        { backPts[pi]  += (typeof val === 'number' ? val : 0); backHas  = true; }
    });

    if (row.matchStr) {
      cells.push({ text: row.matchStr, color: C.muted, size: 12 });
      if (ri === 8) frontMatchStr = row.matchStr;
    }

    drawRow(cells, false, false);
  });

  // Back 9 subtotal + total
  if (hasFrontBack) {
    const backCells = [
      { text: 'In', color: C.muted, bold: true, size: 12 },
      { text: '', size: 11 }, { text: '', size: 11 },
    ];
    dispNames.forEach((_, i) => {
      backCells.push({ text: backHas ? backPts[i] : '', color: playerColors[i], bold: true, size: 13 });
      if (isStableford || isStroke) backCells.push({ text: '', size: 11 });
    });
    if (isMatch) backCells.push({ text: backMatchStr, color: C.muted, size: 11 });
    drawRow(backCells, false, true);
  }

  // Total row
  const totalCells = [
    { text: 'Total', color: C.dark, bold: true, size: 13 },
    { text: '', size: 11 }, { text: '', size: 11 },
  ];
  dispNames.forEach((_, i) => {
    const tot = frontPts[i] + backPts[i];
    totalCells.push({ text: tot || '', color: playerColors[i], bold: true, size: 15 });
    if (isStableford || isStroke) totalCells.push({ text: '', size: 11 });
  });
  if (isMatch) {
    const ms  = state.matchScore ?? 0;
    const up  = Math.abs(ms);
    const txt = ms === 0 ? 'A/S' : ms > 0
      ? `${dispNames[0].split(' ')[0]} ${up}up`
      : `${dispNames[1]?.split(' ')[0]} ${up}up`;
    totalCells.push({ text: txt, color: ms === 0 ? C.green : ms > 0 ? C.gold : C.blue, bold: true, size: 12 });
  }
  drawRow(totalCells, false, true);

  // ── Footer ────────────────────────────────────────────────────────
  ctx.fillStyle = 'rgba(45,92,58,0.08)';
  ctx.fillRect(0, y, totalW, PAD);
  ctx.fillStyle = C.muted;
  ctx.font = '10px Barlow Condensed, Arial';
  ctx.fillText('Generated by Leaderboard · ldrbd.app', PAD, y + 16);
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

  _profileTeeRows = []; // seed fresh from saved data
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

// Show / build the per-tee course handicap inputs for the selected home course
// Tee rows are user-chosen (not derived from course.tees). Persisted in _profileTeeRows session state.
let _profileTeeRows = []; // array of tee names currently shown in the profile editor

function renderCourseHandicapSection() {
  const section  = document.getElementById('prof-course-hcp-section');
  const teesWrap = document.getElementById('prof-course-hcp-tees');
  if (!section || !teesWrap) return;

  const courseId = document.getElementById('prof-course-select')?.value || null;
  const course   = courseId ? allCourses.find(c => c.id === courseId) : null;

  if (!course) {
    section.classList.add('hidden');
    teesWrap.innerHTML = '';
    _profileTeeRows = [];
    return;
  }

  section.classList.remove('hidden');

  const saved = currentProfile?.home_course_handicaps ?? {};

  // Seed _profileTeeRows on first load from saved data (only if empty / course changed)
  if (_profileTeeRows.length === 0) {
    const savedTees = Object.keys(saved);
    if (savedTees.length) {
      _profileTeeRows = savedTees;
    }
  }

  rebuildTeeRows(teesWrap, saved);
}

function rebuildTeeRows(teesWrap, saved) {
  if (!teesWrap) return;
  if (!saved) saved = currentProfile?.home_course_handicaps ?? {};

  if (_profileTeeRows.length === 0) {
    teesWrap.innerHTML = `<div style="color:var(--muted);font-size:0.85rem;padding:0.25rem 0;">
      Tap ＋ to add a tee colour</div>`;
    return;
  }

  teesWrap.innerHTML = _profileTeeRows.map((teeName, idx) => {
    const savedObj = saved[teeName];
    const savedVal = (typeof savedObj === 'object' && savedObj !== null)
      ? (savedObj.course ?? '')
      : (savedObj ?? '');
    const crsId = `prof-course-hcp-crs-${teeName.replace(/\s+/g,'-').toLowerCase()}`;
    return `
      <div style="display:grid;grid-template-columns:1fr auto auto;gap:0.4rem 0.5rem;align-items:center;">
        <input class="prof-course-hcp-tee-name" data-idx="${idx}"
               type="text" placeholder="Tee colour (e.g. Yellow)"
               value="${teeName}"
               style="padding:0.4rem 0.5rem;border-radius:6px;border:1px solid var(--border);
                      background:var(--surface2);color:var(--white);font-size:0.95rem;">
        <input id="${crsId}" data-tee="${teeName}" data-type="course" data-idx="${idx}"
               class="prof-course-hcp-input"
               type="number" step="1" min="0" max="54"
               placeholder="--"
               value="${savedVal}"
               style="text-align:center;padding:0.4rem;border-radius:6px;width:3.5rem;
                      border:1px solid var(--border);background:var(--surface2);
                      color:var(--white);font-size:0.95rem;">
        <button class="prof-tee-remove" data-idx="${idx}"
          style="width:2rem;height:2rem;border-radius:50%;border:none;cursor:pointer;
                 background:var(--surface2);color:var(--red);font-size:1rem;flex-shrink:0;">✕</button>
      </div>`;
  }).join('');

  // Sync tee name changes back to _profileTeeRows
  teesWrap.querySelectorAll('.prof-course-hcp-tee-name').forEach(inp => {
    inp.addEventListener('input', () => {
      const idx = parseInt(inp.dataset.idx);
      _profileTeeRows[idx] = inp.value;
      // also update data-tee on sibling input so save picks it up
      const row = inp.closest('div');
      const hcpInp = row?.querySelector('.prof-course-hcp-input');
      if (hcpInp) hcpInp.dataset.tee = inp.value;
    });
  });

  // Remove row buttons
  teesWrap.querySelectorAll('.prof-tee-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      _profileTeeRows.splice(idx, 1);
      const saved2 = currentProfile?.home_course_handicaps ?? {};
      rebuildTeeRows(teesWrap, saved2);
    });
  });
}

document.getElementById('prof-course-select')?.addEventListener('change', () => {
  _profileTeeRows = []; // reset when course changes so we seed from saved data
  renderCourseHandicapSection();
});

// Add tee row
document.getElementById('prof-add-tee-btn')?.addEventListener('click', () => {
  _profileTeeRows.push('');
  const teesWrap = document.getElementById('prof-course-hcp-tees');
  const saved = currentProfile?.home_course_handicaps ?? {};
  rebuildTeeRows(teesWrap, saved);
  // Focus the newly added name input
  const inputs = teesWrap?.querySelectorAll('.prof-course-hcp-tee-name');
  if (inputs?.length) inputs[inputs.length - 1].focus();
});

// All Courses button
document.getElementById('prof-all-courses-btn')?.addEventListener('click', () => {
  const modal   = document.getElementById('modal-all-courses');
  const listEl  = document.getElementById('all-courses-list');
  if (!modal || !listEl) return;

  if (!allCourses.length) {
    listEl.innerHTML = `<div style="padding:1.5rem;text-align:center;color:var(--muted);">
      No saved courses yet.</div>`;
  } else {
    listEl.innerHTML = allCourses.map(c => `
      <div style="padding:0.65rem 0.75rem;background:var(--surface);
                  border:1px solid var(--border);border-radius:10px;">
        <div style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:700;font-size:1rem;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${c.name}</div>
        ${c.tees?.length ? `<div style="font-size:0.75rem;color:var(--muted);margin-top:2px;">${c.tees.map(t=>t.name).join(' · ')}</div>` : ''}
        <div style="display:flex;gap:0.5rem;margin-top:0.5rem;">
          <button class="btn btn-ghost ac-edit" data-id="${c.id}"
            style="font-size:0.8rem;padding:0.3rem 0.7rem;flex:1;">✏️ Edit</button>
          <button class="btn btn-ghost ac-delete" data-id="${c.id}" data-name="${c.name}"
            style="font-size:0.8rem;padding:0.3rem 0.7rem;flex:1;color:var(--red);">🗑 Delete</button>
        </div>
      </div>`).join('');
  }

  modal.classList.add('open');

  listEl.querySelectorAll('.ac-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      modal.classList.remove('open');
      openCourseWizard(btn.dataset.id);
    });
  });

  listEl.querySelectorAll('.ac-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Delete "${btn.dataset.name}"? This cannot be undone.`)) return;
      try {
        await courseDelete(btn.dataset.id);
        allCourses = allCourses.filter(c => c.id !== btn.dataset.id);
        populateProfileCourseSelect();
        // Remove from home course if it was selected
        const sel = document.getElementById('prof-course-select');
        if (sel?.value === btn.dataset.id) {
          sel.value = '';
          renderCourseHandicapSection();
        }
        // Re-render the modal list
        document.getElementById('prof-all-courses-btn')?.click();
      } catch(err) {
        alert('Could not delete course: ' + err.message);
      }
    });
  });
});

document.getElementById('all-courses-close')?.addEventListener('click', () => {
  document.getElementById('modal-all-courses')?.classList.remove('open');
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
      // Only persist the tee rows currently shown (user-chosen tees, course HCP only)
      const result = {};
      document.querySelectorAll('.prof-course-hcp-input').forEach(input => {
        if (input.dataset.type !== 'course') return;
        // tee name comes from the sibling text input if available, else data-tee
        const row = input.closest('div');
        const nameInp = row?.querySelector('.prof-course-hcp-tee-name');
        const tee = (nameInp?.value.trim()) || input.dataset.tee;
        if (!tee) return;
        const v = parseFloat(input.value);
        if (!isNaN(v)) result[tee] = { course: v };
      });
      return result;
    })(),
  };
  // Require both first and last name
  if (!profile.first_name) {
    document.getElementById('prof-fname').focus();
    document.getElementById('prof-fname').style.borderColor = 'var(--red)';
    alert('Please enter your first name.');
    return;
  }
  if (!profile.last_name) {
    document.getElementById('prof-lname').focus();
    document.getElementById('prof-lname').style.borderColor = 'var(--red)';
    alert('Please enter your surname — this helps friends with the same first name be identified correctly in games.');
    return;
  }
  document.getElementById('prof-fname').style.borderColor = '';
  document.getElementById('prof-lname').style.borderColor = '';

  const btn = document.getElementById('btn-save-profile');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await profileSave(profile);
    currentProfile = { ...currentProfile, ...profile };
    const syncEl = document.getElementById('profile-sync-text');
    if (syncEl) syncEl.textContent = 'Saved ✓';
    setTimeout(() => { if (syncEl) syncEl.textContent = 'Synced'; }, 2000);
    btn.disabled = false;
    btn.textContent = '✓ PROFILE SAVED';
    btn.style.background = '#2d6a4f';
    setTimeout(() => {
      btn.textContent = 'SAVE PROFILE';
      btn.style.background = '';
    }, 2500);
  } catch (err) {
    alert('Could not save profile: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'SAVE PROFILE';
    btn.style.background = '';
  }
});

document.getElementById('btn-profile-home')?.addEventListener('click', () => showHome());

// ================================================================
// BACKUP / RESTORE
// ================================================================

// ── Shared backup helper — uses Web Share API (iCloud/GDrive sheet on iOS),
// or shows a desktop save dialog. Call from any user-gesture context.
async function shareBackupFile() {
  const json    = await exportBackup();
  const fname   = `leaderboard-backup.json`;
  const blob    = new Blob([json], { type: 'application/json' });
  const file    = new File([blob], fname, { type: 'application/json' });

  // ── iOS / Android: Web Share API with file — shows the native share sheet ──
  // Only use share API on touch/mobile devices (canShare is true on desktop Chrome but share does nothing useful)
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  if (isMobile && navigator.canShare && navigator.canShare({ files: [file] })) {
    await new Promise(resolve => {
      const tip = document.createElement('div');
      tip.style.cssText = `
        position:fixed;top:0;left:0;right:0;bottom:0;z-index:10000;
        background:rgba(0,0,0,0.72);display:flex;align-items:flex-end;
        justify-content:center;padding-bottom:2rem;`;
      tip.innerHTML = `
        <div style="background:#fff;border-radius:1rem;padding:1.25rem 1.5rem;
                    max-width:320px;width:90%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.4);">
          <div style="font-size:1.5rem;margin-bottom:0.5rem;">📁</div>
          <div style="font-weight:700;margin-bottom:0.4rem;color:#111;">Save to iCloud Drive</div>
          <div style="font-size:0.85rem;color:#444;line-height:1.5;margin-bottom:1rem;">
            In the sheet that appears, scroll down and tap<br>
            <strong style="color:#000;">"Save to Files"</strong> → choose
            <strong style="color:#000;">iCloud Drive</strong> or
            <strong style="color:#000;">Google Drive</strong>
          </div>
          <button id="_backup-tip-ok" style="background:#d4a843;color:#000;font-weight:700;
            border:none;border-radius:0.5rem;padding:0.65rem 2rem;font-size:0.95rem;cursor:pointer;width:100%;">
            OK, Got It →
          </button>
        </div>`;
      document.body.appendChild(tip);
      document.getElementById('_backup-tip-ok').addEventListener('click', () => {
        tip.remove();
        resolve();
      });
    });
    await navigator.share({ files: [file], title: 'Leaderboard Backup', text: 'Leaderboard backup' });
    return;
  }

  // ── Desktop: show a simple modal with download + optional save-picker ──
  await new Promise(resolve => {
    const modal = document.createElement('div');
    modal.style.cssText = `
      position:fixed;top:0;left:0;right:0;bottom:0;z-index:10000;
      background:rgba(0,0,0,0.72);display:flex;align-items:center;
      justify-content:center;padding:1rem;`;
    modal.innerHTML = `
      <div style="background:#fff;border-radius:1rem;padding:1.5rem;
                  max-width:340px;width:100%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.4);">
        <div style="font-size:1.5rem;margin-bottom:0.5rem;">💾</div>
        <div style="font-weight:700;font-size:1.05rem;margin-bottom:0.35rem;color:#111;">Save Backup</div>
        <div style="font-size:0.85rem;color:#555;margin-bottom:1.25rem;line-height:1.5;">
          Download <strong style="color:#111;">leaderboard-backup.json</strong> to your computer.
          Keep it somewhere safe — you can restore it at any time from this screen.
        </div>
        <button id="_bk-dl" style="background:#d4a843;color:#000;font-weight:700;
          border:none;border-radius:0.5rem;padding:0.7rem 1.5rem;font-size:0.95rem;
          cursor:pointer;width:100%;margin-bottom:0.6rem;">
          ⬇ Download to Desktop
        </button>
        <button id="_bk-cancel" style="background:none;border:none;color:#888;
          font-size:0.85rem;cursor:pointer;padding:0.3rem;">
          Cancel
        </button>
      </div>`;
    document.body.appendChild(modal);

    document.getElementById('_bk-dl').addEventListener('click', () => {
      const url = URL.createObjectURL(blob);
      const a   = document.createElement('a');
      a.href = url; a.download = fname;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
      modal.remove();
      resolve();
    });

    document.getElementById('_bk-cancel').addEventListener('click', () => {
      modal.remove();
      resolve();
    });

    modal.addEventListener('click', e => { if (e.target === modal) { modal.remove(); resolve(); } });
  });
}

// ── Backup prompt — shown after round complete and after course save ──
// Uses a non-blocking modal so it doesn't interrupt the app flow.
function _promptBackup(message) {
  // Don't stack prompts
  if (document.getElementById('modal-backup-prompt')) return;

  const modal = document.createElement('div');
  modal.id = 'modal-backup-prompt';
  modal.style.cssText = `
    position:fixed;bottom:0;left:0;right:0;z-index:9999;
    background:var(--surface,#1a2535);border-top:1px solid var(--gold-border,rgba(212,168,67,0.35));
    padding:1rem 1.25rem 1.5rem;display:flex;flex-direction:column;gap:0.6rem;
    animation:slideUp 0.25s ease;
  `;
  modal.innerHTML = `
    <style>@keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}</style>
    <div style="font-size:0.9rem;color:var(--text,#f0f4f8);line-height:1.4;">☁️ <strong>${message}</strong></div>
    <div style="display:flex;gap:0.5rem;">
      <button id="bkp-prompt-yes" class="btn btn-green" style="flex:1;">Back Up Now</button>
      <button id="bkp-prompt-no"  class="btn btn-ghost" style="flex:0 0 auto;padding:0.5rem 1rem;">Not Now</button>
    </div>`;
  document.body.appendChild(modal);

  const dismiss = () => modal.remove();
  document.getElementById('bkp-prompt-no').addEventListener('click', dismiss);
  document.getElementById('bkp-prompt-yes').addEventListener('click', async () => {
    dismiss();
    try { await shareBackupFile(); }
    catch (err) { if (err.name !== 'AbortError') alert('Backup failed: ' + (err.message ?? err)); }
  });
  // Auto-dismiss after 12 seconds if ignored
  setTimeout(dismiss, 12000);
}

// ── First-launch restore prompt ────────────────────────────────────
function _promptRestore() {
  if (document.getElementById('modal-restore-prompt')) return;
  const modal = document.createElement('div');
  modal.id = 'modal-restore-prompt';
  modal.style.cssText = `
    position:fixed;bottom:0;left:0;right:0;z-index:9999;
    background:var(--surface,#1a2535);border-top:1px solid var(--gold-border,rgba(212,168,67,0.35));
    padding:1rem 1.25rem 1.5rem;display:flex;flex-direction:column;gap:0.6rem;
    animation:slideUp 0.25s ease;
  `;
  modal.innerHTML = `
    <div style="font-size:0.9rem;color:var(--text,#f0f4f8);line-height:1.4;">
      ☁️ <strong>Restore from backup?</strong><br>
      <span style="font-size:0.82rem;color:var(--muted,#a0aec0);">No courses found. If you have a backup file in iCloud Drive or Google Drive, you can restore it now.</span>
    </div>
    <div style="display:flex;gap:0.5rem;">
      <button id="rstr-prompt-yes" class="btn btn-green" style="flex:1;">Restore Backup</button>
      <button id="rstr-prompt-no"  class="btn btn-ghost" style="flex:0 0 auto;padding:0.5rem 1rem;">Start Fresh</button>
    </div>`;
  document.body.appendChild(modal);

  const dismiss = () => modal.remove();
  document.getElementById('rstr-prompt-no').addEventListener('click', dismiss);
  document.getElementById('rstr-prompt-yes').addEventListener('click', () => {
    dismiss();
    document.getElementById('backup-import-file')?.click();
  });
}

document.getElementById('btn-backup-export')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-backup-export');
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
  try {
    await shareBackupFile();
  } catch (err) {
    // AbortError = user cancelled share sheet; NotAllowedError = browser blocked picker
    // In both cases just reset the button silently — no error dialog needed.
    if (err.name !== 'AbortError' && err.name !== 'NotAllowedError' && err.name !== 'SecurityError') {
      alert('Export failed: ' + (err.message ?? err));
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '☁️ Backup to Files'; }
  }
});

document.getElementById('btn-backup-import')?.addEventListener('click', () => {
  document.getElementById('backup-import-file')?.click();
});

// ── No-profile modal wiring ──────────────────────────────────────────
(function _wireNoProfileModal() {
  const modal      = document.getElementById('no-profile-modal');
  const choices    = document.getElementById('no-profile-choices');
  const createForm = document.getElementById('no-profile-create-form');
  if (!modal) return;

  // "Log into Profile" — trigger the existing backup file picker
  document.getElementById('btn-no-profile-login')?.addEventListener('click', () => {
    document.getElementById('backup-import-file')?.click();
    // Modal stays visible until the import actually succeeds (handled by importBackup flow)
  });

  // "Create New Profile" — show inline create form
  document.getElementById('btn-no-profile-create')?.addEventListener('click', () => {
    if (choices)    choices.style.display    = 'none';
    if (createForm) createForm.style.display = '';
    document.getElementById('noprof-fname')?.focus();
  });

  // Back arrow in create form
  document.getElementById('btn-noprof-back')?.addEventListener('click', () => {
    if (choices)    choices.style.display    = '';
    if (createForm) createForm.style.display = 'none';
  });

  // Save new profile
  document.getElementById('btn-noprof-save')?.addEventListener('click', async () => {
    const fname = document.getElementById('noprof-fname')?.value.trim() ?? '';
    const lname = document.getElementById('noprof-lname')?.value.trim() ?? '';
    const hcpRaw = document.getElementById('noprof-hcp')?.value ?? '';
    const hcp   = hcpRaw !== '' ? parseFloat(hcpRaw) : null;

    const fnameEl = document.getElementById('noprof-fname');
    const lnameEl = document.getElementById('noprof-lname');

    if (!fname) {
      if (fnameEl) { fnameEl.style.borderColor = 'var(--red)'; fnameEl.focus(); }
      return;
    }
    if (!lname) {
      if (lnameEl) { lnameEl.style.borderColor = 'var(--red)'; lnameEl.focus(); }
      return;
    }
    if (fnameEl) fnameEl.style.borderColor = '';
    if (lnameEl) lnameEl.style.borderColor = '';

    const btn = document.getElementById('btn-noprof-save');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    try {
      const profile = {
        id:         currentUser?.id,
        first_name: fname,
        last_name:  lname,
        hcp:        !isNaN(hcp) ? hcp : null,
        email:      currentUser?.email ?? null,
      };
      await profileSave(profile);
      currentProfile = { ...(currentProfile ?? {}), ...profile };
      // Dismiss modal and refresh home
      modal.style.display = 'none';
      // Reset form for next time
      if (fnameEl) fnameEl.value = '';
      if (lnameEl) lnameEl.value = '';
      const hcpEl = document.getElementById('noprof-hcp');
      if (hcpEl) hcpEl.value = '';
      if (choices)    choices.style.display    = '';
      if (createForm) createForm.style.display = 'none';
      // Refresh home hero with the new name
      await showHome();
    } catch (err) {
      alert('Could not save profile: ' + (err.message ?? err));
      if (btn) { btn.disabled = false; btn.textContent = 'Save Profile'; }
    }
  });
})();

document.getElementById('backup-import-file')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  e.target.value = ''; // reset so same file can be re-selected

  let json;
  try { json = await file.text(); }
  catch { alert('Could not read file.'); return; }

  // Parse and show summary before confirming
  let backup;
  try { backup = JSON.parse(json); }
  catch { alert('The selected file is not a valid backup (not valid JSON).'); return; }

  const exportDate = backup.exportedAt
    ? new Date(backup.exportedAt).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })
    : 'unknown date';
  const playerCount = backup.players?.length ?? 0;
  const courseCount = backup.courses?.length ?? 0;
  const roundCount  = backup.rounds?.length  ?? 0;

  // Stage 3: Check for any recoverable active rounds before allowing restore.
  // importBackup() itself guards the rounds store, but we also check active_rounds IDB
  // so an IDB-only orphan doesn't silently survive (or confuse recovery after restore).
  let activeWarning = '';
  try {
    const recoverableRounds = currentUser?.id
      ? await _collectRecoverableRounds(currentUser.id).catch(() => [])
      : [];
    if (recoverableRounds.length > 0) {
      const names = recoverableRounds
        .map(r => r.course_name ?? r.game_state?.courseName ?? r.id)
        .join(', ');
      activeWarning = `\n\n⛔ WARNING: ${recoverableRounds.length} unfinished round(s) detected (${names}).\nRestoring will permanently delete this recovery data.`;
    }
  } catch {}

  const confirmed = confirm(
    `Restore this backup?

` +
    `Backup date: ${exportDate}
` +
    `Players: ${playerCount}  |  Courses: ${courseCount}  |  Rounds: ${roundCount}

` +
    `⚠️ Your current players, courses, rounds and settings will be REPLACED by the contents of this backup.

` +
    `This cannot be undone. Continue?` + activeWarning
  );
  if (!confirmed) return;

  // If there are active rounds, importBackup() will throw — surface a clear message.
  const btn = document.getElementById('btn-backup-import');
  if (btn) { btn.disabled = true; btn.textContent = 'Restoring…'; }
  try {
    await importBackup(json);
    // Stage 3: Clear IDB recovery entries for any rounds that were just overwritten.
    // The rounds store was cleared by importBackup — remove any orphan active_rounds entries.
    try {
      const dirtyEntries = await idbGetDirty();
      await Promise.all((dirtyEntries ?? []).map(e => idbClear(e.roundId).catch(() => {})));
    } catch {}
    // Clear localStorage pointers that now point to non-existent rounds.
    try { localStorage.removeItem('lb-active-round'); } catch {}
    try { localStorage.removeItem('lb-game-state-cache'); } catch {}
    alert('Backup restored successfully. The app will now reload.');
    window.location.reload();
  } catch (err) {
    alert('Restore failed: ' + (err.message ?? err));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⬆️ Import Backup'; }
  }
});

document.getElementById('prof-add-course-btn')?.addEventListener('click', () => { cwiz.returnTo = 'profile'; openCourseWizard(null); });
document.getElementById('btn-theme-dark') ?.addEventListener('click', () => applyTheme('dark'));
document.getElementById('btn-theme-light')?.addEventListener('click', () => applyTheme('light'));

// ================================================================
// FRIENDS
// ================================================================
async function showFriends() {
  showScreen('screen-friends');
  setActiveBottomNav('nav-friends');
  // Always re-fetch so new guests appear immediately
  try { allFriends = await friendsLoad(currentUser.id); } catch {}
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
    listEl.innerHTML = '<div class="history-empty">No players yet — add one above.</div>';
    return;
  }
  listEl.innerHTML = allFriends.map(f => {
    const displayName = f.name || f.username || 'Unknown';
    const init = displayName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const details = [];
    if (f.hcp != null) details.push(`HCP ${fmtHandicap(f.hcp)}`);
    if (f.playCount > 0) details.push(`${f.playCount} round${f.playCount === 1 ? '' : 's'}`);
    if (f.email && (f.friends_see_email !== false)) details.push(f.email);
    if (f.username) details.unshift(`@${f.username}`);
    const friendId = f.is_guest ? (f.profileId || '') : (f.userId || '');
    return `
      <div class="friend-item" data-fid="${f.friendshipId}" data-gid="${f.is_guest ? (f.profileId || '') : ''}" data-is-guest="${f.is_guest ? '1' : '0'}">
        <div class="friend-avatar">${init}</div>
        <div class="friend-info">
          <div class="friend-name">${displayName}</div>
          <div class="friend-sub" style="line-height:1.5;">${details.join(' · ')}</div>
        </div>
        <div style="display:flex;align-items:center;gap:0.5rem;flex-shrink:0;">
          <button class="btn btn-ghost friend-edit-btn" style="font-size:1rem;padding:0.4rem 0.6rem;" title="Edit">✏️</button>
          <button class="btn btn-ghost friend-del-btn" style="font-size:1rem;padding:0.4rem 0.6rem;border-color:var(--red-border);color:var(--red);" title="Remove">🗑️</button>
        </div>
      </div>`;
  }).join('');

  listEl.querySelectorAll('.friend-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('[data-fid]');
      const gid = row.dataset.gid;
      const isGuest = row.dataset.isGuest === '1';
      const f = isGuest
        ? allFriends.find(x => x.profileId === gid)
        : allFriends.find(x => x.friendshipId === row.dataset.fid);
      if (!f) return;
      openEditGuestModal(f);
    });
  });

  listEl.querySelectorAll('.friend-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this player?')) return;
      const row = btn.closest('[data-fid]');
      const gid = row.dataset.gid;
      const fid = row.dataset.fid;
      if (gid) {
        await guestProfileDelete(currentUser.id, gid, fid);
      } else {
        await friendRemove(fid);
      }
      allFriends = await friendsLoad(currentUser.id);
      await renderFriendsList();
    });
  });
}

function openEditGuestModal(f) {
  // Re-use the New Player modal in edit mode — works for both guests and real friends
  const nameParts = (f.name || '').split(' ');
  document.getElementById('game-manual-first').value  = nameParts[0] ?? '';
  document.getElementById('game-manual-last').value   = nameParts.slice(1).join(' ') ?? '';
  document.getElementById('game-manual-hcp').value    = f.hcp != null ? f.hcp : '';
  document.getElementById('game-manual-email').value  = f.email ?? '';
  document.getElementById('game-manual-chcp').value   = '';
  document.getElementById('game-manual-phcp').value   = '';
  document.getElementById('game-manual-name').value   = f.name ?? '';

  // Save-to-favourites checkbox — hidden/locked in edit mode
  const saveGuestEl = document.getElementById('game-manual-save-guest');
  if (saveGuestEl) {
    const row = saveGuestEl.closest('label') || saveGuestEl.parentElement;
    row.style.display = 'none';
    saveGuestEl.checked = true;
    saveGuestEl.disabled = true;
  }

  // Populate course select
  const crsSelect = document.getElementById('game-manual-course-select');
  if (crsSelect) {
    crsSelect.innerHTML = '<option value="">— No home course —</option>' +
      (allCourses ?? []).map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    crsSelect.value = f.home_course_id ?? '';
  }
  // Do NOT call renderNewPlayerTeeTable() here — tee section is hidden in edit mode

  // Update modal title to "Edit Player"
  const titleEl = document.querySelector('#modal-add-game-player .modal-header div');
  if (titleEl) titleEl.textContent = 'Edit Player';

  // Hide tee section and email field — not relevant when editing a saved player
  const teeSectionEl = document.getElementById('game-manual-tee-section');
  if (teeSectionEl) { teeSectionEl.style.display = 'none'; teeSectionEl.classList.add('hidden'); }
  const emailFieldEl = document.getElementById('game-manual-email')?.closest('.field');
  if (emailFieldEl) emailFieldEl.style.display = 'none';

  // Mark modal as edit mode — guest vs real friend
  const modal = document.getElementById('modal-add-game-player');
  if (f.is_guest && f.profileId) {
    modal.dataset.editGuestId = f.profileId;
    delete modal.dataset.editRealFriendId;
  } else {
    modal.dataset.editRealFriendId = f.friendshipId || f.userId || '';
    delete modal.dataset.editGuestId;
  }
  modal.dataset.friendsMode = '1';
  delete modal.dataset.editIdx;
  modal.classList.add('open');
  document.getElementById('game-manual-first').focus();
}

document.getElementById('btn-search-friend')?.addEventListener('click', async () => {
  const query    = document.getElementById('friend-search-email').value.trim();
  const emptyEl  = document.getElementById('friend-search-empty');
  const resultEl = document.getElementById('friend-search-result');
  if (!query) return;
  hide('friend-search-result'); hide('friend-search-empty');
  // Friend search requires multi-user/Supabase — not available in local mode
  if (!MULTI_USER) {
    if (emptyEl) { emptyEl.textContent = 'Friend search is not available in local mode. Add players manually using the + button.'; emptyEl.style.display = 'block'; }
    return;
  }

  try {
    let user = null;
    if (query.startsWith('@') || !query.includes('@')) {
      user = await profileFindByUsername(query.replace(/^@/, '').toLowerCase());
    }
    if (!user && query.includes('@')) user = await profileFindByEmail(query);

    if (user && user.id !== currentUser.id) {
      // ── Existing user — send friend request ────────────────────
      const nameStr = user.share_name !== false
        ? `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim()
        : user.username ? `@${user.username}` : 'Player';
      const hcpStr = user.share_hcp !== false && user.hcp != null
        ? ` · HCP ${fmtHandicap(user.hcp)}` : '';
      document.getElementById('friend-found-name').textContent = nameStr + hcpStr;
      show('friend-search-result');
      const sendBtn = document.getElementById('btn-send-request');
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send Request';
      sendBtn.style.background = '';
      sendBtn.style.color = '';
      sendBtn.onclick = async () => {
        sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
        try {
          await friendRequestSend(currentUser.id, user.id);
          hide('friend-search-result');
          document.getElementById('friend-search-email').value = '';
          document.getElementById('friend-search-empty').textContent = '✓ Friend request sent!';
          show('friend-search-empty');
        } catch (err) {
          const isDupe = err?.code === '23505' || err?.message?.includes('duplicate') || err?.message?.includes('unique');
          document.getElementById('friend-search-empty').textContent = isDupe
            ? 'Already friends or request already sent.'
            : (err.message ?? 'Could not send request.');
          show('friend-search-empty');
          sendBtn.disabled = false; sendBtn.textContent = 'Send Request';
        }
      };

    } else if (query.includes('@')) {
      // ── Not found — offer to invite ────────────────────────────
      document.getElementById('friend-found-name').textContent =
        `${query} is not on Leaderboard yet`;
      show('friend-search-result');
      const sendBtn = document.getElementById('btn-send-request');
      sendBtn.disabled = false;
      sendBtn.textContent = '📧 Send Invite Email';
      sendBtn.style.background = 'var(--green)';
      sendBtn.style.color = '#fff';
      sendBtn.onclick = async () => {
        sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
        try {
          const myName = currentProfile
            ? `${currentProfile.first_name ?? ''} ${currentProfile.last_name ?? ''}`.trim()
            : 'A friend';
          const res = await fetch('/api/invite-friend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              inviterProfileId: currentUser.id,
              inviterName:      myName,
              recipientEmail:   query,
            }),
          });
          const json = await res.json();
          hide('friend-search-result');
          sendBtn.style.background = ''; sendBtn.style.color = '';
          document.getElementById('friend-search-email').value = '';
          document.getElementById('friend-search-empty').textContent = res.ok
            ? (json.status === 'existing_user'
                ? '✓ Friend request sent!'
                : `✓ Invite sent to ${query} — they'll get an email to join.`)
            : (json.error ?? 'Invite failed — please try again.');
          show('friend-search-empty');
        } catch (err) {
          document.getElementById('friend-search-empty').textContent = err.message ?? 'Invite failed.';
          show('friend-search-empty');
          sendBtn.disabled = false; sendBtn.textContent = '📧 Send Invite Email';
        }
      };

    } else {
      document.getElementById('friend-search-empty').textContent = 'No user found with that username.';
      show('friend-search-empty');
    }
  } catch (err) {
    document.getElementById('friend-search-empty').textContent = err.message ?? 'Search failed.';
    show('friend-search-empty');
  }
});

document.getElementById('friends-back')?.addEventListener('click', () => showHome());

// ----------------------------------------------------------------
// INVITE MODAL
// ----------------------------------------------------------------
const APP_URL = 'https://ldrbd.app';

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
      const dateStr = r.played_at ?? r.completed_at ?? r.started_at;
      const date = dateStr
        ? new Date(dateStr).toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short', year:'numeric' })
        : '--';
      let state = r.game_state;
      if (typeof state === 'string') { try { state = JSON.parse(state); } catch { state = null; } }
      const summary  = state ? getResultSummary(state) : null;
      const numGroups = state?.allGroupStates?.length ?? (state?.combinedGroups ?? 0);
      const multiGroup = numGroups > 1;
      const histCode = state?.gameCode ?? null;
      return `
        <div class="history-card" data-rid="${r.id}">
          <div class="history-card-icon">${multiGroup ? '👥' : '⛳'}</div>
          <div class="history-card-body">
            <div class="history-card-date">${date}${histCode ? ` <span style="font-size:0.68rem;font-weight:800;letter-spacing:0.08em;color:var(--gold,#d4a843);background:rgba(212,168,67,0.12);border:1px solid rgba(212,168,67,0.3);border-radius:0.25rem;padding:0.05rem 0.3rem;vertical-align:middle;">🏆 ${histCode}</span>` : ''}</div>
            <div class="history-card-title">${r.course_name ?? '--'}${multiGroup ? ` <span style="font-size:0.72rem;color:var(--accent,#b8963e);font-weight:700;">${numGroups} groups</span>` : ''}</div>
            <div class="history-card-winner">${fmtLabel(r.game_format)} · ${r.tee_name ?? ''} Tees${summary?.winner ? ` · 🏆 ${summary.winner}` : ''}</div>
          </div>
          <div class="history-card-chevron">›</div>
        </div>`;
    }).join('');
    listEl.querySelectorAll('.history-card').forEach(item => {
      const openRound = () => {
        try {
          showHistoryDetail(item.dataset.rid, filtered);
        } catch(err) {
          console.error('[history] showHistoryDetail failed:', err);
          alert('Could not open round: ' + (err.message ?? err));
        }
      };
      // touchstart for instant response on iOS
      item.addEventListener('touchstart', (e) => {
        e.currentTarget._touchMoved = false;
      }, { passive: true });
      item.addEventListener('touchmove', (e) => {
        e.currentTarget._touchMoved = true;
      }, { passive: true });
      item.addEventListener('touchend', (e) => {
        if (!e.currentTarget._touchMoved) {
          e.preventDefault();
          openRound();
        }
      }, { passive: false });
      item.addEventListener('click', (e) => {
        if (e.sourceCapabilities?.firesTouchEvents) return;
        openRound();
      });
    });
  } catch (err) { listEl.innerHTML = `<div class="history-empty">${err.message}</div>`; }
}

document.getElementById('history-format-select')?.addEventListener('change', e => {
  historyFilter = e.target.value;
  loadHistory();
});
document.getElementById('history-back')?.addEventListener('click', () => showHome());

function showHistoryDetail(rid, rounds) {
  const r = rounds.find(x => x.id === rid);
  if (!r) { console.error('[history] round not found for id:', rid); return; }

  let state = r.game_state;
  if (typeof state === 'string') {
    try { state = JSON.parse(state); } catch(e) { console.error('[history] parse failed:', e); state = null; }
  }
  console.log('[history] opening:', r.id, r.game_format, 'state:', typeof state, !!state?.log);


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
    const histGameCode = state.gameCode ?? null;
    document.getElementById('hd-result').innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1rem;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.3rem;">
          <div style="font-size:0.58rem;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted);">
            ${fmtLabel(r.game_format)} · ${r.tee_name ?? ''} Tees · ${merged.log?.length ?? 0} holes
          </div>
          ${histGameCode ? `<span style="font-family:var(--font-ui,'Plus Jakarta Sans',sans-serif);font-size:0.68rem;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:#fff;background:rgba(72,187,120,0.25);border:1px solid rgba(72,187,120,0.5);border-radius:0.3rem;padding:0.15rem 0.4rem;">${histGameCode}</span>` : ''}
        </div>
        <div style="font-family:'Plus Jakarta Sans',sans-serif;font-size:1.4rem;font-weight:700;color:var(--gold);">
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
            <span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:700;
                         font-size:0.95rem;color:var(--muted2);">Hole ${holeNum}</span>
          </div>
          ${res
            ? `<div style="text-align:right;">
                <span style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;font-size:1.05rem;">${res.playerName}</span>
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
      // Match-type pairs formats → hole-by-hole view (same as live leaderboard)
      if (isMatch) {
        const gs = allStates[0] ?? merged;
        lbEl.innerHTML = buildMatchLeaderboard(gs);
      } else {
        // Non-match pairs (best2, texas) — summary table
        const rows = allStates.filter(s => s?.names).map((s, i) => {
          const teamName  = s.teamName ?? `Team ${s.groupNumber ?? i + 1}`;
          const holesPlayed = s.log?.length ?? 0;
          let score;
          if (isTexas)      score = texasSbFmt ? (s.texasPts ?? 0) : (s.grossTotal ?? 0);
          else if (isBest2) score = s.groupTotal ?? 0;
          // Build per-player score breakdown for display
          const playerScores = (s.names ?? []).map((nm, pi) => {
            let playerScore;
            if (isTexas) {
              // Texas: no per-player score — show names only
              playerScore = null;
            } else if (isBest2) {
              // best2: sum of net scores per player across played holes
              let netSum = 0;
              (s.log ?? []).forEach(entry => {
                const gross = entry.grosses?.[pi];
                if (gross != null) {
                  const hcp   = s.playingHandicaps?.[pi] ?? 0;
                  const shots = indivStrokesOnHole(hcp, entry.si);
                  netSum += gross - shots;
                }
              });
              playerScore = holesPlayed > 0 ? netSum : null;
            }
            return { initials: toInitials(nm), score: playerScore };
          });
          return { rank: i + 1, label: teamName, sub: null, score, thru: holesPlayed, isLead: i === 0, playerScores };
        });
        const numRows = rows.filter(r => typeof r.score === 'number');
        const strRows = rows.filter(r => typeof r.score !== 'number');
        numRows.sort((a, b) => (isTexas && !texasSbFmt) ? a.score - b.score : b.score - a.score);
        const sorted = [...numRows, ...strRows].map((r, i) => ({ ...r, rank: i + 1, isLead: i === 0 }));
        lbEl.innerHTML = buildLeaderboardTable(sorted, scoreLabel);
      }
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
        const inModes = modes.includes(btn.dataset.mode);
        btn.style.display = inModes ? '' : 'none';
        if (!inModes) return;
        btn.onclick = () => {
          hdScMode = btn.dataset.mode;
          modeRow.querySelectorAll('.hd-sc-mode-btn').forEach(b => {
            if (!modes.includes(b.dataset.mode)) return;
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

  // ── Add group results button ───────────────────────────────────────
  const addGroupBtn = document.getElementById('btn-add-group-results');
  if (addGroupBtn && state) {
    addGroupBtn.onclick = () => openCombineModal(state, r.id, rounds);
  }

  // Live leaderboard button removed — live URL only available in Organiser Admin

  // ── Import All Group Scores button ────────────────────────────────
  const importBtn = document.getElementById('btn-import-group-scores');
  if (importBtn) {
    const importCode = state?.gameCode ?? null;
    if (importCode) {
      importBtn.style.display = '';
      importBtn.textContent = `📥 Import All Group Scores · ${importCode}`;
      importBtn.onclick = async () => {
        importBtn.disabled = true;
        importBtn.textContent = '⏳ Importing…';
        try {
          const WORKER = 'https://leaderboardsync.sw-77d.workers.dev';
          const resp = await fetch(`${WORKER}/scores/${importCode}`);
          if (!resp.ok) {
            const body = await resp.json().catch(() => ({}));
            throw new Error(body.error ?? `HTTP ${resp.status}`);
          }
          const data = await resp.json();
          const fetchedRounds = data.rounds ?? [];
          if (!fetchedRounds.length) {
            alert('No scores found online for this game code.');
            importBtn.disabled = false;
            importBtn.textContent = `📥 Import All Group Scores · ${importCode}`;
            return;
          }

          // Convert each worker round into a minimal game-state compatible object
          // worker round: { round, group, players: [{name, hcp, scores, nets, grossTotal, netTotal, pts, total}] }
          const isStroke = (state?.format ?? state?.scoring ?? '') === 'stroke';
          const newAllGroupStates = fetchedRounds.map((wr, gi) => {
            const players = wr.players ?? [];
            const names  = players.map(p => p.name);
            const hdcps  = players.map(p => p.hcp ?? 0);
            // Rebuild a minimal log from per-hole scores
            const holeCount = players[0]?.scores?.length ?? 0;
            const log = [];
            for (let h = 0; h < holeCount; h++) {
              const grosses = players.map(p => p.scores?.[h] ?? 0);
              const nets    = players.map((p, pi) => p.nets?.[h] ?? grosses[pi] ?? 0);
              log.push({ grosses, nets, holePts: players.map(() => 0) });
            }
            return {
              names,
              hdcps,
              log,
              groupNumber: gi + 1,
              format:  state?.format  ?? state?.scoring ?? '',
              scoring: state?.scoring ?? state?.format  ?? '',
              gameCode: importCode,
              _imported: true,
              _groupId: wr.group,
            };
          });

          // Merge into current state: update allGroupStates
          const updatedState = {
            ...(state ?? {}),
            allGroupStates: newAllGroupStates,
            gameCode: importCode,
          };

          // Save back via roundSaveState — preserves status, just updates game_state
          await roundSaveState(r.id, updatedState);

          // Re-fetch rounds and re-render detail
          const freshRounds = await roundsLoadHistory(currentUser?.id ?? null);
          importBtn.disabled = false;
          showHistoryDetail(r.id, freshRounds);
          alert(`✅ Imported ${newAllGroupStates.length} group(s) from online leaderboard.`);
        } catch (e) {
          console.error('[import-scores]', e);
          alert('Import failed: ' + (e.message ?? e));
          importBtn.disabled = false;
          importBtn.textContent = `📥 Import All Group Scores · ${importCode}`;
        }
      };
    } else {
      importBtn.style.display = 'none';
    }
  }

  const hShareBtn = document.getElementById('hd-share-btn');
  if (hShareBtn) {
    const shareUrl  = `${location.origin}/view?r=${r.id}`;
    const titleStr2 = `${r.course_name ?? 'Golf'} · ${fmtLabel(r.game_format)}`;
    hShareBtn.onclick = async () => {
      const choice = await showShareOptions();
      if (choice === 'image') {
        await shareScorecardImage(merged, titleStr2);
      } else if (choice === 'link') {
        if (navigator.share) {
          try { await navigator.share({ title: titleStr2, url: shareUrl }); } catch {}
        } else {
          await navigator.clipboard.writeText(shareUrl);
          hShareBtn.textContent = '✅ Copied!';
          setTimeout(() => { hShareBtn.textContent = '🔗 Share'; }, 2000);
        }
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
      cwiz.tees = (course.tees ?? []).map(t => ({
        name: t.name, color: t.color,
        courseRating: t.courseRating ?? null,
        slopeRating:  t.slopeRating  ?? null,
        yards:        t.yards        ?? Array(18).fill(null),
      }));
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

  // Ensure save button shows normal label (may have been changed by library-edit flow)
  const saveBtnNormal = document.getElementById('cwiz-save-btn');
  if (saveBtnNormal) saveBtnNormal.textContent = '✅ SAVE COURSE';
  cwiz.libraryEdit = false; cwiz.libraryId = null;

  renderCwizTeesList();
  document.getElementById('modal-course-wizard').classList.add('open');
  show('cwiz-phase-name'); hide('cwiz-phase-holes'); hide('cwiz-phase-review');
  updateCwizStartBtn();
}

// ── Open course wizard pre-populated from a Course Library entry (suggest-edit flow) ──
function _openCourseWizardFromLibrary(course, libraryId) {
  // Mark this as a library-edit so the save handler submits rather than stores locally
  cwiz.courseId    = null;          // no local ID yet
  cwiz.libraryEdit = true;
  cwiz.libraryId   = libraryId;
  cwiz.returnTo    = 'profile';     // return to profile after submit
  cwiz.name        = course.name ?? '';
  cwiz.location    = course.location ?? '';

  document.getElementById('cwiz-name').value     = cwiz.name;
  document.getElementById('cwiz-location').value = cwiz.location;
  document.getElementById('cwiz-title').textContent = '✏️ Suggest Edit';

  // Pre-populate tees from library course object
  cwiz.tees = (course.tees ?? []).map(t => ({
    name:         t.name  ?? '',
    color:        t.color ?? '#888888',
    courseRating: t.courseRating ?? null,
    slopeRating:  t.slopeRating  ?? null,
    yards:        t.yards        ?? Array(18).fill(null),
  }));

  // Pre-populate holes (par + SI per tee) from first tee's par array
  cwiz.holes = Array.from({ length: 18 }, (_, i) => {
    const si = {};
    (course.tees ?? []).forEach(t => { si[t.name] = (t.si ?? [])[i] ?? 1; });
    return { par: (course.tees?.[0]?.par ?? [])[i] ?? 4, si };
  });

  // Relabel save button for the suggest-edit context
  const saveBtn = document.getElementById('cwiz-save-btn');
  if (saveBtn) saveBtn.textContent = '📤 SUBMIT EDIT';

  renderCwizTeesList();
  document.getElementById('modal-course-wizard').classList.add('open');
  show('cwiz-phase-name'); hide('cwiz-phase-holes'); hide('cwiz-phase-review');
  updateCwizStartBtn();
}

function renderCwizTeesList() {
  const TEE_PALETTE = [
    { name:'Yellow', color:'#f5c518' },
    { name:'White',  color:'#e8e8e8' },
    { name:'Red',    color:'#e53e3e' },
    { name:'Blue',   color:'#4299e1' },
    { name:'Black',  color:'#2d3748' },
    { name:'Gold',   color:'#d4a843' },
    { name:'Green',  color:'#48bb78' },
    { name:'Orange', color:'#ed8936' },
    { name:'Purple', color:'#9f7aea' },
    { name:'Silver', color:'#a0aec0' },
  ];

  const listEl = document.getElementById('cwiz-tees-list');
  if (!cwiz.tees.length) {
    listEl.innerHTML = '<div style="font-size:0.72rem;color:var(--muted);">Add at least one tee box</div>'; return;
  }
  listEl.innerHTML = cwiz.tees.map((t, i) => `
    <div class="tee-block" style="margin-bottom:0.85rem;background:var(--surface2,#1a2535);border:1px solid var(--border,rgba(255,255,255,0.12));border-radius:0.6rem;padding:0.6rem 0.7rem;">
      <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;">
        <div style="width:16px;height:16px;border-radius:50%;background:${t.color};flex-shrink:0;border:2px solid rgba(255,255,255,0.3);"></div>
        <input type="text" value="${t.name}" data-name="${i}" placeholder="Tee name (e.g. Yellow, Red…)"
          style="flex:1;background:#fff;border:1px solid #ccc;border-radius:0.4rem;
                 padding:0.35rem 0.6rem;color:#111;font-size:0.9rem;">
        <button class="btn btn-ghost" style="font-size:0.72rem;padding:2px 8px;flex-shrink:0;" data-del="${i}">✕</button>
      </div>
      <div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;">
        <label style="flex:1;font-size:0.65rem;color:var(--muted);">Course Rating
          <input type="number" step="0.1" min="50" max="85" value="${t.courseRating ?? ''}" data-rating="${i}"
            placeholder="e.g. 71.2"
            style="display:block;width:100%;margin-top:2px;background:#fff;border:1px solid #ccc;border-radius:0.4rem;padding:0.3rem 0.5rem;color:#111;font-size:0.88rem;">
        </label>
        <label style="flex:1;font-size:0.65rem;color:var(--muted);">Slope Rating
          <input type="number" step="1" min="55" max="155" value="${t.slopeRating ?? ''}" data-slope="${i}"
            placeholder="e.g. 124"
            style="display:block;width:100%;margin-top:2px;background:#fff;border:1px solid #ccc;border-radius:0.4rem;padding:0.3rem 0.5rem;color:#111;font-size:0.88rem;">
        </label>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;" data-palette="${i}">
        ${TEE_PALETTE.map(p => `
          <button data-swatch="${i}" data-swcolor="${p.color}" data-swname="${p.name}" title="${p.name}"
            style="width:28px;height:28px;border-radius:50%;background:${p.color};border:3px solid ${t.color===p.color ? '#fff' : 'transparent'};cursor:pointer;flex-shrink:0;"></button>
        `).join('')}
      </div>
    </div>`).join('');

  listEl.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => { cwiz.tees.splice(parseInt(btn.dataset.del), 1); renderCwizTeesList(); updateCwizStartBtn(); });
  });
  listEl.querySelectorAll('[data-name]').forEach(inp => {
    inp.addEventListener('input', e => { cwiz.tees[parseInt(e.target.dataset.name)].name = e.target.value; updateCwizStartBtn(); });
  });
  listEl.querySelectorAll('[data-rating]').forEach(inp => {
    inp.addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      cwiz.tees[parseInt(e.target.dataset.rating)].courseRating = isNaN(v) ? null : v;
    });
  });
  listEl.querySelectorAll('[data-slope]').forEach(inp => {
    inp.addEventListener('input', e => {
      const v = parseInt(e.target.value, 10);
      cwiz.tees[parseInt(e.target.dataset.slope)].slopeRating = isNaN(v) ? null : v;
    });
  });
  listEl.querySelectorAll('[data-swatch]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.swatch);
      cwiz.tees[i].color = btn.dataset.swcolor;
      // Auto-fill name if still empty
      if (!cwiz.tees[i].name) cwiz.tees[i].name = btn.dataset.swname;
      renderCwizTeesList(); updateCwizStartBtn();
    });
  });
}

function updateCwizStartBtn() {
  const btn       = document.getElementById('cwiz-start-holes-btn');
  const name      = document.getElementById('cwiz-name')?.value.trim();
  const teesOk    = cwiz.tees.length > 0 && cwiz.tees.every(t => t.name.trim().length > 0);
  const disabled  = !name || !teesOk;
  if (btn) { btn.disabled = disabled; btn.style.opacity = disabled ? '0.4' : '1'; }
}

document.getElementById('cwiz-name')?.addEventListener('input', e => { cwiz.name = e.target.value.trim(); updateCwizStartBtn(); });
document.getElementById('cwiz-location')?.addEventListener('input', e => { cwiz.location = e.target.value.trim(); });

document.getElementById('cwiz-add-tee-btn')?.addEventListener('click', () => {
  // Pick a default colour that hasn't been used yet
  const defaultColors = ['#f5c518','#e8e8e8','#e53e3e','#4299e1','#2d3748','#d4a843','#a0aec0'];
  const usedColors    = new Set(cwiz.tees.map(t => t.color));
  const color         = defaultColors.find(c => !usedColors.has(c)) ?? '#a0aec0';
  cwiz.tees.push({ name: '', color });
  renderCwizTeesList(); updateCwizStartBtn();
  // Focus the new name input
  const inputs = document.querySelectorAll('#cwiz-tees-list [data-name]');
  inputs[inputs.length - 1]?.focus();
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

  const siSec = document.getElementById('cwiz-si-sections');
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
      <div style="font-family:'Plus Jakarta Sans',sans-serif;font-size:0.92rem;font-weight:700;">${cwiz.tees[0]?.name ? (cwiz.holes[i].si[cwiz.tees[0].name] ?? '?') : '?'}</div>
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
      name:         t.name,
      color:        t.color,
      courseRating: t.courseRating ?? null,
      slopeRating:  t.slopeRating  ?? null,
      yards:        t.yards        ?? Array(18).fill(null),
      si:           cwiz.holes.map(h => h.si[t.name] ?? 1),
      par:          cwiz.holes.map(h => h.par),
    }));
    if (cwiz.libraryEdit && cwiz.libraryId) {
      // Suggest-edit flow: save temporarily, submit as pending, then delete local copy
      const tmpId = await courseSave({
        id: undefined, name: cwiz.name, location: cwiz.location,
        tees, isDefault: false, createdBy: currentUser.id,
      });
      try {
        await courseSubmitToLibrary(tmpId, cwiz.libraryId);
      } finally {
        // Remove the temporary local copy regardless of submission outcome
        try { await courseDelete(tmpId); } catch (_) {}
        allCourses = await coursesLoadAll();
      }
      document.getElementById('modal-course-wizard').classList.remove('open');
      cwiz.libraryEdit = false; cwiz.libraryId = null;
      const toast = document.createElement('div');
      toast.textContent = '✅ Edit submitted for review — thanks!';
      toast.style.cssText = 'position:fixed;bottom:2rem;left:50%;transform:translateX(-50%);background:var(--green,#38a169);color:#fff;padding:0.7rem 1.3rem;border-radius:0.6rem;font-size:0.85rem;z-index:9999;pointer-events:none;';
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3500);
      return;
    }
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
    // Prompt to back up after adding a course — key moment for cross-device sync
    _promptBackup('Course saved! Back up now so it\'s available on your other devices?');
    // Offer to share to the library
    _promptShareToLibrary(savedId);
  } catch (err) { alert('Could not save course: ' + err.message); }
  finally { btn.disabled = false; btn.textContent = '✅ SAVE COURSE'; }
});

document.getElementById('cwiz-cancel')?.addEventListener('click', () => {
  document.getElementById('modal-course-wizard').classList.remove('open');
  // Reset any library-edit state so the button is clean for next open
  cwiz.libraryEdit = false; cwiz.libraryId = null;
  const saveBtn = document.getElementById('cwiz-save-btn');
  if (saveBtn) saveBtn.textContent = '✅ SAVE COURSE';
});

// ── Share-to-library prompt (shown after saving a user-created course) ──
function _promptShareToLibrary(courseId) {
  // Only show if navigator.onLine — gracefully skip offline
  if (!navigator.onLine) return;
  const course = allCourses.find(c => c.id === courseId);
  if (!course) return;
  if (course.sharedId) return; // already shared

  const el = document.getElementById('modal-share-library');
  if (!el) return;
  el.querySelector('#share-library-course-name').textContent = course.name;
  el.classList.add('open');

  const yesBtn = el.querySelector('#share-library-yes');
  const noBtn  = el.querySelector('#share-library-no');

  function cleanup() {
    yesBtn?.removeEventListener('click', onYes);
    noBtn?.removeEventListener('click', onNo);
  }
  async function onYes() {
    cleanup();
    yesBtn.disabled = true; yesBtn.textContent = 'Sharing…';
    try {
      await courseSubmitToLibrary(courseId);
      allCourses = await coursesLoadAll();
      el.classList.remove('open');
      const toast = document.createElement('div');
      toast.textContent = '✅ Course submitted for review — thanks!';
      toast.style.cssText = 'position:fixed;bottom:2rem;left:50%;transform:translateX(-50%);background:var(--green,#38a169);color:#fff;padding:0.7rem 1.3rem;border-radius:0.6rem;font-size:0.85rem;z-index:9999;pointer-events:none;';
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3500);
    } catch (e) {
      alert('Could not submit course: ' + e.message);
    } finally {
      yesBtn.disabled = false; yesBtn.textContent = 'Yes, share it';
    }
  }
  function onNo() { cleanup(); el.classList.remove('open'); }

  yesBtn?.addEventListener('click', onYes);
  noBtn?.addEventListener('click', onNo);
}

// ── Explore course library ────────────────────────────────────────────────
async function openExploreLibrary() {
  const modal = document.getElementById('modal-explore-library');
  if (!modal) return;
  modal.classList.add('open');
  _renderExploreResults([]);
  document.getElementById('explore-search-input').value = '';
  document.getElementById('explore-status').textContent = 'Loading…';
  await _searchLibrary('');
}

async function _searchLibrary(q) {
  const statusEl = document.getElementById('explore-status');
  const url      = SYNC_WORKER_URL + '/courses' + (q ? '?q=' + encodeURIComponent(q) : '');
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data    = await resp.json();
    const courses = data.courses ?? [];
    statusEl.textContent = courses.length ? '' : 'No courses found.';
    _renderExploreResults(courses);
  } catch (e) {
    statusEl.textContent = 'Could not load library — check your connection.';
    _renderExploreResults([]);
  }
}

function _renderExploreResults(courses) {
  const list = document.getElementById('explore-results-list');
  if (!list) return;
  if (!courses.length) { list.innerHTML = ''; return; }

  const localSharedIds = new Set(allCourses.map(c => c.sharedId).filter(Boolean));

  list.innerHTML = courses.map(c => {
    const added    = localSharedIds.has(c.id);
    const teeNames = (c.tees ?? []).map(t => t.name).join(' · ');
    const location = [c.location, c.town, c.country].filter(Boolean).join(', ');
    return `<div style="padding:0.65rem 0.75rem;background:var(--surface);
                        border:1px solid var(--border);border-radius:10px;">
      <div style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:700;font-size:1rem;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${c.name}</div>
      ${location ? `<div style="font-size:0.75rem;color:var(--muted);margin-top:2px;">${location}</div>` : ''}
      ${teeNames ? `<div style="font-size:0.75rem;color:var(--muted);margin-top:1px;">${teeNames}</div>` : ''}
      <div style="display:flex;gap:0.5rem;margin-top:0.5rem;">
        <button class="btn btn-ghost explore-add-btn" data-sid="${c.id}"
          style="font-size:0.8rem;padding:0.3rem 0.7rem;flex:1;
                 ${added ? 'opacity:0.5;' : 'background:var(--gold);color:#111;border-color:var(--gold);'}"
          ${added ? 'disabled' : ''}>
          ${added ? '✓ My Courses' : '＋ My Courses'}
        </button>
        <button class="btn btn-ghost explore-edit-btn" data-sid="${c.id}"
          style="font-size:0.8rem;padding:0.3rem 0.7rem;flex:1;">
          ✏️ Suggest Edit
        </button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.explore-add-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('click', async () => {
      const sid    = btn.dataset.sid;
      const course = courses.find(x => x.id === sid);
      if (!course) return;
      btn.disabled = true; btn.textContent = 'Adding…';
      try {
        await courseSave({
          name: course.name, location: course.location,
          town: course.town ?? null, country: course.country ?? null,
          tees: course.tees, isDefault: false,
          createdBy: currentUser?.id,
          sharedId: course.id, version: course.version ?? 1,
        });
        allCourses = await coursesLoadAll();
        btn.textContent = '✓ My Courses';
        btn.style.opacity = '0.5';
      } catch (e) {
        btn.disabled = false; btn.textContent = '＋ My Courses';
        alert('Could not add course: ' + e.message);
      }
    });
  });

  list.querySelectorAll('.explore-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const sid    = btn.dataset.sid;
      const course = courses.find(x => x.id === sid);
      if (!course) return;
      // Pre-populate the course wizard from the library course, flag for pending submission
      document.getElementById('modal-explore-library')?.classList.remove('open');
      _openCourseWizardFromLibrary(course, sid);
    });
  });
}

let _exploreSearchTimer = null;
document.getElementById('explore-search-input')?.addEventListener('input', e => {
  clearTimeout(_exploreSearchTimer);
  _exploreSearchTimer = setTimeout(() => _searchLibrary(e.target.value.trim()), 400);
});
document.getElementById('explore-library-btn')?.addEventListener('click', openExploreLibrary);
document.getElementById('explore-close-btn')?.addEventListener('click', () => {
  document.getElementById('modal-explore-library')?.classList.remove('open');
});

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
      <div style="font-family:'Plus Jakarta Sans',sans-serif;font-size:1.2rem;font-weight:700;color:var(--gold);margin-bottom:0.3rem;">${invite.inviter_name ?? 'Someone'} invited you</div>
      <div style="font-size:0.72rem;color:var(--muted);">${invite.course_name ?? ''} · ${fmtLabel(invite.game_format ?? '')}</div>
      ${troundId ? `<div style="font-size:0.72rem;color:var(--muted);margin-top:0.25rem;">Group ${groupNumber} scorer</div>` : ''}`;
    const user = await authGetUser();
    if (!user) {
      show('join-auth-prompt');
      document.getElementById('btn-join-auth').addEventListener('click', () => {
        sessionStorage.setItem('lb-join-token', token);
        if (troundId) sessionStorage.setItem('lb-join-tround', troundId);
        if (groupNumber) sessionStorage.setItem('lb-join-group', groupNumber);
        showScreen('screen-home');
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
// MOBILE PWA LIFECYCLE PROTECTION (Stage 1)
// ================================================================
// Primary persistence is the awaited idbSaveSeq() on each hole
// confirmation.  These handlers are a secondary safeguard only —
// iOS may kill the PWA before async operations complete, so they
// are not the primary mechanism.  We do a synchronous best-effort
// idbSaveSeq when the page is hidden / unloaded.

function _flushOnHide() {
  if (!roundId || !gameState) return;
  const snap = _buildStateToSave();
  if (!snap) return;
  const seq = _nextSeq();
  // idbSaveSeq returns a Promise; we cannot await it here but we still
  // start it — on most mobile browsers the IDB transaction will commit
  // even if the page is killed shortly after.
  idbSaveSeq(roundId, snap, seq).catch(() => {});
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) _flushOnHide();
});

window.addEventListener('pagehide', () => {
  _flushOnHide();
});

// ================================================================
// KICK OFF
// ================================================================
document.addEventListener('DOMContentLoaded', boot);

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
  // Snapshot CURRENT (pre-edit) totals for diff display
  const log           = gameState.log ?? [];
  const beforeTotals  = [...(gameState.totals    ?? [])];
  const beforeMatch   = gameState.matchScore     ?? 0;
  const beforeSkins   = [...(gameState.skins     ?? [])];
  const beforeRunning = [...(gameState.runningPts ?? [])];

  // Single authoritative edit path: editHole() → recalcState() → full rebuild from log
  let rebuiltState = editHole(gameState, holeIdx, newGrosses);

  // Preserve allGroupStates reference
  rebuiltState.allGroupStates = gameState.allGroupStates;
  rebuiltState.organiserId    = gameState.organiserId;

  // ── SCORECARD EDIT FAST PATH ──────────────────────────────────
  // When the edit originated from the Scorecard Edit overlay, apply immediately
  // without showing the diff modal. The user has already confirmed by adjusting
  // the spinners and pressing Confirm.
  if (_holeEditFromScorecard) {
    _holeEditFromScorecard = false; // reset for next use
    gameState = rebuiltState;
      await saveRoundState();
    renderGameTopBar();
    renderScoreHeader();
    renderHolePanel();
    document.getElementById('result-flash').innerHTML = '&nbsp;';
    // Re-render the Scorecard Edit overlay synchronously (no rAF)
    const amendEl = document.getElementById('amend-overlay');
    if (amendEl && amendEl.style.display !== 'none') {
      _renderAmendScorecard();
    }
    return;
  }

  // ── DIFF SUMMARY (normal live amend path) ──────────────────────
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

  // Save
  await saveRoundState();

  // Re-render game screen (header + hole panel so live scoring matches)
  renderGameTopBar();
  renderScoreHeader();
  renderHolePanel();
  document.getElementById('result-flash').innerHTML = '&nbsp;';

  // If the amend scorecard overlay is open, re-render it synchronously
  const amendOverlay = document.getElementById('amend-overlay');
  if (amendOverlay && amendOverlay.style.display !== 'none') {
    _renderAmendScorecard();
  }
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
// TOURNAMENT HUB  (Phase 4)
// ================================================================
// LocalStorage keys used here:
//   lb-tournaments          JSON array of { code, name, status, ... } — minimal hub-list cache
//   lb-organiser-secret-<CODE>  organiser secret for a tournament this device created
//   lb-round-state-<CODE>-<N>-<GID>  per-round-per-group state (used by start-round flow)
// IndexedDB: idbTournaments (tournaments store, v5)
// ================================================================

// ── Helpers ──────────────────────────────────────────────────────

/** SHA-256 hex of a string */
async function _sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Generate a 16-char random organiser secret */
function _genOrganiserSecret() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => chars[b % chars.length]).join('');
}

/** Worker fetch with optional organiser secret header */
async function _tournWorkerFetch(path, method = 'GET', body = null, organiserSecret = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (organiserSecret) headers['X-Organiser-Secret'] = organiserSecret;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(SYNC_WORKER_URL + path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

/** Load organiser secret for a code from localStorage */
function _getOrganiserSecret(code) {
  try { return localStorage.getItem(`lb-organiser-secret-${code}`) ?? null; } catch { return null; }
}

/** Persist all tournaments from IDB into the lightweight hub cache */
async function _flushTournamentCache() {
  try {
    const all = await idbTournaments.getAll();
    const slim = all.map(t => ({
      code: t.code, name: t.name, status: t.status,
      format: t.format, totalRounds: t.totalRounds, currentRound: t.currentRound,
      isOrganiser: t.isOrganiser, expiresAt: t.expiresAt,
    }));
    localStorage.setItem('lb-tournaments', JSON.stringify(slim));
  } catch {}
}

/** Read the hub-list cache, never throws */
function _readTournamentCache() {
  try { return JSON.parse(localStorage.getItem('lb-tournaments') ?? '[]'); } catch { return []; }
}

// Format label map for display
const TOURN_FORMAT_LABELS = {
  stableford: 'Stableford', strokeplay: 'Strokeplay',
  betterball: 'Better Ball', combined: 'Combined', best2: 'Best 2',
};
const TOURN_HCP_LABELS = {
  none: 'No Adjustment', manual: 'Manual', auto: 'Auto Adjust',
};

// ── Hub screen ───────────────────────────────────────────────────

async function showTournamentHub() {
  showScreen('screen-tournament-hub');
  // nav-tournament is hidden (moved to home screen tile); clear active state from all nav buttons
  setActiveBottomNav(null);
  await renderTournamentHub();
}

async function renderTournamentHub() {
  const listEl      = document.getElementById('hub-active-list');
  const emptyEl     = document.getElementById('hub-empty-state');
  const pastSection = document.getElementById('hub-past-section');
  if (!listEl) return;

  listEl.innerHTML = '<div style="padding:1rem;color:var(--text-muted);text-align:center;font-size:0.9rem;">Loading…</div>';

  try {
    // Merge IDB + cache: IDB is authoritative, cache fills gaps if IDB hasn't loaded yet
    let tourneys = await idbTournaments.getAll().catch(() => []);
    if (!tourneys.length) tourneys = _readTournamentCache();

    const now = Date.now();
    const active = tourneys.filter(t => t.status !== 'completed' && t.status !== 'expired' && (t.expiresAt ?? Infinity) > now);
    const past   = tourneys.filter(t => t.status === 'completed' || t.status === 'expired' || (t.expiresAt ?? Infinity) <= now);

    if (!active.length) {
      listEl.innerHTML = '';
      if (emptyEl) emptyEl.style.display = '';
    } else {
      if (emptyEl) emptyEl.style.display = 'none';
      listEl.innerHTML = active.map(t => _renderHubCard(t)).join('');
      listEl.querySelectorAll('[data-tourn-code]').forEach(card => {
        card.addEventListener('click', () => showTournamentDetail(card.dataset.tournCode));
      });
    }

    if (pastSection) {
      if (past.length) {
        pastSection.style.display = '';
        const pastList = document.getElementById('hub-past-list');
        if (pastList) {
          pastList.innerHTML = past.map(t => _renderHubCard(t, true)).join('');
          pastList.querySelectorAll('[data-tourn-code]').forEach(card => {
            card.addEventListener('click', () => showTournamentDetail(card.dataset.tournCode));
          });
        }
      } else {
        pastSection.style.display = 'none';
      }
    }
  } catch (err) {
    listEl.innerHTML = `<div style="padding:1rem;color:var(--danger);font-size:0.85rem;">Could not load tournaments: ${err.message}</div>`;
  }
}

function _renderHubCard(t, past = false) {
  const fmt   = TOURN_FORMAT_LABELS[t.format] ?? t.format ?? '—';
  const round = t.currentRound ?? 1;
  const total = t.totalRounds ?? '?';
  const badge = t.isOrganiser ? '<span style="font-size:0.7rem;font-weight:800;background:rgba(212,168,67,0.18);color:var(--gold);border:1px solid var(--gold-border);border-radius:4px;padding:0.1em 0.4em;vertical-align:middle;margin-left:0.4rem;">ORG</span>' : '';
  const statusLabel = past
    ? `<span style="color:var(--text-muted);font-size:0.78rem;">Completed</span>`
    : `<span style="color:var(--gold);font-size:0.78rem;font-weight:700;">Round ${round} of ${total}</span>`;
  return `
    <div class="card" data-tourn-code="${t.code}" style="cursor:pointer;margin-bottom:0.5rem;
         padding:0.85rem 1rem;border:1px solid var(--border);">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:0.5rem;">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:800;font-size:1rem;margin-bottom:0.2rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            ${_esc(t.name ?? 'Tournament')}${badge}
          </div>
          <div style="font-size:0.82rem;color:var(--text-muted);">${fmt} · ${statusLabel}</div>
        </div>
        <div style="font-family:monospace;font-size:0.82rem;font-weight:800;letter-spacing:0.1em;
                    color:var(--gold);flex-shrink:0;margin-top:0.2rem;">${t.code}</div>
      </div>
    </div>`;
}

function _esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Hub action buttons
document.getElementById('btn-new-tournament')?.addEventListener('click', () => showTournamentNew());
document.getElementById('btn-join-tournament')?.addEventListener('click', () => showTournamentJoin());
document.getElementById('btn-tournament-history')?.addEventListener('click', () => {
  // For now shows the past section; later can have a dedicated screen
  const pastEl = document.getElementById('hub-past-section');
  if (pastEl) pastEl.scrollIntoView({ behavior: 'smooth' });
});

// ── New Tournament Wizard ────────────────────────────────────────

// State held for the duration of the wizard
let _wiz = {};

function showTournamentNew() {
  // Auto-add the organiser (currentProfile) as first player
  const orgName = currentProfile
    ? `${currentProfile.first_name ?? ''} ${currentProfile.last_name ?? ''}`.trim()
    : '';
  const orgHcp  = currentProfile?.hcp ?? 0;
  const initialPlayers = orgName
    ? [{ friendId: currentProfile?.id ?? 'organiser', name: orgName, hcpIndex: orgHcp, isOrganiser: true }]
    : [];

  _wiz = {
    step: 1,
    name: '',
    duration: '3m',
    totalRounds: 3,
    format: 'stableford',
    hcpMode: 'none',
    hcpStrength: 3,
    pairHcpMode: 'shared',      // for betterball/csm: 'shared' | 'individual'
    pairs: null,                // for team formats: [[playerIdx, playerIdx|null], ...]
    courseMode: 'same',
    courseId: null,             // for same-course
    courseIds: [],              // per-round [{ roundNum, courseId }]
    players: initialPlayers,   // [{ friendId, name, hcpIndex }]
  };

  // Reset rounds stepper display
  const dispEl = document.getElementById('tourn-rounds-display');
  const hidEl  = document.getElementById('tourn-num-rounds');
  if (dispEl) dispEl.textContent = '3';
  if (hidEl)  hidEl.value = '3';

  _wizGoStep(1);
  showScreen('screen-tournament-new');
}

// Rounds +/- stepper
document.getElementById('btn-rounds-dec')?.addEventListener('click', () => {
  const hidEl  = document.getElementById('tourn-num-rounds');
  const dispEl = document.getElementById('tourn-rounds-display');
  const cur = parseInt(hidEl?.value ?? '3');
  const next = Math.max(1, cur - 1);
  if (hidEl)  hidEl.value = next;
  if (dispEl) dispEl.textContent = next;
});
document.getElementById('btn-rounds-inc')?.addEventListener('click', () => {
  const hidEl  = document.getElementById('tourn-num-rounds');
  const dispEl = document.getElementById('tourn-rounds-display');
  const cur = parseInt(hidEl?.value ?? '3');
  const next = Math.min(52, cur + 1);
  if (hidEl)  hidEl.value = next;
  if (dispEl) dispEl.textContent = next;
});

function _wizGoStep(step) {
  _wiz.step = step;
  document.querySelectorAll('.wizard-panel').forEach(p => p.style.display = 'none');
  const panel = document.getElementById(`wizard-step-${step}`);
  if (panel) panel.style.display = '';
  document.querySelectorAll('.wizard-step').forEach(el => {
    const n = parseInt(el.dataset.step);
    el.classList.toggle('active', n === step);
    el.classList.toggle('done', n < step);
  });
  // When entering step 2 refresh panel visibility
  if (step === 2) {
    _wizUpdatePairHcpPanel();
    // Update the selected format indicator to match current state
    const indEl = document.getElementById('wiz-fmt-selected');
    if (indEl && _wiz.format) {
      const _TOURN_FMT_LABELS_LOCAL = {
        stableford:'⭐ Stableford', strokeplay:'✏️ Stroke Play',
        betterball:'🤝 Better Ball', csm:'➕ Combined',
        foursomes:'🔄 Foursomes', greensomes:'🌿 Greensomes',
        scramble:'🎯 Scramble (Pair)', best2:'🏅 Best 2', groupscramble:'🎯 Group Scramble',
      };
      indEl.textContent = 'Selected: ' + (_TOURN_FMT_LABELS_LOCAL[_wiz.format] ?? _wiz.format);
      indEl.style.display = '';
    }
  }
}

// Back button
document.getElementById('tournament-new-back')?.addEventListener('click', () => {
  if (_wiz.step > 1) _wizGoStep(_wiz.step - 1);
  else showTournamentHub();
});

// ── Step 1 wiring ──

// Duration buttons
document.getElementById('tourn-duration-btns')?.querySelectorAll('[data-dur]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById('tourn-duration-btns').querySelectorAll('[data-dur]')
      .forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tourn-duration').value = btn.dataset.dur;
    _wiz.duration = btn.dataset.dur;
  });
});

document.getElementById('btn-wizard-1-next')?.addEventListener('click', () => {
  const name = (document.getElementById('tourn-name')?.value ?? '').trim();
  if (!name) { alert('Please enter a tournament name.'); return; }
  _wiz.name        = name;
  _wiz.duration    = document.getElementById('tourn-duration')?.value ?? '3m';
  _wiz.totalRounds = parseInt(document.getElementById('tourn-num-rounds')?.value ?? '3') || 3;
  _wizGoStep(2);
});

// ── Step 2 wiring ──

// Tournament wizard: formats that require pair assignment before the game starts
const _TOURN_TEAM_FMTS = new Set(['betterball','csm','best2','foursomes','greensomes','scramble','groupscramble']);
// Tournament wizard: formats that support the shared/individual pair-handicap choice
const PAIR_HCP_FORMATS = new Set(['betterball','csm']);

// Format display labels
const _TOURN_FMT_LABELS = {
  stableford:   '⭐ Stableford',
  strokeplay:   '✏️ Stroke Play',
  betterball:   '🤝 Better Ball',
  csm:          '➕ Combined',
  foursomes:    '🔄 Foursomes',
  greensomes:   '🌿 Greensomes',
  scramble:     '🎯 Scramble (Pair)',
  best2:        '🏅 Best 2',
  groupscramble:'🎯 Group Scramble',
};

function _wizSetFormat(fmt) {
  _wiz.format = fmt;
  const hidEl = document.getElementById('tourn-format');
  if (hidEl) hidEl.value = fmt;
  // Show selected indicator
  const indEl = document.getElementById('wiz-fmt-selected');
  if (indEl) {
    indEl.textContent = 'Selected: ' + (_TOURN_FMT_LABELS[fmt] ?? fmt);
    indEl.style.display = '';
  }
  _wizUpdatePairHcpPanel();
}

function _wizUpdatePairHcpPanel() {
  const panel = document.getElementById('tourn-pair-hcp-panel');
  if (panel) panel.style.display = PAIR_HCP_FORMATS.has(_wiz.format) ? '' : 'none';
}

// Wire wizard cat-tiles (same expand/collapse logic as Play screen initCategoryTiles)
(function initWizCategoryTiles() {
  const tiles = document.querySelectorAll('#tourn-format-tiles .cat-tile');
  tiles.forEach(tile => {
    const formatsId = tile.getAttribute('aria-controls');
    const formatsEl = formatsId ? document.getElementById(formatsId) : null;
    if (!formatsEl) return; // no dropdown (shouldn't happen in wizard)

    holdTouch(tile, () => {
      const opening = tile.getAttribute('aria-expanded') !== 'true';
      // Close all wizard tiles
      tiles.forEach(t => {
        t.setAttribute('aria-expanded', 'false');
        const fid = t.getAttribute('aria-controls');
        const fel = fid ? document.getElementById(fid) : null;
        if (fel) fel.hidden = true;
      });
      if (opening) {
        tile.setAttribute('aria-expanded', 'true');
        formatsEl.hidden = false;
      }
    });
  });
})();

// Wire wizard p2v2 sub-accordions (Pair Up formats)
(function initWizP2v2Accordion() {
  document.querySelectorAll('#wiz-cat-pair-formats .p2v2-row').forEach(row => {
    const btn   = row.querySelector('.wiz-p2v2-fmt-btn');
    const modes = row.querySelector('.p2v2-modes');
    if (!btn || !modes) return;

    holdTouch(btn, () => {
      const opening = !btn.classList.contains('open');
      // Close all pair sub-accordions
      document.querySelectorAll('#wiz-cat-pair-formats .p2v2-fmt-btn').forEach(b => {
        b.classList.remove('open');
        const m = b.closest('.p2v2-row')?.querySelector('.p2v2-modes');
        if (m) m.hidden = true;
      });
      if (opening) {
        btn.classList.add('open');
        modes.hidden = false;
      }
    });

    // Mode buttons — for wizard these just set the format (always Stableford)
    modes.querySelectorAll('.wiz-p2v2-mode-btn').forEach(modeBtn => {
      holdTouch(modeBtn, () => {
        const fmt = modeBtn.dataset.fmt ?? row.dataset.fmt;
        _wizSetFormat(fmt);
        // Close all wizard cat-tiles after selection
        document.querySelectorAll('#tourn-format-tiles .cat-tile').forEach(t => {
          t.setAttribute('aria-expanded', 'false');
          const fid = t.getAttribute('aria-controls');
          const fel = fid ? document.getElementById(fid) : null;
          if (fel) fel.hidden = true;
        });
      });
    });
  });
})();

// Wire wizard flat fmt-btns (Solo Scoring and Team Events)
document.querySelectorAll('#tourn-format-tiles .wiz-fmt-btn').forEach(btn => {
  holdTouch(btn, () => {
    const fmt = btn.dataset.fmt;
    if (!fmt) return;
    _wizSetFormat(fmt);
    // Close all wizard cat-tiles after selection
    document.querySelectorAll('#tourn-format-tiles .cat-tile').forEach(t => {
      t.setAttribute('aria-expanded', 'false');
      const fid = t.getAttribute('aria-controls');
      const fel = fid ? document.getElementById(fid) : null;
      if (fel) fel.hidden = true;
    });
  });
});

document.getElementById('tourn-pair-hcp-btns')?.querySelectorAll('[data-phcp]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById('tourn-pair-hcp-btns').querySelectorAll('[data-phcp]')
      .forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tourn-pair-hcp-mode').value = btn.dataset.phcp;
    _wiz.pairHcpMode = btn.dataset.phcp;
  });
});

document.getElementById('btn-pair-hcp-info')?.addEventListener('click', () => {
  showScreen('screen-pair-hcp-info');
});
document.getElementById('pair-hcp-info-back')?.addEventListener('click', () => {
  showScreen('screen-tournament-new');
  _wizGoStep(2);
});

document.getElementById('tourn-hcp-mode-btns')?.querySelectorAll('[data-hcp]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById('tourn-hcp-mode-btns').querySelectorAll('[data-hcp]')
      .forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tourn-hcp-mode').value = btn.dataset.hcp;
    _wiz.hcpMode = btn.dataset.hcp;
    const strengthPanel = document.getElementById('tourn-hcp-strength-panel');
    if (strengthPanel) strengthPanel.style.display = btn.dataset.hcp === 'auto' ? '' : 'none';
  });
});

document.getElementById('tourn-strength-btns')?.querySelectorAll('[data-str]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById('tourn-strength-btns').querySelectorAll('[data-str]')
      .forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tourn-hcp-strength').value = btn.dataset.str;
    _wiz.hcpStrength = parseInt(btn.dataset.str) || 3;
  });
});

document.getElementById('btn-hcp-info')?.addEventListener('click', () => {
  showScreen('screen-tournament-hcp-info');
});
document.getElementById('tournament-hcp-info-back')?.addEventListener('click', () => {
  showScreen('screen-tournament-new');
  _wizGoStep(2);
});

document.getElementById('btn-wizard-2-back')?.addEventListener('click', () => _wizGoStep(1));
document.getElementById('btn-wizard-2-next')?.addEventListener('click', () => {
  _wiz.format      = document.getElementById('tourn-format')?.value ?? 'stableford';
  if (!_wiz.format) { alert('Please select a scoring format.'); return; }
  _wiz.hcpMode     = document.getElementById('tourn-hcp-mode')?.value ?? 'none';
  _wiz.hcpStrength = parseInt(document.getElementById('tourn-hcp-strength')?.value ?? '3') || 3;
  _wiz.pairHcpMode = document.getElementById('tourn-pair-hcp-mode')?.value ?? 'shared';
  _wizBuildCourseStep();
  _wizGoStep(3);
});

// ── Step 3 wiring ──

function _wizBuildCourseStep() {
  const singleEl   = document.getElementById('tourn-course-single');
  const perRoundEl = document.getElementById('tourn-course-per-round');
  const listEl     = document.getElementById('tourn-course-per-round-list');
  const singleSel  = document.getElementById('tourn-course-select-single');

  // Populate the single-course select
  if (singleSel) {
    singleSel.innerHTML = (allCourses ?? [])
      .map(c => `<option value="${_esc(c.id)}">${_esc(c.name)}</option>`).join('');
  }

  const isSame = _wiz.courseMode === 'same';
  if (singleEl)   singleEl.style.display   = isSame ? '' : 'none';
  if (perRoundEl) perRoundEl.style.display  = isSame ? 'none' : '';

  // Per-round: only build round 1 selector (rest set when starting each round)
  if (!isSame && listEl) {
    listEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:0.75rem;">
        <div style="font-size:0.85rem;font-weight:700;white-space:nowrap;">Round 1</div>
        <select id="tourn-course-r1" style="flex:1;font-size:0.95rem;">
          ${(allCourses ?? []).map(c => `<option value="${_esc(c.id)}">${_esc(c.name)}</option>`).join('')}
        </select>
      </div>`;
  }
}

// Same / different course toggle
document.getElementById('btn-same-course')?.addEventListener('click', () => {
  document.getElementById('btn-same-course')?.classList.add('active');
  document.getElementById('btn-diff-courses')?.classList.remove('active');
  document.getElementById('tourn-course-mode').value = 'same';
  _wiz.courseMode = 'same';
  _wizBuildCourseStep();
});
document.getElementById('btn-diff-courses')?.addEventListener('click', () => {
  document.getElementById('btn-diff-courses')?.classList.add('active');
  document.getElementById('btn-same-course')?.classList.remove('active');
  document.getElementById('tourn-course-mode').value = 'different';
  _wiz.courseMode = 'different';
  _wizBuildCourseStep();
});

document.getElementById('btn-wizard-3-back')?.addEventListener('click', () => _wizGoStep(2));
document.getElementById('btn-wizard-3-next')?.addEventListener('click', () => {
  if (_wiz.courseMode === 'same') {
    _wiz.courseId = document.getElementById('tourn-course-select-single')?.value ?? null;
  } else {
    const r1 = document.getElementById('tourn-course-r1')?.value ?? null;
    _wiz.courseIds = r1 ? [{ roundNum: 1, courseId: r1 }] : [];
  }
  _wizBuildPlayersStep();
  _wizGoStep(4);
});

// ── Step 4 wiring ──

// _wiz.players = [{ friendId, name, hcpIndex }]
function _wizBuildPlayersStep() {
  _wizRenderPlayerList();
  const countEl = document.getElementById('tourn-player-count-label');
  if (countEl) countEl.textContent = `${_wiz.players.length} player${_wiz.players.length !== 1 ? 's' : ''} added`;
}

function _wizRenderPlayerList() {
  _ensurePlayerCardStyles();
  const listEl = document.getElementById('tourn-player-list');
  if (!listEl) return;
  if (!_wiz.players.length) {
    listEl.innerHTML = '<div style="padding:0.5rem 0;font-size:0.85rem;color:var(--text-muted);text-align:center;">No players added yet</div>';
    return;
  }
  listEl.innerHTML = `<div class="pp-grid">${_wiz.players.map((p, i) => `
    <div class="pp-card" style="position:relative;">
      <button data-wiz-remove="${i}" style="position:absolute;top:4px;right:4px;
              background:none;border:none;color:var(--danger);font-size:0.85rem;
              cursor:pointer;padding:2px 5px;line-height:1;border-radius:4px;">✕</button>
      <div class="pp-name" style="font-size:14px;padding-right:1.4rem;">${_esc(p.name)}</div>
      <div class="pp-bottom" style="margin-top:auto;">
        <div class="pp-stat">
          <div class="pp-stat-label">HCP Index</div>
          <div class="pp-stat-value">${p.hcpIndex ?? '—'}</div>
        </div>
      </div>
    </div>`).join('')}</div>`;

  listEl.querySelectorAll('[data-wiz-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      _wiz.players.splice(parseInt(btn.dataset.wizRemove), 1);
      _wizBuildPlayersStep();
    });
  });
}

document.getElementById('btn-tourn-add-player')?.addEventListener('click', () => {
  _openFriendPickerForWizard();
});

function _openFriendPickerForWizard() {
  _ensurePlayerCardStyles();
  // Use allFriends (already loaded global) — field is .hcp, not .hcpIndex
  const all = allFriends ?? [];
  if (!all.length) {
    alert('No friends saved yet. Add players in the Friends & Players tab first.');
    return;
  }

  // Exclude already-added players (match by profileId or name)
  const available = all.filter(f =>
    !_wiz.players.some(wp =>
      (f.profileId && wp.friendId === f.profileId) ||
      (wp.name === (f.name || f.username))
    )
  );

  if (!available.length) {
    alert('All your friends are already in the tournament.');
    return;
  }

  const existing = document.getElementById('modal-wiz-friend-pick');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'modal-wiz-friend-pick';
  modal.className = 'modal-overlay open';
  modal.innerHTML = `
    <div class="modal-box" style="max-width:380px;display:flex;flex-direction:column;max-height:85vh;">
      <div class="modal-header">
        <div class="modal-title">Add Players</div>
        <button class="btn-close" id="wiz-fp-close">✕</button>
      </div>
      <div id="wiz-fp-list" style="flex:1;overflow-y:auto;padding:0.5rem;">
        <div class="pp-grid">
        ${available.map(f => {
          const name = f.name || f.username || '(no name)';
          const hcp  = f.hcp ?? 0;
          const pid  = f.profileId ?? f.id ?? name;
          return `<label class="wiz-fp-row pp-card" data-fp-id="${_esc(String(pid))}"
            data-fp-name="${_esc(name)}"
            data-fp-hcp="${hcp}"
            style="cursor:pointer;position:relative;">
            <input type="checkbox" class="wiz-fp-cb" style="position:absolute;top:6px;right:6px;
              width:1.1rem;height:1.1rem;accent-color:var(--gold,#d4a843);flex-shrink:0;" />
            <div class="pp-name" style="font-size:14px;padding-right:1.4rem;">${_esc(name)}</div>
            <div class="pp-bottom" style="margin-top:auto;">
              <div class="pp-stat">
                <div class="pp-stat-label">HCP Index</div>
                <div class="pp-stat-value">${hcp != null ? hcp : '—'}</div>
              </div>
            </div>
          </label>`;
        }).join('')}
        </div>
      </div>
      <div style="padding:0.75rem 1rem;border-top:1px solid var(--border);">
        <button id="wiz-fp-add" class="btn btn-primary" style="width:100%;font-weight:700;" disabled>
          Add Selected Players
        </button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // Keep Add button label and enabled state in sync with checkboxes
  function _syncAddBtn() {
    const checked = modal.querySelectorAll('.wiz-fp-cb:checked');
    const btn = document.getElementById('wiz-fp-add');
    if (!btn) return;
    const n = checked.length;
    btn.disabled = n === 0;
    btn.textContent = n === 0 ? 'Add Selected Players'
      : n === 1 ? 'Add 1 Player'
      : `Add ${n} Players`;
  }

  document.getElementById('wiz-fp-close')?.addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  modal.querySelectorAll('.wiz-fp-row').forEach(row => {
    row.addEventListener('change', () => {
      const cb = row.querySelector('.wiz-fp-cb');
      row.classList.toggle('pp-paired', !!cb?.checked);
      _syncAddBtn();
    });
  });

  document.getElementById('wiz-fp-add')?.addEventListener('click', () => {
    modal.querySelectorAll('.wiz-fp-cb:checked').forEach(cb => {
      const row = cb.closest('.wiz-fp-row');
      if (!row) return;
      _wiz.players.push({
        friendId: row.dataset.fpId,
        name:     row.dataset.fpName,
        hcpIndex: parseFloat(row.dataset.fpHcp) || 0,
      });
    });
    modal.remove();
    _wizBuildPlayersStep();
  });
}

document.getElementById('btn-wizard-4-back')?.addEventListener('click', () => _wizGoStep(3));
document.getElementById('btn-wizard-4-next')?.addEventListener('click', () => {
  // Team formats need a pairing step; solo formats create directly
  if (_TOURN_TEAM_FMTS.has(_wiz.format)) {
    _wizBuildPairingStep();
    _wizGoStep(5);
  } else {
    _wizCreateTournament();
  }
});

// ── Player card styles (shared across wizard, setup, review, pairs screens) ──
function _ensurePlayerCardStyles() {
  if (document.getElementById('pp-styles')) return;
  const s = document.createElement('style');
  s.id = 'pp-styles';
  s.textContent = `
    .pp-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .pp-pair-row { grid-column:span 2; display:flex; gap:0; position:relative; }
    .pp-card { flex:1; min-width:0; background:var(--surface-2,rgba(255,255,255,0.05));
      border:1.5px solid var(--border,rgba(255,255,255,0.12)); border-radius:12px;
      padding:10px 11px 9px; display:flex; flex-direction:column; gap:6px;
      user-select:none; -webkit-user-select:none;
      transition:transform 0.12s ease,box-shadow 0.12s ease,border-color 0.15s ease,opacity 0.15s ease; }
    .pp-card.pp-drag { cursor:grab; touch-action:none; }
    .pp-card.pp-drag:active { cursor:grabbing; }
    .pp-card.pp-paired { border-color:var(--gold,#d4a017); box-shadow:0 0 10px rgba(212,160,23,0.25); }
    .pp-pair-row .pp-card:first-child { border-radius:12px 0 0 12px; border-right:none; }
    .pp-pair-row .pp-card:last-child  { border-radius:0 12px 12px 0; border-left:none; }
    .pp-card.pp-drop-target { border-color:var(--gold,#d4a017)!important;
      box-shadow:0 0 0 2px var(--gold,#d4a017),0 0 16px rgba(212,160,23,0.45)!important;
      animation:pp-pulse 0.85s ease-in-out infinite alternate; }
    @keyframes pp-pulse { from{box-shadow:0 0 0 1.5px var(--gold,#d4a017),0 0 8px rgba(212,160,23,0.3)} to{box-shadow:0 0 0 2.5px var(--gold,#d4a017),0 0 20px rgba(212,160,23,0.55)} }
    .pp-pair-divider { position:relative;width:0;display:flex;align-items:center;justify-content:center;z-index:2; }
    .pp-chain { position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
      width:18px;height:18px;background:var(--gold,#d4a017);border-radius:50%;
      display:flex;align-items:center;justify-content:center;font-size:9px;color:#111;
      box-shadow:0 0 6px rgba(212,160,23,0.5);pointer-events:none; }
    .pp-name { font-size:15px;font-weight:900;line-height:1.2;overflow:hidden;
      display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical; }
    .pp-bottom { display:flex;align-items:flex-end;justify-content:space-between;gap:4px; }
    .pp-stat { display:flex;flex-direction:column;gap:1px; }
    .pp-stat-right { text-align:right; }
    .pp-stat-label { font-size:8.5px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-muted);line-height:1; }
    .pp-stat-value { font-size:15px;font-weight:900;color:var(--gold,#d4a017);font-variant-numeric:tabular-nums;line-height:1; }
    .pp-partner { font-size:10px;font-weight:700;color:var(--text-muted);line-height:1; }
    .pp-partner.pp-partner-active { color:var(--gold-light,#f0bb3a); }
    @keyframes pp-snap-left  { 0%{transform:translateX(0) scale(1)} 35%{transform:translateX(-8px) scale(1.05)} 65%{transform:translateX(2px) scale(0.98)} 100%{transform:translateX(0) scale(1)} }
    @keyframes pp-snap-right { 0%{transform:translateX(0) scale(1)} 35%{transform:translateX(8px) scale(1.05)} 65%{transform:translateX(-2px) scale(0.98)} 100%{transform:translateX(0) scale(1)} }
    .pp-snap-left  { animation:pp-snap-left  0.22s cubic-bezier(0.34,1.56,0.64,1) both; }
    .pp-snap-right { animation:pp-snap-right 0.22s cubic-bezier(0.34,1.56,0.64,1) both; }
  `;
  document.head.appendChild(s);
}

// ── Step 5: Pairing — PairPicker drag-to-pair ──

/* PairPicker
   Renders a drag-to-pair card grid.  Each card shows:
     - Player name (large, bold)
     - Bottom-left:  "Index" label + value in gold
     - Bottom-right: "Playing" label + partner abbrev (gold) or "—" (dim)
   Drag (pointer events) one card onto another to pair; drag a paired card
   away from its partner to unpair.  A spring-bounce animation fires on snap.
   Writes results back to _wiz.pairs on every change.
*/
class PairPicker {
  constructor(container, players, initialPairs, onChange, options = {}) {
    this.container  = container;
    this.players    = players;   // array of { name, hcpIndex }
    this.pairs      = initialPairs; // array of [idxA, idxB|null]
    this.onChange   = onChange;
    this.pairHcpFn  = options.pairHcpFn ?? null; // (piA, piB) => number
    this._drag      = null;
    this._injectStyles();
    this.render();
  }

  // ── flat index → pair + slot ──
  _findSlot(playerIdx) {
    for (let pi = 0; pi < this.pairs.length; pi++) {
      for (let si = 0; si < 2; si++) {
        if (this.pairs[pi][si] === playerIdx) return { pi, si };
      }
    }
    return null;
  }

  _partnerOf(playerIdx) {
    const slot = this._findSlot(playerIdx);
    if (!slot) return null;
    const other = this.pairs[slot.pi][slot.si === 0 ? 1 : 0];
    return other != null ? other : null;
  }

  _abbrev(name) {
    if (!name) return '—';
    const p = name.trim().split(/\s+/);
    return p.length > 1 ? p[0][0] + '. ' + p.slice(1).join(' ') : name;
  }

  _cardHTML(playerIdx) {
    const p       = this.players[playerIdx];
    const hcp     = p.hcpIndex != null ? p.hcpIndex : '—';
    const hcp2    = p.hcpIndex2 != null ? p.hcpIndex2 : null; // optional second stat (e.g. course hcp)
    const isPaired = this._partnerOf(playerIdx) != null;
    return `
      <div class="pp-card pp-drag${isPaired ? ' pp-paired' : ''}" data-pidx="${playerIdx}">
        <div class="pp-name">${_esc(p.name)}</div>
        <div class="pp-bottom">
          <div class="pp-stat">
            <div class="pp-stat-label">Index</div>
            <div class="pp-stat-value">${_esc(String(hcp))}</div>
          </div>
          ${hcp2 != null ? `<div class="pp-stat pp-stat-right">
            <div class="pp-stat-label">Course HCP</div>
            <div class="pp-stat-value" style="font-size:13px;">${_esc(String(hcp2))}</div>
          </div>` : ''}
        </div>
      </div>`;
  }

  render() {
    // Group into paired rows (span 2 cols) + solo cards
    const done   = new Set();
    const rows   = [];
    this.pairs.forEach(pair => {
      const [a, b] = pair;
      if (b != null) {
        rows.push({ type: 'pair', a, b });
        done.add(a); done.add(b);
      } else {
        rows.push({ type: 'solo', a });
        done.add(a);
      }
    });

    let html = '<div class="pp-grid">';
    rows.forEach(row => {
      if (row.type === 'pair') {
        let pairHcpBadge = '';
        if (this.pairHcpFn) {
          const ph = this.pairHcpFn(row.a, row.b);
          pairHcpBadge = `<div class="pp-pair-hcp" style="
            position:absolute;top:-0.9rem;right:0;
            font-size:0.65rem;font-weight:800;color:var(--gold);
            text-transform:uppercase;letter-spacing:0.06em;
            background:var(--surface-2,rgba(20,20,20,0.85));
            padding:1px 6px;border-radius:4px;pointer-events:none;">
            Pair HCP ${ph}</div>`;
        }
        html += `<div class="pp-pair-row" style="position:relative;margin-top:${this.pairHcpFn ? '0.9rem' : '0'};">` +
                pairHcpBadge +
                this._cardHTML(row.a) +
                `<div class="pp-pair-divider"><span class="pp-chain">⛓</span></div>` +
                this._cardHTML(row.b) + `</div>`;
      } else {
        html += this._cardHTML(row.a);
      }
    });
    html += '</div>';

    this.container.innerHTML = html;
    this._bindPointer();
  }

  _bindPointer() {
    this.container.querySelectorAll('.pp-card').forEach(card => {
      card.addEventListener('pointerdown', e => this._onDown(e, card));
    });
  }

  _onDown(e, card) {
    // Only primary pointer / left button
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    card.setPointerCapture(e.pointerId);

    const rect    = card.getBoundingClientRect();
    const playerIdx = +card.dataset.pidx;

    // Create ghost
    const ghost = card.cloneNode(true);
    ghost.style.cssText = `
      position:fixed;left:${rect.left}px;top:${rect.top}px;
      width:${rect.width}px;height:${rect.height}px;
      pointer-events:none;z-index:9999;opacity:0.92;
      transform:scale(1.07);
      box-shadow:0 8px 24px rgba(0,0,0,0.55),0 0 0 2px var(--gold),0 0 14px rgba(212,160,23,0.4);
      border-color:var(--gold);transition:none;`;
    document.body.appendChild(ghost);

    // Dim the origin card
    card.style.opacity = '0.3';

    this._drag = {
      ghost, card, playerIdx,
      ox: e.clientX - rect.left,
      oy: e.clientY - rect.top,
      over: null,
    };

    const onMove = e2 => this._onMove(e2);
    const onUp   = e2 => { this._onUp(e2); card.releasePointerCapture(e2.pointerId); card.removeEventListener('pointermove', onMove); card.removeEventListener('pointerup', onUp); };
    card.addEventListener('pointermove', onMove);
    card.addEventListener('pointerup', onUp);
  }

  _onMove(e) {
    const d = this._drag;
    if (!d) return;
    const x = e.clientX - d.ox;
    const y = e.clientY - d.oy;
    d.ghost.style.left = x + 'px';
    d.ghost.style.top  = y + 'px';

    // Hit-test other cards
    d.ghost.style.display = 'none';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    d.ghost.style.display = '';
    const target = el?.closest('.pp-card');

    // Update drop-target highlight
    if (d.over && d.over !== target) {
      d.over.classList.remove('pp-drop-target');
    }
    if (target && target !== d.card) {
      target.classList.add('pp-drop-target');
      d.over = target;
    } else {
      d.over = null;
    }
  }

  _onUp(e) {
    const d = this._drag;
    this._drag = null;
    if (!d) return;

    // Clean up ghost + dim
    d.ghost.remove();
    d.card.style.opacity = '';
    if (d.over) d.over.classList.remove('pp-drop-target');

    const targetCard = d.over;
    if (!targetCard) { this.render(); return; }

    const fromIdx = d.playerIdx;
    const toIdx   = +targetCard.dataset.pidx;
    if (fromIdx === toIdx) { this.render(); return; }

    this._doPair(fromIdx, toIdx);
  }

  _doPair(fromIdx, toIdx) {
    // Unpair each from their current partner first
    this._unpair(fromIdx);
    this._unpair(toIdx);

    // Find their (now-solo) slots
    const fromSlot = this._findSlot(fromIdx);
    const toSlot   = this._findSlot(toIdx);

    // Merge: put toIdx into fromIdx's pair, remove toIdx's solo pair
    if (fromSlot && toSlot) {
      this.pairs[fromSlot.pi][1] = toIdx;
      // Remove toIdx's now-empty pair entry
      this.pairs.splice(toSlot.pi, 1);
    }

    this.render();
    this._snapAnimation(fromIdx, toIdx);
    this.onChange(this.pairs);
  }

  _unpair(playerIdx) {
    const slot = this._findSlot(playerIdx);
    if (!slot) return;
    const { pi, si } = slot;
    const partnerSlot = si === 0 ? 1 : 0;
    const partner = this.pairs[pi][partnerSlot];
    if (partner == null) return; // already solo

    // Split: current pair becomes two solo entries
    const a = this.pairs[pi][0];
    const b = this.pairs[pi][1];
    this.pairs.splice(pi, 1, [a, null], [b, null]);
  }

  _snapAnimation(idxA, idxB) {
    // Find the two cards in the re-rendered DOM and fire spring animation
    const cards = this.container.querySelectorAll('.pp-card');
    cards.forEach(c => {
      const idx = +c.dataset.pidx;
      if (idx === idxA) { c.classList.add('pp-snap-left');  c.addEventListener('animationend', () => c.classList.remove('pp-snap-left'),  { once: true }); }
      if (idx === idxB) { c.classList.add('pp-snap-right'); c.addEventListener('animationend', () => c.classList.remove('pp-snap-right'), { once: true }); }
    });
  }

  _injectStyles() { _ensurePlayerCardStyles(); }
}

function _wizBuildPairingStep() {
  const listEl = document.getElementById('wiz-pair-list');
  const warnEl = document.getElementById('wiz-pair-warning');
  if (!listEl) return;

  const players = _wiz.players;

  // Initialise pairs array: all solo until the user drags to pair
  if (!_wiz.pairs || _wiz.pairs.length !== players.length) {
    _wiz.pairs = players.map((_, i) => [i, null]);
  }

  // Odd-player warning
  const odd = players.length % 2 !== 0;
  if (warnEl) {
    warnEl.style.display = odd ? '' : 'none';
    warnEl.textContent   = odd ? '⚠️ Odd number of players — one player will remain solo.' : '';
  }

  // Build display player list with both HCP index and course HCP
  const ppPlayers = players.map(p => ({
    name:      p.name,
    hcpIndex:  p.hcpIndex ?? 0,
    hcpIndex2: p.courseHcp ?? p.hcpIndex ?? 0,
  }));

  new PairPicker(listEl, ppPlayers, _wiz.pairs, updatedPairs => {
    _wiz.pairs = updatedPairs;
  });
}

document.getElementById('btn-wizard-5-back')?.addEventListener('click', () => _wizGoStep(4));
document.getElementById('btn-wizard-5-create')?.addEventListener('click', () => _wizCreateTournament());

async function _wizCreateTournament() {
  if (!_wiz.players.length) {
    if (!confirm('No players added. Create tournament anyway? (You can add players from Organiser Admin later.)')) return;
  }

  const isTeam = _TOURN_TEAM_FMTS.has(_wiz.format);
  const btn = document.getElementById(isTeam ? 'btn-wizard-5-create' : 'btn-wizard-4-next');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }

  try {
    const secret = _genOrganiserSecret();
    const hash   = await _sha256(secret);

    // Build courses array for the Worker
    let courses;
    if (_wiz.courseMode === 'same' && _wiz.courseId) {
      courses = Array.from({ length: _wiz.totalRounds }, (_, i) => ({ roundNum: i + 1, courseId: _wiz.courseId }));
    } else {
      courses = _wiz.courseIds ?? [];
    }

    // Build pairs array (indices → player names) for team formats
    let pairsPayload = null;
    if (_TOURN_TEAM_FMTS.has(_wiz.format) && _wiz.pairs?.length) {
      pairsPayload = _wiz.pairs.map(pair => pair.map(idx => idx != null ? _wiz.players[idx]?.name ?? null : null));
    }

    const payload = {
      name:         _wiz.name,
      totalRounds:  _wiz.totalRounds,
      format:       _wiz.format,
      hcpMode:      _wiz.hcpMode,
      hcpStrength:  _wiz.hcpMode === 'auto' ? _wiz.hcpStrength : null,
      pairHcpMode:  PAIR_HCP_FORMATS.has(_wiz.format) ? (_wiz.pairHcpMode ?? 'shared') : null,
      pairs:        pairsPayload,
      duration:     _wiz.duration,
      organiserHash: hash,
      courses,
    };

    // 1. Create tournament in Worker (gets code + expiresAt back)
    const resp = await _tournWorkerFetch('/tournament', 'POST', payload, secret);
    const code = resp.code;
    if (!code) throw new Error('No code returned from server');

    // 2. Persist organiser secret locally
    try { localStorage.setItem(`lb-organiser-secret-${code}`, secret); } catch {}

    // 3. Create roster (POST players)
    if (_wiz.players.length) {
      const rosterPlayers = _wiz.players.map(p => ({
        name:          p.name,
        handicapIndex: p.hcpIndex,
        friendsId:     p.friendId ?? null,
      }));
      await _tournWorkerFetch(`/roster/${code}`, 'POST', { players: rosterPlayers }, secret);
    }

    // 4. Fetch fresh tournament record from Worker and store in IDB
    const tournRecord = await _tournWorkerFetch(`/tournament/${code}`);
    const toStore = {
      ...tournRecord,
      code,
      isOrganiser:   true,
      organiserHash: hash,  // store hash locally so we know we're organiser
      rosterCachedAt: null,
    };
    await idbTournaments.put(toStore);
    await _flushTournamentCache();

    // 5. Navigate to organiser admin screen
    showTournamentOrganiserAdmin(code);

  } catch (err) {
    alert('Could not create tournament: ' + err.message);
    if (btn) { btn.disabled = false; btn.textContent = _TOURN_TEAM_FMTS.has(_wiz.format) ? 'CREATE →' : 'NEXT →'; }
  }
}

// ── Join Tournament Screen ───────────────────────────────────────

function showTournamentJoin() {
  // Reset
  const codeEl    = document.getElementById('join-tournament-code');
  const errEl     = document.getElementById('join-code-error');
  const previewEl = document.getElementById('join-preview-card');
  if (codeEl)    { codeEl.value = ''; }
  if (errEl)     { errEl.style.display = 'none'; errEl.textContent = ''; }
  if (previewEl) { previewEl.style.display = 'none'; }
  showScreen('screen-tournament-join');
  setTimeout(() => codeEl?.focus(), 200);
}

document.getElementById('tournament-join-back')?.addEventListener('click', () => showTournamentHub());

document.getElementById('join-tournament-code')?.addEventListener('input', e => {
  e.target.value = e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
});

document.getElementById('btn-join-lookup')?.addEventListener('click', async () => {
  const code   = (document.getElementById('join-tournament-code')?.value ?? '').trim().toUpperCase();
  const errEl  = document.getElementById('join-code-error');
  const btn    = document.getElementById('btn-join-lookup');
  if (!code) { if (errEl) { errEl.textContent = 'Enter a code.'; errEl.style.display = ''; } return; }

  btn.disabled = true; btn.textContent = 'Looking up…';
  if (errEl) errEl.style.display = 'none';

  try {
    const data = await _tournWorkerFetch(`/tournament/${code}`);
    _renderJoinPreview(code, data);
  } catch (err) {
    if (errEl) { errEl.textContent = '❌ ' + (err.message ?? 'Not found'); errEl.style.display = ''; }
  } finally {
    btn.disabled = false; btn.textContent = 'LOOK UP →';
  }
});

function _renderJoinPreview(code, t) {
  const card   = document.getElementById('join-preview-card');
  const nameEl = document.getElementById('join-preview-name');
  const metaEl = document.getElementById('join-preview-meta');
  const playEl = document.getElementById('join-preview-players');
  const alrEl  = document.getElementById('join-already-joined');
  if (!card) return;

  if (nameEl) nameEl.textContent = t.name ?? code;
  if (metaEl) {
    const fmt = TOURN_FORMAT_LABELS[t.format] ?? t.format ?? '—';
    const hcp = TOURN_HCP_LABELS[t.hcpMode] ?? t.hcpMode ?? '—';
    metaEl.textContent = `${fmt} · ${t.totalRounds} round${t.totalRounds !== 1 ? 's' : ''} · ${hcp}`;
  }

  // Check if already joined
  const existing = _readTournamentCache().find(tc => tc.code === code);
  if (alrEl) alrEl.style.display = existing ? '' : 'none';

  // Show roster preview (fetch from Worker)
  if (playEl) {
    playEl.textContent = 'Loading players…';
    _tournWorkerFetch(`/roster/${code}`).then(r => {
      const players = r.players ?? [];
      playEl.textContent = players.length
        ? players.map(p => p.name).join(', ')
        : 'No players yet.';
    }).catch(() => { playEl.textContent = '—'; });
  }

  card.style.display = '';

  document.getElementById('btn-join-confirm').onclick = async () => {
    const joinBtn = document.getElementById('btn-join-confirm');
    joinBtn.disabled = true; joinBtn.textContent = 'Joining…';
    try {
      // Store the tournament record locally
      const toStore = { ...t, code, isOrganiser: false, rosterCachedAt: null };
      await idbTournaments.put(toStore);
      await _flushTournamentCache();
      showTournamentDetail(code);
    } catch (err) {
      alert('Could not join: ' + err.message);
      joinBtn.disabled = false; joinBtn.textContent = 'JOIN TOURNAMENT →';
    }
  };
}

// ── Tournament Detail Screen ─────────────────────────────────────

async function showTournamentDetail(code) {
  const nameEl     = document.getElementById('td-tournament-name');
  const metaEl     = document.getElementById('td-meta');
  const standEl    = document.getElementById('td-standings');
  const roundsEl   = document.getElementById('td-rounds');
  const startBtn   = document.getElementById('btn-start-next-round');
  const roundNumEl = document.getElementById('td-next-round-num');
  const rejoinBtn  = document.getElementById('btn-view-leaderboard');
  const adminBtn   = document.getElementById('btn-td-organiser-admin');
  const awaitEl    = document.getElementById('td-awaiting-finalisation');

  if (nameEl) nameEl.textContent = '…';
  if (metaEl) metaEl.textContent = '';
  showScreen('screen-tournament-detail');

  try {
    // Always fetch fresh from Worker so round statuses are up to date.
    // Merge with IDB to preserve isOrganiser flag and cached fields.
    let t = await idbTournaments.get(code).catch(() => null);
    try {
      const fresh = await _tournWorkerFetch(`/tournament/${code}`);
      t = { ...(t ?? {}), ...fresh, code,
            isOrganiser: t?.isOrganiser ?? false,
            rosterCachedAt: t?.rosterCachedAt ?? null };
      await idbTournaments.put(t);
      await _flushTournamentCache();
    } catch {
      // Worker unreachable — fall back to cached IDB data
      if (!t) throw new Error('Tournament not found');
    }

    const isOrganiser = !!(t.isOrganiser || _getOrganiserSecret(code));
    if (nameEl) nameEl.textContent = t.name ?? code;
    if (metaEl) {
      const fmt = TOURN_FORMAT_LABELS[t.format] ?? t.format ?? '—';
      metaEl.textContent = `${fmt} · ${t.totalRounds} rounds`;
    }

    // Rounds list
    const rounds = t.rounds ?? [];
    if (roundsEl) {
      roundsEl.innerHTML = rounds.length
        ? rounds.map(r => {
            const statusIcon = { scheduled:'📅', inProgress:'🟢', awaitingFinalisation:'⏳', finalised:'✅' }[r.status] ?? '—';
            return `<div style="display:flex;align-items:center;gap:0.75rem;padding:0.5rem 0;
                                border-bottom:1px solid var(--border);">
              <div style="font-size:1.1rem;">${statusIcon}</div>
              <div>
                <div style="font-weight:700;font-size:0.92rem;">Round ${r.roundNum}</div>
                <div style="font-size:0.78rem;color:var(--text-muted);">
                  ${r.status === 'finalised' ? 'Finalised' : r.status === 'inProgress' ? 'In progress' : r.status === 'awaitingFinalisation' ? 'Awaiting finalisation' : 'Scheduled'}
                </div>
              </div>
            </div>`;
          }).join('')
        : '<div style="font-size:0.85rem;color:var(--text-muted);padding:0.5rem 0;">No rounds yet.</div>';
    }

    // Which round is next?
    const nextRound = rounds.find(r => r.status === 'scheduled') ?? null;
    const awaitingRound = rounds.find(r => r.status === 'awaitingFinalisation') ?? null;
    const liveRound = rounds.find(r => r.status === 'inProgress') ?? null;

    // Awaiting finalisation notice
    if (awaitEl) {
      if (awaitingRound) {
        awaitEl.style.display = '';
        const awn = document.getElementById('td-awaiting-round-num');
        if (awn) awn.textContent = awaitingRound.roundNum;
      } else {
        awaitEl.style.display = 'none';
      }
    }

    // Start next round button
    if (startBtn) {
      if (nextRound && !awaitingRound) {
        startBtn.style.display = '';
        if (roundNumEl) roundNumEl.textContent = nextRound.roundNum;
        startBtn.onclick = () => showTournamentStartRound(code, nextRound.roundNum, t);
      } else {
        startBtn.style.display = 'none';
      }
    }

    // Rejoin live round
    if (rejoinBtn) {
      if (liveRound) {
        rejoinBtn.style.display = '';
        rejoinBtn.onclick = () => {
          // Check per-round localStorage for a saved group state
          const key = `lb-round-state-${code}-${liveRound.roundNum}`;
          const saved = (() => { try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { return null; } })();
          if (saved && gameState) { enterGameScreen(); }
          else showHome(); // fallback — Active Games card will handle it
        };
      } else {
        rejoinBtn.style.display = 'none';
      }
    }

    // Organiser Admin button
    if (adminBtn) adminBtn.style.display = isOrganiser ? '' : 'none';
    if (adminBtn) adminBtn.onclick = () => showTournamentOrganiserAdmin(code);

    // Secondary buttons — View Leaderboard opens the in-app hub leaderboard
    const lbViewBtn = document.getElementById('btn-td-view-leaderboard-full');
    if (lbViewBtn) {
      // Show leaderboard for the most recent non-scheduled round, or round 1 as fallback
      const _finalisedMax = rounds.filter(r => r.status === 'finalised').reduce((max, r) => Math.max(max, r.roundNum), 0);
      const lbRound = liveRound?.roundNum
        ?? awaitingRound?.roundNum
        ?? (_finalisedMax > 0 ? _finalisedMax : 1);
      lbViewBtn.onclick = () => showTournamentHubLeaderboard(code, lbRound);
    }

    // Remove / leave tournament
    const removeBtn = document.getElementById('btn-td-remove-tournament');
    if (removeBtn) {
      removeBtn.textContent = isOrganiser ? '🗑 Delete Tournament' : '🗑 Remove from My List';
      removeBtn.onclick = async () => {
        const msg = isOrganiser
          ? `Delete "${t.name ?? code}" for everyone? This cannot be undone.`
          : `Remove "${t.name ?? code}" from your tournament list?`;
        if (!confirm(msg)) return;
        // Remove from IDB and local cache
        await idbTournaments.delete(code).catch(() => {});
        try {
          const cache = _readTournamentCache().filter(tc => tc.code !== code);
          localStorage.setItem('lb-tournaments', JSON.stringify(cache));
        } catch {}
        // Remove organiser secret if present
        try { localStorage.removeItem(`lb-organiser-secret-${code}`); } catch {}
        showTournamentHub();
      };
    }

    // Back
    document.getElementById('tournament-detail-back').onclick = () => showTournamentHub();

    // Standings — minimal: just list round totals per player from KV (future enhancement)
    if (standEl) {
      standEl.innerHTML = '<div style="font-size:0.82rem;color:var(--text-muted);">Standings available after first round is finalised.</div>';
    }

  } catch (err) {
    if (nameEl) nameEl.textContent = 'Error';
    alert('Could not load tournament: ' + err.message);
  }
}

// ── Start Round Screen ───────────────────────────────────────────

async function showTournamentStartRound(code, roundNum, tournRecord) {
  _ensurePlayerCardStyles();
  const numEl   = document.getElementById('tsr-round-num');
  const nameEl  = document.getElementById('tsr-tourn-name');
  const listEl  = document.getElementById('tsr-player-list');
  const noteEl  = document.getElementById('tsr-hcp-note');
  const crsCard = document.getElementById('tsr-course-card');
  const crsSel  = document.getElementById('tsr-course-select');

  if (numEl)  numEl.textContent  = roundNum;
  if (nameEl) nameEl.textContent = tournRecord?.name ?? code;
  if (listEl) listEl.innerHTML   = 'Loading roster…';
  showScreen('screen-tournament-start-round');

  try {
    const secret  = _getOrganiserSecret(code);
    const roster  = await _tournWorkerFetch(`/roster/${code}`, 'GET', null, secret);
    const players = roster.players ?? [];

    // Course: if same course for all rounds, pre-select; else show picker
    const courses    = tournRecord?.courses ?? [];
    const thisRound  = courses.find(c => c.roundNum === roundNum);
    const hasCourse  = !!(thisRound?.courseId);

    if (crsCard) crsCard.style.display = hasCourse ? 'none' : '';
    if (crsSel && !hasCourse) {
      crsSel.innerHTML = (allCourses ?? []).map(c => `<option value="${_esc(c.id)}">${_esc(c.name)}</option>`).join('');
    }

    // Handicap note
    if (noteEl && tournRecord?.hcpMode !== 'none') {
      noteEl.style.display = '';
      const modeLabel = TOURN_HCP_LABELS[tournRecord.hcpMode] ?? tournRecord.hcpMode;
      noteEl.textContent = `${modeLabel} handicaps will be applied. Adjusted indices are shown below.`;
    } else if (noteEl) {
      noteEl.style.display = 'none';
    }

    // Player checklist
    if (listEl) {
      if (!players.length) {
        listEl.innerHTML = '<div style="font-size:0.85rem;color:var(--text-muted);">No players in roster yet.</div>';
      } else {
        const _toggleCard = (label) => {
          const cb = label.querySelector('input[type=checkbox]');
          if (cb) label.classList.toggle('pp-paired', cb.checked);
        };
        listEl.innerHTML = `<div class="pp-grid">${players.map(p => {
          const origHcp = p.originalHcp ?? p.hcpIndex ?? 0;
          const adjHcp  = p.adjustedHcp ?? origHcp;
          return `<label class="pp-card pp-paired" style="cursor:pointer;position:relative;"
            data-tsr-label>
            <input type="checkbox" data-player-id="${_esc(p.playerId ?? p.id)}"
              data-player-name="${_esc(p.name)}"
              data-player-orig-hcp="${origHcp}"
              data-player-adj-hcp="${adjHcp}"
              checked style="position:absolute;top:6px;right:6px;
                width:1.1rem;height:1.1rem;accent-color:var(--gold);">
            <div class="pp-name" style="font-size:14px;padding-right:1.4rem;">${_esc(p.name)}</div>
            <div class="pp-bottom" style="margin-top:auto;">
              <div class="pp-stat">
                <div class="pp-stat-label">Index</div>
                <div class="pp-stat-value">${origHcp}</div>
              </div>
              <div class="pp-stat pp-stat-right">
                <div class="pp-stat-label">Course HCP</div>
                <div class="pp-partner pp-partner-active">${adjHcp}</div>
              </div>
            </div>
          </label>`;
        }).join('')}</div>`;
        listEl.querySelectorAll('[data-tsr-label]').forEach(label => {
          label.addEventListener('change', () => _toggleCard(label));
        });
      }
    }

    // Launch button
    const launchBtn = document.getElementById('btn-tsr-launch');
    if (launchBtn) {
      launchBtn.onclick = async () => {
        const checked = [...(listEl?.querySelectorAll('input[type=checkbox]:checked') ?? [])];
        if (!checked.length) { alert('Select at least one player.'); return; }
        const selectedPlayers = checked.map(cb => ({
          playerId:     cb.dataset.playerId,
          name:         cb.dataset.playerName,
          hcpIndex:     parseFloat(cb.dataset.playerOrigHcp) || 0,  // raw profile index
          gameHandicap: parseFloat(cb.dataset.playerAdjHcp)  || 0,  // adjusted playing handicap
        }));

        // Determine course
        let courseId = thisRound?.courseId ?? crsSel?.value ?? null;

        // Build a group ID and save round state to localStorage
        const groupId = `g${Date.now()}`;
        const stateKey = `lb-round-state-${code}-${roundNum}-${groupId}`;
        try {
          localStorage.setItem(stateKey, JSON.stringify({
            code, roundNum, groupId, courseId, players: selectedPlayers,
            startedAt: new Date().toISOString(),
          }));
        } catch {}

        // Import tournament context into the main setup flow and start a game
        setup.tournamentId     = code;
        setup.tournRoundNumber = roundNum;
        setup.players = selectedPlayers.map(p => ({
          name: p.name, hcpIndex: p.hcpIndex,
          tournamentPlayerId: p.playerId,
        }));
        setup.courseId = courseId;
        setup.scoring  = tournRecord?.format ?? 'stableford';
        setup.holes    = 18;
        setup.numGroups = 1;
        setup.numPlayers = selectedPlayers.length;
        buildSetupReview();
        showScreen('screen-setup-review');
      };
    }

    document.getElementById('tournament-start-round-back').onclick = () => showTournamentDetail(code);

  } catch (err) {
    if (listEl) listEl.innerHTML = `<div style="color:var(--danger);font-size:0.85rem;">Error: ${err.message}</div>`;
  }
}

// ── Organiser Admin Screen ───────────────────────────────────────

async function showTournamentOrganiserAdmin(code) {
  const nameEl     = document.getElementById('oa-tourn-name');
  const rosterEl   = document.getElementById('oa-roster-table');
  const roundsEl   = document.getElementById('oa-rounds-list');
  const conflictsEl = document.getElementById('oa-conflicts');
  if (nameEl) nameEl.textContent = code;
  if (rosterEl)  rosterEl.innerHTML  = 'Loading…';
  if (roundsEl)  roundsEl.innerHTML  = '';
  showScreen('screen-tournament-organiser-admin');

  const secret = _getOrganiserSecret(code);

  try {
    const [tournData, rosterData] = await Promise.all([
      _tournWorkerFetch(`/tournament/${code}`),
      _tournWorkerFetch(`/roster/${code}`, 'GET', null, secret),
    ]);

    if (nameEl) nameEl.textContent = tournData.name ?? code;

    const players = rosterData.players ?? [];
    const rounds  = tournData.rounds   ?? [];
    const isAuto  = tournData.hcpMode === 'auto';

    // ── Roster table ──
    if (rosterEl) {
      if (!players.length) {
        rosterEl.innerHTML = '<div style="font-size:0.85rem;color:var(--text-muted);">No players in roster.</div>';
      } else {
        const hcpCols = isAuto
          ? '<th style="padding:0.4rem 0.5rem;text-align:right;">Orig HCP</th><th style="padding:0.4rem 0.5rem;text-align:right;">Adj HCP</th>'
          : '<th style="padding:0.4rem 0.5rem;text-align:right;">HCP</th>';

        const rows = players.map(p => {
          const hcpCells = isAuto
            ? `<td style="padding:0.4rem 0.5rem;text-align:right;font-variant-numeric:tabular-nums;">${p.originalHcp ?? '—'}</td>
               <td style="padding:0.4rem 0.5rem;text-align:right;font-variant-numeric:tabular-nums;font-weight:700;color:var(--gold);">${p.adjustedHcp ?? p.originalHcp ?? '—'}</td>`
            : `<td style="padding:0.4rem 0.5rem;text-align:right;">${p.originalHcp ?? '—'}</td>`;
          return `<tr>
            <td style="padding:0.4rem 0.5rem;font-weight:600;">${_esc(p.name)}</td>
            ${hcpCells}
            <td style="padding:0.4rem 0.5rem;font-size:0.75rem;color:var(--text-muted);">${_esc(p.playerId ?? '')}</td>
          </tr>`;
        }).join('');

        rosterEl.innerHTML = `
          <table style="width:100%;border-collapse:collapse;font-size:0.85rem;">
            <thead>
              <tr style="font-size:0.72rem;font-weight:800;letter-spacing:0.05em;
                         text-transform:uppercase;color:var(--text-muted);
                         border-bottom:1px solid var(--border);">
                <th style="padding:0.4rem 0.5rem;text-align:left;">Player</th>
                ${hcpCols}
                <th style="padding:0.4rem 0.5rem;text-align:left;">ID</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>`;
      }
    }

    // ── Rounds list with finalise buttons ──
    if (roundsEl) {
      roundsEl.innerHTML = rounds.map(r => {
        const canFinalise = r.status === 'inProgress' || r.status === 'awaitingFinalisation';
        const statusLabel = { scheduled:'Scheduled', inProgress:'In progress', awaitingFinalisation:'Awaiting finalisation', finalised:'Finalised' }[r.status] ?? r.status;
        return `
          <div class="card" style="padding:0.75rem 1rem;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;">
              <div>
                <div style="font-weight:700;">Round ${r.roundNum}</div>
                <div style="font-size:0.78rem;color:var(--text-muted);">${statusLabel}</div>
              </div>
              ${canFinalise && secret
                ? `<button class="btn btn-outline" data-finalise-round="${r.roundNum}"
                           style="padding:0.5rem 0.85rem;font-size:0.82rem;font-weight:800;
                                  border-color:var(--gold-border);color:var(--gold);">
                     Finalise
                   </button>`
                : (r.status === 'finalised' ? '<span style="color:var(--green);font-size:0.85rem;font-weight:700;">✅ Done</span>' : '')}
            </div>
          </div>`;
      }).join('') || '<div style="font-size:0.85rem;color:var(--text-muted);">No rounds yet.</div>';

      // Wire finalise buttons
      roundsEl.querySelectorAll('[data-finalise-round]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const roundNum = parseInt(btn.dataset.finaliseRound);
          await _organiserFinaliseRound(code, roundNum, secret, tournData);
        });
      });
    }

    // Conflicts placeholder
    if (conflictsEl) conflictsEl.style.display = 'none';

    // Back + late joiner
    document.getElementById('tournament-organiser-admin-back').onclick = () => showTournamentHub();
    document.getElementById('btn-oa-add-late-joiner').onclick = () => alert('Late-joiner flow coming soon.');

    // Go to tournament hub
    const goHubBtn = document.getElementById('btn-oa-go-hub');
    if (goHubBtn) goHubBtn.onclick = () => showTournamentHub();

    // Show tournament code button
    const showCodeBtn = document.getElementById('btn-oa-show-code');
    if (showCodeBtn) showCodeBtn.onclick = () => _showTournamentCodeModal(code);

  } catch (err) {
    if (rosterEl) rosterEl.innerHTML = `<div style="color:var(--danger);">Error: ${err.message}</div>`;
  }
}

function _showTournamentCodeModal(code) {
  const modal    = document.getElementById('modal-tourn-code');
  const codeEl   = document.getElementById('modal-code-display');
  const linkEl   = document.getElementById('modal-invite-link');
  const copyBtn  = document.getElementById('btn-copy-invite');
  const closeBtn = document.getElementById('btn-tourn-code-close');
  if (!modal) return;

  const inviteLink = `${location.origin}/?join=${code}`;
  if (codeEl) codeEl.textContent = code;
  if (linkEl) linkEl.textContent = inviteLink;

  modal.style.display = 'flex';
  modal.classList.add('open');

  if (copyBtn) {
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(inviteLink).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1800);
      }).catch(() => {
        copyBtn.textContent = 'Copy failed';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1800);
      });
    };
  }
  const _close = () => { modal.style.display = 'none'; modal.classList.remove('open'); };
  if (closeBtn) closeBtn.onclick = _close;
  modal.onclick = e => { if (e.target === modal) _close(); };
}

async function _organiserFinaliseRound(code, roundNum, secret, tournData, force = false) {
  const btn = document.querySelector(`[data-finalise-round="${roundNum}"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Finalising…'; }

  try {
    const body = force ? { force: true } : {};
    const resp = await _tournWorkerFetch(`/tournament/${code}/finalise/${roundNum}`, 'POST', body, secret);

    if (resp.requiresConfirm) {
      // Force-confirm gate: show excluded players and ask organiser to confirm
      const excNames = (resp.excluded ?? []).map(p => p.name ?? p).join(', ') || 'some players';
      const mean = resp.meanPreview != null ? ` (mean: ${resp.meanPreview.toFixed(1)} pts)` : '';
      const msg = `${resp.validCount ?? 0} valid score${(resp.validCount ?? 0) !== 1 ? 's' : ''} received${mean}.\n\nExcluded (DNF or incomplete): ${excNames}\n\nFinalise anyway and exclude these players from this round's adjustment?`;
      if (confirm(msg)) {
        await _organiserFinaliseRound(code, roundNum, secret, tournData, true);
      } else {
        if (btn) { btn.disabled = false; btn.textContent = 'Finalise'; }
      }
      return;
    }

    // Success — refresh the screen
    // Update IDB tournament record
    try {
      const fresh = await _tournWorkerFetch(`/tournament/${code}`);
      await idbTournaments.put({ ...fresh, code, isOrganiser: true, rosterCachedAt: null });
      await _flushTournamentCache();
    } catch {}

    alert(`Round ${roundNum} finalised! Adjustments applied.`);
    showTournamentOrganiserAdmin(code);

  } catch (err) {
    alert('Finalise failed: ' + err.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Finalise'; }
  }
}

// ── Profile screen: wire the Friends & Players button ────────────

document.getElementById('btn-profile-friends')?.addEventListener('click', () => showFriends());


// ================================================================
// TOURNAMENT HUB LEADERBOARD  (post-round end screen)
// ================================================================
// Called after a hub tournament round is saved.
// Pulls all scores from the worker, shows a ranked table per player
// with their total pts and the handicap adjustment applied this round.
// ================================================================

async function showTournamentHubLeaderboard(code, roundNum) {
  if (!code) { showHome(); return; }

  showScreen('screen-tourn-hub-lb');

  const nameEl     = document.getElementById('thbl-tourn-name');
  const statusEl   = document.getElementById('thbl-status');
  const tableEl    = document.getElementById('thbl-table');
  const refreshBtn = document.getElementById('btn-thbl-refresh');
  const finishBtn  = document.getElementById('btn-thbl-finish');

  // Tournament name
  if (nameEl) {
    try {
      const t = await idbTournaments.get(code);
      nameEl.textContent = t?.name ?? code;
    } catch { nameEl.textContent = code; }
  }

  if (finishBtn) finishBtn.onclick = () => showHome();

  // Which round did we just complete?
  // roundNum is passed from the end-round handler; fall back to _tournState if not provided.
  if (!roundNum || roundNum < 1) {
    try { const ts = _tournState(); roundNum = ts.currentRound > 0 ? ts.currentRound : 1; } catch { roundNum = 1; }
  }

  // Organiser secret — only present on the device that created the tournament
  const secret = _getOrganiserSecret(code);

  async function _loadAndRender() {
    if (statusEl) { statusEl.textContent = 'Loading scores…'; statusEl.style.display = ''; }
    if (tableEl)  tableEl.innerHTML = '';

    try {
      // Fetch raw scores
      console.log('[lb] fetching scores for code=', code, 'roundNum=', roundNum, 'secret=', !!secret);
      const data = await _workerFetch(`/scores/${code.toUpperCase()}`);
      console.log('[lb] scores response:', JSON.stringify(data).slice(0, 300));

      // Check if all players have completed 18 holes for this round
      const thisRoundEntries = (data?.rounds ?? []).filter(r => (r.round ?? 1) === roundNum);
      const allIn = thisRoundEntries.length > 0 &&
        thisRoundEntries.every(r =>
          (r.players ?? []).every(p => (p.holesPlayed ?? 18) >= 18)
        );
      console.log('[lb] thisRoundEntries=', thisRoundEntries.length, 'allIn=', allIn);
      if (thisRoundEntries.length) {
        thisRoundEntries.forEach(r => r.players?.forEach(p =>
          console.log('[lb] player', p.name, 'holesPlayed=', p.holesPlayed)));
      }

      // Auto-finalise if organiser — worker is idempotent and returns cached adjustments instantly
      // Don't gate on allIn: even after the round is done, we need adjustments to display the Cut column
      let adjustments = null;
      if (secret) {
        try {
          if (statusEl) { statusEl.textContent = 'All scores in — applying adjustments…'; statusEl.style.display = ''; }
          console.log('[lb] calling finalise for round', roundNum);
          const resp = await _tournWorkerFetch(`/tournament/${code}/finalise/${roundNum}`, 'POST', {}, secret);
          console.log('[lb] finalise response:', JSON.stringify(resp).slice(0, 300));
          if (resp?.adjustments?.length) {
            adjustments = resp.adjustments;
          }
          // Update local IDB tournament record with new state
          try {
            const fresh = await _tournWorkerFetch(`/tournament/${code}`);
            await idbTournaments.put({ ...fresh, code, isOrganiser: true, rosterCachedAt: null });
          } catch {}
        } catch (finErr) {
          console.error('[lb] finalise error:', finErr);
        }
      } else {
        console.log('[lb] skipping finalise: no organiser secret on this device');
      }

      if (statusEl) statusEl.style.display = 'none';

      // Determine total rounds for the tournament so we always render the
      // correct number of columns — even mid-round when the server only has
      // data for completed rounds.
      let totalRounds = 1;
      try {
        const t = await idbTournaments.get(code);
        if (t?.totalRounds > 1) totalRounds = t.totalRounds;
      } catch {}
      // Fallback: use the highest round number seen in server data
      const serverMaxRound = Math.max(...(data?.rounds ?? []).map(r => r.round ?? 1), 0);
      if (serverMaxRound > totalRounds) totalRounds = serverMaxRound;

      _renderHubLbTable(tableEl, data, adjustments, roundNum, totalRounds);

    } catch (fetchErr) {
      console.error('[lb] load error:', fetchErr);
      if (statusEl) { statusEl.textContent = '⚠ Could not load scores — check connection and refresh.'; }
    }
  }

  if (refreshBtn) refreshBtn.onclick = () => _loadAndRender();

  await _loadAndRender();
}

function _renderHubLbTable(tableEl, data, adjustments, roundNum, totalRounds) {
  if (!tableEl) return;
  const rounds = data?.rounds ?? [];

  // totalRounds: the declared length of the tournament (may be larger than server data).
  // numRounds: how many rounds we'll show columns for — always at least totalRounds
  //            so the table is stable as rounds arrive.
  const serverMaxRound = rounds.length ? Math.max(...rounds.map(r => r.round ?? 1)) : 1;
  const numRounds = Math.max(totalRounds ?? 1, serverMaxRound);
  const isMultiRound = numRounds > 1;

  if (!rounds.length) {
    tableEl.innerHTML = '<p style="text-align:center;padding:2rem;color:var(--text-muted);">No scores yet — waiting for groups to finish.</p>';
    return;
  }

  // Build adjustment lookup by player name
  const adjByName = {};
  if (adjustments) {
    for (const a of adjustments) {
      if (a.name) adjByName[a.name] = a;
    }
  }

  // Aggregate by player name across all rounds.
  // For incomplete rounds (holes < 18) we track holesPlayed so we can note it.
  const byPlayer = {};
  for (const r of rounds) {
    for (const p of (r.players ?? [])) {
      if (!p.name) continue;
      if (!byPlayer[p.name]) {
        byPlayer[p.name] = { name: p.name, roundMap: {}, totalPts: 0, hcp: p.hcp ?? 0, maxHolesThisRound: 0 };
      }
      const entry = byPlayer[p.name];
      const rn  = r.round ?? 1;
      const pts = p.pts ?? p.total ?? 0;
      const hp  = p.holesPlayed ?? 18;
      entry.totalPts += pts;
      entry.hcp = p.hcp ?? entry.hcp;
      entry.roundMap[rn] = { pts, holesPlayed: hp };
      // Track holes played for current round only (for the "thru" note)
      if (rn === roundNum) entry.maxHolesThisRound = Math.max(entry.maxHolesThisRound, hp);
    }
  }

  const players = Object.values(byPlayer);
  // Sort by total tournament points descending
  players.sort((a, b) => b.totalPts - a.totalPts);

  const showAdj = adjustments && adjustments.length > 0;

  // Update hero subtitle
  const subtitleEl = document.getElementById('thbl-subtitle');
  if (subtitleEl) {
    if (isMultiRound) {
      const completedRounds = new Set(rounds.map(r => r.round ?? 1)).size;
      const allDone = completedRounds >= numRounds;
      subtitleEl.textContent = allDone
        ? `Tournament total — ${numRounds} rounds`
        : `Tournament total (R${completedRounds} of ${numRounds} complete)`;
    } else {
      subtitleEl.textContent = `Round ${roundNum} scores`;
    }
  }

  // Column headers — always render numRounds columns in multi-round mode
  let ptsHdr;
  if (isMultiRound) {
    ptsHdr = Array.from({ length: numRounds }, (_, i) => {
      const rn = i + 1;
      const isLive = rn === roundNum;
      const style = isLive
        ? `${_thStyle()};color:var(--accent,#3b82f6);`
        : _thStyle();
      return `<th style="${style}">R${rn}</th>`;
    }).join('') + `<th style="${_thStyle()}">Tot</th>`;
  } else {
    ptsHdr = `<th style="${_thStyle()}">Pts</th>`;
  }

  const rows = players.map((p, rank) => {
    const badge = rank === 0 ? '🥇' : rank === 1 ? '🥈' : rank === 2 ? '🥉' : `${rank+1}`;
    const adj   = adjByName[p.name];

    // Show holes-played note for the current round if not complete
    const curRoundEntry = p.roundMap[roundNum];
    const curHoles = curRoundEntry?.holesPlayed ?? 18;
    const thruNote = curHoles < 18
      ? ` <span style="font-size:0.7rem;color:var(--text-muted);">(thru ${curHoles})</span>`
      : '';

    // Adjustment cell
    let adjCell = '';
    if (showAdj) {
      if (adj && !adj.excluded) {
        const sign  = adj.delta < 0 ? '' : '+';
        const color = adj.delta < 0 ? '#e53e3e' : '#38a169';
        adjCell = `<td style="${_tdStyle()};color:${color};font-weight:800;">${sign}${adj.delta.toFixed(1)}</td>`;
      } else {
        adjCell = `<td style="${_tdStyle()};color:var(--text-muted);">–</td>`;
      }
    }

    // Score cells
    let ptsCells;
    if (isMultiRound) {
      ptsCells = Array.from({ length: numRounds }, (_, i) => {
        const rn = i + 1;
        const rd = p.roundMap[rn];
        const isLive = rn === roundNum;
        const style = isLive
          ? `${_tdStyle()};color:var(--accent,#3b82f6);`
          : _tdStyle();
        if (rd) {
          return `<td style="${style}">${rd.pts}</td>`;
        } else {
          // Round not yet played
          return `<td style="${_tdStyle()};color:var(--text-muted);">–</td>`;
        }
      }).join('') + `<td style="${_tdStyle(true)}">${p.totalPts}</td>`;
    } else {
      ptsCells = `<td style="${_tdStyle(true)}">${p.totalPts}</td>`;
    }

    return `<tr style="border-bottom:1px solid var(--border,rgba(0,0,0,0.07));">
      <td style="${_tdStyle()}">${badge}</td>
      <td style="padding:0.65rem 0.5rem;font-size:0.88rem;font-weight:700;color:var(--text-dark);">
        ${p.name}${thruNote}
      </td>
      ${adjCell}
      ${ptsCells}
    </tr>`;
  }).join('');

  const adjHdr = showAdj ? `<th style="${_thStyle()}">Cut</th>` : '';

  const liveNote = isMultiRound
    ? `<p style="font-size:0.72rem;color:var(--accent,#3b82f6);text-align:center;padding:0.25rem 0 0;">Current round (R${roundNum}) shown in blue</p>`
    : '';

  tableEl.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-family:'Plus Jakarta Sans',sans-serif;">
      <thead>
        <tr style="background:var(--surface2,rgba(0,0,0,0.06));border-bottom:2px solid var(--border,rgba(0,0,0,0.1));">
          <th style="${_thStyle()}">#</th>
          <th style="padding:0.5rem;text-align:left;font-size:0.72rem;font-weight:800;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-muted);">Player</th>
          ${adjHdr}
          ${ptsHdr}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${liveNote}
    ${showAdj ? `<p style="font-size:0.72rem;color:var(--text-muted);text-align:center;padding:0.5rem 0 0;">Cut = handicap adjustment applied for this round</p>` : ''}`;
}

function _thStyle() {
  return 'padding:0.5rem;text-align:center;font-size:0.72rem;font-weight:800;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-muted);';
}
function _tdStyle(bold) {
  return `padding:0.65rem 0.5rem;text-align:center;font-size:${bold ? '1rem' : '0.88rem'};font-weight:${bold ? '800' : '600'};color:var(--text-dark);`;
}

// Wire the back button on the hub leaderboard screen
document.getElementById('btn-thbl-back-detail')?.addEventListener('click', () => showTournamentHub());
