// ================================================================
// LEADERBOARD — cloudflare-worker.js
// Deploy this as the Cloudflare Worker at:
//   https://leaderboardsync.sw-77d.workers.dev
//
// KV Namespace required:
//   Binding name: COURSE_LIBRARY
//   Add in Cloudflare dashboard → Workers → leaderboardsync → Settings → Variables → KV Namespace Bindings
//
// All existing game-code routes are preserved unchanged.
// New routes added in Stage 7:
//   GET  /courses              — list approved courses (paginated)
//   GET  /courses/:id          — get single course by sharedId
//   POST /courses/submit       — submit a course to the pending queue
//   GET  /admin/courses/pending — list pending courses (admin only)
//   POST /admin/courses/approve/:id — approve a pending course
//   PUT  /admin/courses/:id    — edit an approved course
//
// Admin routes require the header: X-Admin-Key: <ADMIN_SECRET env var>
// ================================================================

// ── CORS headers ─────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Organiser-Secret',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

// ── Generate a permanent short course ID ─────────────────────────
// Format: c_XXXXXXXX  (8 lowercase alphanumeric chars)
function genCourseId() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o/1/i/l ambiguity
  let id = 'c_';
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  for (const b of arr) id += chars[b % chars.length];
  return id;
}

// ── Admin auth ───────────────────────────────────────────────────
function isAdmin(request, env) {
  return request.headers.get('X-Admin-Key') === env.ADMIN_SECRET;
}

// ── Organiser auth ───────────────────────────────────────────────
// The organiser's device sends X-Organiser-Secret (the raw 16-char secret).
// We SHA-256 it and compare against the hash stored in the tournament record.
async function isOrganiser(request, tournRecord) {
  const secret = request.headers.get('X-Organiser-Secret');
  if (!secret || !tournRecord?.organiserHash) return false;
  const encoded = new TextEncoder().encode(secret);
  const hashBuf = await crypto.subtle.digest('SHA-256', encoded);
  const hashHex = Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex === tournRecord.organiserHash;
}

// ── Generate a tournament player ID ──────────────────────────────
// Format: P-XXXXXXXX  (8 lowercase alphanumeric chars)
function genPlayerId() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const arr   = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return 'P-' + Array.from(arr, b => chars[b % chars.length]).join('');
}

// ── Tournament TTL helpers ────────────────────────────────────────
// Map duration label → seconds; add 30-day grace period after expiry.
const DURATION_MAP = {
  '1w':  7   * 24 * 3600,
  '1m':  30  * 24 * 3600,
  '3m':  90  * 24 * 3600,
  '6m':  180 * 24 * 3600,
  '12m': 365 * 24 * 3600,
};
const GRACE_SECS = 30 * 24 * 3600; // 30 days after expiry before KV purges

// ── Generate a random share code ─────────────────────────────────
// Format: N uppercase alphanumeric chars, no 0/O/1/I ambiguity
function makeCode(n) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const arr   = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => chars[b % chars.length]).join('');
}

