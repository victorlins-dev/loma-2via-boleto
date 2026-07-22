// POST /api/acao — audita ações do executivo sobre uma fatura já consultada (baixar PDF / copiar
// linha / copiar PIX). Mesma validação de sessão do /consulta; só grava a trilha (não devolve dado).

import { NextRequest, NextResponse } from "next/server";
import { validarSessao, usuarioAtual, memberPermitido } from "@/lib/clients/bitrix";
import { registrarConsulta } from "@/lib/audit";

export const runtime = "nodejs";

const ACOES = new Set(["DOWNLOAD_PDF", "COPIA_LINHA", "COPIA_PIX"]);
const DEV_NO_AUTH = process.env.ALLOW_DEV_NO_AUTH === "1" && process.env.NODE_ENV !== "production";

export async function POST(req: NextRequest) {
  let body: { auth?: { access_token?: string; domain?: string; member_id?: string }; action?: string; target?: string; cpf?: string; placa?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "corpo inválido" }, { status: 400 });
  }

  const action = String(body.action || "");
  if (!ACOES.has(action)) return NextResponse.json({ error: "ação inválida" }, { status: 400 });

  const accessToken = body.auth?.access_token || "";
  const memberId = body.auth?.member_id || "";

  let user: { id: string; nome: string | null } | null;
  if (DEV_NO_AUTH && !accessToken) {
    user = { id: "dev-local", nome: "Dev Local" };
  } else {
    if (!accessToken) return NextResponse.json({ error: "sessão ausente" }, { status: 401 });
    if (!memberPermitido(memberId)) return NextResponse.json({ error: "portal não autorizado" }, { status: 403 });
    const ok = await validarSessao(accessToken);
    if (!ok) return NextResponse.json({ error: "sessão inválida" }, { status: 401 });
    user = await usuarioAtual(accessToken);
    if (!user) return NextResponse.json({ error: "usuário não identificado" }, { status: 401 });
  }

  await registrarConsulta({
    actorUserId: user.id,
    actorNome: user.nome,
    action,
    cpf: body.cpf ? String(body.cpf).replace(/\D/g, "") : null,
    placa: body.placa || null,
    target: body.target || null,
    result: "ok",
    sourceIp: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
    userAgent: req.headers.get("user-agent"),
  });

  return NextResponse.json({ ok: true });
}
