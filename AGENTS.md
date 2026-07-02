<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
# Big Bolão — Admin Panel and Automatic Results Updater

Painel administrativo standalone em Next.js para gerenciar as partidas da Copa do Mundo 2026.
Permite corrigir resultados quando o atualizador automático falha e definir os confrontos das fases eliminatórias.

O objetivo principal deste projeto é manter o resultado dos jogos da copa atualizados ao vivo. A cada 5 minutos deve descobrir se há um jogo da copa do mundo de 2026 ativo, em tempo regulamentar, para atualizar o resultado do jogo para os usuários do nosso Big Bolão App. Quando há um jogo ao vivo, busca o resultado na API Futebol, serviço pago, que nos dá 100 chamadas por dia, por isso precisamos buscar os jogos em outro lugar antes, evitando assim chamadas desnecessárias à API. Deve considerar somente os 90 minutos do tempo regulamentar e atualizar o jogo como COMPLETED no backend. Deve considerar somente os gols dos 90 minutos. 

---

## Stack

- **Framework:** Next.js 16 (App Router, `use client` em todos os componentes interativos)
- **Linguagem:** TypeScript estrito
- **Estilo:** Tailwind CSS + CSS custom properties (`globals.css`)
- **Auth:** Supabase (`@supabase/supabase-js`) — mesmo projeto do app mobile
- **HTTP:** fetch nativo via `lib/api.ts`
- **Datas:** `date-fns` com locale `ptBR`

---

## Estrutura

```
bolao-admin/
├── app/
│   ├── layout.tsx          # Root layout (sem lógica)
│   ├── page.tsx            # Entry point → re-exporta AdminDashboard
│   └── globals.css         # Design tokens CSS vars + utilitários
├── components/
│   ├── AdminDashboard.tsx  # Shell principal: auth guard, lista de partidas, filtros
│   ├── LoginPage.tsx       # Tela de login (Supabase email/password)
│   └── MatchEditModal.tsx  # Modal de edição de partida
├── lib/
│   ├── api.ts              # Cliente HTTP da API do backend
│   └── supabase.ts         # Cliente Supabase (singleton)
└── types/
    └── index.ts            # Tipos compartilhados (Match, Team, Tournament, etc.)
```

---

## Variáveis de ambiente

Arquivo: `.env.local` (não commitado)

```env
NEXT_PUBLIC_SUPABASE_URL=https://seu-projeto.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sua-anon-key
NEXT_PUBLIC_API_URL=https://big-bolao-api.onrender.com
```

O `lib/supabase.ts` usa placeholders quando as vars não estão definidas para não quebrar o build SSR.

---

## Comandos

```bash
npm run dev      # dev com Turbopack — http://localhost:3000
npm run build    # build de produção
npm run lint     # ESLint
```

---

## Autenticação

- Login com email/password via Supabase (mesmo projeto do app mobile)
- Token JWT injetado automaticamente em cada requisição via `getAuthHeaders()` em `lib/api.ts`
- Backend exige `role: ADMIN` para `PUT /matches/:matchId` — retorna 403 se não for admin
- Sessão persistida pelo SDK do Supabase; logout via `supabase.auth.signOut()`

---

## API do backend

