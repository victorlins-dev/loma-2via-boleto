// Agregações pro painel admin — tudo em cima da audit_consulta que já existe, nenhuma tabela nova.
// "Consulta" pra fins de contagem = action CONSULTA_2A_VIA (a busca em si; DOWNLOAD_PDF/COPIA_LINHA/
// COPIA_PIX são ações de acompanhamento de uma consulta já feita, não contam como novo uso).
import { db } from "@/lib/db/client";
import { auditConsulta } from "@/lib/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";

const CONSULTA = "CONSULTA_2A_VIA";

function iniciosDoDia(diasAtras: number) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - diasAtras);
  return d;
}

export type Metricas = {
  totalHoje: number;
  total7d: number;
  total30d: number;
  taxaErro30d: number; // 0..1, sobre TODAS as ações (não só consulta)
  topExecutivos: { actorUserId: string; actorNome: string | null; total: number }[];
  serieDiaria: { dia: string; total: number }[];
};

export async function buscarMetricas(): Promise<Metricas | null> {
  if (!db) return null;

  const hoje0 = iniciosDoDia(0);
  const d7 = iniciosDoDia(7);
  const d30 = iniciosDoDia(30);

  const [totalHojeRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(auditConsulta)
    .where(and(eq(auditConsulta.action, CONSULTA), gte(auditConsulta.eventTime, hoje0)));

  const [total7dRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(auditConsulta)
    .where(and(eq(auditConsulta.action, CONSULTA), gte(auditConsulta.eventTime, d7)));

  const [total30dRow] = await db
    .select({
      consultas: sql<number>`count(*) filter (where ${auditConsulta.action} = ${CONSULTA})`,
      erros: sql<number>`count(*) filter (where ${auditConsulta.result} = 'erro')`,
      totalAcoes: sql<number>`count(*)`,
    })
    .from(auditConsulta)
    .where(gte(auditConsulta.eventTime, d30));

  const topExecutivos = await db
    .select({
      actorUserId: auditConsulta.actorUserId,
      actorNome: sql<string | null>`max(${auditConsulta.actorNome})`,
      total: sql<number>`count(*)`,
    })
    .from(auditConsulta)
    .where(and(eq(auditConsulta.action, CONSULTA), gte(auditConsulta.eventTime, d30)))
    .groupBy(auditConsulta.actorUserId)
    .orderBy(sql`count(*) desc`)
    .limit(8);

  const diaExpr = sql<string>`to_char(${auditConsulta.eventTime} at time zone 'America/Sao_Paulo', 'YYYY-MM-DD')`;
  const serieDiaria = await db
    .select({ dia: diaExpr, total: sql<number>`count(*)` })
    .from(auditConsulta)
    .where(and(eq(auditConsulta.action, CONSULTA), gte(auditConsulta.eventTime, d30)))
    .groupBy(diaExpr)
    .orderBy(diaExpr);

  const totalAcoes30d = Number(total30dRow?.totalAcoes ?? 0);
  const erros30d = Number(total30dRow?.erros ?? 0);

  return {
    totalHoje: Number(totalHojeRow?.n ?? 0),
    total7d: Number(total7dRow?.n ?? 0),
    total30d: Number(total30dRow?.consultas ?? 0),
    taxaErro30d: totalAcoes30d > 0 ? erros30d / totalAcoes30d : 0,
    topExecutivos: topExecutivos.map((r) => ({
      actorUserId: r.actorUserId,
      actorNome: r.actorNome,
      total: Number(r.total),
    })),
    serieDiaria: serieDiaria.map((r) => ({ dia: r.dia, total: Number(r.total) })),
  };
}
