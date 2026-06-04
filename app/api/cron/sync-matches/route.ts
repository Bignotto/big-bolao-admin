import { NextRequest } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL!;
const SYNC_API_SECRET = process.env.SYNC_API_SECRET!;
const API_FUTEBOL_KEY = process.env.API_FUTEBOL_KEY!;
const CHAMPIONSHIP_ID = Number(process.env.API_FUTEBOL_CHAMPIONSHIP_ID);
const TOURNAMENT_ID = process.env.TOURNAMENT_ID!;

type MatchStatus = 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'POSTPONED';

function mapStatus(status: string): MatchStatus {
  if (status === 'ao_vivo' || status === 'intervalo' || status === 'andamento') return 'IN_PROGRESS';
  if (status === 'encerrado') return 'COMPLETED';
  if (status === 'cancelado' || status === 'suspenso') return 'POSTPONED';
  return 'SCHEDULED';
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

  // 1. Fetch live matches from API-Futebol first
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
      .filter((m) => m.campeonato.campeonato_id === CHAMPIONSHIP_ID)
      .map((m) => [m.partida_id, m])
  );
  console.log(`[sync] liveMap size after filter: ${liveMap.size}`);

  if (liveMap.size === 0) {
    return Response.json({ updated: 0, checked: 0 });
  }

  // 2. Fetch our matches and filter to those present in liveMap
  const matchesRes = await fetch(`${API_URL}/tournaments/${TOURNAMENT_ID}/matches`, {
    headers: { Authorization: `Bearer ${SYNC_API_SECRET}` },
  });
  if (!matchesRes.ok) {
    return Response.json({ error: 'Failed to fetch matches' }, { status: 500 });
  }
  const { matches } = await matchesRes.json();
  console.log(`[sync] DB returned ${matches.length} matches for tournament ${TOURNAMENT_ID}`);
  console.log(`[sync] apiFutebolIds in DB:`, matches.map((m: any) => m.apiFutebolId).filter(Boolean));
  const liveMatches = matches.filter(
    (m: any) => m.apiFutebolId !== null && liveMap.has(m.apiFutebolId)
  );

  // 3. Diff and update changed matches
  let updated = 0;
  for (const match of liveMatches) {
    const live = liveMap.get(match.apiFutebolId);

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

  return Response.json({ updated, checked: liveMatches.length });
}
