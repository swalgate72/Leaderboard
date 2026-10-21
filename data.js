// data.js — DECOMMISSIONED
//
// This module previously contained the Supabase data provider.
// Supabase has been removed from this application.
//
// All data operations now go through local.js (IndexedDB) via provider.js.
// MULTI_USER is permanently false in provider.js; this file is never
// imported on normal app startup.
//
// The only remaining reference is the one-time migration export button
// (btn-supabase-export in index.html), which dynamically imports this
// module. That button and this stub can be removed together in Stage 5.

export function _decommissioned() {
  throw new Error(
    'data.js has been decommissioned. All data operations use local.js (IndexedDB). ' +
    'If you are seeing this error, the Supabase export button was clicked and ' +
    'data.js no longer contains a working Supabase client. ' +
    'Remove btn-supabase-export from index.html to eliminate this code path.'
  );
}

// Re-export stubs for every function previously exported by this module.
// These throw if called, ensuring any accidental import fails loudly rather
// than silently returning undefined.
const stub = name => (..._args) => { throw new Error(`data.js:${name} — decommissioned`); };

export const authOnStateChange             = stub('authOnStateChange');
export const authGetUser                   = stub('authGetUser');
export const authSignIn                    = stub('authSignIn');
export const authSignUp                    = stub('authSignUp');
export const authSignOut                   = stub('authSignOut');
export const authSignInWithGoogle          = stub('authSignInWithGoogle');
export const authForgotPassword            = stub('authForgotPassword');
export const authUpdatePassword            = stub('authUpdatePassword');
export const profileLoad                   = stub('profileLoad');
export const profileSave                   = stub('profileSave');
export const profileFindByEmail            = stub('profileFindByEmail');
export const profileFindByUsername         = stub('profileFindByUsername');
export const coursesLoadAll                = stub('coursesLoadAll');
export const courseLoadById                = stub('courseLoadById');
export const courseSave                    = stub('courseSave');
export const courseDelete                  = stub('courseDelete');
export const coursesEnsureDefaults         = stub('coursesEnsureDefaults');
export const roundCreate                   = stub('roundCreate');
export const roundSaveState                = stub('roundSaveState');
export const roundComplete                 = stub('roundComplete');
export const roundAbandon                  = stub('roundAbandon');
export const roundReactivate               = stub('roundReactivate');
export const roundDelete                   = stub('roundDelete');
export const roundsLoadActive              = stub('roundsLoadActive');
export const roundLoadById                 = stub('roundLoadById');
export const roundsLoadHistory             = stub('roundsLoadHistory');
export const roundPlayersSave              = stub('roundPlayersSave');
export const roundPlayersLoad              = stub('roundPlayersLoad');
export const roundPlayerClaimScorer        = stub('roundPlayerClaimScorer');
export const friendsLoad                   = stub('friendsLoad');
export const friendRequestsLoadPending     = stub('friendRequestsLoadPending');
export const friendRequestSend             = stub('friendRequestSend');
export const friendRequestAccept           = stub('friendRequestAccept');
export const friendRequestDecline          = stub('friendRequestDecline');
export const friendRemove                  = stub('friendRemove');
export const guestProfileCreate            = stub('guestProfileCreate');
export const guestProfileUpdate            = stub('guestProfileUpdate');
export const guestProfileLinkEmail         = stub('guestProfileLinkEmail');
export const guestProfileDelete            = stub('guestProfileDelete');
export const pushSubscriptionSave          = stub('pushSubscriptionSave');
export const pushSubscriptionsLoadForUser  = stub('pushSubscriptionsLoadForUser');
export const pushSubscriptionDelete        = stub('pushSubscriptionDelete');
export const smsInviteCreate               = stub('smsInviteCreate');
export const smsInviteDelete               = stub('smsInviteDelete');
export const smsInvitesDeleteMany          = stub('smsInvitesDeleteMany');
export const gameInvitesPollPending        = stub('gameInvitesPollPending');
export const gameInviteLoad                = stub('gameInviteLoad');
export const gameInvitesLoadHistory        = stub('gameInvitesLoadHistory');
export const invitesForRoundLoad           = stub('invitesForRoundLoad');
export const invitesForTournamentRoundLoad = stub('invitesForTournamentRoundLoad');
export const smsInviteLookup               = stub('smsInviteLookup');
export const smsInviteAccept               = stub('smsInviteAccept');
export const smsBuildInviteLink            = stub('smsBuildInviteLink');
export const smsBuildMessage               = stub('smsBuildMessage');
export const realtimeSubscribeRound        = stub('realtimeSubscribeRound');
export const realtimeBroadcastRound        = stub('realtimeBroadcastRound');
export const realtimeSubscribeFriendRequests = stub('realtimeSubscribeFriendRequests');
export const realtimeSubscribeGameInvites  = stub('realtimeSubscribeGameInvites');
export const realtimeSubscribeTournament   = stub('realtimeSubscribeTournament');
export const realtimeUnsubscribe           = stub('realtimeUnsubscribe');
export const challengeCreate               = stub('challengeCreate');
export const challengeUpdate               = stub('challengeUpdate');
export const challengesLoadPending         = stub('challengesLoadPending');
export const realtimeSubscribeChallenges   = stub('realtimeSubscribeChallenges');
export const tournamentCreate              = stub('tournamentCreate');
export const tournamentsLoad               = stub('tournamentsLoad');
export const tournamentLoadById            = stub('tournamentLoadById');
export const tournamentUpdate              = stub('tournamentUpdate');
export const tournamentDelete              = stub('tournamentDelete');
export const tournamentPlayersAdd          = stub('tournamentPlayersAdd');
export const tournamentPlayersLoad         = stub('tournamentPlayersLoad');
export const tournamentPlayerUpdate        = stub('tournamentPlayerUpdate');
export const tournamentRoundsLoad          = stub('tournamentRoundsLoad');
export const tournamentRoundLoadById       = stub('tournamentRoundLoadById');
export const tournamentRoundCreate         = stub('tournamentRoundCreate');
export const tournamentRoundUpdate         = stub('tournamentRoundUpdate');
export const tournamentScoresLoad          = stub('tournamentScoresLoad');
export const tournamentAllScoresLoad       = stub('tournamentAllScoresLoad');
export const tournamentScoresSave          = stub('tournamentScoresSave');
export const tournamentTeamsCreate         = stub('tournamentTeamsCreate');
export const tournamentTeamsLoad           = stub('tournamentTeamsLoad');
export const tournamentTeamUpdate          = stub('tournamentTeamUpdate');
export const roundTeamsCreate              = stub('roundTeamsCreate');
export const roundTeamsLoad                = stub('roundTeamsLoad');
export const roundTeamUpdate               = stub('roundTeamUpdate');
export const exportBackup                  = stub('exportBackup');
export const importBackup                  = stub('importBackup');
export const exportFromSupabase            = stub('exportFromSupabase');
