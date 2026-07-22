// schema.ts — Drizzle (Postgres/Neon). V1 = uma empresa só (Loma). Multi-empresa NÃO se aplica agora
// (decisão Victor 22/07) — deixamos o app simples; se um dia virar multi-empresa, acrescenta-se uma
// coluna de empresa aqui sem reescrever o resto.
//
// `audit_consulta` = trilha de auditoria. APPEND-ONLY / IMUTÁVEL: em produção o role da app recebe só
// INSERT (UPDATE/DELETE revogados na migration de hardening). Índices: BRIN em event_time (append-only
// cresce em ordem de tempo → índice minúsculo) + B-Tree em actor/target (filtros do painel admin).
// CPF/placa entram MASCARADOS (lib/mask) — minimização LGPD.

import { pgTable, bigserial, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";

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
