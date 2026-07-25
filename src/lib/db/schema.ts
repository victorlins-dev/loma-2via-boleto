// schema.ts — Drizzle (Postgres/Neon). V1 = uma empresa só (Loma). Multi-empresa NÃO se aplica agora
// (decisão Victor 22/07) — deixamos o app simples; se um dia virar multi-empresa, acrescenta-se uma
// coluna de empresa aqui sem reescrever o resto.
//
// `audit_consulta` = trilha de auditoria. APPEND-ONLY / IMUTÁVEL: em produção o role da app recebe só
// INSERT (UPDATE/DELETE revogados na migration de hardening). Índices: BRIN em event_time (append-only
// cresce em ordem de tempo → índice minúsculo) + B-Tree em actor/target (filtros do painel admin).
// CPF/placa entram MASCARADOS (lib/mask) — minimização LGPD.

import { pgTable, bigserial, text, timestamp, integer, jsonb, index, unique } from "drizzle-orm/pg-core";

export const auditConsulta = pgTable(
  "audit_consulta",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    eventTime: timestamp("event_time", { withTimezone: true }).notNull().defaultNow(),
    actorUserId: text("actor_user_id").notNull(), // id do usuário Bitrix (executivo)
    actorNome: text("actor_nome"),
    action: text("action").notNull(), // CONSULTA_2A_VIA | DOWNLOAD_PDF | COPIA_LINHA
    target: text("target"), // código do associado consultado
    queryParam: text("query_param"), // CPF/placa MASCARADO (nunca em claro)
    result: text("result").notNull(), // ok | negado | nao_encontrado | recorrente | erro
    recordsReturned: integer("records_returned"),
    sourceIp: text("source_ip"),
    sessionId: text("session_id"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata"),
  },
  (t) => [
    index("audit_event_time_brin").using("brin", t.eventTime),
    index("audit_actor_idx").on(t.actorUserId, t.eventTime),
    index("audit_target_idx").on(t.target),
  ],
);

// situacao_historico — ESPELHO local do log de mudança de situação do associado na Hinova
// (pedido do Victor 24/07: "desde quando o associado está INADIMPLENTE"). A API SGA só expõe isso
// via `listar/alteracao-associados`, em janelas de até 7 dias e SEM filtro por associado — inviável
// bater na Hinova por consulta ao vivo (seria ~50+ chamadas por lookup). Por isso sincronizamos aqui
// 1x/dia (cron) e a consulta ao vivo do app lê deste espelho local, instantâneo.
// `codigoAlteracao` = chave natural do evento na Hinova → UNIQUE garante upsert idempotente
// (rodar o sync 2x no mesmo dia, ou re-rodar o backfill, nunca duplica).
export const situacaoHistorico = pgTable(
  "situacao_historico",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    codigoAlteracao: text("codigo_alteracao").notNull(),
    codigoAssociado: text("codigo_associado").notNull(),
    cpf: text("cpf").notNull(),
    valorAnterior: text("valor_anterior"), // codigo_situacao anterior
    valorPosterior: text("valor_posterior").notNull(), // codigo_situacao novo
    dataAlteracao: timestamp("data_alteracao", { withTimezone: true }).notNull(),
    sincronizadoEm: timestamp("sincronizado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("situacao_historico_codigo_alteracao_key").on(t.codigoAlteracao),
    index("situacao_historico_cpf_idx").on(t.cpf, t.dataAlteracao),
  ],
);

// situacao_catalogo — de-para codigo_situacao → descrição (ex: "4" → "INADIMPLENTE"). Vem de
// `listar/situacao/todos`, refrescado pelo mesmo cron diário (a Hinova raramente muda esse catálogo).
export const situacaoCatalogo = pgTable("situacao_catalogo", {
  codigoSituacao: text("codigo_situacao").primaryKey(),
  descricao: text("descricao").notNull(),
  sincronizadoEm: timestamp("sincronizado_em", { withTimezone: true }).notNull().defaultNow(),
});
