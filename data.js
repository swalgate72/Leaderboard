// ================================================================
// LEADERBOARD — data.js
// All Supabase interaction in one place.
// No UI logic, no scoring logic — pure data access only.
// ================================================================

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.39.3/+esm';

const SUPABASE_URL  = 'https://fzknjqjnwnfuyfjrgacf.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ6a25qcWpud25mdXlmanJnYWNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAxODIxNjgsImV4cCI6MjA5NTc1ODE2OH0.Hy-eeXpw9yv_b3LpobYFrfEZ6OwW55dHIZc4G0pPA1k';
const APP_URL       = 'https://leaderboard-ten-wheat.vercel.app';

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    storage: {
      getItem:    k => { try { return localStorage.getItem(k); }    catch { return sessionStorage.getItem(k); } },
      setItem:    (k,v) => { try { localStorage.setItem(k,v); }    catch { sessionStorage.setItem(k,v); } },
      removeItem: k => { try { localStorage.removeItem(k); }       catch { sessionStorage.removeItem(k); } },
    },
  },
});

// ================================================================
// AUTH
// ================================================================

export async function authSignIn(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

export async function authSignUp(email, password, firstName, lastName) {
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { first_name: firstName, last_name: lastName } },
  });
  if (error) throw error;
  // When email confirmation is OFF in Supabase, signUp returns an active
  // session immediately (no confirmation email step needed). When it's ON,
  // only a user comes back and a session is created later, after the user
  // clicks the confirmation link. Callers need to know which case this is.
  return { user: data.user, hasSession: !!data.session };
}

export async function authSignOut() {
  const { error } = await sb.auth.signOut();
  if (error) throw error;
}

export async function authSignInWithGoogle() {
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: APP_URL },
  });
  if (error) throw error;
}

export async function authForgotPassword(email) {
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: APP_URL,
  });
  if (error) throw error;
}

export function authOnStateChange(callback) {
  return sb.auth.onAuthStateChange((event, session) => {
    callback(event, session?.user ?? null);
  });
}

export async function authGetUser() {
  const { data } = await sb.auth.getUser();
  return data?.user ?? null;
}

// ================================================================
// PROFILES
// ================================================================

export async function profileLoad(userId) {
  const { data, error } = await sb
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function profileSave(profile) {
  const { error } = await sb
    .from('profiles')
    .upsert({ ...profile, updated_at: new Date().toISOString() });
  if (error) throw error;
}

export async function profileFindByEmail(email) {
  const { data, error } = await sb.rpc('find_user_by_email', {
    lookup_email: email,
  });
  if (error) throw error;
  return data?.[0] ?? null;
}

// ================================================================
// COURSES
// ================================================================

export async function coursesLoadAll() {
  const { data: authData } = await sb.auth.getUser();
  const userId = authData?.user?.id;
  if (!userId) return [];
  const { data, error } = await sb
    .from('courses')
    .select('id, name, location, tees, is_default, created_by')
    .eq('created_by', userId)
    .order('name');
  if (error) throw error;
  return data ?? [];
}

export async function courseLoadById(id) {
  const { data, error } = await sb
    .from('courses')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function courseSave({ id, name, location, tees, isDefault, createdBy }) {
  // If setting this course as default, clear any existing default first
  if (isDefault) {
    await sb
      .from('courses')
      .update({ is_default: false })
      .eq('created_by', createdBy);
  }

  const payload = {
    name,
    location: location || null,
    tees,
    is_default: isDefault ?? false,
    created_by: createdBy,
    updated_at: new Date().toISOString(),
  };

  if (id) {
    const { error } = await sb.from('courses').update(payload).eq('id', id);
    if (error) throw error;
    return id;
  } else {
    const { data, error } = await sb
      .from('courses')
      .insert(payload)
      .select('id')
      .single();
    if (error) throw error;
    return data.id;
  }
}

export async function courseDelete(id) {
  const { error } = await sb.from('courses').delete().eq('id', id);
  if (error) throw error;
}

// Seed default courses for a new user if they have none
export async function coursesEnsureDefaults(userId) {
  const existing = await coursesLoadAll();
  // Only seed if this user has no courses yet
  const mine = existing.filter(c => c.created_by === userId);
  if (mine.length > 0) return;

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
      name: c.name,
      location: c.location,
      tees: c.tees,
      isDefault: c.isDefault,
      createdBy: userId,
    });
  }
}

