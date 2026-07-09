import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL     = process.env.SUPABASE_URL ?? 'https://fzknjqjnwnfuyfjrgacf.supabase.co';
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId, first_name, last_name, hcp, home_course_id, home_course_handicaps } = req.body ?? {};
  if (!userId || !first_name) return res.status(400).json({ error: 'Missing required fields' });
  if (!SUPABASE_SERVICE)     return res.status(500).json({ error: 'Server not configured' });

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  try {
    // Create a guest auth user with a random password they'll never use
    const guestEmail  = `guest_${Date.now()}_${Math.random().toString(36).slice(2,9)}@leaderboard.guest`;
    const guestPass   = crypto.randomUUID(); // random, never used

    const { data: authData, error: authErr } = await admin.auth.admin.createUser({
      email:              guestEmail,
      password:           guestPass,
      email_confirm:      true,
      app_metadata:       { is_guest: true },
      user_metadata:      { is_guest: true, invited_by: userId },
    });

    if (authErr) {
      console.error('createUser error:', JSON.stringify(authErr));
      throw new Error('Auth error: ' + authErr.message);
    }

    const guestId = authData?.user?.id;
    if (!guestId) throw new Error('No user ID returned from createUser');

    // Upsert profile
    const { error: profErr } = await admin.from('profiles').upsert({
      id:                    guestId,
      first_name:            first_name.trim(),
      last_name:             (last_name ?? '').trim(),
      hcp:                   hcp ?? null,
      home_course_id:        home_course_id ?? null,
      home_course_handicaps: home_course_handicaps ?? null,
      is_guest:              true,
      onboarding_complete:   false,
    }, { onConflict: 'id' });

    if (profErr) {
      console.error('profile upsert error:', JSON.stringify(profErr));
      throw new Error('Profile error: ' + profErr.message);
    }

    // Create friendship
    const { error: friendErr } = await admin.from('friendships').insert({
      requester_id: userId,
      addressee_id: guestId,
      status:       'accepted',
    });

    if (friendErr) {
      console.error('friendship error:', JSON.stringify(friendErr));
      throw new Error('Friendship error: ' + friendErr.message);
    }

    return res.status(200).json({ guestId });

  } catch (err) {
    console.error('create-guest error:', err?.message, err);
    return res.status(500).json({ error: err.message ?? 'Failed to create guest' });
  }
}