Base URL: `NEXT_PUBLIC_API_URL` (padrão: `https://big-bolao-api.onrender.com`)

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/tournaments` | Lista torneios |
| GET | `/tournaments/:id/matches` | Partidas (`?stage=&status=&limit=&offset=`) |
| GET | `/matches/:id` | Detalhes de uma partida |
| PUT | `/matches/:id` | Atualiza partida (admin only) |

### Payload de atualização (`PUT /matches/:id`)

```ts
{
  homeTeamScore?: number | null
  awayTeamScore?: number | null
  matchStatus?: 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'POSTPONED'
  hasExtraTime?: boolean
  hasPenalties?: boolean
  penaltyHomeScore?: number | null
  penaltyAwayScore?: number | null
  matchDatetime?: string  // ISO 8601
  stadium?: string | null
}
```

**Regras de negócio do backend (validadas no use case):**
- Placar só pode ser definido se `matchStatus` for `IN_PROGRESS` ou `COMPLETED`
- `hasPenalties` exige `hasExtraTime: true`
- Pênaltis exigem placar empatado no tempo normal/prorrogação
- `penaltyHomeScore !== penaltyAwayScore` (pênaltis não podem empatar)

---

## Design system

Cores em CSS custom properties no `globals.css`:

```
--bg, --surface, --surface-2        → backgrounds
--border, --border-bright           → bordas
--text, --text-muted, --text-dim    → tipografia
--accent (#00d4ff)                  → ações primárias
--green, --yellow, --red, --orange  → status e fases
```

Classes prontas: `.card`, `.input`, `.btn`, `.btn-primary`, `.btn-ghost`, `.btn-danger`
Fonte display: **Barlow Condensed** | Fonte corpo: **Barlow**
Badges de fase: `.stage-GROUP` `.stage-ROUND_OF_16` `.stage-QUARTER_FINAL` `.stage-SEMI_FINAL` `.stage-FINAL` `.stage-THIRD_PLACE` `.stage-LOSERS_MATCH`

---

## Como fazer cada coisa

### Editar um campo existente no modal

1. Abrir `components/MatchEditModal.tsx`
2. Localizar o `useState` correspondente
3. Modificar a lógica no `handleSave()` e/ou o JSX do campo

### Adicionar um novo campo editável

1. Adicionar `useState` em `MatchEditModal.tsx`
2. Incluir o campo no `payload` dentro de `handleSave()`
3. Adicionar o `<input>` ou `<select>` no JSX dentro de `<div className="px-6 py-5 space-y-5">`
4. Se o campo não existir em `UpdateMatchPayload`, adicionar em `types/index.ts`

### Adicionar informação na lista de partidas

1. Abrir `components/AdminDashboard.tsx`
2. Modificar o componente `MatchRow` no final do arquivo

### Conectar um novo endpoint da API

1. Adicionar função em `lib/api.ts` usando `apiFetch<T>(path, options?)`
2. Tipar o retorno em `types/index.ts` se necessário
3. Chamar a função no componente com `useEffect` + `useState`

### Exibir um toast

```ts
addToast('success', 'Mensagem de sucesso')
addToast('error', 'Mensagem de erro')
```

`addToast` está disponível no escopo do `AdminDashboard`. Para usar em subcomponentes, passar como prop ou elevar o estado.

---

## Limitação: atribuição de times em mata-mata

O endpoint `PUT /matches/:matchId` **não aceita `homeTeamId`/`awayTeamId`** — não estão no schema do backend.

Para partidas com times ainda indefinidos (ex: "Vencedor Jogo A"), há duas opções:

**Opção A — Estender o backend (correto a longo prazo)**

No backend (`big-bolao-api`), modificar:
1. `src/http/schemas/match.schemas.ts` → adicionar `homeTeamId` e `awayTeamId` ao `UpdateMatchRequest`
2. `src/useCases/matches/updateMatchUseCase.ts` → o use case já aceita `homeTeam` e `awayTeam` — só falta expor pelo HTTP
3. `src/http/controllers/matches/updateMatchController.ts` → mapear os novos campos do body para o use case

Depois, no painel admin:
- `types/index.ts`: adicionar `homeTeamId?: number; awayTeamId?: number` a `UpdateMatchPayload`
- `MatchEditModal.tsx`: adicionar dois `<select>` para escolher os times (precisará de `GET /tournaments/:id/teams`)

**Opção B — SQL direto (rápido, manual)**

```sql
UPDATE "Match"
SET "homeTeamId" = <id>, "awayTeamId" = <id>, "updatedAt" = NOW()
WHERE id = <matchId>;
```

---

## Deploy

**Vercel (recomendado):**
1. Push para o GitHub
2. Importar projeto no Vercel
3. Definir as 3 variáveis de ambiente (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_URL`)
4. Deploy automático a cada push na `main`

**Render:**
- Build command: `npm run build`
- Start command: `npm start`
- Node version: 18+