// ================================================================
// ROUNDS
// ================================================================

export async function roundCreate({ organiserId, courseName, teeName, gameFormat,
  hcpAllowance, si, par, numHoles, holeOffset, playerNames, gameState }) {
  const { data, error } = await sb
    .from('rounds')
    .insert({
      organiser_id:  organiserId,
      course_name:   courseName,
      tee_name:      teeName,
      game_format:   gameFormat,
      hcp_allowance: hcpAllowance,
      si,
      par,
      status:        'active',
      started_at:    new Date().toISOString(),
      player_names:  playerNames,
      game_state:    gameState,
      updated_at:    new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

export async function roundSaveState(roundId, gameState, playerNames) {
  const { error } = await sb
    .from('rounds')
    .update({
      game_state:   gameState,
      player_names: playerNames,
      updated_at:   new Date().toISOString(),
    })
    .eq('id', roundId);
  if (error) throw error;
}

export async function roundComplete(roundId, gameState) {
  const { error } = await sb
    .from('rounds')
    .update({
      status:       'completed',
      game_state:   gameState,
      completed_at: new Date().toISOString(),
      updated_at:   new Date().toISOString(),
    })
    .eq('id', roundId);
  if (error) throw error;
}

export async function roundAbandon(roundId) {
  // "Abandon & Save Progress" — the round stops being actively played but
  // stays resumable. Previously this set status to 'cancelled', which
  // dropped it out of every active-round query and made it unrecoverable —
  // 'paused' keeps it out of the live-game UI while still showing up in
  // Active Games so the organiser can pick it back up later.
  const { error } = await sb
    .from('rounds')
    .update({
      status:     'paused',
      updated_at: new Date().toISOString(),
    })
    .eq('id', roundId);
  if (error) throw error;
}

export async function roundReactivate(roundId) {
  // Flip a paused round back to active when the organiser resumes it.
  const { error } = await sb
    .from('rounds')
    .update({
      status:     'active',
      updated_at: new Date().toISOString(),
    })
    .eq('id', roundId);
  if (error) throw error;
}

export async function roundDelete(roundId) {
  // Clean up child rows first — round_players has a foreign key on round_id,
  // so deleting the round without this first can silently fail (FK violation)
  // and leave the round stuck as 'active' forever.
  await sb.from('round_players').delete().eq('round_id', roundId);
  const { data, error } = await sb
    .from('rounds')
    .delete()
    .eq('id', roundId)
    .select('id'); // force Supabase to confirm what was actually deleted
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error('The round could not be deleted — you may not have permission.');
  }
}

export async function roundsLoadActive(userId) {
  // Find rounds where user is organiser — include both 'active' (currently being
  // played) and 'paused' (saved via Abandon & Save Progress, resumable) so saved
  // games actually show up for the organiser to pick back up.
  const { data: ownRounds, error: e1 } = await sb
    .from('rounds')
    .select('id, course_name, tee_name, game_format, player_names, game_state, started_at, updated_at, status')
    .eq('organiser_id', userId)
    .in('status', ['active', 'paused'])
    .order('updated_at', { ascending: false });
  if (e1) throw e1;

  // Also find rounds where user is a player (joined as group scorer/watcher)
  const { data: playerRounds, error: e2 } = await sb
    .from('round_players')
    .select('round_id, rounds!inner(id, course_name, tee_name, game_format, player_names, game_state, started_at, updated_at, status)')
    .eq('profile_id', userId)
    .in('rounds.status', ['active', 'paused']);

  const joined = (playerRounds ?? [])
    .map(r => r.rounds)
    .filter(r => r && !(ownRounds ?? []).some(o => o.id === r.id)); // dedupe

  return [...(ownRounds ?? []), ...joined]
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
}

export async function roundLoadById(roundId) {
  const { data, error } = await sb
    .from('rounds')
    .select('*')
    .eq('id', roundId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function roundsLoadHistory(organiserId) {
  const { data, error } = await sb
    .from('rounds')
    .select('id, course_name, tee_name, game_format, player_names, game_state, started_at, completed_at')
    .eq('organiser_id', organiserId)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

// ================================================================
// ROUND PLAYERS
// ================================================================

export async function roundPlayersSave(roundId, players) {
  // Delete existing players for this round then re-insert
  // Simpler than upsert for this use case
  await sb.from('round_players').delete().eq('round_id', roundId);

  if (!players.length) return;

  const rows = players.map(p => ({
    round_id:         roundId,
    profile_id:       p.profileId ?? null,
    name:             p.name,
    handicap_index:   p.handicapIndex,
    playing_handicap: p.playingHandicap,
    group_number:     p.groupNumber,
    is_scorer:        p.isScorer ?? false,
    mobile:           p.mobile ?? null,
  }));

  const { error } = await sb.from('round_players').insert(rows);
  if (error) throw error;
}

export async function roundPlayersLoad(roundId) {
  const { data, error } = await sb
    .from('round_players')
    .select('*')
    .eq('round_id', roundId)
    .order('group_number')
    .order('created_at');
  if (error) throw error;
  return data ?? [];
}

// ================================================================
// FRIENDS
// ================================================================

export async function friendsLoad(userId) {
  const { data, error } = await sb
    .from('friendships')
    .select('id, requester_id, addressee_id')
    .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
    .eq('status', 'accepted');
  if (error) throw error;
  if (!data?.length) return [];

  // Fetch each friend's profile separately to avoid FK alias issues
  const friends = [];
  for (const f of data) {
    const friendId = f.requester_id === userId ? f.addressee_id : f.requester_id;
    const { data: prof } = await sb
      .from('profiles')
      .select('id, first_name, last_name, hcp')
      .eq('id', friendId)
      .maybeSingle();
    if (prof) {
      friends.push({
        friendshipId: f.id,
        profileId:    prof.id,
        name:         `${prof.first_name ?? ''} ${prof.last_name ?? ''}`.trim() || 'Friend',
        hcp:          prof.hcp ?? 0,
      });
    }
  }
  return friends;
}

export async function friendRequestsLoadPending(userId) {
  const { data, error } = await sb
    .from('friendships')
    .select('id, requester_id')
    .eq('addressee_id', userId)
    .eq('status', 'pending');
  if (error) throw error;
  if (!data?.length) return [];

  const requests = [];
  for (const f of data) {
    const { data: prof } = await sb
      .from('profiles')
      .select('id, first_name, last_name, hcp')
      .eq('id', f.requester_id)
      .maybeSingle();
    requests.push({
      friendshipId: f.id,
      profileId:    f.requester_id,
      name:         prof ? `${prof.first_name ?? ''} ${prof.last_name ?? ''}`.trim() || 'Friend' : 'Friend',
      hcp:          prof?.hcp ?? 0,
    });
  }
  return requests;
}

export async function friendRequestSend(requesterId, addresseeId) {
  const { error } = await sb
    .from('friendships')
    .insert({ requester_id: requesterId, addressee_id: addresseeId, status: 'pending' });
  if (error) throw error;
}

export async function friendRequestAccept(friendshipId) {
  const { error } = await sb
    .from('friendships')
    .update({ status: 'accepted', updated_at: new Date().toISOString() })
    .eq('id', friendshipId);
  if (error) throw error;
}

export async function friendRequestDecline(friendshipId) {
  const { error } = await sb
    .from('friendships')
    .update({ status: 'declined', updated_at: new Date().toISOString() })
    .eq('id', friendshipId);
  if (error) throw error;
}

export async function friendRemove(friendshipId) {
  const { error } = await sb
    .from('friendships')
    .delete()
    .eq('id', friendshipId);
  if (error) throw error;
}

// ================================================================
// SMS INVITES
// ================================================================

export async function smsInviteCreate({ roundId, roundPlayerId, inviterId, name, mobile, recipientProfileId, tournamentRoundId, groupNumber }) {
  const { data, error } = await sb
    .from('sms_invites')
    .insert({
      round_id:             roundId,
      round_player_id:      roundPlayerId ?? null,
      inviter_id:           inviterId,
      name,
      mobile:               mobile ?? null,
      recipient_profile_id: recipientProfileId ?? null,
      tournament_round_id:  tournamentRoundId ?? null,
      group_number:         groupNumber ?? null,
    })
    .select('id, token')
    .single();
  if (error) throw error;
  return data; // { id, token }
}

export async function smsInviteDelete(inviteId) {
  const { error } = await sb.from('sms_invites').delete().eq('id', inviteId);
  if (error) throw error;
}

export async function smsInvitesDeleteMany(inviteIds) {
  if (!inviteIds?.length) return;
  const { data, error } = await sb
    .from('sms_invites')
    .delete()
    .in('id', inviteIds)
    .select('id'); // force Supabase to return the rows actually deleted
  if (error) throw error;
  // RLS can silently block deletes (no error, just 0 rows affected) — surface that
  // as a real failure so the UI doesn't show success when nothing changed.
  if (!data || data.length === 0) {
    throw new Error('No invites were deleted — you may not have permission to delete these.');
  }
  if (data.length < inviteIds.length) {
    throw new Error(`Only ${data.length} of ${inviteIds.length} invites could be deleted.`);
  }
  return data;
}

export async function gameInvitesPollPending(userId, since) {
  const { data, error } = await sb
    .from('sms_invites')
    .select('*')
    .eq('recipient_profile_id', userId)
    .eq('status', 'pending')
    .gt('created_at', since)
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) throw error;
  return data ?? [];
}

export async function gameInviteLoad(inviteId) {
  const { data, error } = await sb
    .from('sms_invites')
    .select('id, token, inviter_id, name, round_id, recipient_profile_id, tournament_round_id, group_number, status')
    .eq('id', inviteId)
    .single();
  if (error) throw error;
  return data ?? null;
}

// Full invite history for a user — both sent (as inviter) and received (as recipient),
// any status. Used by the "Game Invites" button on the home banner.
export async function gameInvitesLoadHistory(userId, limit = 30) {
  const { data, error } = await sb
    .from('sms_invites')
    .select('*')
    .or(`inviter_id.eq.${userId},recipient_profile_id.eq.${userId}`)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

// All invites sent for a specific round (used by the organiser's "Resend" screen
// to work out who has and hasn't received/accepted an invite yet).
export async function invitesForRoundLoad(roundId) {
  const { data, error } = await sb
    .from('sms_invites')
    .select('*')
    .eq('round_id', roundId);
  if (error) throw error;
  return data ?? [];
}

// All invites sent for a specific tournament round.
export async function invitesForTournamentRoundLoad(tournamentRoundId) {
  const { data, error } = await sb
    .from('sms_invites')
    .select('*')
    .eq('tournament_round_id', tournamentRoundId);
  if (error) throw error;
  return data ?? [];
}

export function realtimeSubscribeGameInvites(userId, onInvite) {
  return sb
    .channel(`game_invites:${userId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'sms_invites', filter: `recipient_profile_id=eq.${userId}` },
      payload => onInvite(payload.new)
    )
    .subscribe();
}

export async function smsInviteLookup(token) {
  const { data, error } = await sb.rpc('get_invite_by_token', {
    invite_token: token,
  });
  if (error) throw error;
  return data?.[0] ?? null;
}

export async function smsInviteAccept(inviteId) {
  const { error } = await sb
    .from('sms_invites')
    .update({ status: 'accepted' })
    .eq('id', inviteId);
  if (error) throw error;
}

// Build the SMS link for a scorer invite
export function smsBuildInviteLink(token) {
  return `${APP_URL}?join=${token}`;
}

// Build the pre-filled SMS body for a scorer invite
export function smsBuildMessage({ inviterName, courseName, teeName, formatLabel, token }) {
  const link = smsBuildInviteLink(token);
  return `${inviterName} has invited you to score a round on Leaderboard!\n\n${courseName} · ${teeName} Tees · ${formatLabel}\n\nJoin here: ${link}`;
}

// ================================================================
// REALTIME
// ================================================================

// Subscribe to changes on a specific round (for live scoring sync)
export function realtimeSubscribeRound(roundId, onUpdate) {
  return sb
    .channel(`round:${roundId}`)
    .on('broadcast', { event: 'score_update' }, payload => {
      onUpdate(payload.payload);
    })
    .subscribe();
}

export async function realtimeBroadcastRound(channel, gameState) {
  if (!channel) return;
  await channel.send({
    type: 'broadcast',
    event: 'score_update',
    payload: { game_state: gameState },
  });
}

// Subscribe to incoming friend requests
export function realtimeSubscribeFriendRequests(userId, onRequest) {
  return sb
    .channel(`friend_requests:${userId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'friendships', filter: `addressee_id=eq.${userId}` },
      () => onRequest()
    )
    .subscribe();
}

export function realtimeUnsubscribe(channel) {
  if (channel) sb.removeChannel(channel);
}

// ================================================================
// TOURNAMENTS
// ================================================================

export async function tournamentCreate({ organiserId, name, format, numRounds, hcpMode, scoringMode, scoringModeTeam }) {
  const { data, error } = await sb
    .from('tournaments')
    .insert({
      organiser_id:  organiserId,
      name, format,
      num_rounds:    numRounds,
      hcp_mode:      hcpMode,
      scoring_mode:  scoringMode ?? 'cumulative',
      scoring_mode_team: scoringModeTeam ?? 'individual',
      status:        'active',
    })
    .select().single();
  if (error) throw error;
  return data;
}

export async function tournamentsLoad(organiserId) {
  // Load tournaments where user is organiser OR co-organiser
  const { data, error } = await sb
    .from('tournaments')
    .select('*')
    .or(`organiser_id.eq.${organiserId},co_organiser_id.eq.${organiserId}`)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function tournamentLoadById(id) {
  const { data, error } = await sb
    .from('tournaments')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function tournamentUpdate(id, updates) {
  const { error } = await sb.from('tournaments').update(updates).eq('id', id);
  if (error) throw error;
}

export async function tournamentDelete(id) {
  const { error } = await sb.from('tournaments').delete().eq('id', id);
  if (error) throw error;
}

// ── Tournament Players ───────────────────────────────────────────

export async function tournamentPlayersAdd(tournamentId, players) {
  // players: [{name, profileId, startingHcp, teamName}]
  const rows = players.map(p => ({
    tournament_id: tournamentId,
    name:          p.name,
    profile_id:    p.profileId ?? null,
    starting_hcp:  p.startingHcp,
    current_hcp:   p.startingHcp,
    team_name:     p.teamName ?? null,
  }));
  const { data, error } = await sb.from('tournament_players').insert(rows).select();
  if (error) throw error;
  return data;
}

export async function tournamentPlayersLoad(tournamentId) {
  const { data, error } = await sb
    .from('tournament_players')
    .select('*')
    .eq('tournament_id', tournamentId)
    .order('name');
  if (error) throw error;
  return data ?? [];
}

export async function tournamentPlayerUpdate(id, updates) {
  const { error } = await sb.from('tournament_players').update(updates).eq('id', id);
  if (error) throw error;
}

// ── Tournament Rounds ────────────────────────────────────────────

export async function tournamentRoundsLoad(tournamentId) {
  const { data, error } = await sb
    .from('tournament_rounds')
    .select('*')
    .eq('tournament_id', tournamentId)
    .order('round_number');
  if (error) throw error;
  return data ?? [];
}

export async function tournamentRoundLoadById(troundId) {
  const { data, error } = await sb
    .from('tournament_rounds')
    .select('*')
    .eq('id', troundId)
    .single();
  if (error) throw error;
  return data ?? null;
}

export async function tournamentRoundCreate({ tournamentId, roundNumber, courseName, teeName, date }) {
  const { data, error } = await sb
    .from('tournament_rounds')
    .insert({ tournament_id: tournamentId, round_number: roundNumber, course_name: courseName, tee_name: teeName, date, status: 'pending' })
    .select().single();
  if (error) throw error;
  return data;
}

export async function tournamentRoundUpdate(id, updates) {
  const { error } = await sb.from('tournament_rounds').update(updates).eq('id', id);
  if (error) throw error;
}

// ── Tournament Round Scores ──────────────────────────────────────

export async function tournamentScoresLoad(tournamentRoundId) {
  const { data, error } = await sb
    .from('tournament_round_scores')
    .select('*')
    .eq('tournament_round_id', tournamentRoundId);
  if (error) throw error;
  return data ?? [];
}

export async function tournamentAllScoresLoad(tournamentId) {
  // Load all scores for all rounds in this tournament
  const rounds = await tournamentRoundsLoad(tournamentId);
  if (!rounds.length) return [];
  const roundIds = rounds.map(r => r.id);
  const { data, error } = await sb
    .from('tournament_round_scores')
    .select('*')
    .in('tournament_round_id', roundIds);
  if (error) throw error;
  return data ?? [];
}

export async function tournamentScoresSave(tournamentRoundId, scores) {
  // scores: [{tournamentPlayerId, gross, net, points, hcpUsed, absent, teamName}]
  // Upsert by tournament_round_id + tournament_player_id
  const rows = scores.map(s => ({
    tournament_round_id:    tournamentRoundId,
    tournament_player_id:  s.tournamentPlayerId,
    gross_score:           s.gross ?? null,
    net_score:             s.net   ?? null,
    points:                s.points ?? null,
    hcp_used:              s.hcpUsed ?? null,
    absent:                s.absent ?? false,
    team_name:             s.teamName ?? null,
  }));
  const { error } = await sb
    .from('tournament_round_scores')
    .upsert(rows, { onConflict: 'tournament_round_id,tournament_player_id' });
  if (error) throw error;
}

// ── Realtime ─────────────────────────────────────────────────────

export function realtimeSubscribeTournament(tournamentId, onUpdate) {
  return sb.channel(`tournament:${tournamentId}`)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'tournament_round_scores',
    }, onUpdate)
    .subscribe();
}

// ================================================================
// SCORE CHALLENGES
// ================================================================

export async function challengeCreate({ roundId, challengerId, challengerName, holeNumber }) {
  const { data, error } = await sb
    .from('score_challenges')
    .insert({
      round_id:         roundId,
      challenger_id:    challengerId,
      challenger_name:  challengerName,
      hole_number:      holeNumber,
      status:           'pending',
    })
    .select().single();
  if (error) throw error;
  return data;
}

export async function challengeUpdate(id, status) {
  const { error } = await sb
    .from('score_challenges')
    .update({ status })
    .eq('id', id);
  if (error) throw error;
}

export async function challengesLoadPending(roundId) {
  const { data, error } = await sb
    .from('score_challenges')
    .select('*')
    .eq('round_id', roundId)
    .eq('status', 'pending')
    .order('created_at');
  if (error) throw error;
  return data ?? [];
}

export function realtimeSubscribeChallenges(roundId, onChallenge) {
  return sb.channel(`challenges:${roundId}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'score_challenges',
      filter: `round_id=eq.${roundId}`,
    }, payload => onChallenge(payload.new))
    .subscribe();
}

// ── Find profile by username ──────────────────────────────────────
export async function profileFindByUsername(username) {
  const { data, error } = await sb
    .from('profiles')
    .select('*')
    .eq('username', username.toLowerCase())
    .maybeSingle();
  if (error) throw error;
  return data;
}

// ================================================================
// TOURNAMENT TEAMS
// ================================================================

export async function tournamentTeamsCreate(tournamentId, teams) {
  // teams: [{name, playerIds: [uuid]}]
  const rows = teams.map(t => ({ tournament_id: tournamentId, name: t.name }));
  const { data, error } = await sb.from('tournament_teams').insert(rows).select();
  if (error) throw error;
  // Assign players to teams
  for (let i = 0; i < data.length; i++) {
    const teamId = data[i].id;
    const pids   = teams[i].playerIds ?? [];
    if (pids.length) {
      const { error: e2 } = await sb
        .from('tournament_players')
        .update({ team_id: teamId })
        .in('id', pids);
      if (e2) throw e2;
    }
  }
  return data;
}

export async function tournamentTeamsLoad(tournamentId) {
  const { data, error } = await sb
    .from('tournament_teams')
    .select('*')
    .eq('tournament_id', tournamentId)
    .order('name');
  if (error) throw error;
  return data ?? [];
}

export async function tournamentTeamUpdate(id, updates) {
  const { error } = await sb.from('tournament_teams').update(updates).eq('id', id);
  if (error) throw error;
}

// ── Round-level team assignments ─────────────────────────────────

export async function roundTeamsCreate(tournamentRoundId, roundTeams) {
  // roundTeams: [{teamId, playerIds, format, name}]
  const rows = roundTeams.map(t => ({
    tournament_round_id: tournamentRoundId,
    team_id:    t.teamId ?? null,
    player_ids: t.playerIds,
    format:     t.format,
    name:       t.name,
  }));
  const { data, error } = await sb.from('tournament_round_teams').insert(rows).select();
  if (error) throw error;
  return data;
}

export async function roundTeamsLoad(tournamentRoundId) {
  const { data, error } = await sb
    .from('tournament_round_teams')
    .select('*')
    .eq('tournament_round_id', tournamentRoundId);
  if (error) throw error;
  return data ?? [];
}

export async function roundTeamUpdate(id, updates) {
  const { error } = await sb.from('tournament_round_teams').update(updates).eq('id', id);
  if (error) throw error;
}
