// Vercel serverless function — sends a Leaderboard friend invite email
// Uses Supabase admin to create/invite user, then stores pending friendship

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL          = process.env.SUPABASE_URL  ?? 'https://fzknjqjnwnfuyfjrgacf.supabase.co';
const SUPABASE_SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_URL               = process.env.APP_URL ?? 'https://leaderboard-ten-wheat.vercel.app';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { inviterProfileId, inviterName, recipientEmail } = req.body ?? {};

  if (!inviterProfileId || !recipientEmail) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  // Admin client — can invite users and bypass RLS
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  try {
    // 1. Check if user already exists in profiles
    const { data: existing } = await admin
      .from('profiles')
      .select('id')
      .eq('email', recipientEmail.toLowerCase())
      .maybeSingle();

    if (existing) {
      // User exists — just create friendship if not already friends
      const { error: friendErr } = await admin
        .from('friendships')
        .insert({
          requester_id: inviterProfileId,
          addressee_id: existing.id,
          status: 'pending',
        });
      // Ignore duplicate errors
      if (friendErr && !friendErr.code?.includes('23505')) throw friendErr;
      return res.status(200).json({ status: 'existing_user', message: 'Friend request sent to existing user' });
    }

    // 2. Invite new user via Supabase Auth
    // This sends a magic link email and creates an auth user
    const redirectTo = `${APP_URL}/onboard.html`;
    const { data: inviteData, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(
      recipientEmail.toLowerCase(),
      {
        redirectTo,
        data: {
          invited_by:   inviterProfileId,
          inviter_name: inviterName ?? 'A friend',
        },
      }
    );

    if (inviteErr) throw inviteErr;

    const newUserId = inviteData?.user?.id;
    if (!newUserId) throw new Error('No user ID returned from invite');

    // 3. Create a minimal profile for the new user
    await admin.from('profiles').upsert({
      id:         newUserId,
      email:      recipientEmail.toLowerCase(),
      first_name: null,
      last_name:  null,
      hcp:        null,
      onboarding_complete: false,
      invited_by: inviterProfileId,
    }, { onConflict: 'id' });

    // 4. Create pending friendship — confirmed when they complete onboarding
    await admin.from('friendships').insert({
      requester_id: inviterProfileId,
      addressee_id: newUserId,
      status:       'pending',
    });

    return res.status(200).json({ status: 'invited', message: 'Invite email sent' });

  } catch (err) {
    console.error('invite-friend error:', err);
    return res.status(500).json({ error: err.message ?? 'Invite failed' });
  }
}
