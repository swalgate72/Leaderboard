// This endpoint sent Supabase friend invite emails.
// Supabase has been removed from this application — the multi-user invite
// flow is no longer active (MULTI_USER = false in provider.js).
// This file is kept as a stub so Vercel does not return 404 on stale requests.
export default function handler(_req, res) {
  res.status(410).json({
    error: 'This endpoint has been decommissioned. Multi-user invites are not available.',
  });
}