// ================================================================
// MAIN HANDLER
// ================================================================
export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── NEW: Course library routes ────────────────────────────────

    // GET /courses — list approved courses
    if (method === 'GET' && path === '/courses') {
      return handleCourseList(request, env, url);
    }

    // POST /courses/submit — submit to pending queue
    if (method === 'POST' && path === '/courses/submit') {
      return handleCourseSubmit(request, env);
    }

    // GET /courses/:id — single approved course
    if (method === 'GET' && path.startsWith('/courses/') && path.split('/').length === 3) {
      const id = path.split('/')[2];
      return handleCourseGet(id, env);
    }

    // POST /players — upload player list, return share code
    if (method === 'POST' && path === '/players') {
      return handlePlayersUpload(request, env);
    }

    // GET /players/:code — retrieve shared player list
    if (method === 'GET' && path.startsWith('/players/') && path.split('/').length === 3) {
      return handlePlayersDownload(path.split('/')[2].toUpperCase(), env);
    }

    // ── Admin: KV key listing (for admin-codes.html) ──────────────
    if (path === '/admin/kv-list') {
      if (!isAdmin(request, env)) return err('Unauthorized', 401);
      return handleAdminKvList(request, env, url);
    }

    // ── Admin: KV single-key read (for admin-codes.html) ─────────
    if (path === '/admin/kv-get') {
      if (!isAdmin(request, env)) return err('Unauthorized', 401);
      return handleAdminKvGet(request, env, url);
    }

    // Admin routes
    if (path.startsWith('/admin/courses')) {
      if (!isAdmin(request, env)) return err('Unauthorized', 401);

      // GET /admin/courses/pending
      if (method === 'GET' && path === '/admin/courses/pending') {
        return handleAdminPending(env, url);
      }

      // POST /admin/courses/approve/:id
      if (method === 'POST' && path.match(/^\/admin\/courses\/approve\/[^/]+$/)) {
        const id = path.split('/').pop();
        return handleAdminApprove(id, request, env);
      }

      // PUT /admin/courses/pending/:id — edit a pending course
      if (method === 'PUT' && path.match(/^\/admin\/courses\/pending\/[^/]+$/)) {
        const id = path.split('/').pop();
        return handleAdminEditPending(id, request, env);
      }

      // PUT /admin/courses/:id — edit an approved course
      if (method === 'PUT' && path.match(/^\/admin\/courses\/[^/]+$/)) {
        const id = path.split('/').pop();
        return handleAdminEdit(id, request, env);
      }

      // DELETE /admin/courses/pending/:id — delete a pending course
      if (method === 'DELETE' && path.match(/^\/admin\/courses\/pending\/[^/]+$/)) {
        const id = path.split('/').pop();
        return handleAdminDeletePending(id, env);
      }

      // DELETE /admin/courses/:id — delete an approved course
      if (method === 'DELETE' && path.match(/^\/admin\/courses\/[^/]+$/)) {
        const id = path.split('/').pop();
        return handleAdminDeleteApproved(id, env);
      }

      return err('Not found', 404);
    }

    // ── Route: health check ───────────────────────────────────────
    if (path === '/' || path === '/health') {
      return json({ ok: true, service: 'leaderboardsync' });
    }

    // ── POST /game — store a game setup, return a share code ──────
    if (method === 'POST' && path === '/game') {
      return handleGameCreate(request, env);
    }

    // ── GET /game/:code — retrieve a stored game setup ────────────
    if (method === 'GET' && path.startsWith('/game/') && path.split('/').length === 3) {
      return handleGameGet(path.split('/')[2].toUpperCase(), env);
    }

    // ── PUT /scores/:code — push/merge group scores for a game ────
    if (method === 'PUT' && path.startsWith('/scores/') && path.split('/').length === 3) {
      return handleScoresPut(path.split('/')[2].toUpperCase(), request, env);
    }

    // ── GET /scores/:code — retrieve all group scores for a game ──
    if (method === 'GET' && path.startsWith('/scores/') && path.split('/').length === 3) {
      return handleScoresGet(path.split('/')[2].toUpperCase(), env);
    }

    // ── Tournament routes ─────────────────────────────────────────

    // POST /tournament — create a new tournament
    if (method === 'POST' && path === '/tournament') {
      return handleTournamentCreate(request, env);
    }

    // GET /tournament/:code — fetch tournament details
    if (method === 'GET' && path.match(/^\/tournament\/[A-Z0-9]+$/)) {
      return handleTournamentGet(path.split('/')[2], env);
    }

    // PUT /tournament/:code — update tournament (organiser only)
    if (method === 'PUT' && path.match(/^\/tournament\/[A-Z0-9]+$/)) {
      return handleTournamentUpdate(path.split('/')[2], request, env);
    }

    // POST /tournament/:code/finalise/:round — finalise a round (organiser only)
    if (method === 'POST' && path.match(/^\/tournament\/[A-Z0-9]+\/finalise\/\d+$/)) {
      const parts = path.split('/');
      return handleRoundFinalise(parts[2], parseInt(parts[4], 10), request, env);
    }

    // GET /roster/:code — fetch roster
    if (method === 'GET' && path.match(/^\/roster\/[A-Z0-9]+$/)) {
      return handleRosterGet(path.split('/')[2], env);
    }

    // POST /roster/:code — create roster (organiser only, called at tournament creation)
    if (method === 'POST' && path.match(/^\/roster\/[A-Z0-9]+$/)) {
      return handleRosterCreate(path.split('/')[2], request, env);
    }

    // POST /roster/:code/add — add a player to an existing roster (organiser only)
    if (method === 'POST' && path.match(/^\/roster\/[A-Z0-9]+\/add$/)) {
      return handleRosterAddPlayer(path.split('/')[2], request, env);
    }

    // POST /roster/:code/adjust — manual handicap adjustment (organiser only)
    if (method === 'POST' && path.match(/^\/roster\/[A-Z0-9]+\/adjust$/)) {
      return handleRosterAdjust(path.split('/')[2], request, env);
    }

    return err('Not found', 404);
  },
};

// ================================================================
// COURSE LIBRARY HANDLERS
// ================================================================

// KV key patterns:
//   course:approved:<id>   — approved course record
//   course:pending:<id>    — pending course record
//   course:index           — JSON array of approved ids (for listing)
//   course:pending:index   — JSON array of pending ids

