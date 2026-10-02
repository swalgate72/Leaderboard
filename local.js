// ================================================================
// LEADERBOARD — local.js
// Local-first data provider.
//
// Implements the same function signatures as data.js so that
// provider.js can swap between them transparently.
//
// Single-user — no authentication, no network required.
// All persistence goes to IndexedDB via db.js.
//
// Multi-user / Supabase features are stubbed with safe no-ops or
// empty returns. The stubs are clearly marked DORMANT so they
// can be activated later by switching provider.js to data.js.
// ================================================================

import { players as playersStore, courses as coursesStore,
         rounds as roundsStore, settings as settingsStore } from './db.js';

// ── Local owner ID ───────────────────────────────────────────────
// A stable UUID generated once on first run and persisted in settings.
// Used wherever Supabase previously used auth.uid().

const LOCAL_OWNER_KEY = 'ownerId';

async function getOrCreateOwnerId() {
  let id = await settingsStore.get(LOCAL_OWNER_KEY);
  if (!id) {
    id = crypto.randomUUID();
    await settingsStore.set(LOCAL_OWNER_KEY, id);
  }
  return id;
}

// ── Timestamp helper ─────────────────────────────────────────────
const now = () => new Date().toISOString();

// ================================================================
// AUTH — local identity (no network, no password)
// ================================================================

// authOnStateChange: fires the callback once immediately with the
// local owner record, mimicking Supabase's signed-in event.
// app.js calls this at startup; in local mode it triggers onSignedIn.
export function authOnStateChange(callback) {
  // Fire asynchronously so app.js event listeners finish attaching first
  setTimeout(async () => {
    try {
      const user = await authGetUser();
      callback('SIGNED_IN', user);
    } catch {
      callback('SIGNED_OUT', null);
    }
  }, 0);
  // Return a dummy unsubscribe handle so callers don't throw
  return { data: { subscription: { unsubscribe: () => {} } } };
}

export async function authGetUser() {
  const id = await getOrCreateOwnerId();
  const owner = await settingsStore.get('owner');
  // Return a user-shaped object matching what Supabase returns
  return {
    id,
    email:        owner?.email ?? null,
    user_metadata: {
      first_name: owner?.first_name ?? null,
      last_name:  owner?.last_name  ?? null,
    },
  };
}

// DORMANT — no-ops for auth operations not needed in local mode
export async function authSignIn()         { throw new Error('Not available in local mode'); }
export async function authSignUp()         { throw new Error('Not available in local mode'); }
export async function authSignOut()        { /* no session to clear */ }
export async function authSignInWithGoogle() { throw new Error('Not available in local mode'); }
export async function authForgotPassword() { throw new Error('Not available in local mode'); }
export async function authUpdatePassword(newPw) {
  // In local mode there is no password — just acknowledge silently
}

// ================================================================
// PROFILE — owner's own record
// ================================================================

export async function profileLoad(userId) {
  // userId is the local owner ID — we only have one profile
  const owner = await settingsStore.get('owner');
  if (!owner) return null;
  // Return in the same shape as the Supabase profiles row
  return {
    id:                    userId,
    first_name:            owner.first_name ?? null,
    last_name:             owner.last_name  ?? null,
    hcp:                   owner.hcp        ?? null,
    username:              owner.username   ?? null,
    mobile:                owner.mobile     ?? null,
    email:                 owner.email      ?? null,
    whs:                   owner.whs        ?? null,
    home_course_id:        owner.home_course_id ?? null,
    home_course_handicaps: owner.home_course_handicaps ?? {},
    is_guest:              false,
    onboarding_complete:   true,
    // Privacy fields kept for schema compatibility but not shown in local UI
    share_name:            owner.share_name  ?? false,
    friends_see_name:      owner.friends_see_name ?? false,
    share_hcp:             owner.share_hcp   ?? false,
    friends_see_hcp:       owner.friends_see_hcp ?? false,
    share_mobile:          owner.share_mobile ?? false,
    friends_see_mobile:    owner.friends_see_mobile ?? false,
    share_email:           owner.share_email ?? false,
    friends_see_email:     owner.friends_see_email ?? false,
  };
}

