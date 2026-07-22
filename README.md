# loma-2via-boleto

App de **2ª via de boleto** pros executivos comerciais da Loma. Popup no Bitrix24 (menu lateral) onde o
executivo digita **CPF + placa** de um associado e vê as **3 últimas faturas** (baixar PDF ou copiar a
linha digitável). Toda consulta é **auditada** (quem consultou o quê, quando) e mostrável num painel admin.

> Frente da reunião Luan 21/07. Plano/arquitetura completa: `../docs - Claude/PLANO-APP-2VIA-BOLETO-EXECUTIVOS.md`.
> **Produção da Loma é AO VIVO (19k associados) — gate de infra antes de qualquer deploy; Victor testa.**

## Arquitetura (resumo — decisões embasadas em pesquisa, ver o PLANO)
- **Front + BFF:** Next.js (App Router) na Vercel. Node runtime nos handlers que falam com Bitrix/SGA/DB.
- **Bitrix = só a porta:** app local, placement `LEFT_MENU`. O Bitrix embute nosso app num iframe e manda
  o usuário logado; validamos server-side (`app.info`, fail-closed) antes de tocar no SGA.
- **SGA/Hinova:** token read-only fica **só no servidor** (env). Reusa a lógica validada do bot de atendimento.
- **Banco:** Neon (Postgres) + Drizzle. Sempre a connection string `-pooler`.
- **Multi-tenant desde o dia 1:** cada portal Bitrix (`member_id`) = um `tenant_id`. Todas as queries
  escopadas por tenant + RLS no Postgres.
- **Auditoria:** tabela `audit_consulta` **imutável** (INSERT-only), CPF **mascarado**, gravada na **mesma
  transação** da consulta (não dá pra burlar pelo front). Painel `/admin` (só admin) com filtros + export.

## Camadas
```
src/app/api/*/route.ts     # HTTP: auth + validação + resposta (fino)
src/lib/services/*         # regra de negócio / orquestração
src/lib/clients/sga.ts     # cliente SGA (segura o token; nunca vaza)
src/lib/clients/bitrix.ts  # validação de sessão Bitrix (app.info) + user.admin
src/lib/db/{schema,client} # Drizzle: schema + conexão pooled
src/lib/{audit,mask,tenant}.ts
```

## Segredos (env server-only — Victor seta; Claude nunca vê o valor)
Ver `.env.example`. NUNCA usar prefixo `NEXT_PUBLIC_` pra token.

## Status
🚧 **F0 — fundação (em construção local, SEM deploy).** Próximo: front + registro do app no Bitrix (com gate).
