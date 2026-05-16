'use client';

import { useState, useEffect } from 'react';
import type { Match, UpdateMatchPayload, MatchStatus } from '@/types';
import { updateMatch } from '@/lib/api';
import { format } from 'date-fns';

interface Props {
  match: Match;
  onClose: () => void;
  onSaved: (match: Match) => void;
}

const STATUS_LABELS: Record<MatchStatus, string> = {
  SCHEDULED: 'Agendada',
  IN_PROGRESS: 'Em Andamento',
  COMPLETED: 'Encerrada',
  POSTPONED: 'Adiada',
};

const STAGE_LABELS: Record<string, string> = {
  GROUP: 'Fase de Grupos',
  ROUND_OF_16: 'Oitavas de Final',
  QUARTER_FINAL: 'Quartas de Final',
  SEMI_FINAL: 'Semifinal',
  FINAL: 'Final',
  THIRD_PLACE: 'Terceiro Lugar',
  LOSERS_MATCH: 'Repescagem',
};

export default function MatchEditModal({ match, onClose, onSaved }: Props) {
  console.log('[MatchEditModal] mounting for match', match?.id);
  const isKnockout = match.stage !== 'GROUP';

  // Form state
  const [status, setStatus] = useState<MatchStatus>(match.matchStatus);
  const [homeScore, setHomeScore] = useState<string>(
    match.homeTeamScore !== null ? String(match.homeTeamScore) : ''
  );
  const [awayScore, setAwayScore] = useState<string>(
    match.awayTeamScore !== null ? String(match.awayTeamScore) : ''
  );
  const [hasExtraTime, setHasExtraTime] = useState(match.hasExtraTime);
  const [hasPenalties, setHasPenalties] = useState(match.hasPenalties);
  const [penaltyHome, setPenaltyHome] = useState<string>(
    match.penaltyHomeScore !== null ? String(match.penaltyHomeScore) : ''
  );
  const [penaltyAway, setPenaltyAway] = useState<string>(
    match.penaltyAwayScore !== null ? String(match.penaltyAwayScore) : ''
  );
  const [stadium, setStadium] = useState(match.stadium ?? '');
  const [matchDatetime, setMatchDatetime] = useState(() => {
    try {
      const d = new Date(match.matchDatetime);
      if (isNaN(d.getTime())) return '';
      return format(d, "yyyy-MM-dd'T'HH:mm");
    } catch {
      return '';
    }
  });

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const canHaveScore = status === 'IN_PROGRESS' || status === 'COMPLETED';

  // Reset penalties if extra time is unchecked
  useEffect(() => {
    if (!hasExtraTime) {
      setHasPenalties(false);
      setPenaltyHome('');
      setPenaltyAway('');
    }
  }, [hasExtraTime]);

  useEffect(() => {
    if (!hasPenalties) {
      setPenaltyHome('');
      setPenaltyAway('');
    }
  }, [hasPenalties]);

  async function handleSave() {
    setSaving(true);
    setError('');

    const home = homeScore !== '' ? Number(homeScore) : null;
    const away = awayScore !== '' ? Number(awayScore) : null;

    if (canHaveScore && hasPenalties) {
      if (home !== away) {
        setError('Pênaltis exigem placar empatado no tempo normal.');
        setSaving(false);
        return;
      }
      if (penaltyHome !== '' && penaltyAway !== '' && Number(penaltyHome) === Number(penaltyAway)) {
        setError('Placar de pênaltis não pode ser empate.');
        setSaving(false);
        return;
      }
    }

    try {
      const payload: UpdateMatchPayload = {
        matchStatus: status,
        stadium: stadium || null,
        matchDatetime: new Date(matchDatetime).toISOString(),
      };

      if (canHaveScore) {
        payload.homeTeamScore = homeScore !== '' ? Number(homeScore) : null;
        payload.awayTeamScore = awayScore !== '' ? Number(awayScore) : null;
      } else {
        payload.homeTeamScore = null;
        payload.awayTeamScore = null;
      }

      if (isKnockout && canHaveScore) {
        payload.hasExtraTime = hasExtraTime;
        payload.hasPenalties = hasPenalties;
        if (hasPenalties) {
          payload.penaltyHomeScore = penaltyHome !== '' ? Number(penaltyHome) : null;
          payload.penaltyAwayScore = penaltyAway !== '' ? Number(penaltyAway) : null;
        } else {
          payload.penaltyHomeScore = null;
          payload.penaltyAwayScore = null;
        }
      }

      const updated = await updateMatch(match.id, payload);
      onSaved(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
        zIndex: 9999,
        background: 'rgba(0,0,0,0.7)',
        backdropFilter: 'blur(4px)',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="card modal-in w-full max-w-lg overflow-hidden"
        style={{ border: '1px solid var(--border-bright)' }}
      >
        {/* Header */}
        <div
          className="px-6 py-4 flex items-center justify-between"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className={`inline-flex px-2 py-0.5 rounded text-xs font-display font-bold border stage-${match.stage}`}>
                {STAGE_LABELS[match.stage]}
              </span>
              {match.group && (
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Grupo {match.group}
                </span>
              )}
            </div>
            <h2 className="font-display font-bold text-xl">
              Partida #{match.id}
            </h2>
          </div>
          <button onClick={onClose} className="btn btn-ghost p-2" style={{ padding: '6px' }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Teams display */}
        <div
          className="px-6 py-4 flex items-center justify-between gap-4"
          style={{ borderBottom: '1px solid var(--border)', background: 'rgba(0,0,0,0.2)' }}
        >
          <TeamDisplay team={match.homeTeam} align="left" />
          <div className="text-center flex-shrink-0">
            {match.homeTeamScore !== null && match.awayTeamScore !== null ? (
              <span className="font-display font-bold text-2xl" style={{ color: 'var(--accent)' }}>
                {match.homeTeamScore} — {match.awayTeamScore}
              </span>
            ) : (
              <span className="font-display text-lg" style={{ color: 'var(--text-dim)' }}>vs</span>
            )}
          </div>
          <TeamDisplay team={match.awayTeam} align="right" />
        </div>

        {/* Form */}
        <div className="px-6 py-5 space-y-5 max-h-[60vh] overflow-y-auto">

          {/* Status + Datetime */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Status</Label>
              <select
                className="input"
                value={status}
                onChange={(e) => setStatus(e.target.value as MatchStatus)}
              >
                {Object.entries(STATUS_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <div>
              <Label>Data / Hora (local)</Label>
              <input
                className="input"
                type="datetime-local"
                value={matchDatetime}
                onChange={(e) => setMatchDatetime(e.target.value)}
              />
            </div>
          </div>

          {/* Stadium */}
          <div>
            <Label>Estádio</Label>
            <input
              className="input"
              type="text"
              value={stadium}
              onChange={(e) => setStadium(e.target.value)}
              placeholder="Nome do estádio"
            />
          </div>

          {/* Scores */}
          <div>
            <Label>Placar</Label>
            {!canHaveScore && (
              <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
                Placar disponível apenas para status Em Andamento ou Encerrada
              </p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs mb-1 truncate" style={{ color: 'var(--text-muted)' }}>
                  {match.homeTeam.name}
                </p>
                <input
                  className="input"
                  type="number"
                  min="0"
                  value={homeScore}
                  onChange={(e) => setHomeScore(e.target.value)}
                  placeholder="0"
                  disabled={!canHaveScore}
                />
              </div>
              <div>
                <p className="text-xs mb-1 truncate" style={{ color: 'var(--text-muted)' }}>
                  {match.awayTeam.name}
                </p>
                <input
                  className="input"
                  type="number"
                  min="0"
                  value={awayScore}
                  onChange={(e) => setAwayScore(e.target.value)}
                  placeholder="0"
                  disabled={!canHaveScore}
                />
              </div>
            </div>
          </div>

          {/* Knockout extras */}
          {isKnockout && canHaveScore && (
            <div
              className="p-4 rounded-lg space-y-4"
              style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
            >
              <p className="text-xs font-display font-bold tracking-widest" style={{ color: 'var(--text-muted)' }}>
                MATA-MATA
              </p>

              <label className="flex items-center gap-3 cursor-pointer">
                <Toggle checked={hasExtraTime} onChange={setHasExtraTime} />
                <span className="text-sm">Prorrogação</span>
              </label>

              {hasExtraTime && (
                <label className="flex items-center gap-3 cursor-pointer">
                  <Toggle checked={hasPenalties} onChange={setHasPenalties} />
                  <span className="text-sm">Pênaltis</span>
                </label>
              )}

              {hasPenalties && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs mb-1 truncate" style={{ color: 'var(--text-muted)' }}>
                      {match.homeTeam.name} (pen.)
                    </p>
                    <input
                      className="input"
                      type="number"
                      min="0"
                      value={penaltyHome}
                      onChange={(e) => setPenaltyHome(e.target.value)}
                      placeholder="0"
                    />
                  </div>
                  <div>
                    <p className="text-xs mb-1 truncate" style={{ color: 'var(--text-muted)' }}>
                      {match.awayTeam.name} (pen.)
                    </p>
                    <input
                      className="input"
                      type="number"
                      min="0"
                      value={penaltyAway}
                      onChange={(e) => setPenaltyAway(e.target.value)}
                      placeholder="0"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {error && (
            <div
              className="p-3 rounded-md text-sm"
              style={{ background: 'var(--red-dim)', color: 'var(--red)', border: '1px solid rgba(255,82,82,0.3)' }}
            >
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="px-6 py-4 flex items-center justify-end gap-3"
          style={{ borderTop: '1px solid var(--border)' }}
        >
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? (
              <>
                <Spinner />
                Salvando...
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M11.5 4.5L5.5 10.5L2.5 7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Salvar
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-xs font-display font-semibold tracking-widest mb-2"
      style={{ color: 'var(--text-muted)' }}>
      {children}
    </label>
  );
}

function TeamDisplay({ team, align }: { team: { name: string; flagUrl?: string | null }; align: 'left' | 'right' }) {
  return (
    <div className={`flex items-center gap-2 flex-1 ${align === 'right' ? 'flex-row-reverse' : ''}`}>
      {team.flagUrl ? (
        <img src={team.flagUrl} alt="" className="w-8 h-6 object-cover rounded-sm flex-shrink-0"
          style={{ border: '1px solid var(--border)' }} />
      ) : (
        <div className="w-8 h-6 rounded-sm flex-shrink-0"
          style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }} />
      )}
      <span className="font-display font-semibold text-sm truncate">{team.name}</span>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="relative flex-shrink-0"
      style={{ width: 36, height: 20 }}
    >
      <div
        className="absolute inset-0 rounded-full transition-colors duration-200"
        style={{ background: checked ? 'var(--accent)' : 'var(--border-bright)' }}
      />
      <div
        className="absolute top-1 rounded-full transition-transform duration-200"
        style={{
          width: 12,
          height: 12,
          background: '#fff',
          left: 4,
          transform: checked ? 'translateX(16px)' : 'translateX(0)',
        }}
      />
    </button>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