export async function profileSave(profile) {
  // Merge into the stored owner record
  const existing = (await settingsStore.get('owner')) ?? {};
  const updated  = { ...existing, ...profile };
  // Remove fields that are specific to Supabase row format
  delete updated.id;
  await settingsStore.set('owner', updated);
}

// DORMANT — social profile lookup not used in local mode
export async function profileFindByEmail()    { return null; }
export async function profileFindByUsername() { return null; }

// ================================================================
// COURSES
// ================================================================

export async function coursesLoadAll() {
  const all = await coursesStore.getAll();
  return all
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(c => ({ ...c, is_default: c.isDefault ?? false })); // app.js checks c.is_default
}

export async function courseLoadById(id) {
  return coursesStore.get(id);
}

export async function courseSave({ id, name, location, tees, isDefault, createdBy }) {
  const all = await coursesStore.getAll();

  // If setting default, clear existing default first
  if (isDefault) {
    for (const c of all.filter(c => c.isDefault)) {
      await coursesStore.put({ ...c, isDefault: false, updatedAt: now() });
    }
  }

  const courseId = id ?? crypto.randomUUID();
  const existing = id ? (await coursesStore.get(id)) : null;

  await coursesStore.put({
    id:        courseId,
    name:      name ?? existing?.name ?? '',
    location:  location ?? existing?.location ?? null,
    tees:      tees ?? existing?.tees ?? [],
    isDefault: isDefault ?? false,
    createdAt: existing?.createdAt ?? now(),
    updatedAt: now(),
  });
  return courseId;
}

export async function courseDelete(id) {
  await coursesStore.delete(id);
}

