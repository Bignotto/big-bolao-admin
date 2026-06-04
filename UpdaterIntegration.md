# Match Updater Integration Guide

## Overview

A Vercel Cron Job in the `match-editor` Next.js project runs every minute and syncs live
World Cup scores into big-bolao-api. It polls API-Futebol for live data and calls the
`PUT /matches/:id` endpoint for any match where the score or status has changed.

```
[Vercel Cron — every 1 minute]
  │
  ├─ 1. GET  {BIG_BOLAO_API_URL}/tournaments/{TOURNAMENT_ID}/matches
  │         Authorization: Bearer {SYNC_API_SECRET}
  │         → filter: apiFutebolId != null && isToday(matchDatetime)
  │
  ├─ 2. GET  https://api.api-futebol.com.br/v1/ao-vivo
  │         Authorization: Bearer {API_FUTEBOL_KEY}
  │         → filter: campeonato_id === API_FUTEBOL_CHAMPIONSHIP_ID
  │         → build map: partida_id → liveMatch
  │
  └─ 3. For each today's match found in the live map:
            if score, status, or penalties changed:
              PUT {BIG_BOLAO_API_URL}/matches/{match.id}
              Authorization: Bearer {SYNC_API_SECRET}
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

## API-Futebol Endpoint

### GET /ao-vivo

Returns all currently live matches across all championships.

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

**Status mapping:**

| API-Futebol `status` | big-bolao-api `matchStatus` |
|---|---|
| `agendado` | `SCHEDULED` |
| `ao_vivo` | `IN_PROGRESS` |
| `intervalo` | `IN_PROGRESS` |
| `encerrado` | `COMPLETED` |
| `cancelado` | `POSTPONED` |
| `suspenso` | `POSTPONED` |

Filter by: `m.campeonato.campeonato_id === Number(API_FUTEBOL_CHAMPIONSHIP_ID)`

Key for cross-reference: `partida_id` maps to `match.apiFutebolId` in big-bolao-api.

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
    { "path": "/api/cron/sync-matches", "schedule": "* * * * *" }
  ]
}
```

Vercel Hobby plan supports 2 cron jobs at a 60-second minimum interval.

---

### `app/api/cron/sync-matches/route.ts`

```ts
import { NextRequest } from 'next/server';

const API_URL = process.env.BIG_BOLAO_API_URL!;
const SYNC_API_SECRET = process.env.SYNC_API_SECRET!;
const API_FUTEBOL_KEY = process.env.API_FUTEBOL_KEY!;
const CHAMPIONSHIP_ID = Number(process.env.API_FUTEBOL_CHAMPIONSHIP_ID);
const TOURNAMENT_ID = process.env.TOURNAMENT_ID!;

type MatchStatus = 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'POSTPONED';

function mapStatus(status: string): MatchStatus {
  if (status === 'ao_vivo' || status === 'intervalo') return 'IN_PROGRESS';
  if (status === 'encerrado') return 'COMPLETED';
  if (status === 'cancelado' || status === 'suspenso') return 'POSTPONED';
  return 'SCHEDULED';
}

function isToday(date: Date): boolean {
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

export async function GET(request: NextRequest) {
  if (request.headers.get('Authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 1. Fetch today's matches from big-bolao-api
  const matchesRes = await fetch(`${API_URL}/tournaments/${TOURNAMENT_ID}/matches`, {
    headers: { Authorization: `Bearer ${SYNC_API_SECRET}` },
  });
  if (!matchesRes.ok) {
    return Response.json({ error: 'Failed to fetch matches' }, { status: 500 });
  }
  const { matches } = await matchesRes.json();
  const todayMatches = matches.filter(
    (m: any) => m.apiFutebolId !== null && isToday(new Date(m.matchDatetime))
  );

  if (todayMatches.length === 0) {
    return Response.json({ updated: 0, checked: 0 });
  }

  // 2. Fetch live matches from API-Futebol
  const liveRes = await fetch('https://api.api-futebol.com.br/v1/ao-vivo', {
    headers: { Authorization: `Bearer ${API_FUTEBOL_KEY}` },
  });
  if (!liveRes.ok) {
    return Response.json({ error: 'Failed to fetch live data' }, { status: 500 });
  }
  const allLive: any[] = await liveRes.json();
  const liveMap = new Map(
    allLive
      .filter((m) => m.campeonato.campeonato_id === CHAMPIONSHIP_ID)
      .map((m) => [m.partida_id, m])
  );

  // 3. Update changed matches
  let updated = 0;
  for (const match of todayMatches) {
    const live = liveMap.get(match.apiFutebolId);
    if (!live) continue;

    const newStatus = mapStatus(live.status);
    const scoreChanged =
      live.placar_mandante !== match.homeTeamScore ||
      live.placar_visitante !== match.awayTeamScore;
    const statusChanged = newStatus !== match.matchStatus;
    const penaltiesChanged =
      live.placar_penaltis_mandante !== match.penaltyHomeScore ||
      live.placar_penaltis_visitante !== match.penaltyAwayScore;

    if (!scoreChanged && !statusChanged && !penaltiesChanged) continue;

    const body: Record<string, unknown> = {
      homeTeamScore: live.placar_mandante,
      awayTeamScore: live.placar_visitante,
      matchStatus: newStatus,
    };
    if (live.disputa_penalti) {
      body.hasPenalties = true;
      body.penaltyHomeScore = live.placar_penaltis_mandante;
      body.penaltyAwayScore = live.placar_penaltis_visitante;
    }

    const updateRes = await fetch(`${API_URL}/matches/${match.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SYNC_API_SECRET}`,
      },
      body: JSON.stringify(body),
    });

    if (updateRes.ok) updated++;
  }

  return Response.json({ updated, checked: todayMatches.length });
}
```

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