async function handleCourseList(request, env, url) {
  if (!env.COURSE_LIBRARY) return err('KV not configured', 503);

  const q       = (url.searchParams.get('q') ?? '').toLowerCase().trim();
  const cursor  = url.searchParams.get('cursor') ?? undefined;
  const limit   = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);

  // List all approved keys
  const listResult = await env.COURSE_LIBRARY.list({ prefix: 'course:approved:', cursor, limit });
  const keys       = listResult.keys.map(k => k.name);

  // Fetch each course
  const courses = await Promise.all(
    keys.map(k => env.COURSE_LIBRARY.get(k, { type: 'json' }))
  );

  // Filter by search query if provided
  let results = courses.filter(Boolean);
  if (q) {
    results = results.filter(c =>
      (c.name     ?? '').toLowerCase().includes(q) ||
      (c.location ?? '').toLowerCase().includes(q) ||
      (c.town     ?? '').toLowerCase().includes(q) ||
      (c.country  ?? '').toLowerCase().includes(q)
    );
  }

  return json({
    courses:    results,
    cursor:     listResult.list_complete ? null : listResult.cursor,
    complete:   listResult.list_complete,
  });
}

async function handleCourseGet(id, env) {
  if (!env.COURSE_LIBRARY) return err('KV not configured', 503);
  const course = await env.COURSE_LIBRARY.get('course:approved:' + id, { type: 'json' });
  if (!course) return err('Course not found', 404);
  return json(course);
}

async function handleCourseSubmit(request, env) {
  if (!env.COURSE_LIBRARY) return err('KV not configured', 503);

  let body;
  try { body = await request.json(); }
  catch { return err('Invalid JSON'); }

  // Basic validation
  if (!body.name || typeof body.name !== 'string') return err('name required');
  if (!Array.isArray(body.tees) || body.tees.length === 0) return err('tees array required');

  const id = genCourseId();
  const record = {
    id,
    name:         body.name.trim(),
    location:     body.location ?? null,
    town:         body.town     ?? null,
    country:      body.country  ?? null,
    tees:         body.tees,
    status:       'pending',
    submittedAt:  body.submittedAt ?? new Date().toISOString(),
    approvedAt:   null,
    version:      1,
  };

  await env.COURSE_LIBRARY.put('course:pending:' + id, JSON.stringify(record));

  return json({ id, status: 'pending', version: 1 }, 201);
}

async function handleAdminPending(env, url) {
  if (!env.COURSE_LIBRARY) return err('KV not configured', 503);

  const cursor = url.searchParams.get('cursor') ?? undefined;
  const limit  = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);

  const listResult = await env.COURSE_LIBRARY.list({ prefix: 'course:pending:', cursor, limit });
  // Exclude the index key — it's a JSON array, not a course record
  const keys       = listResult.keys.map(k => k.name).filter(k => k !== 'course:pending:index');

  const courses = await Promise.all(
    keys.map(k => env.COURSE_LIBRARY.get(k, { type: 'json' }))
  );

  return json({
    courses:  courses.filter(Boolean),
    cursor:   listResult.list_complete ? null : listResult.cursor,
    complete: listResult.list_complete,
  });
}

async function handleAdminApprove(id, request, env) {
  if (!env.COURSE_LIBRARY) return err('KV not configured', 503);

  const pending = await env.COURSE_LIBRARY.get('course:pending:' + id, { type: 'json' });
  if (!pending) return err('Pending course not found', 404);

  // Optional override from request body (admin can fix typos before approving)
  let overrides = {};
  try { overrides = await request.json(); } catch { /* no body — fine */ }

  const approved = {
    ...pending,
    ...overrides,
    id,
    status:     'approved',
    approvedAt: new Date().toISOString(),
  };

  // Move from pending → approved
  await env.COURSE_LIBRARY.put('course:approved:' + id, JSON.stringify(approved));
  await env.COURSE_LIBRARY.delete('course:pending:' + id);

  return json({ id, status: 'approved' });
}

async function handleAdminEdit(id, request, env) {
  if (!env.COURSE_LIBRARY) return err('KV not configured', 503);

  const existing = await env.COURSE_LIBRARY.get('course:approved:' + id, { type: 'json' });
  if (!existing) return err('Approved course not found', 404);

  let updates;
  try { updates = await request.json(); }
  catch { return err('Invalid JSON'); }

  const updated = {
    ...existing,
    ...updates,
    id,                                   // id is immutable
    status:    'approved',                // status is immutable via this route
    version:   (existing.version ?? 1) + 1,
    updatedAt: new Date().toISOString(),
  };

  await env.COURSE_LIBRARY.put('course:approved:' + id, JSON.stringify(updated));

  return json({ id, version: updated.version });
}

async function handleAdminEditPending(id, request, env) {
  if (!env.COURSE_LIBRARY) return err('KV not configured', 503);

  const existing = await env.COURSE_LIBRARY.get('course:pending:' + id, { type: 'json' });
  if (!existing) return err('Pending course not found', 404);

  let updates;
  try { updates = await request.json(); }
  catch { return err('Invalid JSON'); }

  const updated = {
    ...existing,
    ...updates,
    id,
    status:    'pending',
    updatedAt: new Date().toISOString(),
  };

  await env.COURSE_LIBRARY.put('course:pending:' + id, JSON.stringify(updated));

  return json({ id });
}

