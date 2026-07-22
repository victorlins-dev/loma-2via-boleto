// POST /api/admin/consultas — lista a trilha de auditoria pro painel admin. SÓ ADMIN.
// Valida sessão (portal fixado) + exige user.admin. Filtros: usuário, período, resultado.

import { NextRequest, NextResponse } from "next/server";
import { validarSessao, usuarioAtual, memberPermitido } from "@/lib/clients/bitrix";
import { db } from "@/lib/db/client";
import { auditConsulta } from "@/lib/db/schema";
import { and, desc, eq, gte, lte, type SQL } from "drizzle-orm";

export const runtime = "nodejs";

const IS_PROD = process.env.NODE_ENV === "production";
const DEV_NO_AUTH = process.env.ALLOW_DEV_NO_AUTH === "1" && !IS_PROD;

export async function POST(req: NextRequest) {
  let body: {
    auth?: { access_token?: string; member_id?: string };
    filtros?: { actor?: string; de?: string; ate?: string; result?: string };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "corpo inválido" }, { status: 400 });
  }

  const accessToken = body.auth?.access_token || "";
  const memberId = body.auth?.member_id || "";

  // Gate de admin (em dev, o modo local entra como admin).
  if (!(DEV_NO_AUTH && !accessToken)) {
    if (!accessToken) return NextResponse.json({ error: "sessão ausente" }, { status: 401 });
    if (!memberPermitido(memberId)) return NextResponse.json({ error: "portal não autorizado" }, { status: 403 });
    if (!(await validarSessao(accessToken))) return NextResponse.json({ error: "sessão inválida" }, { status: 401 });
    const user = await usuarioAtual(accessToken);
    if (!user) return NextResponse.json({ error: "usuário não identificado" }, { status: 401 });
    if (!user.isAdmin) return NextResponse.json({ error: "acesso restrito a administradores" }, { status: 403 });
  }

  if (!db) return NextResponse.json({ rows: [], semBanco: true });

  const f = body.filtros || {};
  const conds: SQL[] = [];
  if (f.actor) conds.push(eq(auditConsulta.actorUserId, f.actor));
  if (f.result) conds.push(eq(auditConsulta.result, f.result));
  if (f.de) conds.push(gte(auditConsulta.eventTime, new Date(f.de)));
  if (f.ate) conds.push(lte(auditConsulta.eventTime, new Date(f.ate)));

  const rows = await db
    .select()
    .from(auditConsulta)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(auditConsulta.eventTime))
    .limit(500);

  return NextResponse.json({ rows });
}
