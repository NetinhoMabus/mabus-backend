# Mabus Monitor de Licitações v2 — Claude + Claudinho MCP

## Como funciona

```
[Netlify]         [Railway]              [Anthropic API]
frontend/  →  POST /api/sync  →  Claude + Claudinho MCP  →  Nextcloud Deck
           ←  JSON estruturado  ←  lê boards em tempo real
```

Quando o usuário clica em **↻ Sincronizar**, o backend chama a API da Anthropic com o MCP do Claudinho. O Claude lê os boards do Nextcloud Deck em tempo real e retorna os dados estruturados. Resultado fica em cache no SQLite.

---

## Boards fixos (já confirmados)

| Board | ID | Uso |
|-------|-----|-----|
| 👀 Acompanhar | 79 | Pipeline de licitações |
| 🏆 Processos Vencidos novo | 132 | Homologadas (stack ID: 545) |

---

## PASSO 1 — Deploy do backend no Railway

1. Acesse **railway.app** → Login with GitHub
2. **New Project → Deploy from GitHub repo**
3. Suba a pasta `backend/` em um repositório GitHub
4. Em **Variables**, adicione:

```
PANEL_PASSWORD=mabus2026
JWT_SECRET=coloque-string-aleatoria-longa-aqui
ANTHROPIC_API_KEY=sk-ant-XXXXXXXXXXXXXXX
CLAUDINHO_MCP_URL=https://mcp.mabus.com.br/mcp
```

5. Em **Settings → Build**:
   - Build: `npm install`
   - Start: `node server.js`

6. Copie a URL gerada (ex: `mabus-backend.up.railway.app`)

---

## PASSO 2 — Configurar o frontend

Abra `frontend/index.html` no Bloco de Notas, encontre:

```javascript
const API = (window.ENV_API_URL || 'http://localhost:3001');
```

Substitua por:

```javascript
const API = 'https://SUA-URL-DO-RAILWAY.up.railway.app';
```

---

## PASSO 3 — Deploy no Netlify

1. Acesse **app.netlify.com** → seu site **monitordelicitacoes**
2. **Deploys** → arraste o `frontend/index.html`
3. Aguarde 1-2 minutos

---

## PASSO 4 — Usar o sistema

1. Abra o link do Netlify
2. Login com a senha `PANEL_PASSWORD`
3. Clique em **↻ Sincronizar** — o Claude lê o Deck via Claudinho (10-30s)
4. Dados aparecem em tempo real
5. Upload de planilhas na aba **📊 Planilhas** (uma vez por licitação, fica salvo)

---

## ANTHROPIC_API_KEY — onde obter

1. Acesse **console.anthropic.com**
2. Menu → **API Keys** → **Create Key**
3. Copie e cole nas variáveis do Railway

---

## Troubleshooting

| Problema | Solução |
|----------|---------|
| "Erro ao sincronizar" | Verifique ANTHROPIC_API_KEY e CLAUDINHO_MCP_URL no Railway |
| Sync demora muito | Normal — Claude + MCP leva 15-30s. Cache carrega instantâneo |
| "Backend offline" | Verifique se o Railway está rodando em railway.app |
| Railway para (free tier) | Upgrade para $5/mês para uso contínuo sem sleep |
