// POST /api/leads/importar — cria de verdade (Contato+Negócio em Comercial → Lista 300) as linhas
// que o líder confirmou. Só líder. Sempre audita o lote (sucesso ou erro), antes de responder.

import { NextRequest, NextResponse } from "next/server";
import { autenticarLider, type AuthInput } from "@/lib/services/lider-auth.service";
import { importarLeads, LIMITE_LINHAS, type LinhaEntrada } from "@/lib/services/import-leads.service";
import { listarExecutivosComerciais } from "@/lib/clients/bitrix-crm";
import { registrarImportacaoLeads } from "@/lib/audit";
import { hasDb } from "@/lib/db/client";

export const runtime = "nodejs";
export const maxDuration = 60;

const IS_PROD = process.env.NODE_ENV === "production";

export async function POST(req: NextRequest) {
  if (IS_PROD && !hasDb) return NextResponse.json({ error: "auditoria indisponível" }, { status: 503 });

  let body: { auth?: AuthInput; executivoId?: string; linhas?: LinhaEntrada[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "corpo inválido" }, { status: 400 });
  }

  const gate = await autenticarLider(body.auth);
  if (!gate.ok) return NextResponse.json({ error: gate.erro }, { status: gate.status });

  const linhas = (Array.isArray(body.linhas) ? body.linhas : []).slice(0, LIMITE_LINHAS);
  const executivoId = String(body.executivoId || "");
  if (!linhas.length) return NextResponse.json({ error: "nenhuma linha enviada" }, { status: 400 });
  if (!executivoId) return NextResponse.json({ error: "escolha um executivo" }, { status: 400 });

  // Nunca confia no executivoId do payload sem checar contra a lista real de executivos comerciais
  // (evita atribuir negócio a um usuário arbitrário fora do time).
  const executivos = await listarExecutivosComerciais();
  const executivo = executivos.find((e) => e.id === executivoId);
  if (!executivo) return NextResponse.json({ error: "executivo inválido" }, { status: 400 });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const ua = req.headers.get("user-agent");

  try {
    const resumo = await importarLeads(linhas, executivoId);

    await registrarImportacaoLeads({
      liderUserId: gate.user.id,
      liderNome: gate.user.nome,
      executivoDestinoId: executivoId,
      executivoDestinoNome: executivo.nome,
      totalLinhas: linhas.length,
      criados: resumo.criados,
      ignorados: resumo.ignorados,
      erros: resumo.erros.length,
      sourceIp: ip,
      userAgent: ua,
      metadata: resumo.erros.length ? { erros: resumo.erros } : null,
    });

    return NextResponse.json(resumo);
  } catch (err) {
    await registrarImportacaoLeads({
      liderUserId: gate.user.id,
      liderNome: gate.user.nome,
      executivoDestinoId: executivoId,
      executivoDestinoNome: executivo.nome,
      totalLinhas: linhas.length,
      criados: 0,
      ignorados: 0,
      erros: linhas.length,
      sourceIp: ip,
      userAgent: ua,
      metadata: { msg: err instanceof Error ? err.message : "erro" },
    });
    return NextResponse.json({ error: "falha ao importar" }, { status: 502 });
  }
}
