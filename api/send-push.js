// Vercel serverless function — sends Web Push notifications
// Called from the app when a game invite is created
import webpush from 'web-push';

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL   = process.env.VAPID_EMAIL ?? 'mailto:steve@walgate.net';

webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Simple auth — caller must pass SUPABASE_ANON key as Bearer
  // (prevents random internet requests from triggering pushes)
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { subscription, payload } = req.body ?? {};
  if (!subscription?.endpoint) {
    return res.status(400).json({ error: 'Missing subscription' });
  }

  try {
    await webpush.sendNotification(
      subscription,
      JSON.stringify({
        title: payload?.title ?? 'Leaderboard',
        body:  payload?.body  ?? 'You have a new game invite!',
        icon:  '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        data:  payload?.data  ?? {},
        tag:   payload?.tag   ?? 'game-invite',
      })
    );
    return res.status(200).json({ ok: true });
  } catch (err) {
    // 410 Gone = subscription expired/invalid — caller should delete it
    if (err.statusCode === 410) {
      return res.status(410).json({ error: 'Subscription expired', gone: true });
    }
    console.error('send-push error:', err);
    return res.status(500).json({ error: err.message });
  }
}
