// situacao-historico.service.ts — sincroniza e consulta o ESPELHO local do log de mudança de
// situação do associado (pedido do Victor 24/07: "desde quando está INADIMPLENTE").
//
// Por que espelho e não consulta ao vivo: a Hinova só expõe isso via `listar/alteracao-associados`,
// em janelas de até 7 dias e SEM filtro por associado (devolve TODAS as mudanças da cooperativa
// naquele período). Achar 1 associado em 12 meses ao vivo seria ~50+ chamadas POR CONSULTA —
// inviável a 400 consultas/dia (~20 mil chamadas extras/dia na API de produção da Hinova, que o bot
// de atendimento e a cotação também usam). Solução: sincroniza 1x/dia (poucas chamadas, custo fixo,
// independente do volume de uso dos executivos); a consulta ao vivo lê deste espelho, instantânea.

import { eq, desc } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { situacaoHistorico, situacaoCatalogo } from "@/lib/db/schema";
import { listarAlteracoesSituacaoAssociado, listarCatalogoSituacao } from "@/lib/clients/sga";

/** Sincroniza as mudanças de situação num período (a Hinova limita ~7 dias por chamada — quem
 *  chama decide a janela). Idempotente: `codigo_alteracao` é a chave natural do evento na Hinova,
 *  upsert com onConflictDoNothing nunca duplica (rodar 2x no mesmo dia é seguro). */
export async function sincronizarPeriodo(dataInicial: Date, dataFinal: Date): Promise<{ lidos: number; novos: number }> {
  if (!db) throw new Error("sem DATABASE_URL — sync indisponível");
  const alteracoes = await listarAlteracoesSituacaoAssociado(dataInicial, dataFinal);
  if (!alteracoes.length) return { lidos: 0, novos: 0 };

  const rows = alteracoes.map((a) => ({
    codigoAlteracao: a.codigoAlteracao,
    codigoAssociado: a.codigoAssociado,
    cpf: a.cpf,
    valorAnterior: a.valorAnterior,
    valorPosterior: a.valorPosterior,
    dataAlteracao: new Date(a.dataAlteracao),
  }));

  const inseridos = await db
    .insert(situacaoHistorico)
    .values(rows)
    .onConflictDoNothing({ target: situacaoHistorico.codigoAlteracao })
    .returning({ id: situacaoHistorico.id });

  return { lidos: alteracoes.length, novos: inseridos.length };
}

/** Refresca o catálogo codigo_situacao → descrição. Chamar raramente (a Hinova quase não muda isso) —
 *  o cron diário já cobre. */
export async function sincronizarCatalogo(): Promise<number> {
  if (!db) throw new Error("sem DATABASE_URL — sync indisponível");
  const itens = await listarCatalogoSituacao();
  if (!itens.length) return 0;
  await db
    .insert(situacaoCatalogo)
    .values(itens.map((i) => ({ codigoSituacao: i.codigo, descricao: i.descricao })))
    .onConflictDoUpdate({
      target: situacaoCatalogo.codigoSituacao,
      set: { descricao: sql`excluded.descricao`, sincronizadoEm: sql`now()` },
    });
  return itens.length;
}

/** Data em que o associado entrou na situação ATUAL (ex: desde quando está INADIMPLENTE).
 *  Só afirma a data se a ÚLTIMA transição registrada no nosso espelho bater com a descrição da
 *  situação ATUAL (live, vinda do SGA) — evita afirmar uma data errada se o sync estiver atrasado
 *  ou o associado não tiver histórico sincronizado ainda (associado fora do backfill, por ex.).
 *  Retorna null nesses casos — quem chama cai pro fallback ("há mais de 6 meses"). */
export async function buscarDataInicioSituacaoAtual(cpf: string, situacaoAtualDescricao: string): Promise<Date | null> {
  if (!db) return null;
  const cpfDigits = cpf.replace(/\D/g, "");
  if (cpfDigits.length !== 11) return null;

  const rows = await db
    .select({ dataAlteracao: situacaoHistorico.dataAlteracao, descricao: situacaoCatalogo.descricao })
    .from(situacaoHistorico)
    .innerJoin(situacaoCatalogo, eq(situacaoCatalogo.codigoSituacao, situacaoHistorico.valorPosterior))
    .where(eq(situacaoHistorico.cpf, cpfDigits))
    .orderBy(desc(situacaoHistorico.dataAlteracao))
    .limit(1);

  const ultima = rows[0];
  if (!ultima) return null;
  const bate = ultima.descricao.trim().toUpperCase() === situacaoAtualDescricao.trim().toUpperCase();
  return bate ? ultima.dataAlteracao : null;
}
