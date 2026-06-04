export type MatchStage =
  | 'GROUP'
  | 'ROUND_OF_16'
  | 'QUARTER_FINAL'
  | 'SEMI_FINAL'
  | 'FINAL'
  | 'THIRD_PLACE'
  | 'LOSERS_MATCH';

export type MatchStatus = 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'POSTPONED';

export interface Team {
  id: number;
  name: string;
  countryCode: string | null;
  flagUrl: string | null;
}

export interface Match {
  id: number;
  tournamentId: number;
  homeTeamId: number | null;
  awayTeamId: number | null;
  matchDatetime: string;
  apiFutebolId: number | null;
  stadium: string | null;
  stage: MatchStage;
  group: string | null;
  homeTeamScore: number | null;
  awayTeamScore: number | null;
  matchStatus: MatchStatus;
  hasExtraTime: boolean;
  hasPenalties: boolean;
  penaltyHomeScore: number | null;
  penaltyAwayScore: number | null;
  homeTeam: Team | null;
  awayTeam: Team | null;
}

export interface Tournament {
  id: number;
  name: string;
  startDate: string;
  endDate: string;
  logoUrl: string | null;
  status: 'UPCOMING' | 'ACTIVE' | 'COMPLETED';
  totalMatches: number;
  completedMatches: number;
}

export interface UpdateMatchPayload {
  homeTeamScore?: number | null;
  awayTeamScore?: number | null;
  matchStatus?: MatchStatus;
  hasExtraTime?: boolean;
  hasPenalties?: boolean;
  penaltyHomeScore?: number | null;
  penaltyAwayScore?: number | null;
  matchDate?: string;
  stadium?: string | null;
  homeTeam?: number;
  awayTeam?: number;
}
