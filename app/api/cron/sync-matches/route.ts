import { NextRequest } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL!;
const SYNC_API_SECRET = process.env.SYNC_API_SECRET!;
const API_FUTEBOL_KEY = process.env.API_FUTEBOL_KEY!;
const CHAMPIONSHIP_ID = Number(process.env.API_FUTEBOL_CHAMPIONSHIP_ID);
const TOURNAMENT_ID = process.env.TOURNAMENT_ID!;

type MatchStatus = 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'POSTPONED';

type EspnEvent = {
  date: string;
  status: { type: { name: string; completed: boolean } };
  competitions: Array<{
    competitors: Array<{
      homeAway: 'home' | 'away';
      score: string;
    }>;
  }>;
};

function mapStatus(status: string): MatchStatus {
  if (status === 'ao_vivo' || status === 'intervalo' || status === 'andamento') return 'IN_PROGRESS';
  if (status === 'encerrado') return 'COMPLETED';
  if (status === 'cancelado' || status === 'suspenso') return 'POSTPONED';
  return 'SCHEDULED';
}

// Match a DB match to an ESPN event by kickoff time proximity (within 2h).
// World Cup has at most 4 games/day so this is unambiguous in practice.
function findEspnEvent(matchDatetime: string, events: EspnEvent[]): EspnEvent | null {
  const kickoff = new Date(matchDatetime).getTime();
  const candidates = events.filter((e) => {
    const diff = Math.abs(new Date(e.date).getTime() - kickoff);
    return diff < 2 * 60 * 60 * 1000;
  });
  if (candidates.length === 0) return null;
  return candidates.sort(
    (a, b) =>
      Math.abs(new Date(a.date).getTime() - kickoff) -
      Math.abs(new Date(b.date).getTime() - kickoff)
  )[0];
}

