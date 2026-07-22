// mask.ts — mascaramento de PII pra auditoria/exibição (minimização LGPD).
// O CPF NÃO é guardado em claro no log; guardamos mascarado. A busca por CPF no painel admin usa a
// versão mascarada como chave visual (e, se precisar cruzar exato, um hash — ver hashCpf).

import { createHash } from "node:crypto";

/** "12345678909" | "123.456.789-09" → "123.***.***-09" */
export function maskCpf(cpf: string): string {
  const d = String(cpf || "").replace(/\D/g, "");
  if (d.length !== 11) return "***";
  return `${d.slice(0, 3)}.***.***-${d.slice(9)}`;
}

/** Placa "ABC1D23" → "ABC1***" (mantém marca visível, esconde final). */
export function maskPlaca(placa: string): string {
  const p = String(placa || "").replace(/\s/g, "").toUpperCase();
  if (p.length < 5) return "***";
  return `${p.slice(0, 4)}***`;
}

/** Hash estável (não reversível) pra cruzar consultas do mesmo CPF sem guardar o número.
 *  Usa um salt de ambiente pra não ser um rainbow-table trivial de CPF. */
export function hashCpf(cpf: string, salt = process.env.SESSION_SECRET || ""): string {
  const d = String(cpf || "").replace(/\D/g, "");
  return createHash("sha256").update(`${salt}:${d}`).digest("hex").slice(0, 32);
}
