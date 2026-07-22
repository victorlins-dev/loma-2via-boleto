// audit.ts — grava a trilha de auditoria. É subproduto OBRIGATÓRIO da consulta: o handler grava o
// audit ANTES de devolver a resposta ao executivo (sem log → sem resposta). Não dá pra burlar pelo front.
// CPF/placa entram MASCARADOS (lib/mask). Tabela imutável (INSERT-only garantido pela migration).

import { db } from "@/lib/db/client";
import { auditConsulta } from "@/lib/db/schema";
import { maskCpf, maskPlaca } from "@/lib/mask";

export type AuditInput = {
  actorUserId: string;
  actorNome?: string | null;
  action: string; // CONSULTA_2A_VIA | DOWNLOAD_PDF | COPIA_LINHA
  cpf?: string | null;
  placa?: string | null;
  target?: string | null; // código do associado consultado
  result: string; // ok | negado | nao_encontrado | recorrente | erro
  recordsReturned?: number | null;
  sourceIp?: string | null;
  sessionId?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
};

export async function registrarConsulta(input: AuditInput): Promise<void> {
  // Sem banco (dev local sem DATABASE_URL) → auditoria best-effort, não derruba a consulta.
  if (!db) {
    console.warn("[audit] sem DATABASE_URL — consulta NÃO auditada (só dev local).");
    return;
  }
  const partes = [
    input.cpf ? `cpf=${maskCpf(input.cpf)}` : null,
    input.placa ? `placa=${maskPlaca(input.placa)}` : null,
  ].filter(Boolean);
  await db.insert(auditConsulta).values({
    actorUserId: input.actorUserId,
    actorNome: input.actorNome ?? null,
    action: input.action,
    target: input.target ?? null,
    queryParam: partes.join(" ") || null, // já mascarado
    result: input.result,
    recordsReturned: input.recordsReturned ?? null,
    sourceIp: input.sourceIp ?? null,
    sessionId: input.sessionId ?? null,
    userAgent: input.userAgent ?? null,
    metadata: input.metadata ?? null,
  });
}
