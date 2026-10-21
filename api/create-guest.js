// This endpoint created guest users in Supabase.
// Supabase has been removed from this application — all guest profiles
// are now stored locally in IndexedDB via local.js.
// This file is kept as a stub so Vercel does not return 404 on stale requests.
export default function handler(_req, res) {
  res.status(410).json({
    error: 'This endpoint has been decommissioned. Guest profiles are stored locally.',
  });
}
