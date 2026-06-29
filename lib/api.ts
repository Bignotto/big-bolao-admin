import { supabase } from './supabase';
import type { Match, Tournament, UpdateMatchPayload } from '@/types';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'https://big-bolao-api.onrender.com';

async function getAuthHeaders(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Not authenticated');
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${API_URL}${path}`, { ...options, headers: { ...headers, ...options?.headers } });
  const body = await res.json();
  if (!res.ok) {
    console.error('[api] error response:', res.status, JSON.stringify(body));
    throw new Error(body.message ?? body.error ?? body.detail ?? `API error ${res.status}`);
  }
  return body as T;
}

export async function getTournaments(): Promise<Tournament[]> {
  const data = await apiFetch<{ tournaments: Tournament[] }>('/tournaments');
  return data.tournaments;
}

export async function getTournamentMatches(
  tournamentId: number,
  params?: { stage?: string; status?: string; limit?: number; offset?: number }
): Promise<Match[]> {
  const qs = new URLSearchParams();
  if (params?.stage) qs.set('stage', params.stage);
  if (params?.status) qs.set('status', params.status);
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  const query = qs.toString() ? `?${qs}` : '';
  const data = await apiFetch<{ matches: Match[] }>(`/tournaments/${tournamentId}/matches${query}`);
  return data.matches;
}

export async function getMatch(matchId: number): Promise<Match> {
  const data = await apiFetch<{ match: Match }>(`/matches/${matchId}`);
  return data.match;
}

export async function updateMatch(matchId: number, payload: UpdateMatchPayload): Promise<Match> {
  const data = await apiFetch<{ match: Match }>(`/matches/${matchId}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  return data.match;
}
