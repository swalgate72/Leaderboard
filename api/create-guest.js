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
    // Create a real auth user for the guest using a fake email
    // This gives us a valid UUID that satisfies the profiles FK constraint
    const guestEmail = `guest_${Date.now()}_${Math.random().toString(36).slice(2,8)}@leaderboard.guest`;

    const { data: authData, error: authErr } = await admin.auth.admin.createUser({
      email:             guestEmail,
      email_confirm:     true,  // no confirmation needed
      user_metadata:     { is_guest: true, invited_by: userId },
    });
    if (authErr) throw new Error('Auth: ' + authErr.message);

    const guestId = authData.user.id;

    // Upsert profile (trigger may have already created it)
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
    if (profErr) throw new Error('Profile: ' + profErr.message);

    // Create accepted friendship
    const { error: friendErr } = await admin.from('friendships').insert({
      requester_id: userId,
      addressee_id: guestId,
      status:       'accepted',
    });
    if (friendErr) throw new Error('Friendship: ' + friendErr.message);

    return res.status(200).json({ guestId });

  } catch (err) {
    console.error('create-guest error:', err);
    return res.status(500).json({ error: err.message ?? 'Failed to create guest' });
  }
}
