// POST /api/consulta — handler-PADRÃO (canônico) do app. Fino: auth + validação + serviço + auditoria.
// Runtime Node (fala com SGA/DB). O token do SGA NUNCA sai daqui pro cliente.
//
// SEM tela de login: a identidade do executivo vem SILENCIOSA do Bitrix (o front lê BX24.getAuth() ao
// abrir e manda o auth junto). Aqui validamos essa sessão contra o próprio portal (fail-closed) antes
// de tocar no SGA. Fluxo: valida sessão → identifica executivo → consulta SGA → AUDITA → responde.

import { NextRequest, NextResponse } from "next/server";
import { validarSessao, usuarioAtual, memberPermitido } from "@/lib/clients/bitrix";
import { consultarFaturas } from "@/lib/services/boleto.service";
import { registrarConsulta } from "@/lib/audit";
import { hasDb } from "@/lib/db/client";

export const runtime = "nodejs";

const IS_PROD = process.env.NODE_ENV === "production";
// Modo DEV blindado: só vale FORA de produção (mesmo que a env vaze pra Vercel, não abre).
const DEV_NO_AUTH = process.env.ALLOW_DEV_NO_AUTH === "1" && !IS_PROD;

export async function POST(req: NextRequest) {
  let body: { auth?: { access_token?: string; domain?: string; member_id?: string }; cpf?: string; placa?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "corpo inválido" }, { status: 400 });
  }

  const cpf = String(body.cpf || "").replace(/\D/g, "");
  const placa = String(body.placa || "").replace(/\s/g, "").toUpperCase();
  const accessToken = body.auth?.access_token || "";
  const memberId = body.auth?.member_id || "";

  // Auditoria é OBRIGATÓRIA em produção: sem banco, não serve (fail-closed).
  if (IS_PROD && !hasDb) {
    return NextResponse.json({ error: "auditoria indisponível" }, { status: 503 });
  }

  // Basta UM: CPF (11 dígitos) OU placa. Se CPF vier, tem que estar completo.
  const temCpf = cpf.length === 11;
  const temPlaca = placa.length >= 5;
  if (!temCpf && !temPlaca) {
    return NextResponse.json({ error: "informe o CPF completo ou a placa" }, { status: 400 });
  }
  if (cpf.length > 0 && cpf.length !== 11) {
    return NextResponse.json({ error: "CPF incompleto" }, { status: 400 });
  }

  // Identidade do executivo. Fora de produção, o modo dev dispensa o Bitrix.
  let user: { id: string; nome: string | null } | null;
  if (DEV_NO_AUTH && !accessToken) {
    user = { id: "dev-local", nome: "Dev Local" };
  } else {
    if (!accessToken) return NextResponse.json({ error: "sessão ausente" }, { status: 401 });
    if (!memberPermitido(memberId)) return NextResponse.json({ error: "portal não autorizado" }, { status: 403 });
    // Valida SEMPRE contra o portal FIXADO no servidor (não contra o que o navegador mandou).
    const ok = await validarSessao(accessToken);
    if (!ok) return NextResponse.json({ error: "sessão inválida" }, { status: 401 });
    user = await usuarioAtual(accessToken);
    if (!user) return NextResponse.json({ error: "usuário não identificado" }, { status: 401 });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const ua = req.headers.get("user-agent");
  const cpfArg = temCpf ? cpf : null;
  const placaArg = temPlaca ? placa : null;

  try {
    const r = await consultarFaturas(cpfArg ?? undefined, placaArg ?? undefined);
    const records = r.result === "ok" ? r.faturas.length : 0;
    const target = r.result === "ok" || r.result === "recorrente" || r.result === "selecionar_placa" ? r.codigo : null;

    // 3) AUDITORIA — sempre, antes de responder (subproduto obrigatório).
    await registrarConsulta({
      actorUserId: user.id,
      actorNome: user.nome,
      action: "CONSULTA_2A_VIA",
      cpf: cpfArg,
      placa: placaArg,
      target,
      result: r.result,
      recordsReturned: records,
      sourceIp: ip,
      userAgent: ua,
    });

    return NextResponse.json(r);
  } catch (err) {
    try {
      await registrarConsulta({
        actorUserId: user.id,
        actorNome: user.nome,
        action: "CONSULTA_2A_VIA",
        cpf: cpfArg,
        placa: placaArg,
        result: "erro",
        sourceIp: ip,
        userAgent: ua,
        metadata: { msg: err instanceof Error ? err.message : "erro" },
      });
    } catch {
      /* auditoria do erro é best-effort */
    }
    // TEMP DEBUG (Fase A, só admin testando): expõe o detalhe do erro pra diagnosticar.
    // ⚠️ REMOVER antes de abrir pros executivos.
    return NextResponse.json(
      { error: "falha ao consultar", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
