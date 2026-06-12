'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { getTournaments, getTournamentMatches } from '@/lib/api';
import type { Tournament, Match, Team, MatchStage, MatchStatus } from '@/types';
import LoginPage from './LoginPage';
import MatchEditModal from './MatchEditModal';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

const STAGES: MatchStage[] = [
  'GROUP',
  'ROUND_OF_16',
  'QUARTER_FINAL',
  'SEMI_FINAL',
  'FINAL',
  'THIRD_PLACE',
  'LOSERS_MATCH',
];

const STAGE_LABELS: Record<MatchStage, string> = {
  GROUP: 'Grupos',
  ROUND_OF_16: 'Oitavas',
  QUARTER_FINAL: 'Quartas',
  SEMI_FINAL: 'Semi',
  FINAL: 'Final',
  THIRD_PLACE: '3º Lugar',
  LOSERS_MATCH: 'Repescagem',
};

const STATUS_LABELS: Record<MatchStatus, string> = {
  SCHEDULED: 'Agendada',
  IN_PROGRESS: 'Ao Vivo',
  COMPLETED: 'Encerrada',
  POSTPONED: 'Adiada',
};

interface Toast {
  id: number;
  type: 'success' | 'error';
  message: string;
}

export default function AdminDashboard() {
  const [session, setSession] = useState<any>(null);
  const [loadingAuth, setLoadingAuth] = useState(true);

  // Data
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [selectedTournament, setSelectedTournament] = useState<number | null>(null);
  const [matches, setMatches] = useState<Match[]>([]);
  const [loadingMatches, setLoadingMatches] = useState(false);

  const teams = useMemo(
    () =>
      Array.from(
        new Map(
          matches
            .flatMap((m) => [m.homeTeam, m.awayTeam])
            .filter((t): t is Team => t != null)
            .map((t) => [t.id, t])
        ).values()
      ),
    [matches]
  );

  // Filters
  const [filterStage, setFilterStage] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [search, setSearch] = useState('');

  // Edit
  const [editingMatch, setEditingMatch] = useState<Match | null>(null);

  // Toast
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);

  function addToast(type: 'success' | 'error', message: string) {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }

  // Auth
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoadingAuth(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Load tournaments
  useEffect(() => {
    if (!session) return;
    getTournaments()
      .then((t) => {
        setTournaments(t);
        if (t.length > 0) setSelectedTournament(t[0].id);
      })
      .catch(() => addToast('error', 'Erro ao carregar torneios'));
  }, [session]);

  // Load matches
  const loadMatches = useCallback(() => {
    if (!selectedTournament) return;
    setLoadingMatches(true);
    getTournamentMatches(selectedTournament, {
      stage: filterStage || undefined,
      status: filterStatus || undefined,
      limit: 100,
    })
      .then(setMatches)
      .catch(() => addToast('error', 'Erro ao carregar partidas'))
      .finally(() => setLoadingMatches(false));
  }, [selectedTournament, filterStage, filterStatus]);

  useEffect(() => {
    loadMatches();
  }, [loadMatches]);

  // Filter by search
  const filteredMatches = matches.filter((m) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (m.homeTeam?.name ?? '').toLowerCase().includes(q) ||
      (m.awayTeam?.name ?? '').toLowerCase().includes(q) ||
      (m.stadium ?? '').toLowerCase().includes(q) ||
      String(m.id).includes(q)
    );
  });

  // Group by stage
  const grouped = STAGES.reduce<Record<string, Match[]>>((acc, stage) => {
    const list = filteredMatches.filter((m) => m.stage === stage);
    if (list.length > 0) acc[stage] = list;
    return acc;
  }, {});

  function handleSaved(updated: Match) {
    setMatches((prev) => prev.map((m) => (m.id === updated.id ? { ...m, ...updated } : m)));
    setEditingMatch(null);
    addToast('success', `Partida #${updated.id} atualizada com sucesso`);
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
  }

  if (loadingAuth) return <LoadingScreen />;
  if (!session) return <LoginPage />;

  const currentTournament = tournaments.find((t) => t.id === selectedTournament);

  return (
    <div className="min-h-screen">
      {/* Top bar */}
      <header
        style={{
          background: 'var(--surface)',
          borderBottom: '1px solid var(--border)',
          position: 'sticky',
          top: 0,
          zIndex: 100,
        }}
      >
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
          {/* Logo */}
          <div className="flex items-center gap-3 flex-shrink-0">
            <div
              className="flex items-center justify-center w-8 h-8 rounded-lg"
              style={{ background: 'rgba(0,212,255,0.1)', border: '1px solid rgba(0,212,255,0.3)' }}
            >
              <svg width="16" height="16" viewBox="0 0 32 32" fill="none">
                <circle cx="16" cy="16" r="14" stroke="#00d4ff" strokeWidth="1.5" />
                <path d="M16 8L20 14L16 12L12 14Z" fill="#00d4ff" opacity="0.8" />
                <path d="M16 24L12 18L16 20L20 18Z" fill="#00d4ff" opacity="0.8" />
              </svg>
            </div>
            <div>
              <h1 className="font-display font-bold text-base tracking-wide leading-tight">BIG BOLÃO</h1>
              <p className="text-xs leading-tight" style={{ color: 'var(--text-muted)' }}>Admin</p>
            </div>
          </div>

          {/* Tournament selector */}
          {tournaments.length > 1 && (
            <select
              className="input"
              style={{ maxWidth: 240 }}
              value={selectedTournament ?? ''}
              onChange={(e) => setSelectedTournament(Number(e.target.value))}
            >
              {tournaments.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          )}

          {/* Stats */}
          {currentTournament && (
            <div className="hidden md:flex items-center gap-6">
              <Stat label="Total" value={currentTournament.totalMatches ?? 0} />
              <Stat label="Encerradas" value={currentTournament.completedMatches ?? 0} accent="accent" />
              <Stat
                label="Pendentes"
                value={(currentTournament.totalMatches ?? 0) - (currentTournament.completedMatches ?? 0)}
                accent="yellow"
              />
            </div>
          )}

          {/* Logout */}
          <button className="btn btn-ghost" onClick={handleSignOut} style={{ flexShrink: 0 }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M5 2H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3M9 10l3-3-3-3M12 7H5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Sair
          </button>
        </div>
      </header>

      {/* Filters */}
      <div
        style={{
          background: 'var(--surface)',
          borderBottom: '1px solid var(--border)',
          position: 'sticky',
          top: 57,
          zIndex: 99,
        }}
      >
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-3 flex-wrap">
          {/* Search */}
          <div className="relative flex-1" style={{ minWidth: 200, maxWidth: 300 }}>
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2"
              width="13"
              height="13"
              viewBox="0 0 13 13"
              fill="none"
              style={{ color: 'var(--text-dim)' }}
            >
              <circle cx="5.5" cy="5.5" r="4.5" stroke="currentColor" strokeWidth="1.3" />
              <path d="M9 9l2.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            <input
              className="input"
              style={{ paddingLeft: 32 }}
              placeholder="Buscar time, estádio, #id..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {/* Stage filter */}
          <select
            className="input"
            style={{ width: 160 }}
            value={filterStage}
            onChange={(e) => setFilterStage(e.target.value)}
          >
            <option value="">Todas as fases</option>
            {STAGES.map((s) => (
              <option key={s} value={s}>{STAGE_LABELS[s]}</option>
            ))}
          </select>

          {/* Status filter */}
          <select
            className="input"
            style={{ width: 160 }}
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
          >
            <option value="">Todos os status</option>
            {Object.entries(STATUS_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>

          {/* Refresh */}
          <button className="btn btn-ghost" onClick={loadMatches} disabled={loadingMatches}>
            <svg
              width="13"
              height="13"
              viewBox="0 0 13 13"
              fill="none"
              className={loadingMatches ? 'animate-spin' : ''}
            >
              <path
                d="M11 6.5A4.5 4.5 0 1 1 6.5 2H9M9 2l-2 2M9 2l-2-2"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Atualizar
          </button>

          <span className="text-xs ml-auto" style={{ color: 'var(--text-muted)' }}>
            {filteredMatches.length} partida{filteredMatches.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Content */}
      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
        {loadingMatches && matches.length === 0 ? (
          <div className="flex items-center justify-center py-32">
            <div className="text-center">
              <svg className="animate-spin mx-auto mb-4" width="32" height="32" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="var(--border-bright)" strokeWidth="2" />
                <path d="M12 2a10 10 0 0 1 10 10" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <p style={{ color: 'var(--text-muted)' }}>Carregando partidas...</p>
            </div>
          </div>
        ) : filteredMatches.length === 0 ? (
          <div className="flex items-center justify-center py-32">
            <div className="text-center">
              <div className="text-4xl mb-4">⚽</div>
              <p className="font-display font-bold text-lg mb-2">Nenhuma partida encontrada</p>
              <p style={{ color: 'var(--text-muted)' }}>Tente ajustar os filtros</p>
            </div>
          </div>
        ) : (
          <div className="space-y-8">
            {Object.entries(grouped).map(([stage, stageMatches]) => (
              <section key={stage} className="animate-in">
                {/* Stage header */}
                <div className="flex items-center gap-3 mb-3">
                  <span className={`inline-flex px-3 py-1 rounded text-xs font-display font-bold border stage-${stage}`}>
                    {STAGE_LABELS[stage as MatchStage]}
                  </span>
                  <div className="flex-1 h-px" style={{ background: 'var(--border)' }} />
                  <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
                    {stageMatches.length} jogo{stageMatches.length !== 1 ? 's' : ''}
                  </span>
                </div>

                {/* Match cards */}
                <div className="grid gap-2">
                  {stageMatches.map((match) => (
                    <MatchRow
                      key={match.id}
                      match={match}
                      onEdit={() => setEditingMatch(match)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>

      {/* Edit modal */}
      {editingMatch && (
        <MatchEditModal
          match={editingMatch}
          teams={teams}
          onClose={() => setEditingMatch(null)}
          onSaved={handleSaved}
        />
      )}

      {/* Toasts */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}

function MatchRow({ match, onEdit }: { match: Match; onEdit: () => void }) {
  const hasScore = match.homeTeamScore !== null && match.awayTeamScore !== null;
  const matchDate = new Date(match.matchDatetime);

  return (
    <div
      className="card card-interactive flex items-center gap-4 px-4 py-3 group"
      role="button"
      tabIndex={0}
      onClick={onEdit}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onEdit(); }}
    >
      {/* ID */}
      <span
        className="font-display font-bold text-xs flex-shrink-0 w-10 text-right"
        style={{ color: 'var(--text-dim)' }}
      >
        #{match.id}
      </span>

      {/* Home team */}
      <div className="flex items-center gap-2 flex-1 min-w-0 justify-end">
        <span className="font-display font-semibold text-sm truncate">{match.homeTeam?.name ?? '?'}</span>
        {match.homeTeam?.flagUrl ? (
          <img src={match.homeTeam.flagUrl} alt="" className="w-7 h-5 object-cover rounded-sm flex-shrink-0"
            style={{ border: '1px solid var(--border)' }} />
        ) : (
          <div className="w-7 h-5 rounded-sm flex-shrink-0" style={{ background: 'var(--surface-2)' }} />
        )}
      </div>

      {/* Score */}
      <div className="flex-shrink-0 w-28 text-center">
        {hasScore ? (
          <span className="font-display font-bold text-lg" style={{ color: 'var(--accent)' }}>
            {match.homeTeamScore} — {match.awayTeamScore}
          </span>
        ) : (
          <div>
            <span className="font-display font-bold text-base" style={{ color: 'var(--text-dim)' }}>vs</span>
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-dim)' }}>
              {format(matchDate, 'dd/MM HH:mm')}
            </div>
          </div>
        )}
      </div>

      {/* Away team */}
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {match.awayTeam?.flagUrl ? (
          <img src={match.awayTeam.flagUrl} alt="" className="w-7 h-5 object-cover rounded-sm flex-shrink-0"
            style={{ border: '1px solid var(--border)' }} />
        ) : (
          <div className="w-7 h-5 rounded-sm flex-shrink-0" style={{ background: 'var(--surface-2)' }} />
        )}
        <span className="font-display font-semibold text-sm truncate">{match.awayTeam?.name ?? '?'}</span>
      </div>

      {/* Penalties indicator */}
      {match.hasPenalties && match.penaltyHomeScore !== null && (
        <span className="hidden sm:inline-flex text-xs px-2 py-0.5 rounded flex-shrink-0"
          style={{ background: 'var(--yellow-dim)', color: 'var(--yellow)', border: '1px solid rgba(255,215,64,0.3)' }}>
          pen. {match.penaltyHomeScore}–{match.penaltyAwayScore}
        </span>
      )}
      {match.hasExtraTime && !match.hasPenalties && (
        <span className="hidden sm:inline-flex text-xs px-2 py-0.5 rounded flex-shrink-0"
          style={{ background: 'var(--surface-2)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}>
          prorr.
        </span>
      )}

      {/* Status */}
      <div className="flex-shrink-0 w-28 text-right hidden sm:block">
        <StatusBadge status={match.matchStatus} />
      </div>

      {/* Datetime */}
      {hasScore && (
        <span className="text-xs flex-shrink-0 hidden md:block" style={{ color: 'var(--text-dim)' }}>
          {format(matchDate, 'dd/MM HH:mm')}
        </span>
      )}

      {/* Edit icon */}
      <div
        className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ color: 'var(--accent)' }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M9.5 2.5l2 2-7 7H2.5v-2l7-7z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: MatchStatus }) {
  const labels: Record<MatchStatus, string> = {
    SCHEDULED: 'Agendada',
    IN_PROGRESS: 'Ao Vivo',
    COMPLETED: 'Encerrada',
    POSTPONED: 'Adiada',
  };
  return (
    <span className={`text-xs font-display font-semibold status-${status} ${status === 'IN_PROGRESS' ? 'animate-pulse-slow' : ''}`}>
      {status === 'IN_PROGRESS' && '● '}{labels[status]}
    </span>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: string }) {
  const colors: Record<string, string> = {
    accent: 'var(--accent)',
    yellow: 'var(--yellow)',
    green: 'var(--green)',
  };
  return (
    <div className="text-center">
      <div
        className="font-display font-bold text-xl leading-tight"
        style={{ color: accent ? colors[accent] : 'var(--text)' }}
      >
        {value}
      </div>
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</div>
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <svg className="animate-spin" width="32" height="32" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" stroke="var(--border-bright)" strokeWidth="2" />
        <path d="M12 2a10 10 0 0 1 10 10" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </div>
  );
}