export async function coursesEnsureDefaults(userId) {
  const existing = await coursesStore.getAll();
  if (existing.length > 0) return; // already seeded

  // Exact same course definitions as data.js — verified from source
  const defaults = [
    {
      name: 'East Berkshire Golf Course', location: 'Crowthorne, England',
      tees: [
        { name: 'White',  color: '#e8e8e8', si: [18,14,4,10,16,8,2,6,12,1,15,13,5,3,11,17,7,9],  par: [4,4,4,4,3,4,4,4,3,4,5,4,3,4,4,3,4,4] },
        { name: 'Yellow', color: '#f5c518', si: [18,14,4,10,16,8,2,6,12,1,15,13,5,3,11,17,7,9],  par: [4,4,4,4,3,4,4,4,3,4,5,4,3,4,4,3,4,4] },
        { name: 'Red',    color: '#e53e3e', si: [18,10,14,6,16,8,4,2,12,15,3,13,7,1,9,17,11,5],  par: [4,4,5,4,3,4,4,4,3,5,4,4,3,4,4,3,5,4] },
      ],
      isDefault: true,
    },
    {
      name: 'Pennard Golf Club', location: 'Swansea, Wales',
      tees: [
        { name: 'Blue',   color: '#4299e1', si: [3,17,8,16,12,2,13,11,1,10,7,18,9,6,14,15,5,4],  par: [4,3,4,5,3,4,4,4,4,5,3,4,4,4,3,5,5,4] },
        { name: 'White',  color: '#e8e8e8', si: [3,17,8,16,12,2,13,11,1,10,7,18,9,6,14,15,5,4],  par: [4,3,4,5,3,4,4,4,4,5,3,4,4,4,3,5,5,4] },
        { name: 'Yellow', color: '#f5c518', si: [3,17,8,16,12,2,13,11,1,10,7,18,9,6,14,15,5,4],  par: [4,3,4,5,3,4,4,4,4,5,3,4,4,4,3,5,5,4] },
        { name: 'Red',    color: '#e53e3e', si: [14,18,8,6,13,5,11,4,10,3,12,16,9,15,17,7,2,1], par: [5,3,4,5,3,4,4,4,5,5,3,4,3,4,3,5,5,4] },
      ],
      isDefault: false,
    },
    {
      name: 'Neath Golf Club', location: 'Swansea, Wales',
      tees: [
        { name: 'Black',  color: '#2d3748', si: [3,18,13,7,15,10,5,1,12,9,14,6,2,17,11,4,16,8], par: [5,3,4,5,3,4,4,4,4,4,4,5,4,3,4,4,3,5] },
        { name: 'White',  color: '#e8e8e8', si: [3,18,13,7,15,10,5,1,12,9,14,6,2,17,11,4,16,8], par: [5,3,4,5,3,4,4,4,4,4,4,5,4,3,4,4,3,5] },
        { name: 'Green',  color: '#38a169', si: [3,18,13,7,15,10,5,1,12,9,14,6,2,17,11,4,16,8], par: [5,3,4,5,3,4,4,4,4,4,4,5,4,3,4,4,3,5] },
        { name: 'Red',    color: '#e53e3e', si: [3,18,13,7,15,10,5,1,12,9,14,6,2,17,11,4,16,8], par: [5,3,4,5,3,4,4,4,4,4,4,5,5,3,4,4,3,5] },
      ],
      isDefault: false,
    },
    {
      name: 'Sandmartins Golf Club', location: 'Wokingham, England',
      tees: [
        { name: 'White',  color: '#e8e8e8', si: [4,18,12,16,2,8,14,10,6,3,7,15,1,17,11,5,13,9], par: [4,4,5,3,4,4,4,3,4,4,4,3,4,3,4,5,3,5] },
        { name: 'Yellow', color: '#f5c518', si: [4,18,12,16,2,8,14,10,6,3,7,15,1,17,11,5,13,9], par: [4,4,5,3,4,4,4,3,4,4,4,3,4,3,4,5,3,5] },
        { name: 'Red',    color: '#e53e3e', si: [4,18,12,16,2,8,14,10,6,3,7,15,1,17,11,5,13,9], par: [4,4,5,3,4,4,4,3,4,4,4,3,4,3,4,5,3,5] },
      ],
      isDefault: false,
    },
    {
      name: 'Windlesham Golf Club', location: 'Windlesham, England',
      tees: [
        { name: 'Navy',   color: '#1a365d', si: [5,7,11,17,1,15,9,13,3,8,14,6,2,18,10,12,4,16], par: [4,4,4,3,4,3,5,4,5,4,3,5,4,3,4,4,4,5] },
        { name: 'Silver', color: '#a0aec0', si: [5,7,11,17,1,15,9,13,3,8,14,6,2,18,10,12,4,16], par: [4,4,4,3,4,3,5,4,5,4,3,5,4,3,4,4,4,5] },
        { name: 'Black',  color: '#2d3748', si: [5,7,11,17,1,15,9,13,3,8,14,6,2,18,10,12,4,16], par: [4,4,4,3,4,3,5,4,5,4,3,5,4,3,4,4,4,5] },
        { name: 'Gold',   color: '#d4a843', si: [5,7,11,17,1,15,9,13,3,8,14,6,2,18,10,12,4,16], par: [4,4,4,3,4,3,5,4,5,4,3,5,4,3,4,4,4,5] },
      ],
      isDefault: false,
    },
    {
      name: 'Billingbear Park — Old Course', location: 'Wokingham, England',
      tees: [
        { name: 'White',  color: '#e8e8e8', si: [5,17,13,11,2,7,15,9,6,3,16,12,10,1,8,14,18,4], par: [4,4,5,3,4,4,3,3,4,4,4,5,3,4,4,3,4,4] },
        { name: 'Yellow', color: '#f5c518', si: [5,17,13,11,2,7,15,9,6,3,16,12,10,1,8,14,18,4], par: [4,4,5,3,4,4,3,3,4,4,4,5,3,4,4,3,4,4] },
        { name: 'Red',    color: '#e53e3e', si: [5,16,11,9,2,7,13,18,3,6,15,12,10,1,8,14,17,4],  par: [4,4,4,3,4,4,3,3,4,4,5,4,3,4,4,3,4,4] },
      ],
      isDefault: false,
    },
    {
      name: 'Billingbear Park — New Course (Par 3)', location: 'Wokingham, England',
      tees: [
        { name: 'White',  color: '#e8e8e8', si: [7,9,3,1,5,4,6,2,8,7,9,3,1,5,4,6,2,8], par: [3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3] },
        { name: 'Yellow', color: '#f5c518', si: [7,9,3,1,5,4,6,2,8,7,9,3,1,5,4,6,2,8], par: [3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3] },
        { name: 'Red',    color: '#e53e3e', si: [7,9,3,1,5,4,6,2,8,7,9,3,1,5,4,6,2,8], par: [3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3] },
      ],
      isDefault: false,
    },
    {
      name: 'Downshire Golf Course', location: 'Bracknell, England',
      tees: [
        { name: 'White',  color: '#e8e8e8', si: [12,14,18,2,6,4,8,16,10,9,3,7,13,17,5,1,15,11], par: [4,5,3,4,4,4,3,4,5,5,4,4,4,3,4,4,3,5] },
        { name: 'Yellow', color: '#f5c518', si: [12,14,18,2,6,4,8,16,10,9,3,7,13,17,5,1,15,11], par: [4,5,3,4,4,4,3,4,5,5,4,4,4,3,4,4,3,5] },
        { name: 'Red',    color: '#e53e3e', si: [15,9,17,3,5,1,13,7,11,4,8,14,12,18,6,2,16,10],  par: [4,5,3,4,5,4,3,4,5,5,5,4,4,3,4,4,3,5] },
      ],
      isDefault: false,
    },
    {
      name: 'Peterstone Lakes Golf Course', location: 'Cardiff, Wales',
      tees: [
        { name: 'White',  color: '#e8e8e8', si: [8,12,6,18,10,14,2,16,4,13,15,3,17,7,1,9,5,11], par: [4,3,5,3,4,4,5,3,4,4,3,5,4,3,5,5,4,4] },
        { name: 'Yellow', color: '#f5c518', si: [8,12,6,18,10,14,2,16,4,13,15,3,17,7,1,9,5,11], par: [4,3,5,3,4,4,5,3,4,4,3,5,4,3,5,5,4,4] },
        { name: 'Red',    color: '#e53e3e', si: [8,12,6,18,10,14,2,16,4,13,15,3,17,7,1,9,5,11], par: [4,3,5,3,4,4,5,3,4,4,3,5,4,3,5,5,4,4] },
      ],
      isDefault: false,
    },
  ];

  for (const c of defaults) {
    await courseSave({
      name:      c.name,
      location:  c.location,
      tees:      c.tees,
      isDefault: c.isDefault,
      createdBy: userId,
    });
  }
}