async function handleAdminDeletePending(id, env) {
  if (!env.COURSE_LIBRARY) return err('KV not configured', 503);
  const existing = await env.COURSE_LIBRARY.get('course:pending:' + id, { type: 'json' });
  if (!existing) return err('Pending course not found', 404);
  await env.COURSE_LIBRARY.delete('course:pending:' + id);
  return json({ id, deleted: true });
}

async function handleAdminDeleteApproved(id, env) {
  if (!env.COURSE_LIBRARY) return err('KV not configured', 503);
  const existing = await env.COURSE_LIBRARY.get('course:approved:' + id, { type: 'json' });
  if (!existing) return err('Approved course not found', 404);
  await env.COURSE_LIBRARY.delete('course:approved:' + id);
  return json({ id, deleted: true });
}

// ================================================================
// GAME SETUP HANDLERS
// ================================================================

async function handleGameCreate(request, env) {
  if (!env.GAMES) return err('KV not configured', 503);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const ttlHours = typeof body.ttlHours === 'number' && body.ttlHours > 0
    ? body.ttlHours
    : 24;
  const ttlSecs = Math.min(ttlHours * 3600, 366 * 24 * 3600); // cap at 366 days

  const code = makeCode(6);
  const record = {
    code,
    course:    body.course  ?? null,
    format:    body.format  ?? null,
    players:   body.players ?? [],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlSecs * 1000).toISOString(),
  };

  await env.GAMES.put('game:' + code, JSON.stringify(record), { expirationTtl: ttlSecs });
  return json({ code, expiresAt: record.expiresAt }, 201);
}

async function handleGameGet(code, env) {
  if (!env.GAMES) return err('KV not configured', 503);
  const raw = await env.GAMES.get('game:' + code);
  if (!raw) return err('Code not found or expired', 404);
  return json(JSON.parse(raw));
}

// ================================================================
// SCORES HANDLERS
// ================================================================
// Scores are stored per-group under: scores:<code>:<round>:<groupId>
// (round is included in the key so multi-round tournaments don't overwrite)
// Each group's record: { code, round, group, players:[...], updatedAt }
// TTL matches the game's ttlHours (default 90 days) but we use a fixed
// 90-day TTL here since we don't look up the game record on every push.
//
// Legacy keys (scores:<code>:<groupId>) are also listed on GET so old data
// still appears — they lack a round prefix and are treated as round 1.

const SCORES_TTL = 90 * 24 * 3600; // 90 days in seconds

async function handleScoresPut(code, request, env) {
  if (!env.GAMES) return err('KV not configured', 503);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const rounds = body.rounds;
  if (!Array.isArray(rounds) || rounds.length === 0) return err('rounds array required');

  // Store each group's scores separately so multiple groups can push independently.
  // Key includes round number so tournament rounds never overwrite each other.
  await Promise.all(rounds.map(r => {
    const roundNum = r.round ?? 1;
    const groupId  = String(r.group ?? 'default').slice(0, 60);
    const record = {
      code,
      round:     roundNum,
      group:     groupId,
      players:   r.players ?? [],
      updatedAt: new Date().toISOString(),
    };
    return env.GAMES.put(
      `scores:${code}:r${roundNum}:${groupId}`,
      JSON.stringify(record),
      { expirationTtl: SCORES_TTL }
    );
  }));

  // If this is a hub tournament, mark the round as inProgress so the
  // detail screen shows live status and finalise is allowed.
  try {
    const tournRecord = await env.GAMES.get('tourn:' + code, { type: 'json' });
    if (tournRecord?.rounds) {
      let changed = false;
      const roundNums = [...new Set(rounds.map(r => r.round ?? 1))];
      const updatedRounds = tournRecord.rounds.map(r => {
        if (roundNums.includes(r.roundNum) && r.status === 'scheduled') {
          changed = true;
          return { ...r, status: 'inProgress', startedAt: Date.now() };
        }
        return r;
      });
      if (changed) {
        await env.GAMES.put('tourn:' + code, JSON.stringify({ ...tournRecord, rounds: updatedRounds }), { expirationTtl: SCORES_TTL });
      }
    }
  } catch {}

  return json({ ok: true, stored: rounds.length });
}

async function handleScoresGet(code, env) {
  if (!env.GAMES) return err('KV not configured', 503);

  // List all group entries for this code
  const listResult = await env.GAMES.list({ prefix: `scores:${code}:` });
  if (!listResult.keys.length) return err('No scores found for this code', 404);

  const records = await Promise.all(
    listResult.keys.map(k => env.GAMES.get(k.name, { type: 'json' }))
  );

  return json({ rounds: records.filter(Boolean) });
}

