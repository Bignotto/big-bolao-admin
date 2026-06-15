# Match Updater Integration Guide

## Overview

A Vercel Cron Job in the `match-editor` Next.js project runs every 5 minutes and syncs live
World Cup scores into big-bolao-api. It polls API-Futebol for live data and calls the
`PUT /matches/:id` endpoint for any match where the score or status has changed.

**Design principle:** API-Futebol is the sole source of truth for scores. ESPN is used only
as a free gate to avoid burning API-Futebol credits when no matches are active, and as a
last-resort signal to detect match completion when the API-Futebol call fails. ESPN scores
are never written to the database.

```
[Vercel Cron — every 5 minutes]
  │
  ├─ 1. GET  {BIG_BOLAO_API_URL}/tournaments/{TOURNAMENT_ID}/matches
  │         Authorization: Bearer {SYNC_API_SECRET}
  │         → identify matches with apiFutebolId != null
  │         → identify matches stuck IN_PROGRESS
  │
  ├─ 2. GET  https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard
  │         (free, no credit cost)
  │         → espnHasLive = any event with STATUS_IN_PROGRESS or STATUS_HALFTIME
  │         → shouldSync  = espnHasLive OR inProgressInDB.length > 0
  │
  ├─ 3. [only if shouldSync]
  │    GET  https://api.api-futebol.com.br/v1/ao-vivo          ← 1 credit
  │         Authorization: Bearer {API_FUTEBOL_KEY}
  │         → filter: campeonato_id === API_FUTEBOL_CHAMPIONSHIP_ID && status !== 'pre-jogo'
  │         → build map: partida_id → liveMatch
  │
  ├─ 4. For each DB match found in the live map:
  │         if score, status, or penalties changed:
  │           PUT {BIG_BOLAO_API_URL}/matches/{match.id}
  │           Authorization: Bearer {SYNC_API_SECRET}
  │
  └─ 5. For each IN_PROGRESS match NOT in the live map (dropped off ao-vivo):
            GET  https://api.api-futebol.com.br/v1/partidas/{apiFutebolId}   ← 1 credit each
            → if status === 'finalizado':
                PUT {BIG_BOLAO_API_URL}/matches/{match.id}  { matchStatus: 'COMPLETED',
                                                               placar_mandante, placar_visitante,
                                                               penalties if present }
            → if API-Futebol call fails:
                use ESPN status to detect completion (isFinished check)
                PUT {BIG_BOLAO_API_URL}/matches/{match.id}  { matchStatus: 'COMPLETED' only }
                (keeps existing DB score — last written by API-Futebol)
```

---

## Prerequisite: big-bolao-api change

`GET /tournaments/:tournamentId/matches` is currently behind `verifySupabaseToken` for all
callers. The cron job uses `SYNC_API_SECRET` — not a Supabase token — so this route must
be updated before the cron can fetch matches.

**File:** `src/http/routes/tournaments.routes.ts`

Move the matches route out of the global `addHook('onRequest', verifySupabaseToken)` scope
and register it with `preHandler: [verifyAdminOrSyncSecret]`:

```ts
// The /tournaments and /tournaments/:tournamentId routes keep the Supabase hook.
// The /tournaments/:tournamentId/matches route gets its own preHandler:
app.get(
  '/tournaments/:tournamentId/matches',
  { preHandler: [verifyAdminOrSyncSecret], schema: { ... } },
  getTournamentMatchesController
);
```

`verifyAdminOrSyncSecret` already exists at `src/http/middlewares/verifyAdminOrSyncSecret.ts`.
It passes immediately if `Authorization: Bearer <SYNC_API_SECRET>` matches, otherwise
falls back to Supabase token + admin role check — so regular admin users are unaffected.

---

## big-bolao-api Endpoints

### GET /tournaments/:tournamentId/matches

Fetch all matches for the World Cup tournament. Filter client-side to today + has `apiFutebolId`.

```
GET {BIG_BOLAO_API_URL}/tournaments/{TOURNAMENT_ID}/matches
Authorization: Bearer {SYNC_API_SECRET}
```

**Response 200:**
```json
{
  "matches": [
    {
      "id": 42,
      "tournamentId": 1,
      "matchDatetime": "2026-06-15T18:00:00.000Z",
      "stadium": "Estadio Azteca",
      "stage": "GROUP",
      "group": "A",
      "apiFutebolId": 38291,
      "homeTeamScore": null,
      "awayTeamScore": null,
      "matchStatus": "SCHEDULED",
      "hasExtraTime": false,
      "hasPenalties": false,
      "penaltyHomeScore": null,
      "penaltyAwayScore": null,
      "homeTeam": { "id": 5, "name": "Brazil", "countryCode": "BRA", "flagUrl": "..." },
      "awayTeam": { "id": 12, "name": "Argentina", "countryCode": "ARG", "flagUrl": "..." }
    }
  ]
}
```