// ================================================================
// ROUNDS
// ================================================================

export async function roundCreate({
  organiserId, courseName, teeName, gameFormat,
  hcpAllowance, si, par, numHoles, holeOffset,
  playerNames, gameState, weather,
}) {
  const id = crypto.randomUUID();
  const rec = {
    id,
    status:       'active',
    createdAt:    now(),
    updatedAt:    now(),
    completedAt:  null,
    // Metadata snapshot — immutable after creation
    organiserId:  organiserId ?? null,
    courseName:   courseName  ?? null,
    teeName:      teeName     ?? null,
    gameFormat:   gameFormat  ?? null,
    hcpAllowance: hcpAllowance ?? 100,
    si:           si  ?? [],
    par:          par ?? [],
    numHoles:     numHoles   ?? 18,
    holeOffset:   holeOffset ?? 0,
    weather:      weather    ?? null,
    playerNames:  playerNames ?? [],
    // game_state blob — updated as round progresses
    game_state:   gameState ?? null,
    // Players array populated by roundPlayersSave
    players:      [],
  };
  await roundsStore.put(rec);
  return id;
}

export async function roundSaveState(roundId, gameState, playerNames) {
  const existing = await roundsStore.get(roundId);
  if (!existing) throw new Error('Round not found: ' + roundId);
  await roundsStore.put({
    ...existing,
    game_state:  gameState,
    playerNames: playerNames ?? existing.playerNames,
    updatedAt:   now(),
  });
}

export async function roundComplete(roundId, gameState) {
  const existing = await roundsStore.get(roundId);
  if (!existing) throw new Error('Round not found: ' + roundId);
  await roundsStore.put({
    ...existing,
    status:      'completed',
    game_state:  gameState,
    completedAt: now(),
    updatedAt:   now(),
  });
}

export async function roundAbandon(roundId) {
  const existing = await roundsStore.get(roundId);
  if (!existing) throw new Error('Round not found: ' + roundId);
  await roundsStore.put({ ...existing, status: 'paused', updatedAt: now() });
}