// ================================================================
// PLAYER SHARE HANDLERS (Stage 8)
// ================================================================

async function handlePlayersUpload(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }
  if (!Array.isArray(body.players) || body.players.length === 0) return err('players array required');

  const code   = makeCode(6);
  const ttl    = 24 * 3600; // 24 hours
  const record = {
    code,
    players:   body.players,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
  };

  await env.GAMES.put('players:' + code, JSON.stringify(record), { expirationTtl: ttl });
  return json({ code, expiresAt: record.expiresAt }, 201);
}

async function handlePlayersDownload(code, env) {
  const raw = await env.GAMES.get('players:' + code);
  if (!raw) return err('Code not found or expired', 404);
  const record = JSON.parse(raw);
  return json({ players: record.players, expiresAt: record.expiresAt });
}

// ================================================================
// ADMIN KV INSPECTION HANDLERS (for admin-codes.html)
// ================================================================

// GET /admin/kv-list?prefix=<prefix>
// Returns all KV keys under the given prefix (no values).
// Used by admin-codes.html to enumerate game: and scores: keys.
async function handleAdminKvList(request, env, url) {
  if (!env.GAMES) return err('KV not configured', 503);

  const prefix = url.searchParams.get('prefix') ?? '';
  // Only allow safe prefixes — prevent full KV dumps
  const allowed = ['game:', 'scores:', 'players:'];
  if (!allowed.some(p => prefix.startsWith(p) || prefix === p.replace(':', '') || prefix === '')) {
    return err('Prefix not allowed', 400);
  }

  const keys   = [];
  let cursor   = undefined;
  let complete = false;

  // Page through all keys (up to 1000)
  while (!complete && keys.length < 1000) {
    const result = await env.GAMES.list({ prefix, cursor, limit: 200 });
    result.keys.forEach(k => keys.push(k.name));
    complete = result.list_complete;
    cursor   = result.cursor;
  }

  return json({ keys, count: keys.length });
}

// GET /admin/kv-get?key=<full-kv-key>
// Returns the JSON value stored at a single KV key.
// Only game: keys are allowed (scores: are too large to be useful individually).
async function handleAdminKvGet(request, env, url) {
  if (!env.GAMES) return err('KV not configured', 503);

  const key = url.searchParams.get('key') ?? '';
  if (!key.startsWith('game:')) return err('Only game: keys can be retrieved', 400);

  const raw = await env.GAMES.get(key);
  if (!raw) return err('Key not found', 404);

  try {
    return json(JSON.parse(raw));
  } catch {
    return json({ raw });
  }
}

// ================================================================
// TOURNAMENT HANDLERS
// ================================================================
//
// KV key patterns (all in GAMES namespace):
//   tourn:<CODE>              — tournament master record
//   roster:<CODE>             — persistent player roster
//   roster:<CODE>:adj:<ROUND> — stored adjustment results per round
//                               (existence = already applied; idempotency key)
//
// Tournament master record shape:
//   { code, name, format, hcpMode, hcpStrength, totalRounds, currentRound,
//     courses: [{ roundNum, courseId }], status, expiresAt, createdAt,
//     organiserHash, rounds: [{ roundNum, status, groupIds, courseId,
//     startedAt, finalisedAt }] }
//
// Roster record shape:
//   { code, players: [{ playerId, name, originalHcp, adjustedHcp,
//     teamId|null, adjustments: [{ round, before, after, delta, mean }] }],
//     updatedAt }

async function handleTournamentCreate(request, env) {
  if (!env.GAMES) return err('KV not configured', 503);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  // Required fields
  if (!body.name || typeof body.name !== 'string') return err('name required');
  if (!body.duration || !DURATION_MAP[body.duration])
    return err('duration must be one of: ' + Object.keys(DURATION_MAP).join(', '));
  if (!body.format) return err('format required');
  if (!body.organiserHash || typeof body.organiserHash !== 'string')
    return err('organiserHash required');

  const totalRounds = Math.max(1, Math.min(parseInt(body.totalRounds ?? 1, 10), 52));
  const ttlSecs     = DURATION_MAP[body.duration] + GRACE_SECS;
  const expiresAt   = Date.now() + DURATION_MAP[body.duration] * 1000;

  const code = makeCode(6);

  // Build initial rounds array
  const roundsArr = [];
  for (let i = 1; i <= totalRounds; i++) {
    roundsArr.push({
      roundNum:     i,
      status:       'scheduled',  // scheduled | inProgress | awaitingFinalisation | finalised
      groupIds:     [],
      courseId:     body.courses?.[i - 1]?.courseId ?? null,
      startedAt:    null,
      finalisedAt:  null,
    });
  }

  const record = {
    code,
    name:          body.name.trim(),
    format:        body.format,
    hcpMode:       body.hcpMode       ?? 'none',   // none | manual | auto
    hcpStrength:   body.hcpStrength   ?? 3,         // 2 | 3 | 4 (auto only)
    totalRounds,
    currentRound:  1,
    courses:       body.courses       ?? [],
    status:        'upcoming',  // upcoming | active | completed | expired
    organiserHash: body.organiserHash,
    expiresAt,
    createdAt:     Date.now(),
    rounds:        roundsArr,
  };

  await env.GAMES.put('tourn:' + code, JSON.stringify(record), { expirationTtl: ttlSecs });
  return json({ code, expiresAt }, 201);
}

