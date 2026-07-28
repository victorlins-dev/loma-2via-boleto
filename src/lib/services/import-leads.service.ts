// import-leads.service.ts — validação e orquestração da Importação de Leads (líderes comerciais
// colam nome+telefone, o app cria Contato+Negócio em Comercial → Lista 300, atribuído a um
// executivo escolhido). Ver plano/decisões em
// C:\Users\Loma\.claude\plans\abundant-snuggling-wreath.md.

import { buscarDuplicadosPorTelefone, criarLeadsComercial, type CriarLeadResultado } from "@/lib/clients/bitrix-crm";

export const LIMITE_LINHAS = 200;

export type LinhaEntrada = { nome: string; telefone: string };
export type LinhaValidada =
  | { status: "ok"; nome: string; telefone: string }
  | { status: "duplicado"; nome: string; telefone: string }
  | { status: "invalido"; nome: string; telefone: string; motivo: string };

/** "(11) 99999-9999" | "11999999999" | "+55 11 99999-9999" -> "11999999999" (DDD+número, sem 55). */
export function normalizarTelefone(bruto: string): string {
  let d = String(bruto || "").replace(/\D/g, "");
  if (d.length === 13 && d.startsWith("55")) d = d.slice(2); // +55 DDD número (13 dígitos)
  if (d.length === 12 && d.startsWith("55")) d = d.slice(2); // +55 DDD número (fixo, 12 dígitos)
  return d;
}

function telefoneValido(d: string): boolean {
  return d.length === 10 || d.length === 11; // DDD(2) + fixo(8) ou celular(9)
}

/** Corta em LIMITE_LINHAS e valida formato (nome/telefone). Duplicado é checado à parte
 *  (precisa bater no Bitrix), não aqui. */
export function validarFormato(linhas: LinhaEntrada[]): { processadas: LinhaEntrada[]; cortadas: number } {
  const processadas = linhas.slice(0, LIMITE_LINHAS);
  return { processadas, cortadas: Math.max(0, linhas.length - LIMITE_LINHAS) };
}

/** Prévia: valida formato + consulta duplicado em lote no Bitrix. */
export async function gerarPreview(linhas: LinhaEntrada[]): Promise<LinhaValidada[]> {
  const comFormatoOk: { idx: number; telefone: string }[] = [];
  const out: LinhaValidada[] = new Array(linhas.length);

  linhas.forEach((l, i) => {
    const nome = String(l.nome || "").trim();
    const telefone = normalizarTelefone(l.telefone);
    if (!nome) {
      out[i] = { status: "invalido", nome, telefone, motivo: "Nome vazio" };
      return;
    }
    if (!telefoneValido(telefone)) {
      out[i] = { status: "invalido", nome, telefone, motivo: "Telefone inválido (esperado DDD + número)" };
      return;
    }
    comFormatoOk.push({ idx: i, telefone });
  });

  if (comFormatoOk.length) {
    const duplicados = await buscarDuplicadosPorTelefone(comFormatoOk.map((x) => x.telefone));
    comFormatoOk.forEach(({ idx, telefone }, i) => {
      const nome = String(linhas[idx].nome || "").trim();
      out[idx] = duplicados[i] ? { status: "duplicado", nome, telefone } : { status: "ok", nome, telefone };
    });
  }

  return out;
}

export type ResumoImportacao = {
  criados: number;
  ignorados: number;
  erros: Array<{ nome: string; telefone: string; motivo: string }>;
};

/** Importação de verdade: recebe as linhas que o LÍDER escolheu importar (o front só manda as
 *  marcadas — o que inclui, de propósito, linhas que a prévia avisou como duplicado, se o líder
 *  decidiu forçar). RE-VALIDA só o FORMATO (nunca confia cegamente no payload do cliente) — não
 *  re-bloqueia por duplicado aqui, porque "duplicado" nunca foi uma trava, foi só aviso na prévia;
 *  bloquear de novo aqui reintroduziria exatamente o comportamento que foi decidido NÃO ter. */
export async function importarLeads(linhas: LinhaEntrada[], executivoId: string): Promise<ResumoImportacao> {
  const aptos: { nome: string; telefone: string }[] = [];
  let ignorados = 0;
  for (const l of linhas) {
    const nome = String(l.nome || "").trim();
    const telefone = normalizarTelefone(l.telefone);
    if (!nome || !telefoneValido(telefone)) {
      ignorados++;
      continue;
    }
    aptos.push({ nome, telefone });
  }

  if (!aptos.length) return { criados: 0, ignorados, erros: [] };

  const resultados: CriarLeadResultado[] = await criarLeadsComercial(aptos, executivoId);

  let criados = 0;
  const erros: ResumoImportacao["erros"] = [];
  resultados.forEach((r, i) => {
    if (r.ok) {
      criados++;
    } else {
      erros.push({ nome: aptos[i].nome, telefone: aptos[i].telefone, motivo: r.motivo });
    }
  });

  return { criados, ignorados, erros };
}