export async function roundReactivate(roundId) {
  const existing = await roundsStore.get(roundId);
  if (!existing) throw new Error('Round not found: ' + roundId);
  await roundsStore.put({ ...existing, status: 'active', updatedAt: now() });
}

export async function roundDelete(roundId) {
  await roundsStore.delete(roundId);
}

export async function roundsLoadActive(userId) {
  const all = await roundsStore.getAll();
  return all
    .filter(r => r.status === 'active' || r.status === 'paused')
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .map(_normaliseRound);
}

export async function roundLoadById(roundId) {
  const r = await roundsStore.get(roundId);
  return r ? _normaliseRound(r) : null;
}

export async function roundsLoadHistory(userId) {
  const all = await roundsStore.getAll();
  return all
    .filter(r => r.status === 'completed')
    .sort((a, b) => new Date(b.completedAt || b.updatedAt) - new Date(a.completedAt || a.updatedAt))
    .map(_normaliseRound);
}

// Normalise a round record to the shape that app.js expects
// (matches the Supabase rounds row shape)
function _normaliseRound(r) {
  return {
    id:           r.id,
    organiser_id: r.organiserId ?? null,
    course_name:  r.courseName  ?? null,
    tee_name:     r.teeName     ?? null,
    game_format:  r.gameFormat  ?? null,
    hcp_allowance: r.hcpAllowance ?? 100,
    si:           r.si  ?? [],
    par:          r.par ?? [],
    status:       r.status,
    started_at:   r.createdAt,
    completed_at: r.completedAt ?? null,
    updated_at:   r.updatedAt,
    weather:      r.weather      ?? null,
    player_names: r.playerNames  ?? [],
    game_state:   typeof r.game_state === 'string'
      ? (() => { try { return JSON.parse(r.game_state); } catch { return null; } })()
      : (r.game_state ?? null),
    players:      r.players ?? [],
    // Keep local fields accessible
    _local: true,
  };
}

// ================================================================
// ROUND PLAYERS — embedded in round record
// ================================================================

export async function roundPlayersSave(roundId, players) {
  const existing = await roundsStore.get(roundId);
  if (!existing) throw new Error('Round not found: ' + roundId);

  // Embed player snapshot directly in the round record
  const snapshot = players.map(p => ({
    playerId:        p.profileId ?? null,  // local player ID (nullable)
    name:            p.name,
    handicapIndex:   p.handicapIndex   ?? p.hcpIndex ?? 0,
    courseHandicap:  p.courseHandicap  ?? p.handicapIndex ?? 0,
    playingHandicap: p.playingHandicap ?? p.handicapIndex ?? 0,
    groupNumber:     p.groupNumber  ?? 1,
    isScorer:        p.isScorer     ?? false,
    isGuest:         p.isGuest      ?? false,
    mobile:          p.mobile       ?? null,
  }));

  await roundsStore.put({ ...existing, players: snapshot, updatedAt: now() });
}

export async function roundPlayersLoad(roundId) {
  const r = await roundsStore.get(roundId);
  if (!r) return [];
  // Return in the shape round_players rows have
  return (r.players ?? []).map((p, i) => ({
    id:               `${roundId}_${i}`,
    round_id:         roundId,
    profile_id:       p.playerId ?? null,
    name:             p.name,
    handicap_index:   p.handicapIndex,
    playing_handicap: p.playingHandicap,
    group_number:     p.groupNumber,
    is_scorer:        p.isScorer,
    mobile:           p.mobile ?? null,
    created_at:       r.createdAt,
  }));
}

// DORMANT — single user, no scorer claim needed
export async function roundPlayerClaimScorer() {}

// ================================================================
// FRIENDS / PLAYERS
// ================================================================