async function handleTournamentGet(code, env) {
  if (!env.GAMES) return err('KV not configured', 503);
  const record = await env.GAMES.get('tourn:' + code, { type: 'json' });
  if (!record) return err('Tournament not found or expired', 404);
  // Never expose organiserHash to clients
  const { organiserHash: _oh, ...safe } = record;
  return json(safe);
}

async function handleTournamentUpdate(code, request, env) {
  if (!env.GAMES) return err('KV not configured', 503);
  const record = await env.GAMES.get('tourn:' + code, { type: 'json' });
  if (!record) return err('Tournament not found', 404);
  if (!await isOrganiser(request, record)) return err('Unauthorized', 401);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  // Only allow safe fields to be updated
  const allowed = ['name', 'status', 'currentRound', 'courses', 'hcpMode', 'hcpStrength', 'rounds'];
  const updates = {};
  for (const k of allowed) {
    if (k in body) updates[k] = body[k];
  }

  const ttlRemaining = Math.max(1, Math.floor((record.expiresAt - Date.now()) / 1000) + GRACE_SECS);
  const updated = { ...record, ...updates, updatedAt: Date.now() };
  await env.GAMES.put('tourn:' + code, JSON.stringify(updated), { expirationTtl: ttlRemaining });
  return json({ ok: true });
}

