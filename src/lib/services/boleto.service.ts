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
  ehRecorrenteCartao,
  type Fatura,
  type Evento,
} from "@/lib/clients/sga";
import { buscarDataInicioSituacaoAtual } from "@/lib/services/situacao-historico.service";

export type { Evento } from "@/lib/clients/sga";
export type PlacaOpcao = { placa: string; modelo: string | null; situacao: string };
// Situação consolidada do associado (pedido do Luan 22/07): ativo/inativo + em dia/inadimplente.
// `notaAssociado` (pedido do Victor 24/07): "desde quando" a situação do ASSOCIADO (ativo/inadimplente/
// etc, campo codigo_situacao) é a atual. Vem do espelho local sincronizado (situacao-historico.service) —
// a Hinova não expõe isso num campo direto, só em logs em lote sem filtro por pessoa (inviável ao vivo).
// `notaFinanceira`: fallback pra situação FINANCEIRA (nível veículo/boleto, dimensão diferente — não
// temos histórico exato sincronizado pra essa ainda). Sem custo extra: já buscamos ~12 meses de boleto
// pra trás (listarUltimasFaturas); se não achou NADA nesse período e é INADIMPLENTE, é seguro afirmar
// "há mais de 6 meses" — o limiar de negócio (depois disso o associado vira venda nova/paga adesão de novo).
export type SituacaoInfo = {
  associado: string | null;
  financeira: string | null;
  notaAssociado?: string | null;
  notaFinanceira?: string | null;
};
export type ConsultaResult =
  | { result: "ok"; associadoNome: string | null; codigo: string | null; placa: string; modelo: string | null; situacao: SituacaoInfo; eventos: Evento[]; faturas: Fatura[] }
  | { result: "selecionar_placa"; associadoNome: string | null; codigo: string | null; veiculos: PlacaOpcao[] }
  | { result: "recorrente"; associadoNome: string | null; codigo: string | null; placa: string; situacao: SituacaoInfo; eventos: Evento[]; mensagem: string }
  | { result: "nao_encontrado"; motivo: "associado" | "placa" | "sem_faturas"; associadoNome?: string | null; placa?: string; situacao?: SituacaoInfo; eventos?: Evento[]; debug?: unknown };

const MAX_EVENTOS = 5;

function fmtBrDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

const MSG_RECORRENTE =
  "Este veículo está em cobrança recorrente no cartão — não há boleto para 2ª via. " +
  "Para atualizar o cartão, use o link oficial de atualização de cadastro do associado.";

/** Lista as 3 últimas faturas de uma placa; ramifica pra recorrente/não-encontrado se vazio. */
async function porPlaca(
  placa: string,
  assoc?: { nome: string | null; codigo: string | null; modelo: string | null; cpf?: string | null; formaPagamentoRecorrente?: string | null },
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
  // "Desde quando" a situação do associado é a atual — só afirma se o espelho local (sincronizado
  // 1x/dia) já tiver o histórico dessa pessoa E a última transição bater com a situação live.
  if (situacao.associado && cpfUse.length === 11) {
    const desde = await buscarDataInicioSituacaoAtual(cpfUse, situacao.associado).catch(() => null);
    if (desde) situacao.notaAssociado = `desde ${fmtBrDate(desde)}`;
  }
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

  // Sem boleto na janela de busca (SGA só permite consultar por janelas de ~90 dias). Antes
  // presumíamos "cartão recorrente" pela AUSÊNCIA de fatura — dava falso positivo em qualquer
  // inadimplente antigo cujo boleto em aberto ficou fora da janela (achado do Victor 24/07,
  // caso Elias Pereira Lima: inadimplente desde 2024, sem boleto recorrente nenhum).
  // Agora usa a forma de pagamento REAL cadastrada do associado (descricao_tipo_cobranca_recorrente),
  // que só é buscada aqui (lazy) — evita custo extra quando a fatura já foi achada acima.
  const formaPagamento =
    assoc?.formaPagamentoRecorrente ?? (cpfUse.length === 11 ? (await buscarPorCpf(cpfUse))?.formaPagamentoRecorrente ?? null : null);

  if (ehRecorrenteCartao(formaPagamento)) {
    return { result: "recorrente", associadoNome: info?.nome ?? null, codigo: info?.codigo ?? null, placa: p, situacao, eventos, mensagem: MSG_RECORRENTE };
  }
  // Não é cartão — mostra situação/eventos mesmo sem fatura na janela (associado pode ter
  // boleto real em aberto fora do período consultável; a situação financeira já denuncia isso).
  // Nenhum boleto em ~12 meses (listarUltimasFaturas varre 4 janelas de ~90 dias) + INADIMPLENTE
  // = seguro afirmar "há mais de 6 meses" (limiar de negócio antes de virar venda nova).
  const inadimplenteSemHistorico = (situacao.financeira || "").toUpperCase().includes("INADIMPL");
  const situacaoComNota: SituacaoInfo = inadimplenteSemHistorico
    ? { ...situacao, notaFinanceira: "há mais de 6 meses sem boleto (nenhum encontrado nos últimos ~12 meses consultados)" }
    : situacao;
  return { result: "nao_encontrado", motivo: "sem_faturas", associadoNome: info?.nome ?? null, placa: p, situacao: situacaoComNota, eventos };
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
        assoc
          ? { nome: assoc.nome, codigo: assoc.codigo, modelo: v?.modelo ?? null, cpf: assoc.cpf, formaPagamentoRecorrente: assoc.formaPagamentoRecorrente }
          : undefined,
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
        { nome: assoc.nome, codigo: assoc.codigo, modelo: veiculos[0].modelo, cpf: assoc.cpf, formaPagamentoRecorrente: assoc.formaPagamentoRecorrente },
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
