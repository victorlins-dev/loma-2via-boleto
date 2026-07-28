// POST /api/leads/executivos — lista os executivos comerciais pro dropdown "vincular a".
// Só líder (gate em lider-auth.service.ts).

import { NextRequest, NextResponse } from "next/server";
import { autenticarLider, type AuthInput } from "@/lib/services/lider-auth.service";
import { listarExecutivosComerciais } from "@/lib/clients/bitrix-crm";

export const runtime = "nodejs";
export const maxDuration = 20;

export async function POST(req: NextRequest) {
  let body: { auth?: AuthInput };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "corpo inválido" }, { status: 400 });
  }

  const gate = await autenticarLider(body.auth);
  if (!gate.ok) return NextResponse.json({ error: gate.erro }, { status: gate.status });

  try {
    const executivos = await listarExecutivosComerciais();
    return NextResponse.json({ executivos });
  } catch {
    return NextResponse.json({ error: "falha ao buscar executivos" }, { status: 502 });
  }
}