// ── Round finalisation ────────────────────────────────────────────
// Worker-authoritative: all handicap adjustment logic lives here.
// Idempotency: if roster:<CODE>:adj:<ROUND> already exists, return
// its stored results without recalculating.
async function handleRoundFinalise(code, roundNum, request, env) {
  if (!env.GAMES) return err('KV not configured', 503);

  const record = await env.GAMES.get('tourn:' + code, { type: 'json' });
  if (!record) return err('Tournament not found', 404);
  if (!await isOrganiser(request, record)) return err('Unauthorized', 401);

  const roundMeta = record.rounds?.find(r => r.roundNum === roundNum);
  if (!roundMeta) return err('Round not found', 404);
  // Allow finalising even if still 'scheduled' — scores may have been pushed
  // without an explicit round-start step (hub tournament flow).
  if (roundMeta.status === 'finalised') {
    // Already done — return cached result if available
    const adjKey = `roster:${code}:adj:${roundNum}`;
    const existingAdj = await env.GAMES.get(adjKey, { type: 'json' });
    if (existingAdj) return json({ ok: true, adjustments: existingAdj.adjustments, cached: true });
  }

  let body;
  try { body = await request.json(); } catch { body = {}; }
  const force = !!body.force;

  // ── Idempotency check ─────────────────────────────────────────
  const adjKey     = `roster:${code}:adj:${roundNum}`;
  const existingAdj = await env.GAMES.get(adjKey, { type: 'json' });
  if (existingAdj) {
    // Already finalised — return stored results
    return json({ ok: true, adjustments: existingAdj.adjustments, cached: true });
  }

  // ── Collect submitted scores for this round ───────────────────
  const listResult = await env.GAMES.list({ prefix: `scores:${code}:r${roundNum}:` });
  const groupRecords = await Promise.all(
    listResult.keys.map(k => env.GAMES.get(k.name, { type: 'json' }))
  );
  const allGroups = groupRecords.filter(Boolean);

  // Flatten to per-player scores: last submitted score wins for same playerId+round
  const playerScoreMap = new Map();
  for (const group of allGroups) {
    for (const p of (group.players ?? [])) {
      if (!p.playerId) continue;
      const existing = playerScoreMap.get(p.playerId);
      // Keep most recently updated
      if (!existing || group.updatedAt > (existing._updatedAt ?? '')) {
        playerScoreMap.set(p.playerId, { ...p, _updatedAt: group.updatedAt });
      }
    }
  }

  // Fetch roster
  const roster = await env.GAMES.get('roster:' + code, { type: 'json' });
  if (!roster) return err('Roster not found', 404);

  // ── Determine valid scores (completed all 18 holes, not DNF) ──
  // A player is valid if holesPlayed === 18 (or holes array length 18 with all scored).
  const validScores = [];
  const excludedPlayers = [];

  for (const rp of roster.players) {
    const submitted = playerScoreMap.get(rp.playerId);
    if (!submitted) {
      excludedPlayers.push({ playerId: rp.playerId, name: rp.name, reason: 'no_score' });
      continue;
    }
    const holesPlayed = submitted.holesPlayed
      ?? (Array.isArray(submitted.holes) ? submitted.holes.filter(h => h != null).length : 0);
    if (holesPlayed < 18) {
      excludedPlayers.push({ playerId: rp.playerId, name: rp.name, reason: 'incomplete' });
      continue;
    }
    validScores.push({ playerId: rp.playerId, name: rp.name, points: submitted.points ?? 0 });
  }

  // ── Force-finalise confirmation gate ─────────────────────────
  // If there are excluded players and force is not set, return a preview
  // so the client can show the confirmation UI.
  if (excludedPlayers.length > 0 && !force) {
    const mean = validScores.length >= 2
      ? validScores.reduce((s, p) => s + p.points, 0) / validScores.length
      : null;
    return json({
      ok:              false,
      requiresConfirm: true,
      excluded:        excludedPlayers,
      validCount:      validScores.length,
      meanPreview:     mean !== null ? Math.round(mean * 10) / 10 : null,
    }, 200);
  }

  // ── Compute adjustments (auto mode, not the final round) ──────
  let adjustments = [];
  const isAutoMode   = record.hcpMode === 'auto';
  const isFinalRound = roundNum >= record.totalRounds;

  if (isAutoMode && !isFinalRound) {
    if (validScores.length < 2) {
      // Not enough scores — skip adjustment, record warning
      adjustments = [];
    } else {
      const mean     = validScores.reduce((s, p) => s + p.points, 0) / validScores.length;
      const strength = record.hcpStrength ?? 3;

      adjustments = roster.players.map(rp => {
        const valid = validScores.find(v => v.playerId === rp.playerId);
        if (!valid) {
          // Excluded player — no adjustment
          return {
            playerId:    rp.playerId,
            name:        rp.name,
            before:      rp.adjustedHcp,
            after:       rp.adjustedHcp,
            delta:       0,
            mean:        Math.round(mean * 10) / 10,
            excluded:    true,
          };
        }
        // Adjustment = (mean - playerPoints) / strength, rounded to 1 d.p.
        const rawDelta   = (mean - valid.points) / strength;
        const delta      = Math.round(rawDelta * 10) / 10;
        const before     = rp.adjustedHcp;
        const after      = Math.round((before + delta) * 10) / 10;
        return {
          playerId: rp.playerId,
          name:     rp.name,
          before,
          after,
          delta,
          mean:     Math.round(mean * 10) / 10,
          excluded: false,
        };
      });

      // Apply adjusted indices back to the roster
      const updatedPlayers = roster.players.map(rp => {
        const adj = adjustments.find(a => a.playerId === rp.playerId);
        if (!adj || adj.excluded) return rp;
        return {
          ...rp,
          adjustedHcp: adj.after,
          adjustments: [
            ...(rp.adjustments ?? []),
            { round: roundNum, before: adj.before, after: adj.after, delta: adj.delta, mean: adj.mean },
          ],
        };
      });

      // Update roster with new adjusted indices
      const ttlRemaining = Math.max(1, Math.floor((record.expiresAt - Date.now()) / 1000) + GRACE_SECS);
      const updatedRoster = { ...roster, players: updatedPlayers, updatedAt: Date.now() };
      await env.GAMES.put('roster:' + code, JSON.stringify(updatedRoster), { expirationTtl: ttlRemaining });
    }
  }

  // ── Store adjustment results (idempotency key) ────────────────
  const adjRecord = { adjustments, finalisedAt: Date.now(), roundNum, code };
  const ttlRemaining = Math.max(1, Math.floor((record.expiresAt - Date.now()) / 1000) + GRACE_SECS);
  await env.GAMES.put(adjKey, JSON.stringify(adjRecord), { expirationTtl: ttlRemaining });

  // ── Mark round as finalised in tournament record ──────────────
  const updatedRounds = record.rounds.map(r =>
    r.roundNum === roundNum
      ? { ...r, status: 'finalised', finalisedAt: Date.now() }
      : r
  );
  // Advance currentRound if this is the current one and not the last
  const nextRound = (!isFinalRound && record.currentRound === roundNum)
    ? roundNum + 1
    : record.currentRound;
  const tournStatus = isFinalRound ? 'completed' : record.status;

  const updatedRecord = {
    ...record,
    rounds:       updatedRounds,
    currentRound: nextRound,
    status:       tournStatus,
    updatedAt:    Date.now(),
  };
  await env.GAMES.put('tourn:' + code, JSON.stringify(updatedRecord), { expirationTtl: ttlRemaining });

  return json({ ok: true, adjustments, excluded: excludedPlayers });
}