// friendsLoad returns all local players in the same shape as
// the Supabase friendsLoad, so app.js picker works unchanged.
export async function friendsLoad(userId) {
  const all = await playersStore.getAll();
  return all
    .sort((a, b) => (b.playCount ?? 0) - (a.playCount ?? 0) || a.name.localeCompare(b.name))
    .map(p => ({
      friendshipId:           p.id,            // used as deletion key
      profileId:              p.id,
      name:                   `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() || p.name || 'Player',
      first_name:             p.firstName ?? null,
      last_name:              p.lastName  ?? null,
      hcp:                    p.hcp ?? 0,
      home_course_id:         p.homeCourseId ?? null,
      home_course_handicaps:  p.teeHandicaps ?? {},
      playCount:              p.playCount ?? 0,
      is_guest:               p.isGuest   ?? false,
      email:                  p.email     ?? null,
      isGuestTable:           p.isGuest   ?? false,
    }));
}

// DORMANT stubs — social features not active in local mode
export async function friendRequestsLoadPending() { return []; }
export async function friendRequestSend()         {}
export async function friendRequestAccept()       {}
export async function friendRequestDecline()      {}

export async function friendRemove(friendshipId) {
  // friendshipId == profileId in local mode
  await playersStore.delete(friendshipId);
}

// ================================================================
// GUEST PLAYERS
// ================================================================

export async function guestProfileCreate(userId, guestData) {
  const { first_name, last_name, hcp, home_course_id, home_course_handicaps } = guestData;
  const id = crypto.randomUUID();
  await playersStore.put({
    id,
    firstName:    first_name?.trim() ?? '',
    lastName:     last_name?.trim()  ?? '',
    name:         `${first_name?.trim() ?? ''} ${last_name?.trim() ?? ''}`.trim(),
    hcp:          hcp ?? null,
    homeCourseId: home_course_id ?? null,
    teeHandicaps: home_course_handicaps ?? {},
    isGuest:      true,
    email:        null,
    mobile:       null,
    playCount:    0,
    createdAt:    now(),
    updatedAt:    now(),
  });
  return id;
}

export async function guestProfileUpdate(guestId, data) {
  const existing = await playersStore.get(guestId);
  if (!existing) throw new Error('Player not found: ' + guestId);
  const { first_name, last_name, hcp, email, home_course_id, home_course_handicaps } = data;
  await playersStore.put({
    ...existing,
    firstName:    first_name?.trim()    ?? existing.firstName,
    lastName:     last_name?.trim()     ?? existing.lastName,
    name:         `${first_name?.trim() ?? existing.firstName ?? ''} ${last_name?.trim() ?? existing.lastName ?? ''}`.trim(),
    hcp:          hcp          ?? existing.hcp,
    email:        email        ?? existing.email,
    homeCourseId: home_course_id        ?? existing.homeCourseId,
    teeHandicaps: home_course_handicaps ?? existing.teeHandicaps,
    updatedAt:    now(),
  });
}

export async function guestProfileLinkEmail(guestId, email) {
  const existing = await playersStore.get(guestId);
  if (!existing) return;
  await playersStore.put({ ...existing, email: email?.toLowerCase() ?? null, updatedAt: now() });
}

export async function guestProfileDelete(userId, guestId, friendshipId) {
  await playersStore.delete(guestId);
}

// ================================================================
// DORMANT STUBS — multi-user features
// All return safe empty values. Kept so app.js call sites don't throw.
// ================================================================

// Push notifications
export async function pushSubscriptionSave()           {}
export async function pushSubscriptionsLoadForUser()   { return []; }
export async function pushSubscriptionDelete()         {}

// SMS/game invites
export async function smsInviteCreate()                { return null; }
export async function smsInviteDelete()                {}
export async function smsInvitesDeleteMany()           {}
export async function gameInvitesPollPending()         { return []; }
export async function gameInviteLoad()                 { return null; }
export async function gameInvitesLoadHistory()         { return []; }
export async function invitesForRoundLoad()            { return []; }
export async function invitesForTournamentRoundLoad()  { return []; }
export async function smsInviteLookup()                { return null; }
export async function smsInviteAccept()                {}
export function smsBuildInviteLink()                   { return ''; }
export function smsBuildMessage()                      { return ''; }

// Realtime
export function  realtimeSubscribeRound()              { return null; }
export async function realtimeBroadcastRound()         {}
export function  realtimeSubscribeFriendRequests()     { return null; }
export function  realtimeSubscribeGameInvites()        { return null; }
export function  realtimeSubscribeTournament()         { return null; }
export function  realtimeUnsubscribe(channel)          {} // null-safe no-op

// Score challenges
export async function challengeCreate()                { return null; }
export async function challengeUpdate()                {}
export async function challengesLoadPending()          { return []; }
export function  realtimeSubscribeChallenges()         { return null; }

// Tournaments — all dormant
export async function tournamentCreate()               { return null; }
export async function tournamentsLoad()                { return []; }
export async function tournamentLoadById()             { return null; }
export async function tournamentUpdate()               {}
export async function tournamentDelete()               {}
export async function tournamentPlayersAdd()           { return []; }
export async function tournamentPlayersLoad()          { return []; }
export async function tournamentPlayerUpdate()         {}
export async function tournamentRoundsLoad()           { return []; }
export async function tournamentRoundLoadById()        { return null; }
export async function tournamentRoundCreate()          { return null; }
export async function tournamentRoundUpdate()          {}
export async function tournamentScoresLoad()           { return []; }
export async function tournamentAllScoresLoad()        { return []; }
export async function tournamentScoresSave()           {}
export async function tournamentTeamsCreate()          { return []; }
export async function tournamentTeamsLoad()            { return []; }
export async function tournamentTeamUpdate()           {}
export async function roundTeamsCreate()               { return []; }
export async function roundTeamsLoad()                 { return []; }
export async function roundTeamUpdate()                {}

// ================================================================
// BACKUP / RESTORE — export and import all local data
// ================================================================

// Schema version for the backup format.
// Increment when the data model changes in a breaking way.
const BACKUP_SCHEMA_VERSION = 1;

export async function exportBackup() {
  const [owner, allPlayers, allCourses, allRounds, allSettings] = await Promise.all([
    settingsStore.get('owner'),
    playersStore.getAll(),
    coursesStore.getAll(),
    roundsStore.getAll(),
    settingsStore.getAll(),
  ]);

  const payload = {
    schema:     BACKUP_SCHEMA_VERSION,
    appVersion: '3.2',
    exportedAt: now(),
    owner:      owner ?? null,
    players:    allPlayers,
    courses:    allCourses,
    rounds:     allRounds,
    settings:   allSettings.filter(s => s.key !== 'owner'), // owner stored separately
  };

  // Compute checksum over the payload (Web Crypto SHA-256)
  const body    = JSON.stringify(payload);
  const msgBuf  = new TextEncoder().encode(body);
  const hashBuf = await crypto.subtle.digest('SHA-256', msgBuf);
  const hashHex = Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  return JSON.stringify({ ...payload, checksum: hashHex }, null, 2);
}

export async function importBackup(jsonString) {
  // 1. Parse
  let backup;
  try { backup = JSON.parse(jsonString); }
  catch { throw new Error('Backup file is not valid JSON.'); }

  // 2. Version check
  if (!backup.schema || backup.schema > BACKUP_SCHEMA_VERSION) {
    throw new Error(`Backup schema version ${backup.schema} is not supported (max: ${BACKUP_SCHEMA_VERSION}).`);
  }

  // 3. Checksum verification
  const { checksum, ...payloadWithoutChecksum } = backup;
  if (checksum) {
    const body    = JSON.stringify(payloadWithoutChecksum);
    const msgBuf  = new TextEncoder().encode(body);
    const hashBuf = await crypto.subtle.digest('SHA-256', msgBuf);
    const hashHex = Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    if (hashHex !== checksum) {
      throw new Error('Backup checksum failed — the file may be corrupt or incomplete.');
    }
  }

  // 4. All validation passed — write to IDB
  // OVERWRITE mode: clear each store, then bulk-insert backup data.
  // This is atomic per store but not across stores. If it fails partway,
  // the app may be in a mixed state — the user should re-import.

  await Promise.all([
    playersStore.clear(),
    coursesStore.clear(),
    roundsStore.clear(),
    settingsStore.clear(),
  ]);

  await Promise.all([
    backup.players?.length  ? playersStore.putMany(backup.players)  : Promise.resolve(),
    backup.courses?.length  ? coursesStore.putMany(backup.courses)  : Promise.resolve(),
    backup.rounds?.length   ? roundsStore.putMany(backup.rounds)    : Promise.resolve(),
    backup.settings?.length ? settingsStore.putMany(backup.settings): Promise.resolve(),
  ]);

  // Restore owner separately
  if (backup.owner) {
    await settingsStore.set('owner', backup.owner);
  }

  // Restore owner ID if present
  if (backup.owner?.id) {
    await settingsStore.set('ownerId', backup.owner.id);
  }
}

// ================================================================
// SUPABASE EXPORT — reads from data.js (Supabase), packages into
// the backup format so existing Supabase data can be migrated.
// Only called once during migration; not used in normal local mode.
// ================================================================

export async function exportFromSupabase(supabaseProvider) {
  // supabaseProvider = the data.js module, passed in by the migration UI
  // This function is called BEFORE switching to local mode, while
  // Supabase is still live.
  const user = await supabaseProvider.authGetUser();
  if (!user) throw new Error('Not signed in to Supabase.');

  const [profile, allCourses, allRounds, allFriends] = await Promise.all([
    supabaseProvider.profileLoad(user.id),
    supabaseProvider.coursesLoadAll(),
    supabaseProvider.roundsLoadHistory(user.id),
    supabaseProvider.friendsLoad(user.id),
  ]);

  // Map Supabase shapes to local shapes
  const owner = profile ? {
    id:                    user.id,
    first_name:            profile.first_name,
    last_name:             profile.last_name,
    hcp:                   profile.hcp,
    username:              profile.username,
    mobile:                profile.mobile,
    email:                 profile.email,
    whs:                   profile.whs,
    home_course_id:        profile.home_course_id,
    home_course_handicaps: profile.home_course_handicaps ?? {},
  } : null;

  const players = allFriends.map(f => ({
    id:          f.profileId,
    firstName:   f.name.split(' ')[0] ?? '',
    lastName:    f.name.split(' ').slice(1).join(' ') ?? '',
    name:        f.name,
    hcp:         f.hcp ?? 0,
    homeCourseId: f.home_course_id ?? null,
    teeHandicaps: f.home_course_handicaps ?? {},
    isGuest:     f.is_guest ?? false,
    email:       f.email ?? null,
    mobile:      null,
    playCount:   f.playCount ?? 0,
    createdAt:   now(),
    updatedAt:   now(),
  }));

  const courses = allCourses.map(c => ({
    id:        c.id,
    name:      c.name,
    location:  c.location ?? null,
    tees:      c.tees ?? [],
    isDefault: c.is_default ?? false,
    createdAt: now(),
    updatedAt: now(),
  }));

  const rounds = allRounds.map(r => ({
    id:           r.id,
    status:       'completed',
    createdAt:    r.started_at ?? now(),
    updatedAt:    r.updated_at ?? now(),
    completedAt:  r.completed_at ?? now(),
    organiserId:  r.organiser_id ?? user.id,
    courseName:   r.course_name ?? null,
    teeName:      r.tee_name    ?? null,
    gameFormat:   r.game_format ?? null,
    hcpAllowance: r.hcp_allowance ?? 100,
    si:           r.si  ?? [],
    par:          r.par ?? [],
    numHoles:     r.game_state?.numHoles  ?? 18,
    holeOffset:   r.game_state?.holeOffset ?? 0,
    weather:      r.weather ?? null,
    playerNames:  r.player_names ?? [],
    game_state:   r.game_state ?? null,
    players:      (r.game_state?.names ?? []).map((name, i) => ({
      playerId:        null, // historical — player IDs not guaranteed to match
      name,
      handicapIndex:   r.game_state?.handicapIndexes?.[i]   ?? 0,
      courseHandicap:  r.game_state?.handicapIndexes?.[i]   ?? 0,
      playingHandicap: r.game_state?.playingHandicaps?.[i]  ?? 0,
      groupNumber:     1,
      isScorer:        false,
      isGuest:         false,
      mobile:          null,
    })),
  }));

  const payload = {
    schema:     BACKUP_SCHEMA_VERSION,
    appVersion: '3.2',
    exportedAt: now(),
    source:     'supabase-migration',
    owner,
    players,
    courses,
    rounds,
    settings:   [],
  };

  const body    = JSON.stringify(payload);
  const msgBuf  = new TextEncoder().encode(body);
  const hashBuf = await crypto.subtle.digest('SHA-256', msgBuf);
  const hashHex = Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  return JSON.stringify({ ...payload, checksum: hashHex }, null, 2);
}