**MatchStatus enum:** `SCHEDULED` | `IN_PROGRESS` | `COMPLETED` | `POSTPONED`

**MatchStage enum:** `GROUP` | `ROUND_OF_32` | `ROUND_OF_16` | `QUARTER_FINAL` | `SEMI_FINAL` | `THIRD_PLACE` | `FINAL` | `LOSERS_MATCH`

---

### PUT /matches/:matchId

Update a match's live score and status. All body fields are optional.

```
PUT {BIG_BOLAO_API_URL}/matches/{matchId}
Authorization: Bearer {SYNC_API_SECRET}
Content-Type: application/json
```

**Body:**
```json
{
  "homeTeamScore": 2,
  "awayTeamScore": 1,
  "matchStatus": "IN_PROGRESS",
  "hasExtraTime": false,
  "hasPenalties": false,
  "penaltyHomeScore": null,
  "penaltyAwayScore": null
}
```

**All accepted body fields:**

| Field | Type | Notes |
|---|---|---|
| `homeTeamScore` | `number` | Goals scored by home team |
| `awayTeamScore` | `number` | Goals scored by away team |
| `matchStatus` | `MatchStatus` enum | See values above |
| `matchStage` | `MatchStage` enum | Only needed for knockout stage progression |
| `hasExtraTime` | `boolean` | |
| `hasPenalties` | `boolean` | |
| `penaltyHomeScore` | `number` | |
| `penaltyAwayScore` | `number` | |
| `matchDate` | `string` (ISO 8601) | Reschedule only |
| `stadium` | `string` | |

**Responses:**
- `200` — `{ "match": { ...updatedMatch } }`
- `401` — Wrong or missing Authorization header
- `404` — Match not found
- `422` — Validation error (wrong field types)

---

## API-Futebol Endpoints

### GET /ao-vivo  *(1 credit per call)*

Returns all currently live matches across all championships. Used in step 3 to sync
in-progress scores.

```
GET https://api.api-futebol.com.br/v1/ao-vivo
Authorization: Bearer {API_FUTEBOL_KEY}
```

**Response (array):**
```json
[
  {
    "partida_id": 38291,
    "campeonato": { "campeonato_id": 417, "nome": "Copa do Mundo FIFA 2026" },
    "placar": "2-1",
    "placar_mandante": 2,
    "placar_visitante": 1,
    "placar_penaltis_mandante": null,
    "placar_penaltis_visitante": null,
    "disputa_penalti": false,
    "status": "ao_vivo",
    "data_realizacao_iso": "2026-06-15T18:00:00+03:00",
    "time_mandante": { "time_id": 1, "nome_popular": "Brasil", "sigla": "BRA" },
    "time_visitante": { "time_id": 2, "nome_popular": "Argentina", "sigla": "ARG" }
  }
]
```

**Status mapping (ao-vivo):**

| API-Futebol `status` | big-bolao-api `matchStatus` |
|---|---|
| `agendado` | `SCHEDULED` |
| `pre-jogo` | `SCHEDULED` (filtered out — excluded from liveMap) |
| `ao_vivo` | `IN_PROGRESS` |
| `intervalo` | `IN_PROGRESS` |
| `andamento` | `IN_PROGRESS` |
| `encerrado` | `COMPLETED` |
| `cancelado` | `POSTPONED` |
| `suspenso` | `POSTPONED` |

Filter by: `m.campeonato.campeonato_id === Number(API_FUTEBOL_CHAMPIONSHIP_ID)`

Key for cross-reference: `partida_id` maps to `match.apiFutebolId` in big-bolao-api.

---

### GET /partidas/:partida_id  *(1 credit per call)*

Returns full details for a single match, including the final score after the match ends.
Used in step 5 to close out matches that have dropped off `/ao-vivo`, capturing any
last-minute goals before marking the match COMPLETED.

```
GET https://api.api-futebol.com.br/v1/partidas/{apiFutebolId}
Authorization: Bearer {API_FUTEBOL_KEY}
```