// ================================================================
// ROSTER HANDLERS
// ================================================================

async function handleRosterGet(code, env) {
  if (!env.GAMES) return err('KV not configured', 503);
  const roster = await env.GAMES.get('roster:' + code, { type: 'json' });
  if (!roster) return err('Roster not found', 404);
  return json(roster);
}

async function handleRosterCreate(code, request, env) {
  if (!env.GAMES) return err('KV not configured', 503);

  // Verify tournament exists and caller is organiser
  const record = await env.GAMES.get('tourn:' + code, { type: 'json' });
  if (!record) return err('Tournament not found', 404);
  if (!await isOrganiser(request, record)) return err('Unauthorized', 401);

  // Check roster doesn't already exist
  const existing = await env.GAMES.get('roster:' + code, { type: 'json' });
  if (existing) return err('Roster already exists; use /roster/:code/add to add players', 409);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }
  if (!Array.isArray(body.players)) return err('players array required');

  // Assign persistent player IDs to each player
  const players = body.players.map(p => ({
    playerId:    genPlayerId(),
    name:        String(p.name ?? '').trim(),
    originalHcp: p.handicapIndex ?? p.originalHcp ?? 0,
    adjustedHcp: p.handicapIndex ?? p.originalHcp ?? 0,
    teamId:      p.teamId ?? null,
    friendsId:   p.friendsId ?? null,  // local Friends record reference
    adjustments: [],
  }));

  const roster = {
    code,
    players,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const ttlRemaining = Math.max(1, Math.floor((record.expiresAt - Date.now()) / 1000) + GRACE_SECS);
  await env.GAMES.put('roster:' + code, JSON.stringify(roster), { expirationTtl: ttlRemaining });
  return json({ ok: true, players: players.map(p => ({ playerId: p.playerId, name: p.name })) }, 201);
}

async function handleRosterAddPlayer(code, request, env) {
  if (!env.GAMES) return err('KV not configured', 503);

  const record = await env.GAMES.get('tourn:' + code, { type: 'json' });
  if (!record) return err('Tournament not found', 404);
  if (!await isOrganiser(request, record)) return err('Unauthorized', 401);

  const roster = await env.GAMES.get('roster:' + code, { type: 'json' });
  if (!roster) return err('Roster not found — create it first', 404);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }
  if (!body.name) return err('name required');

  const newPlayer = {
    playerId:    genPlayerId(),
    name:        String(body.name).trim(),
    originalHcp: body.handicapIndex ?? 0,
    adjustedHcp: body.handicapIndex ?? 0,
    teamId:      body.teamId   ?? null,
    friendsId:   body.friendsId ?? null,
    adjustments: [],
  };

  const updatedRoster = {
    ...roster,
    players:   [...roster.players, newPlayer],
    updatedAt: Date.now(),
  };

  const ttlRemaining = Math.max(1, Math.floor((record.expiresAt - Date.now()) / 1000) + GRACE_SECS);
  await env.GAMES.put('roster:' + code, JSON.stringify(updatedRoster), { expirationTtl: ttlRemaining });
  return json({ ok: true, playerId: newPlayer.playerId, name: newPlayer.name }, 201);
}

async function handleRosterAdjust(code, request, env) {
  if (!env.GAMES) return err('KV not configured', 503);

  const record = await env.GAMES.get('tourn:' + code, { type: 'json' });
  if (!record) return err('Tournament not found', 404);
  if (!await isOrganiser(request, record)) return err('Unauthorized', 401);

  const roster = await env.GAMES.get('roster:' + code, { type: 'json' });
  if (!roster) return err('Roster not found', 404);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }
  // body.adjustments: [{ playerId, newAdjustedHcp }]
  if (!Array.isArray(body.adjustments)) return err('adjustments array required');

  const adjMap = new Map(body.adjustments.map(a => [a.playerId, a.newAdjustedHcp]));
  const updatedPlayers = roster.players.map(p => {
    if (!adjMap.has(p.playerId)) return p;
    const after = adjMap.get(p.playerId);
    const delta = Math.round((after - p.adjustedHcp) * 10) / 10;
    return {
      ...p,
      adjustedHcp: after,
      adjustments: [
        ...(p.adjustments ?? []),
        { round: body.round ?? null, before: p.adjustedHcp, after, delta, mean: null, manual: true },
      ],
    };
  });

  const updatedRoster = { ...roster, players: updatedPlayers, updatedAt: Date.now() };
  const ttlRemaining  = Math.max(1, Math.floor((record.expiresAt - Date.now()) / 1000) + GRACE_SECS);
  await env.GAMES.put('roster:' + code, JSON.stringify(updatedRoster), { expirationTtl: ttlRemaining });
  return json({ ok: true });
}
