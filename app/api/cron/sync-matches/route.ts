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
  const isDev = process.env.NODE_ENV === 'development';
  if (!isDev && request.headers.get('Authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

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