export async function GET(request: NextRequest) {
  const isDev = process.env.NODE_ENV === 'development';
  if (!isDev) {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) {
      console.error('CRON_SECRET is not set');
      return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
    }
    if (request.headers.get('Authorization') !== `Bearer ${cronSecret}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  // 1. Fetch our matches first — needed to check for stuck IN_PROGRESS (free, our API)
  const matchesUrl = `${API_URL}/tournaments/${TOURNAMENT_ID}/matches`;
  console.log(`[sync] fetching matches from: ${matchesUrl}`);
  console.log(`[sync] SYNC_API_SECRET defined: ${!!SYNC_API_SECRET}, length: ${SYNC_API_SECRET?.length ?? 0}`);
  const matchesRes = await fetch(matchesUrl);
  if (!matchesRes.ok) {
    const body = await matchesRes.text().catch(() => '(unreadable)');
    console.error(`[sync] failed to fetch matches: ${matchesRes.status} ${body}`);
    return Response.json({ error: 'Failed to fetch matches' }, { status: 500 });
  }
  const { matches } = await matchesRes.json();
  const inProgressInDB: any[] = matches.filter(
    (m: any) => m.matchStatus === 'IN_PROGRESS' && m.apiFutebolId
  );
  console.log(`[sync] DB returned ${matches.length} matches for tournament ${TOURNAMENT_ID}`);
  console.log(`[sync] IN_PROGRESS in DB: ${inProgressInDB.length}`);
  console.log(`[sync] apiFutebolIds in DB:`, matches.map((m: any) => m.apiFutebolId).filter(Boolean));

  // 2. Check ESPN scoreboard — free, no api-futebol credit cost
  const espnRes = await fetch(
    'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard'
  );

  let espnHasLive = false;
  let espnEvents: EspnEvent[] = [];
  if (espnRes.ok) {
    const espnBody = await espnRes.json() as { events: EspnEvent[] };
    espnEvents = espnBody.events;
    espnHasLive = espnEvents.some((e) => {
      const s = e.status.type.name;
      return s === 'STATUS_IN_PROGRESS' || s === 'STATUS_HALFTIME';
    });
    const espnStatuses = espnEvents.map((e) => ({ date: e.date, status: e.status.type.name, completed: e.status.type.completed }));
    console.log(`[sync] ESPN events: ${espnEvents.length}, espnHasLive: ${espnHasLive}`);
    console.log(`[sync] ESPN event statuses:`, JSON.stringify(espnStatuses));
  } else {
    console.warn(`[sync] ESPN check failed (${espnRes.status}) — proceeding anyway`);
    espnHasLive = true;
  }

  // Sync if ESPN shows live games OR our DB has matches stuck IN_PROGRESS
  const shouldSync = espnHasLive || inProgressInDB.length > 0;
  console.log(`[sync] shouldSync: ${shouldSync} (espnHasLive=${espnHasLive}, inProgressInDB=${inProgressInDB.length})`);

  if (!shouldSync) {
    console.log('[sync] no active matches per ESPN and no IN_PROGRESS in DB — skipping api-futebol call');
    return Response.json({ skipped: true, reason: 'no active matches' });
  }

  // 3. Call api-futebol /ao-vivo (1 credit — only reached when shouldSync)
  const liveRes = await fetch('https://api.api-futebol.com.br/v1/ao-vivo', {
    headers: { Authorization: `Bearer ${API_FUTEBOL_KEY}` },
  });
  if (!liveRes.ok) {
    return Response.json({ error: 'Failed to fetch live data' }, { status: 500 });
  }
  const allLive: any[] = await liveRes.json();
  console.log(`[sync] API-Futebol returned ${allLive.length} live matches`);
  console.log(`[sync] championship IDs in response:`, [...new Set(allLive.map((m) => m.campeonato.campeonato_id))]);
  console.log(`[sync] filtering for CHAMPIONSHIP_ID=${CHAMPIONSHIP_ID} (type: ${typeof CHAMPIONSHIP_ID})`);

  const liveMap = new Map(
    allLive
      .filter((m) => m.campeonato.campeonato_id === CHAMPIONSHIP_ID && m.status !== 'pre-jogo')
      .map((m) => [m.partida_id, m])
  );
  console.log(`[sync] liveMap size after filter: ${liveMap.size}`);
  for (const [id, m] of liveMap) {
    console.log(`[sync] live match raw id=${id}:`, JSON.stringify(m));
  }

  // 4. Diff and update matches that are in the api-futebol live feed
  const liveMatches = matches.filter(
    (m: any) => m.apiFutebolId !== null && liveMap.has(m.apiFutebolId)
  );
  console.log(`[sync] liveMatches matched in DB: ${liveMatches.length}`);

  let updated = 0;
  for (const match of liveMatches) {
    const live = liveMap.get(match.apiFutebolId);

    const newStatus = mapStatus(live.status);
    const scoreChanged =
      live.placar_mandante !== match.homeTeamScore ||
      live.placar_visitante !== match.awayTeamScore;
    const statusChanged = newStatus !== match.matchStatus;
    // Only consider penalties changed if a shootout is actually in progress.
    // Without this guard, the API returning placar_penaltis_mandante=0 (not null)
    // on a pre-game match produces a false positive against null DB values.
    const penaltiesChanged =
      !!live.disputa_penalti &&
      ((live.placar_penaltis_mandante ?? null) !== (match.penaltyHomeScore ?? null) ||
        (live.placar_penaltis_visitante ?? null) !== (match.penaltyAwayScore ?? null));

    console.log(
      `[sync] match ${match.id} (apiFutebolId=${match.apiFutebolId})` +
      ` DB=${match.homeTeamScore}-${match.awayTeamScore}(${match.matchStatus})` +
      ` live=${live.placar_mandante}-${live.placar_visitante}(${live.status}→${newStatus})` +
      ` scoreChanged=${scoreChanged} statusChanged=${statusChanged} penaltiesChanged=${penaltiesChanged}`
    );

    if (!scoreChanged && !statusChanged && !penaltiesChanged) continue;

    // Only send scores when they are non-null; the backend rejects null scores.
    const body: Record<string, unknown> = { matchStatus: newStatus };
    if (live.placar_mandante !== null) body.homeTeamScore = live.placar_mandante;
    if (live.placar_visitante !== null) body.awayTeamScore = live.placar_visitante;
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

    if (updateRes.ok) {
      updated++;
    } else {
      const errBody = await updateRes.text().catch(() => '(unreadable)');
      console.error(`[sync] PUT match ${match.id} failed: ${updateRes.status} ${errBody}`);
    }
  }

  // 5. Close out IN_PROGRESS matches that have dropped off the api-futebol live feed.
  //    Use ESPN scoreboard (already fetched, free) to get the final score.
  const stuckMatches = inProgressInDB.filter((m) => !liveMap.has(m.apiFutebolId));
  console.log(`[sync] stuck IN_PROGRESS not in live feed: ${stuckMatches.length}`);

  for (const match of stuckMatches) {
    const espnEvent = findEspnEvent(match.matchDatetime, espnEvents);
    if (!espnEvent) {
      console.warn(`[sync] no ESPN event found for stuck match ${match.id} (apiFutebolId=${match.apiFutebolId})`);
      continue;
    }

    const espnStatus = espnEvent.status.type.name;
    // Only close out if ESPN confirms the game is finished
    const isFinished =
      espnEvent.status.type.completed ||
      espnStatus === 'STATUS_FINAL' ||
      espnStatus === 'STATUS_FULL_TIME' ||
      espnStatus === 'STATUS_FT';
    if (!isFinished) {
      console.log(`[sync] ESPN shows match ${match.id} as ${espnStatus} — not closing out yet`);
      continue;
    }

    const comp = espnEvent.competitions[0];
    const home = comp?.competitors.find((c) => c.homeAway === 'home');
    const away = comp?.competitors.find((c) => c.homeAway === 'away');
    if (!home || !away) {
      console.warn(`[sync] ESPN event missing competitor data for match ${match.id}`);
      continue;
    }

    const homeScore = parseInt(home.score, 10);
    const awayScore = parseInt(away.score, 10);
    console.log(`[sync] closing out match ${match.id} via ESPN: ${homeScore}-${awayScore} (${espnStatus})`);

    const updateRes = await fetch(`${API_URL}/matches/${match.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SYNC_API_SECRET}`,
      },
      body: JSON.stringify({
        homeTeamScore: homeScore,
        awayTeamScore: awayScore,
        matchStatus: 'COMPLETED',
      }),
    });

    if (updateRes.ok) updated++;
    else console.error(`[sync] failed to close out match ${match.id}: ${updateRes.status}`);
  }

  return Response.json({ updated, checked: liveMatches.length + stuckMatches.length });
}
