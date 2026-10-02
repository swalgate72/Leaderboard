// ================================================================
// LEADERBOARD — provider.js
// Single-switch data provider selector.
//
// MULTI_USER = false  →  local.js (IndexedDB, no network required)
// MULTI_USER = true   →  data.js  (Supabase, requires auth + network)
//
// app.js imports everything from this file.
// Changing MULTI_USER is the only code change needed to switch modes.
//
// IMPORTANT — Supabase initialisation:
// When MULTI_USER = false, data.js is loaded via dynamic import ONLY
// if and when a migration export is triggered (exportFromSupabase).
// The Supabase client does NOT initialise on normal app startup in
// local mode. No Supabase network requests, no auth dependency.
//
// When MULTI_USER = true, data.js is imported statically and the
// Supabase client initialises as it does today.
// ================================================================

// ── Configuration ────────────────────────────────────────────────
// Change this to true to reactivate Supabase multi-user mode.
export const MULTI_USER = false;

// ── Active provider ──────────────────────────────────────────────
// Static import of local.js — always safe, no network dependency.
// data.js is NOT statically imported here to prevent Supabase client
// initialisation when MULTI_USER = false.
import * as localProvider from './local.js';

// In multi-user mode, data.js needs to be statically imported.
// The conditional below handles both cases cleanly.
// When MULTI_USER = false: only localProvider is used.
// When MULTI_USER = true: replace this file with the version that
// statically imports data.js (see reactivation notes below).
const provider = localProvider;

// ── Re-export every function by name ─────────────────────────────
// This keeps all call sites in app.js unchanged.

// Auth
export const authOnStateChange   = (...a) => provider.authOnStateChange(...a);
export const authGetUser         = (...a) => provider.authGetUser(...a);
export const authSignIn          = (...a) => provider.authSignIn(...a);
export const authSignUp          = (...a) => provider.authSignUp(...a);
export const authSignOut         = (...a) => provider.authSignOut(...a);
export const authSignInWithGoogle= (...a) => provider.authSignInWithGoogle(...a);
export const authForgotPassword  = (...a) => provider.authForgotPassword(...a);
export const authUpdatePassword  = (...a) => provider.authUpdatePassword(...a);

// Profile
export const profileLoad         = (...a) => provider.profileLoad(...a);
export const profileSave         = (...a) => provider.profileSave(...a);
export const profileFindByEmail  = (...a) => provider.profileFindByEmail(...a);
export const profileFindByUsername = (...a) => provider.profileFindByUsername(...a);

// Courses
export const coursesLoadAll      = (...a) => provider.coursesLoadAll(...a);
export const courseLoadById      = (...a) => provider.courseLoadById(...a);
export const courseSave          = (...a) => provider.courseSave(...a);
export const courseDelete        = (...a) => provider.courseDelete(...a);
export const coursesEnsureDefaults = (...a) => provider.coursesEnsureDefaults(...a);

// Rounds
export const roundCreate         = (...a) => provider.roundCreate(...a);
export const roundSaveState      = (...a) => provider.roundSaveState(...a);
export const roundComplete       = (...a) => provider.roundComplete(...a);
export const roundAbandon        = (...a) => provider.roundAbandon(...a);
export const roundReactivate     = (...a) => provider.roundReactivate(...a);
export const roundDelete         = (...a) => provider.roundDelete(...a);
export const roundsLoadActive    = (...a) => provider.roundsLoadActive(...a);
export const roundLoadById       = (...a) => provider.roundLoadById(...a);
export const roundsLoadHistory   = (...a) => provider.roundsLoadHistory(...a);

// Round players
export const roundPlayersSave    = (...a) => provider.roundPlayersSave(...a);
export const roundPlayersLoad    = (...a) => provider.roundPlayersLoad(...a);
export const roundPlayerClaimScorer = (...a) => provider.roundPlayerClaimScorer(...a);

// Friends / players
export const friendsLoad         = (...a) => provider.friendsLoad(...a);
export const friendRequestsLoadPending = (...a) => provider.friendRequestsLoadPending(...a);
export const friendRequestSend   = (...a) => provider.friendRequestSend(...a);
export const friendRequestAccept = (...a) => provider.friendRequestAccept(...a);
export const friendRequestDecline= (...a) => provider.friendRequestDecline(...a);
export const friendRemove        = (...a) => provider.friendRemove(...a);

// Guest players
export const guestProfileCreate  = (...a) => provider.guestProfileCreate(...a);
export const guestProfileUpdate  = (...a) => provider.guestProfileUpdate(...a);
export const guestProfileLinkEmail = (...a) => provider.guestProfileLinkEmail(...a);
export const guestProfileDelete  = (...a) => provider.guestProfileDelete(...a);

// Push notifications (dormant in local mode)
export const pushSubscriptionSave = (...a) => provider.pushSubscriptionSave(...a);
export const pushSubscriptionsLoadForUser = (...a) => provider.pushSubscriptionsLoadForUser(...a);
export const pushSubscriptionDelete = (...a) => provider.pushSubscriptionDelete(...a);

