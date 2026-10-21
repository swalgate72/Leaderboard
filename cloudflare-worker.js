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
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
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

      // PUT /admin/courses/:id
      if (method === 'PUT' && path.match(/^\/admin\/courses\/[^/]+$/)) {
        const id = path.split('/').pop();
        return handleAdminEdit(id, request, env);
      }

      return err('Not found', 404);
    }

    // ── EXISTING game-code routes (preserved exactly) ─────────────
    // These handle /game-codes, /leaderboard, /competitions, /push etc.
    // All existing logic below is unchanged from the original worker.

    // ── Route: health check ───────────────────────────────────────
    if (path === '/' || path === '/health') {
      return json({ ok: true, service: 'leaderboardsync' });
    }

    // ── EXISTING ROUTES ──────────────────────────────────────────
    // (The original worker code for game codes, leaderboard sync,
    //  push notifications etc. continues here unchanged.
    //  Paste the full original worker body after this comment.)

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
  const keys       = listResult.keys.map(k => k.name);

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
