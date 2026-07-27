// POST /api/admin/consultas — lista a trilha de auditoria pro painel admin (externo, fora do
// Bitrix). Auth = sessão Supabase (painel próprio), não mais a sessão do Bitrix — o app em si
// (/, dentro do iframe) continua gravando a auditoria exatamente como antes, só quem LÊ aqui mudou.
// Paginação por cursor (event_time, id) em vez do limit(500) fixo antigo.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { db } from "@/lib/db/client";
import { auditConsulta } from "@/lib/db/schema";
import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";

export const runtime = "nodejs";

const PAGE_SIZE = 100;

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "sessão ausente" }, { status: 401 });

  let body: {
    filtros?: { actor?: string; de?: string; ate?: string; result?: string };
    cursor?: { eventTime: string; id: number } | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "corpo inválido" }, { status: 400 });
  }

  if (!db) return NextResponse.json({ rows: [], proximoCursor: null, semBanco: true });

  const f = body.filtros || {};
  const conds: SQL[] = [];
  if (f.actor) conds.push(eq(auditConsulta.actorUserId, f.actor));
  if (f.result) conds.push(eq(auditConsulta.result, f.result));
  if (f.de) conds.push(gte(auditConsulta.eventTime, new Date(f.de)));
  if (f.ate) conds.push(lte(auditConsulta.eventTime, new Date(f.ate)));

  const cursor = body.cursor;
  if (cursor?.eventTime && Number.isFinite(cursor.id)) {
    conds.push(
      sql`(${auditConsulta.eventTime}, ${auditConsulta.id}) < (${new Date(cursor.eventTime)}, ${cursor.id})`,
    );
  }

  const rows = await db
    .select()
    .from(auditConsulta)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(auditConsulta.eventTime), desc(auditConsulta.id))
    .limit(PAGE_SIZE);

  const ultima = rows[rows.length - 1];
  const proximoCursor =
    rows.length === PAGE_SIZE && ultima ? { eventTime: ultima.eventTime.toISOString(), id: ultima.id } : null;

  return NextResponse.json({ rows, proximoCursor });
}
