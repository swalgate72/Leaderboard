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
    // Generate a UUID for the guest
    const guestId = crypto.randomUUID();

    // Insert guest profile (bypasses RLS via service role)
    const { error: profErr } = await admin.from('profiles').insert({
      id:                    guestId,
      first_name:            first_name.trim(),
      last_name:             (last_name ?? '').trim(),
      hcp:                   hcp ?? null,
      home_course_id:        home_course_id ?? null,
      home_course_handicaps: home_course_handicaps ?? null,
      is_guest:              true,
      onboarding_complete:   false,
    });
    if (profErr) throw new Error(profErr.message);

    // Create accepted friendship
    const { error: friendErr } = await admin.from('friendships').insert({
      requester_id: userId,
      addressee_id: guestId,
      status:       'accepted',
    });
    if (friendErr) throw new Error(friendErr.message);

    return res.status(200).json({ guestId });
  } catch (err) {
    console.error('create-guest error:', err);
    return res.status(500).json({ error: err.message ?? 'Failed to create guest' });
  }
}
