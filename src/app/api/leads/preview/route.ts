// POST /api/leads/preview — recebe as linhas coladas (nome+telefone), valida formato + limite de
// 200 + checa duplicado no CRM em lote. Só líder.

import { NextRequest, NextResponse } from "next/server";
import { autenticarLider, type AuthInput } from "@/lib/services/lider-auth.service";
import { gerarPreview, LIMITE_LINHAS, type LinhaEntrada } from "@/lib/services/import-leads.service";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  let body: { auth?: AuthInput; linhas?: LinhaEntrada[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "corpo inválido" }, { status: 400 });
  }

  const gate = await autenticarLider(body.auth);
  if (!gate.ok) return NextResponse.json({ error: gate.erro }, { status: gate.status });

  const linhas = Array.isArray(body.linhas) ? body.linhas : [];
  if (!linhas.length) return NextResponse.json({ error: "nenhuma linha enviada" }, { status: 400 });

  const cortadas = Math.max(0, linhas.length - LIMITE_LINHAS);
  const processadas = linhas.slice(0, LIMITE_LINHAS);

  try {
    const preview = await gerarPreview(processadas);
    return NextResponse.json({ preview, cortadas });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "falha ao gerar prévia" }, { status: 502 });
  }
}