**Response (relevant fields):**
```json
{
  "partida_id": 38291,
  "placar_mandante": 2,
  "placar_visitante": 1,
  "disputa_penalti": {
    "placar_penalti_mandante": 4,
    "placar_penalti_visitante": 3
  },
  "status": "finalizado"
}
```

> Note: penalty key names differ from `/ao-vivo`:
> - `/ao-vivo` → `placar_penaltis_mandante` / `placar_penaltis_visitante`
> - `/partidas/:id` → `disputa_penalti.placar_penalti_mandante` / `disputa_penalti.placar_penalti_visitante`

**Status values (partidas endpoint):**

| `status` | Meaning |
|---|---|
| `agendado` | Not started |
| `pre-jogo` | Pre-match window |
| `ao_vivo` | In progress |
| `finalizado` | Match over — safe to mark COMPLETED |

---

## Environment Variables

### Vercel project settings (match-editor)

| Variable | Description | Example |
|---|---|---|
| `BIG_BOLAO_API_URL` | big-bolao-api production URL | `https://big-bolao-api.onrender.com` |
| `SYNC_API_SECRET` | Shared secret — must match Render env var | `your-strong-secret` |
| `API_FUTEBOL_KEY` | API-Futebol paid plan key | `live_abc123...` |
| `API_FUTEBOL_CHAMPIONSHIP_ID` | World Cup 2026 championship ID from API-Futebol | `417` |
| `TOURNAMENT_ID` | big-bolao-api internal tournament ID for World Cup | `1` |
| `CRON_SECRET` | Auto-injected by Vercel; secures the cron route | *(set automatically)* |

### Render (big-bolao-api) — must already be set

| Variable | Description |
|---|---|
| `SYNC_API_SECRET` | Must match the value set in Vercel |

---

## Files to Create in match-editor

### `vercel.json`

```json
{
  "crons": [
    { "path": "/api/cron/sync-matches", "schedule": "*/5 * * * *" }
  ]
}
```

Vercel Hobby plan supports 2 cron jobs at a 60-second minimum interval. Running every 5 minutes
is sufficient given the ESPN gate — the expensive API-Futebol call is skipped entirely when no
matches are active.

---

### `app/api/cron/sync-matches/route.ts`

> The canonical source of truth is the file at `app/api/cron/sync-matches/route.ts`.
> See that file for the full implementation. Key behaviours:
>
> - Auth: dev bypass (`NODE_ENV === 'development'`) + `CRON_SECRET` header check in prod
> - Step 2 ESPN gate: if ESPN fails, `espnHasLive` is set to `true` so we never silently skip
> - Step 4 penalty guard: only flags `penaltiesChanged` when `disputa_penalti` is truthy,
>   avoiding false positives from `placar_penaltis_mandante=0` on pre-match records
> - Step 5 closeout: calls `/partidas/{apiFutebolId}` for the authoritative final score;
>   ESPN is only a fallback when that call fails, and even then only `matchStatus` is sent
>   (scores are never taken from ESPN)

---

## Testing

### Local (skip Vercel auth guard)

```bash
# Start match-editor dev server, then:
curl http://localhost:3000/api/cron/sync-matches \
  -H "Authorization: Bearer test-secret"
```

Add a dev bypass at the top of the route handler:

```ts
const isDev = process.env.NODE_ENV === 'development';
if (!isDev && request.headers.get('Authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
}
```

### Sandbox (Copa do Brasil — championship ID 2)

1. Set `API_FUTEBOL_CHAMPIONSHIP_ID=2` and use your API-Futebol sandbox/test key
2. Set `apiFutebolId` on a few test matches in the DB (direct SQL or admin panel)
3. Trigger the cron manually — confirm scores update in big-bolao-api

### Production (live World Cup matches)

1. Confirm the real `API_FUTEBOL_CHAMPIONSHIP_ID` from the API-Futebol dashboard
2. Deploy to Vercel — confirm cron appears in Vercel dashboard under "Cron Jobs"
3. Trigger manually once; check response: `{ updated: N, checked: N }`
4. Monitor Vercel function logs during a live match

---

## Deployment Checklist

- [ ] Apply the big-bolao-api route auth fix (`GET /tournaments/:tournamentId/matches` → `verifyAdminOrSyncSecret`)
- [ ] Add `vercel.json` with cron schedule
- [ ] Add `app/api/cron/sync-matches/route.ts`
- [ ] Set all env vars in Vercel project settings
- [ ] Deploy — verify cron appears in Vercel dashboard
- [ ] Trigger manually once — confirm `{ updated, checked }` response
- [ ] Verify a match score update appears in the app during a live match
