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
    // Store guest in guest_friends table — avoids auth.users FK constraint entirely
    const { data, error } = await admin
      .from('guest_friends')
      .insert({
        owner_id:              userId,
        first_name:            first_name.trim(),
        last_name:             (last_name ?? '').trim(),
        hcp:                   hcp ?? null,
        home_course_id:        home_course_id ?? null,
        home_course_handicaps: home_course_handicaps ?? null,
      })
      .select('id')
      .single();

    if (error) {
      console.error('guest_friends insert error:', error.message, JSON.stringify(error));
      throw new Error(error.message);
    }

    return res.status(200).json({ guestId: data.id, isGuestTable: true });

  } catch (err) {
    console.error('create-guest error:', err?.message);
    return res.status(500).json({ error: err.message ?? 'Unknown error' });
  }
}
