# Big Bolão — Admin Panel

Painel administrativo standalone em Next.js para gerenciar partidas do World Cup 2026.

## Funcionalidades

- **Login via Supabase** — mesmo auth do app mobile (requer role `ADMIN`)
- **Listagem de partidas** por torneio, agrupadas por fase
- **Filtros**: fase, status, busca por time/estádio
- **Edição**: placar, status, data/hora, estádio
- **Mata-mata**: prorrogação + pênaltis

## Setup

### 1. Instalar dependências
```bash
npm install
```

### 2. Configurar variáveis de ambiente
```bash
cp .env.local.example .env.local
```

Edite `.env.local`:
```env
NEXT_PUBLIC_SUPABASE_URL=https://seu-projeto.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sua-anon-key
NEXT_PUBLIC_API_URL=https://big-bolao-api.onrender.com
```

> O usuário logado deve ter `role: ADMIN` no banco. Caso contrário, PUT /matches retorna 403.

### 3. Rodar
```bash
npm run dev
# http://localhost:3000
```

### 4. Build
```bash
npm run build && npm start
```

## Deploy (Vercel)
1. Push para GitHub
2. Importe no Vercel
3. Configure as env vars
4. Deploy automático

## Limitação importante

O backend atual (`PUT /matches/:matchId`) **não suporta atualização de homeTeamId/awayTeamId**.
Para partidas de mata-mata com times indefinidos, a atribuição deve ser feita diretamente no banco.