// SMS / game invites (dormant in local mode)
export const smsInviteCreate     = (...a) => provider.smsInviteCreate(...a);
export const smsInviteDelete     = (...a) => provider.smsInviteDelete(...a);
export const smsInvitesDeleteMany= (...a) => provider.smsInvitesDeleteMany(...a);
export const gameInvitesPollPending = (...a) => provider.gameInvitesPollPending(...a);
export const gameInviteLoad      = (...a) => provider.gameInviteLoad(...a);
export const gameInvitesLoadHistory = (...a) => provider.gameInvitesLoadHistory(...a);
export const invitesForRoundLoad = (...a) => provider.invitesForRoundLoad(...a);
export const invitesForTournamentRoundLoad = (...a) => provider.invitesForTournamentRoundLoad(...a);
export const smsInviteLookup     = (...a) => provider.smsInviteLookup(...a);
export const smsInviteAccept     = (...a) => provider.smsInviteAccept(...a);
export const smsBuildInviteLink  = (...a) => provider.smsBuildInviteLink(...a);
export const smsBuildMessage     = (...a) => provider.smsBuildMessage(...a);

// Realtime (dormant in local mode)
export const realtimeSubscribeRound = (...a) => provider.realtimeSubscribeRound(...a);
export const realtimeBroadcastRound = (...a) => provider.realtimeBroadcastRound(...a);
export const realtimeSubscribeFriendRequests = (...a) => provider.realtimeSubscribeFriendRequests(...a);
export const realtimeSubscribeGameInvites = (...a) => provider.realtimeSubscribeGameInvites(...a);
export const realtimeSubscribeTournament = (...a) => provider.realtimeSubscribeTournament(...a);
export const realtimeUnsubscribe = (...a) => provider.realtimeUnsubscribe(...a);

// Score challenges (dormant in local mode)
export const challengeCreate     = (...a) => provider.challengeCreate(...a);
export const challengeUpdate     = (...a) => provider.challengeUpdate(...a);
export const challengesLoadPending = (...a) => provider.challengesLoadPending(...a);
export const realtimeSubscribeChallenges = (...a) => provider.realtimeSubscribeChallenges(...a);

// Tournaments (dormant in local mode)
export const tournamentCreate    = (...a) => provider.tournamentCreate(...a);
export const tournamentsLoad     = (...a) => provider.tournamentsLoad(...a);
export const tournamentLoadById  = (...a) => provider.tournamentLoadById(...a);
export const tournamentUpdate    = (...a) => provider.tournamentUpdate(...a);
export const tournamentDelete    = (...a) => provider.tournamentDelete(...a);
export const tournamentPlayersAdd    = (...a) => provider.tournamentPlayersAdd(...a);
export const tournamentPlayersLoad   = (...a) => provider.tournamentPlayersLoad(...a);
export const tournamentPlayerUpdate  = (...a) => provider.tournamentPlayerUpdate(...a);
export const tournamentRoundsLoad    = (...a) => provider.tournamentRoundsLoad(...a);
export const tournamentRoundLoadById = (...a) => provider.tournamentRoundLoadById(...a);
export const tournamentRoundCreate   = (...a) => provider.tournamentRoundCreate(...a);
export const tournamentRoundUpdate   = (...a) => provider.tournamentRoundUpdate(...a);
export const tournamentScoresLoad    = (...a) => provider.tournamentScoresLoad(...a);
export const tournamentAllScoresLoad = (...a) => provider.tournamentAllScoresLoad(...a);
export const tournamentScoresSave    = (...a) => provider.tournamentScoresSave(...a);
export const tournamentTeamsCreate   = (...a) => provider.tournamentTeamsCreate(...a);
export const tournamentTeamsLoad     = (...a) => provider.tournamentTeamsLoad(...a);
export const tournamentTeamUpdate    = (...a) => provider.tournamentTeamUpdate(...a);
export const roundTeamsCreate        = (...a) => provider.roundTeamsCreate(...a);
export const roundTeamsLoad          = (...a) => provider.roundTeamsLoad(...a);
export const roundTeamUpdate         = (...a) => provider.roundTeamUpdate(...a);

// Backup / restore (local only — not delegated to Supabase provider)
export const exportBackup        = (...a) => localProvider.exportBackup(...a);
export const importBackup        = (...a) => localProvider.importBackup(...a);
export const exportFromSupabase  = (...a) => localProvider.exportFromSupabase(...a);

// ================================================================
// FUTURE REACTIVATION NOTES
// ================================================================
//
// To reactivate Supabase (multi-user mode):
//
// 1. Set MULTI_USER = true at the top of this file.
//
// 2. Replace the static import of local.js with:
//    import * as localProvider  from './local.js';
//    import * as supabaseProvider from './data.js';
//    const provider = MULTI_USER ? supabaseProvider : localProvider;
//
// 3. Run the one-time local→Supabase migration:
//    - Read all IDB data
//    - Call data.js write functions to push to Supabase
//    - Supabase IDs: if original Supabase UUIDs were preserved in the
//      backup, they can be used directly. Players created locally
//      after Supabase was removed have local UUIDs — these need
//      Supabase profile rows created via admin.auth.admin.createUser
//      (see api/create-guest.js for the pattern). A mapping table
//      local_id → supabase_id is needed for those players.
//
// 4. Re-enable startSyncLoop() in app.js (currently guarded by
//    the MULTI_USER check added in this migration).
//
// 5. Re-enable the auth screen (screen-auth) for new user sign-up.
//    Existing local users will need to create a Supabase account;
//    their local data can be migrated using the export/import flow.
