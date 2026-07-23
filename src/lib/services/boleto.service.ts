// boleto.service.ts — regra de negócio da consulta de 2ª via.
// Regra (Victor 22/07): o executivo pesquisa por CPF, por placa, ou pelos dois — basta UM.
//  - Só placa → lista as 3 últimas faturas dessa placa.
//  - Só CPF (ou CPF+placa sem placa escolhida) → se o associado tem 1 veículo, vai direto; se tem
//    VÁRIOS, devolve a lista pro front mostrar um SELETOR de placa; se veio placa junto, usa a placa.
// O `result` alimenta a auditoria.

import {
  buscarPorCpf,
  buscarVeiculoPorPlaca,
  buscarBoleto,
  buscarSituacaoAssociado,
  listarUltimasFaturas,
  listarEventosVeiculo,
  eventoEmAberto,
  situacaoFinanceiraVeiculo,
  type Fatura,
  type Evento,
} from "@/lib/clients/sga";

export type { Evento } from "@/lib/clients/sga";
export type PlacaOpcao = { placa: string; modelo: string | null; situacao: string };
// Situação consolidada do associado (pedido do Luan 22/07): ativo/inativo + em dia/inadimplente.
export type SituacaoInfo = { associado: string | null; financeira: string | null };
export type ConsultaResult =
  | { result: "ok"; associadoNome: string | null; codigo: string | null; placa: string; modelo: string | null; situacao: SituacaoInfo; eventos: Evento[]; faturas: Fatura[] }
  | { result: "selecionar_placa"; associadoNome: string | null; codigo: string | null; veiculos: PlacaOpcao[] }
  | { result: "recorrente"; associadoNome: string | null; codigo: string | null; placa: string; situacao: SituacaoInfo; eventos: Evento[]; mensagem: string }
  | { result: "nao_encontrado"; motivo: "associado" | "placa" | "sem_faturas"; debug?: unknown };

const MAX_EVENTOS = 5;

const MSG_RECORRENTE =
  "Este veículo está em cobrança recorrente no cartão — não há boleto para 2ª via. " +
  "Para atualizar o cartão, use o link oficial de atualização de cadastro do associado.";

/** Lista as 3 últimas faturas de uma placa; ramifica pra recorrente/não-encontrado se vazio. */
async function porPlaca(
  placa: string,
  assoc?: { nome: string | null; codigo: string | null; modelo: string | null; cpf?: string | null },
  cpf?: string,
): Promise<ConsultaResult> {
  const p = placa.replace(/\s/g, "").toUpperCase();
  // Se não temos dados do associado (busca só por placa), tenta enriquecer best-effort.
  const info = assoc ?? (await buscarVeiculoPorPlaca(p));

  // Situação do associado (ativo/inativo) + financeira (em dia/inadimplente), em paralelo.
  // O CPF pode vir do executivo, do CPF já resolvido, ou do próprio lookup da placa.
  const cpfUse = (cpf || info?.cpf || "").replace(/\D/g, "");
  const [sitAssoc, sf, eventosAll] = await Promise.all([
    cpfUse.length >= 11 ? buscarSituacaoAssociado(cpfUse) : Promise.resolve(null),
    situacaoFinanceiraVeiculo(p),
    listarEventosVeiculo(p).catch(() => [] as Evento[]),
  ]);
  const situacao: SituacaoInfo = {
    associado: sitAssoc?.descricao ?? null,
    financeira: sf?.situacao ?? null,
  };
  // Só os eventos EM ABERTO (pedido do Luan: "abertos + situação"), mais recentes primeiro.
  const eventos = eventosAll
    .filter((e) => eventoEmAberto(e.situacao))
    .sort((a, b) => (b.data || "").localeCompare(a.data || ""))
    .slice(0, MAX_EVENTOS);

  const { faturas } = await listarUltimasFaturas(p, info?.codigo ?? null, 3);
  if (faturas.length) {
    // A listagem nem sempre traz o link do PDF (link_boleto) — enriquece cada fatura pelo
    // endpoint de boleto individual (linha digitável + link PDF + PIX numa chamada). Em PARALELO
    // (até 3 faturas de uma vez) em vez de uma por vez, pra não somar latência.
    await Promise.all(
      faturas.map(async (f) => {
        if (f.nossoNumero && (!f.linkBoleto || !f.linhaDigitavel || !f.pixCopiaCola)) {
          const det = await buscarBoleto(f.nossoNumero);
          if (det) {
            f.linkBoleto = f.linkBoleto || det.linkBoleto;
            f.linhaDigitavel = f.linhaDigitavel || det.linhaDigitavel;
            f.pixCopiaCola = f.pixCopiaCola || det.pixCopiaCola;
          }
        }
      }),
    );
    return {
      result: "ok",
      associadoNome: info?.nome ?? null,
      codigo: info?.codigo ?? null,
      placa: p,
      modelo: info?.modelo ?? null,
      situacao,
      eventos,
      faturas,
    };
  }

  // Sem boleto → pode ser cartão/recorrente. Usa a situação financeira já buscada acima.
  const inadimplente = (sf?.situacao || "").toUpperCase().includes("INADIMPL");
  const recorrenteProvavel = !!sf && (inadimplente || !sf.nossoNumero);
  if (recorrenteProvavel) {
    return { result: "recorrente", associadoNome: info?.nome ?? null, codigo: info?.codigo ?? null, placa: p, situacao, eventos, mensagem: MSG_RECORRENTE };
  }
  return { result: "nao_encontrado", motivo: "sem_faturas" };
}

/** Consulta por CPF e/ou placa (basta um). */
export async function consultarFaturas(cpf?: string, placa?: string): Promise<ConsultaResult> {
  const cpfDigits = (cpf || "").replace(/\D/g, "");
  const placaNorm = (placa || "").replace(/\s/g, "").toUpperCase();

  // Placa informada → caminho direto pela placa (ganha do CPF; é o mais específico).
  if (placaNorm) {
    if (cpfDigits.length === 11) {
      const assoc = await buscarPorCpf(cpfDigits);
      const v = assoc?.veiculos.find((x) => x.placa === placaNorm);
      return porPlaca(
        placaNorm,
        assoc ? { nome: assoc.nome, codigo: assoc.codigo, modelo: v?.modelo ?? null, cpf: assoc.cpf } : undefined,
        cpfDigits,
      );
    }
    return porPlaca(placaNorm);
  }

  // Só CPF.
  if (cpfDigits.length === 11) {
    const assoc = await buscarPorCpf(cpfDigits);
    if (!assoc) return { result: "nao_encontrado", motivo: "associado" };
    const veiculos = assoc.veiculos;
    if (veiculos.length === 0) return { result: "nao_encontrado", motivo: "placa" };
    if (veiculos.length === 1) {
      return porPlaca(
        veiculos[0].placa,
        { nome: assoc.nome, codigo: assoc.codigo, modelo: veiculos[0].modelo, cpf: assoc.cpf },
        cpfDigits,
      );
    }
    // Vários veículos → o front mostra o seletor de placa.
    return {
      result: "selecionar_placa",
      associadoNome: assoc.nome,
      codigo: assoc.codigo,
      veiculos: veiculos.map((v) => ({ placa: v.placa, modelo: v.modelo, situacao: v.situacao })),
    };
  }

  return { result: "nao_encontrado", motivo: "associado" };
}
