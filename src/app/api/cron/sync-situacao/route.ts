// GET /api/cron/sync-situacao — chamado 1x/dia pelo Vercel Cron (ver vercel.json).
// Sincroniza o espelho local de mudanças de situação do associado (situacao_historico) +
// o catálogo de códigos (situacao_catalogo). Custo fixo na Hinova: 1-2 chamadas/dia,
// independente de quantas consultas os executivos fizerem no app (ver situacao-historico.service.ts).

import { NextRequest, NextResponse } from "next/server";
import { sincronizarPeriodo, sincronizarCatalogo } from "@/lib/services/situacao-historico.service";

export const runtime = "nodejs";
export const maxDuration = 60;

// Janela com sobreposição (5 dias, não só "ontem"): cobre o caso do cron falhar/pular um dia sem
// perder eventos — upsert por codigo_alteracao garante que reprocessar dias já sincronizados não duplica.
const JANELA_DIAS = 5;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "não autorizado" }, { status: 401 });
    }
  }

  try {
    const hoje = new Date();
    const inicio = new Date(hoje.getTime() - JANELA_DIAS * 864e5);

    const [catalogo, periodo] = await Promise.all([sincronizarCatalogo(), sincronizarPeriodo(inicio, hoje)]);

    return NextResponse.json({ ok: true, catalogo, periodo });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "erro" }, { status: 500 });
  }
}
