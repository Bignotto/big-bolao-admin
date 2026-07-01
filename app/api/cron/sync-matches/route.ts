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
  if (status === 'agendado') return 'SCHEDULED';
  console.warn(`[sync] mapStatus: unknown api-futebol status "${status}" — defaulting to SCHEDULED`);
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
  const matchesRes = await fetch(matchesUrl, {
    headers: { Authorization: `Bearer ${SYNC_API_SECRET}` },
  });
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
    console.log(`[sync] live match id=${id} raw status="${m.status}" placar=${m.placar_mandante}-${m.placar_visitante} disputa_penalti=${!!m.disputa_penalti}`);
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
    console.log(
      `[sync] match ${match.id} (apiFutebolId=${match.apiFutebolId})` +
      ` DB=${match.homeTeamScore}-${match.awayTeamScore}(${match.matchStatus})` +
      ` live=${live.placar_mandante}-${live.placar_visitante}(${live.status}→${newStatus})` +
      ` scoreChanged=${scoreChanged} statusChanged=${statusChanged}`
    );

    if (!scoreChanged && !statusChanged) continue;

    // Only send scores when they are non-null; the backend rejects null scores.
    const body: Record<string, unknown> = { matchStatus: newStatus };
    if (live.placar_mandante !== null) body.homeTeamScore = live.placar_mandante;
    if (live.placar_visitante !== null) body.awayTeamScore = live.placar_visitante;

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
  //    Fetch the individual match from API Futebol so we get the authoritative final score,
  //    capturing any last-minute goals that happened before the match dropped off ao-vivo.
  //    ESPN is used only as a fallback to confirm completion when the API Futebol call fails.
  const stuckMatches = inProgressInDB.filter((m) => !liveMap.has(m.apiFutebolId));
  console.log(`[sync] stuck IN_PROGRESS not in live feed: ${stuckMatches.length}`);

  for (const match of stuckMatches) {
    const matchAge = Date.now() - new Date(match.matchDatetime).getTime();
    const isOverdue = matchAge > 2 * 60 * 60 * 1000;

    const partidaRes = await fetch(
      `https://api.api-futebol.com.br/v1/partidas/${match.apiFutebolId}`,
      { headers: { Authorization: `Bearer ${API_FUTEBOL_KEY}` } }
    );

    if (!partidaRes.ok) {
      console.warn(
        `[sync] API-Futebol /partidas/${match.apiFutebolId} failed (${partidaRes.status})` +
        ` — falling back to ESPN detection for match ${match.id}`
      );
      const espnEvent = findEspnEvent(match.matchDatetime, espnEvents);
      const espnStatus = espnEvent?.status.type.name ?? 'not found';
      const isFinished =
        !!espnEvent &&
        (espnEvent.status.type.completed ||
          espnStatus === 'STATUS_FINAL' ||
          espnStatus === 'STATUS_FULL_TIME' ||
          espnStatus === 'STATUS_FT');
      if (!isFinished && !isOverdue) {
        console.log(`[sync] ESPN shows match ${match.id} as ${espnStatus} — not closing out yet`);
        continue;
      }
      const reason = isFinished
        ? 'ESPN fallback'
        : `overdue (${Math.round(matchAge / 60000)}min, ESPN=${espnStatus})`;
      console.log(`[sync] closing out match ${match.id} via ${reason} (keeping DB score)`);
      const espnCloseBody: Record<string, unknown> = { matchStatus: 'COMPLETED' };
      if (match.homeTeamScore !== null) espnCloseBody.homeTeamScore = match.homeTeamScore;
      if (match.awayTeamScore !== null) espnCloseBody.awayTeamScore = match.awayTeamScore;
      const fallbackRes = await fetch(`${API_URL}/matches/${match.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SYNC_API_SECRET}` },
        body: JSON.stringify(espnCloseBody),
      });
      if (fallbackRes.ok) updated++;
      else console.error(`[sync] failed to close out match ${match.id} via fallback: ${fallbackRes.status}`);
      continue;
    }

    const partida = await partidaRes.json();
    console.log(
      `[sync] API-Futebol partida ${match.apiFutebolId}` +
      ` status=${partida.status}` +
      ` placar=${partida.placar_mandante}-${partida.placar_visitante}` +
      ` disputa_penalti=${!!partida.disputa_penalti}` +
      ` age=${Math.round(matchAge / 60000)}min`
    );

    if (partida.status !== 'finalizado') {
      if (!isOverdue) {
        console.log(`[sync] match ${match.id} not yet finalizado — not closing out`);
        continue;
      }
      console.log(
        `[sync] force-closing overdue match ${match.id}` +
        ` (API-Futebol status=${partida.status}, age=${Math.round(matchAge / 60000)}min, keeping DB score)`
      );
      const forceBody: Record<string, unknown> = { matchStatus: 'COMPLETED' };
      if (match.homeTeamScore !== null) forceBody.homeTeamScore = match.homeTeamScore;
      if (match.awayTeamScore !== null) forceBody.awayTeamScore = match.awayTeamScore;
      const forceRes = await fetch(`${API_URL}/matches/${match.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SYNC_API_SECRET}` },
        body: JSON.stringify(forceBody),
      });
      if (forceRes.ok) updated++;
      else console.error(`[sync] failed to force-close match ${match.id}: ${forceRes.status}`);
      continue;
    }

    const body: Record<string, unknown> = { matchStatus: 'COMPLETED' };
    if (partida.placar_mandante !== null) body.homeTeamScore = partida.placar_mandante;
    if (partida.placar_visitante !== null) body.awayTeamScore = partida.placar_visitante;

    console.log(
      `[sync] closing out match ${match.id} via API-Futebol:` +
      ` ${partida.placar_mandante}-${partida.placar_visitante}`
    );

    const updateRes = await fetch(`${API_URL}/matches/${match.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SYNC_API_SECRET}` },
      body: JSON.stringify(body),
    });

    if (updateRes.ok) updated++;
    else console.error(`[sync] failed to close out match ${match.id}: ${updateRes.status}`);
  }

  return Response.json({ updated, checked: liveMatches.length + stuckMatches.length });
}
