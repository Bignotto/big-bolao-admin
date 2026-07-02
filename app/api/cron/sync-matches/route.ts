import { NextRequest } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL!;
const SYNC_API_SECRET = process.env.SYNC_API_SECRET!;
const API_FUTEBOL_KEY = process.env.API_FUTEBOL_KEY!;
const CHAMPIONSHIP_ID = Number(process.env.API_FUTEBOL_CHAMPIONSHIP_ID);
const TOURNAMENT_ID = process.env.TOURNAMENT_ID!;

type MatchStatus = 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'POSTPONED';

// Update window: a match is only tracked for 2h after kickoff (~90min + halftime
// + stoppage). Past that, regulation is over — we close it out and ignore extra time.
const LIVE_WINDOW_MS = 2 * 60 * 60 * 1000;

// DB stores matchDatetime as America/Sao_Paulo wall-clock time (the mobile app
// relies on that to block predictions), so any 'Z' or offset suffix added by
// serialization is a lie. Parse the naive local time and shift to real UTC.
// Brazil has no DST since 2019, so the offset is a fixed UTC-3.
const SAO_PAULO_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;

function kickoffUtcMs(matchDatetime: string): number {
  const naive = matchDatetime.replace(/(Z|[+-]\d{2}:?\d{2})$/, '');
  return new Date(`${naive}Z`).getTime() + SAO_PAULO_UTC_OFFSET_MS;
}

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
  const kickoff = kickoffUtcMs(matchDatetime);
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
  const runStart = Date.now();
  console.log(`[sync] ===== run started at ${new Date(runStart).toISOString()} =====`);

  const isDev = process.env.NODE_ENV === 'development';
  if (!isDev) {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) {
      console.error('CRON_SECRET is not set');
      return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
    }
    if (request.headers.get('Authorization') !== `Bearer ${cronSecret}`) {
      console.warn('[sync] unauthorized request — Authorization header missing or wrong');
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
    // ESPN uses many in-play status names (STATUS_FIRST_HALF, STATUS_SECOND_HALF,
    // STATUS_HALFTIME, STATUS_IN_PROGRESS, ...) — an allowlist already missed a live
    // match once. Instead: any event that has kicked off, isn't completed, and is
    // still inside the 2h regulation window counts as live.
    const isEventLive = (e: EspnEvent) => {
      if (e.status.type.completed) return false;
      const sinceKickoff = Date.now() - new Date(e.date).getTime();
      return sinceKickoff >= 0 && sinceKickoff < LIVE_WINDOW_MS;
    };
    espnHasLive = espnEvents.some(isEventLive);
    const espnStatuses = espnEvents.map((e) => ({
      date: e.date,
      status: e.status.type.name,
      completed: e.status.type.completed,
      sinceKickoffMin: Math.round((Date.now() - new Date(e.date).getTime()) / 60000),
      live: isEventLive(e),
    }));
    console.log(`[sync] ESPN events: ${espnEvents.length}, espnHasLive: ${espnHasLive}`);
    console.log(`[sync] ESPN event statuses:`, JSON.stringify(espnStatuses));
  } else {
    console.warn(`[sync] ESPN check failed (${espnRes.status}) — proceeding anyway`);
    espnHasLive = true;
  }

  // Second signal, independent of ESPN: our own fixture schedule. Any match not
  // yet final whose kickoff was within the last 2h is potentially live, so a
  // missing/mislabeled ESPN event can't blind the sync. Matches drop out of this
  // window as soon as they're marked COMPLETED, so the extra api-futebol calls
  // only cover real match windows.
  const inScheduleWindow = matches.filter((m: any) => {
    if (!m.apiFutebolId) return false;
    if (m.matchStatus === 'COMPLETED' || m.matchStatus === 'POSTPONED') return false;
    const sinceKickoff = Date.now() - kickoffUtcMs(m.matchDatetime);
    return sinceKickoff >= 0 && sinceKickoff < LIVE_WINDOW_MS;
  });
  console.log(`[sync] matches in 2h schedule window: ${inScheduleWindow.length}`);
  for (const m of inScheduleWindow) {
    console.log(
      `[sync] schedule window: match ${m.id} (apiFutebolId=${m.apiFutebolId})` +
      ` kickoff="${m.matchDatetime}" (SP time → ${new Date(kickoffUtcMs(m.matchDatetime)).toISOString()} UTC)` +
      ` age=${Math.round((Date.now() - kickoffUtcMs(m.matchDatetime)) / 60000)}min status=${m.matchStatus}`
    );
  }

  // Sync if ESPN shows live games, our schedule says a match should be underway,
  // or our DB has matches stuck IN_PROGRESS
  const shouldSync = espnHasLive || inScheduleWindow.length > 0 || inProgressInDB.length > 0;
  console.log(`[sync] shouldSync: ${shouldSync} (espnHasLive=${espnHasLive}, scheduleWindow=${inScheduleWindow.length}, inProgressInDB=${inProgressInDB.length})`);

  if (!shouldSync) {
    console.log('[sync] no live matches per ESPN, none due per schedule, none IN_PROGRESS in DB — skipping api-futebol call');
    console.log(`[sync] ===== run finished: skipped, duration=${Date.now() - runStart}ms =====`);
    return Response.json({ skipped: true, reason: 'no active matches' });
  }

  // 3. Call api-futebol /ao-vivo (1 credit — only reached when shouldSync)
  const liveRes = await fetch('https://api.api-futebol.com.br/v1/ao-vivo', {
    headers: { Authorization: `Bearer ${API_FUTEBOL_KEY}` },
  });
  if (!liveRes.ok) {
    const body = await liveRes.text().catch(() => '(unreadable)');
    console.error(`[sync] API-Futebol /ao-vivo failed: ${liveRes.status} ${body}`);
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

    // Never touch a match already COMPLETED in the DB: after the 2h window closes
    // it, extra time keeps it in the live feed and a plain diff would reopen it
    // (and pull in extra-time goals — only the 90-minute score counts).
    if (match.matchStatus === 'COMPLETED') {
      console.log(`[sync] match ${match.id} already COMPLETED in DB but still in live feed — ignoring`);
      continue;
    }

    // 2h update window: past it, regulation is over. Close the match with the
    // score already in the DB and stop tracking.
    const matchAge = Date.now() - kickoffUtcMs(match.matchDatetime);
    if (matchAge > LIVE_WINDOW_MS) {
      console.log(
        `[sync] match ${match.id} still in live feed past 2h window` +
        ` (age=${Math.round(matchAge / 60000)}min) — closing at regulation score` +
        ` ${match.homeTeamScore}-${match.awayTeamScore}`
      );
      const timeoutBody: Record<string, unknown> = { matchStatus: 'COMPLETED' };
      if (match.homeTeamScore !== null) timeoutBody.homeTeamScore = match.homeTeamScore;
      if (match.awayTeamScore !== null) timeoutBody.awayTeamScore = match.awayTeamScore;
      const timeoutRes = await fetch(`${API_URL}/matches/${match.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SYNC_API_SECRET}` },
        body: JSON.stringify(timeoutBody),
      });
      if (timeoutRes.ok) {
        updated++;
        console.log(`[sync] match ${match.id} closed at 2h window: ${JSON.stringify(timeoutBody)}`);
      } else {
        const errBody = await timeoutRes.text().catch(() => '(unreadable)');
        console.error(`[sync] failed to close out match ${match.id} at 2h window: ${timeoutRes.status} ${errBody}`);
      }
      continue;
    }

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

    if (!scoreChanged && !statusChanged) {
      console.log(`[sync] match ${match.id} unchanged — nothing to update`);
      continue;
    }

    // Only send scores when they are non-null; the backend rejects null scores.
    const body: Record<string, unknown> = { matchStatus: newStatus };
    if (live.placar_mandante !== null) body.homeTeamScore = live.placar_mandante;
    if (live.placar_visitante !== null) body.awayTeamScore = live.placar_visitante;

    console.log(`[sync] PUT match ${match.id}: ${JSON.stringify(body)}`);
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
      console.log(`[sync] match ${match.id} updated OK`);
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
    const matchAge = Date.now() - kickoffUtcMs(match.matchDatetime);
    const isOverdue = matchAge > LIVE_WINDOW_MS;
    console.log(
      `[sync] checking stuck match ${match.id} (apiFutebolId=${match.apiFutebolId})` +
      ` DB=${match.homeTeamScore}-${match.awayTeamScore}` +
      ` age=${Math.round(matchAge / 60000)}min isOverdue=${isOverdue}`
    );

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
      if (fallbackRes.ok) {
        updated++;
        console.log(`[sync] match ${match.id} closed via fallback: ${JSON.stringify(espnCloseBody)}`);
      } else {
        const errBody = await fallbackRes.text().catch(() => '(unreadable)');
        console.error(`[sync] failed to close out match ${match.id} via fallback: ${fallbackRes.status} ${errBody}`);
      }
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
      if (forceRes.ok) {
        updated++;
        console.log(`[sync] match ${match.id} force-closed: ${JSON.stringify(forceBody)}`);
      } else {
        const errBody = await forceRes.text().catch(() => '(unreadable)');
        console.error(`[sync] failed to force-close match ${match.id}: ${forceRes.status} ${errBody}`);
      }
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

    if (updateRes.ok) {
      updated++;
      console.log(`[sync] match ${match.id} closed via API-Futebol: ${JSON.stringify(body)}`);
    } else {
      const errBody = await updateRes.text().catch(() => '(unreadable)');
      console.error(`[sync] failed to close out match ${match.id}: ${updateRes.status} ${errBody}`);
    }
  }

  console.log(
    `[sync] ===== run finished: updated=${updated}` +
    ` checked=${liveMatches.length + stuckMatches.length}` +
    ` (live=${liveMatches.length}, stuck=${stuckMatches.length})` +
    ` duration=${Date.now() - runStart}ms =====`
  );
  return Response.json({ updated, checked: liveMatches.length + stuckMatches.length });
}
