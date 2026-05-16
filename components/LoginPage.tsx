'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
    setLoading(false);
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      {/* Background decoration */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse 60% 50% at 50% 0%, rgba(0,212,255,0.06) 0%, transparent 70%)',
        }}
      />

      <div className="w-full max-w-sm animate-in" style={{ animationDelay: '0ms' }}>
        {/* Header */}
        <div className="text-center mb-10">
          <div
            className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-5"
            style={{
              background: 'rgba(0,212,255,0.1)',
              border: '1px solid rgba(0,212,255,0.3)',
            }}
          >
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <circle cx="16" cy="16" r="14" stroke="#00d4ff" strokeWidth="1.5" />
              <path d="M16 8 L20 14 L16 12 L12 14 Z" fill="#00d4ff" opacity="0.8" />
              <path d="M16 24 L12 18 L16 20 L20 18 Z" fill="#00d4ff" opacity="0.8" />
              <path d="M8 16 L14 12 L12 16 L14 20 Z" fill="#00d4ff" opacity="0.6" />
              <path d="M24 16 L18 20 L20 16 L18 12 Z" fill="#00d4ff" opacity="0.6" />
            </svg>
          </div>
          <h1
            className="font-display text-4xl font-bold tracking-wider mb-1"
            style={{ color: 'var(--text)' }}
          >
            BIG BOLÃO
          </h1>
          <p className="font-display text-sm tracking-widest" style={{ color: 'var(--text-muted)' }}>
            PAINEL ADMINISTRATIVO
          </p>
        </div>

        {/* Form */}
        <div className="card p-6">
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-display font-semibold tracking-widest mb-2"
                style={{ color: 'var(--text-muted)' }}>
                EMAIL
              </label>
              <input
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@bigbolao.com"
                required
                autoComplete="email"
              />
            </div>
            <div>
              <label className="block text-xs font-display font-semibold tracking-widest mb-2"
                style={{ color: 'var(--text-muted)' }}>
                SENHA
              </label>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                autoComplete="current-password"
              />
            </div>

            {error && (
              <div
                className="p-3 rounded-md text-sm"
                style={{ background: 'var(--red-dim)', color: 'var(--red)', border: '1px solid rgba(255,82,82,0.3)' }}
              >
                {error}
              </div>
            )}

            <button type="submit" className="btn btn-primary w-full justify-center mt-2" disabled={loading}>
              {loading ? (
                <>
                  <Spinner />
                  ENTRANDO...
                </>
              ) : (
                'ENTRAR'
              )}
            </button>
          </form>
        </div>

        <p className="text-center mt-6 text-xs" style={{ color: 'var(--text-dim)' }}>
          Acesso restrito — apenas administradores
        </p>
      </div>
    </div>
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
