// sga.ts — cliente do SGA/Hinova (read-only), SERVER-ONLY. O token nunca vai pro browser.
//
// Portado da versão validada em produção do bot de atendimento
// (Bitrix_evolution_lab/src/services/sga-client.js) + acréscimo `listarUltimasFaturas` (histórico),
// que é o que este app precisa e o bot não tinha (o bot só pegava a fatura aberta).
//
// Gotchas do SGA (todos observados em produção):
//  - 404/406 = "não encontrado" → tratar como vazio, NÃO erro.
//  - Respostas inconsistentes: array | { boletos:[] } | { data:[] } | objeto único → normalizar.
//  - Datas dd/MM/yyyy nos payloads de boleto.
//  - Conta RECORRENTE (cartão): listar boleto por associado/veículo pode dar 406/vazio (não tem boleto).
//    O SERVICE decide o fluxo "cartão" (link de atualização) — aqui só devolvemos vazio.

import axios from "axios";

const AUTH_PATH = "/usuario/autenticar";
const HTTP_TIMEOUT_MS = 10000; // falha mais rapido que os 15s antigos (evita travar a tela)

let cachedToken: string | null = null;
let authInFlight: Promise<string> | null = null;
// Dedupe de autenticacao: com varias chamadas em PARALELO e token ainda nao obtido, todas
// compartilham UMA unica autenticacao (o token da SGA nao expira, entao basta uma).
async function ensureAuth(): Promise<string> {
  if (cachedToken) return cachedToken;
  if (!authInFlight) authInFlight = authenticate().finally(() => { authInFlight = null; });
  return authInFlight;
}

function host(): string {
  const h = process.env.SGA_HOST;
  if (!h) throw new Error("SGA_HOST ausente");
  return h.replace(/\/$/, "");
}
export function isConfigured(): boolean {
  return !!(process.env.SGA_HOST && process.env.SGA_USER && process.env.SGA_PASSWORD);
}

export type Veiculo = { placa: string; situacao: string; modelo: string | null };
export type Associado = {
  nome: string | null;
  cpf: string | null;
  codigo: string | null;
  veiculos: Veiculo[];
  // Forma de pagamento REALMENTE cadastrada (ex: "BOLETO / CARNÊ", "CARTÃO DE CRÉDITO"...).
  // Vem do mesmo payload de /associado/buscar (achado 24/07: não dava pra inferir "cartão"
  // pela ausência de boleto na janela de busca — inadimplente antigo fora da janela virava
  // falso "cartão recorrente". Agora usa o campo real em vez de adivinhar.)
  formaPagamentoRecorrente: string | null;
};

/** true se a descrição indica cobrança recorrente NO CARTÃO (não boleto/carnê). null/desconhecido = false
 *  (não afirma recorrente sem o dado real — evita repetir o erro do heurístico antigo). */
export function ehRecorrenteCartao(descricao: string | null): boolean {
  if (!descricao) return false;
  const d = normalizeText(descricao);
  if (d.includes("BOLETO") || d.includes("CARNE")) return false;
  return d.includes("CART") || d.includes("RECORR") || d.includes("DEBITO") || d.includes("DÉBITO");
}
export type Fatura = {
  nossoNumero: string | null;
  valor: string | null;
  vencimento: string | null;
  /** Data em que o SGA gerou o boleto (`data_emissao`). Na Loma a geração é em massa, por volta do
   *  dia 23, vencendo dia 10 do mês seguinte — ver a data de geração explica na hora por que uma
   *  fatura "nova" tem vencimento no mês que vem. */
  emissao: string | null;
  situacao: string | null;
  pago: boolean;
  /** Cobrável: situação ABERTO no catálogo oficial do SGA (código 2 — o único que a Hinova conta
   *  como inadimplência). É o que vai no bloco destacado da tela. */
  aberto: boolean;
  linhaDigitavel: string | null;
  linkBoleto: string | null;
  pixCopiaCola: string | null;
};

function normalizeText(v: unknown): string {
  return String(v == null ? "" : v).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
}
function readStr(row: Record<string, unknown> | null, keys: string[]): string {
  if (!row) return "";
  for (const k of keys) {
    const val = row[k];
    if (val != null && String(val).trim()) return String(val);
  }
  return "";
}
// Só aceita link se for URL de verdade. Boleto PAGO/BAIXADO faz o SGA devolver um TEXTO de erro
// no campo link_boleto ("Não foi possível...") — não é link, então vira null (esconde o botão PDF).
function urlOnly(s: string): string | null {
  return /^https?:\/\//i.test(s) ? s : null;
}
function asArray(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (Array.isArray(o.boletos)) return o.boletos as Record<string, unknown>[];
    if (Array.isArray(o.data)) return o.data as Record<string, unknown>[];
    return [o];
  }
  return [];
}
function modeloSimples(desc: unknown): string | null {
  const s = String(desc || "").trim();
  return s ? s.split(/\s+/)[0] : null;
}
function fmtBr(d: Date): string {
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

async function authenticate(): Promise<string> {
  const res = await axios.post(
    `${host()}${AUTH_PATH}`,
    { usuario: process.env.SGA_USER, senha: process.env.SGA_PASSWORD },
    {
      timeout: HTTP_TIMEOUT_MS,
      headers: {
        "Content-Type": "application/json",
        ...(process.env.SGA_TOKEN ? { Authorization: `Bearer ${process.env.SGA_TOKEN}` } : {}),
      },
    },
  );
  const token = res.data?.token_usuario;
  if (!token) throw new Error("SGA auth: token_usuario ausente");
  cachedToken = token;
  return token;
}

async function authed(method: "get" | "post", path: string, body?: unknown): Promise<unknown> {
  if (!cachedToken) await ensureAuth();
  const call = () =>
    axios.request({
      method,
      url: `${host()}${path}`,
      data: body,
      timeout: HTTP_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${cachedToken}`,
        ...(method === "post" ? { "Content-Type": "application/json" } : {}),
      },
      validateStatus: (s) => (s >= 200 && s < 300) || s === 401 || s === 404 || s === 406,
    });
  let res = await call();
  if (res.status === 401) {
    await authenticate();
    res = await call();
  }
  if (res.status === 404 || res.status === 406) return null; // não-existe/vazio, não é erro
  if (res.status < 200 || res.status >= 300) throw new Error(`SGA ${path} falhou: ${res.status}`);
  return res.data;
}

function pickAssociado(rec: Record<string, unknown> | null): Associado | null {
  if (!rec || typeof rec !== "object") return null;
  const nome = readStr(rec, ["nome", "nome_associado", "nome_completo"]) || null;
  const cpf = readStr(rec, ["cpf", "cpf_associado"]).replace(/\D/g, "") || null;
  const codigo = readStr(rec, ["codigo_associado", "codigo", "codigo_associado_beneficiario"]) || null;
  if (!nome && !codigo) return null;
  const vs = Array.isArray((rec as { veiculos?: unknown }).veiculos)
    ? ((rec as { veiculos: Record<string, unknown>[] }).veiculos)
    : [];
  const veiculos: Veiculo[] = vs
    .map((v) => ({
      placa: readStr(v, ["placa"]).replace(/\s/g, "").toUpperCase() || "",
      situacao: normalizeText(readStr(v, ["situacao", "descricao_situacao"])),
      modelo: modeloSimples(readStr(v, ["descricao_modelo", "modelo"])),
    }))
    .filter((v) => v.placa);
  const formaPagamentoRecorrente = readStr(rec, ["descricao_tipo_cobranca_recorrente"]) || null;
  return { nome, cpf, codigo: codigo ? String(codigo) : null, veiculos, formaPagamentoRecorrente };
}

export async function buscarPorCpf(cpf: string): Promise<Associado | null> {
  const d = String(cpf).replace(/\D/g, "");
  const data = await authed("get", `/associado/buscar/${d}/cpf`);
  const arr = asArray(data);
  return arr.length ? pickAssociado(arr[0]) : null;
}

/** Detalhe do veículo por placa (best-effort: nome/código/CPF do associado + modelo).
 *  Usado quando o executivo pesquisa SÓ por placa (sem CPF) — o CPF daqui permite
 *  buscar a situação do associado mesmo sem o executivo digitar o CPF. */
export async function buscarVeiculoPorPlaca(
  placa: string,
): Promise<{ nome: string | null; codigo: string | null; modelo: string | null; cpf: string | null } | null> {
  const p = String(placa).replace(/\s/g, "").toUpperCase();
  const data = await authed("get", `/veiculo/buscar/${p}/placa`);
  const rec = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!rec) return null;
  return {
    nome: readStr(rec, ["nome_associado", "nome"]) || null,
    codigo: readStr(rec, ["codigo_associado", "codigo"]) || null,
    modelo: modeloSimples(readStr(rec, ["descricao_modelo", "modelo"])),
    cpf: readStr(rec, ["cpf_associado", "cpf"]).replace(/\D/g, "") || null,
  };
}

/** Situação do associado (ATIVO/INATIVO) por CPF ou CNPJ.
 *  Doc SGA: GET buscar/situacao-associado/:cpfOuCnpj → { codigo_situacao, descricao }. */
export type SituacaoAssociado = { codigoSituacao: string | null; descricao: string | null };
export async function buscarSituacaoAssociado(cpfOuCnpj: string): Promise<SituacaoAssociado | null> {
  const d = String(cpfOuCnpj).replace(/\D/g, "");
  if (!d) return null;
  const data = await authed("get", `/buscar/situacao-associado/${d}`);
  const rec = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!rec) return null;
  return {
    codigoSituacao: readStr(rec, ["codigo_situacao"]) || null,
    descricao: readStr(rec, ["descricao", "descricao_situacao"]) || null,
  };
}

// CATÁLOGO OFICIAL de situação de boleto (GET listar/situacao-boleto/todos, lido em 31/07/2026 —
// rota liberada pelo Victor na tela do SGA). Só o código 2 é cobrável:
//   1 BAIXADO (pago=SIM) · 2 ABERTO (pago=NÃO, considerado_inadimplencia=Y) · 3 CANCELADO ·
//   4 BAIXADO C/ PENDÊNCIA (pago=SIM) · 555 CANCELADO REATIVAÇÃO · 666 CANCELADO TRATATIVA
//   COMERCIAL · 777 CANCELADO BOLETO INDEVIDO · 999 EXCLUÍDO · 1000 CANCELADO REATIVAÇÃO INADIM.
// ⚠️ Antes disto classificávamos por PALAVRA na descrição, e EXCLUÍDO passava como "em aberto".
// O código é a fonte oficial — a descrição só entra como plano B.
const CODIGO_SITUACAO_ABERTO = "2";
const SITUACAO_NAO_COBRAVEL = /(BAIXAD|PAGO|LIQUIDAD|QUITAD|CANCELAD|ESTORNAD|EXCLU)/;

function pickFatura(row: Record<string, unknown>): Fatura {
  const situacao = normalizeText(readStr(row, ["situacao_boleto", "status"]));
  const codigoSituacao = readStr(row, ["codigo_situacao_boleto"]);
  const pago = !!(readStr(row, ["data_pagamento"]) || situacao.includes("PAGO"));
  const pix = (row.pix && typeof row.pix === "object" ? row.pix : {}) as Record<string, unknown>;
  return {
    nossoNumero: readStr(row, ["nosso_numero", "codigo_boleto"]) || null,
    valor: readStr(row, ["valor_boleto", "valor", "total_boleto"]) || null,
    vencimento: readStr(row, ["data_vencimento", "data_vencimento_original"]) || null,
    emissao: readStr(row, ["data_emissao"]) || null,
    situacao: readStr(row, ["descricao_situacao_boleto", "situacao_boleto", "status"]) || null,
    pago,
    // O código vem nas listagens E no `buscar/boleto/:nosso_numero` (esse devolve o código mas
    // NÃO a descrição — conferido ao vivo em 31/07/2026: boleto pago volta código 1 com
    // situacao_boleto null). A descrição é só plano B, se algum dia vier payload sem código.
    aberto: codigoSituacao
      ? codigoSituacao === CODIGO_SITUACAO_ABERTO
      : !pago && !SITUACAO_NAO_COBRAVEL.test(situacao),
    linhaDigitavel: readStr(row, ["linha_digitavel"]) || null,
    linkBoleto: urlOnly(readStr(row, ["link_boleto"])),
    pixCopiaCola: readStr(pix, ["copia_cola", "copiaCola"]) || null,
  };
}

/** Data de boleto → timestamp. O SGA responde em ISO (`2026-08-10`) na listagem, mas os payloads
 *  antigos apareciam em dd/MM/yyyy — aceita OS DOIS.
 *  ⚠️ Isto já quebrou a ordenação uma vez (31/07/2026): lendo só dd/MM/yyyy, TODA fatura virava
 *  timestamp 0, o sort não ordenava nada e o corte das "3 últimas" podia descartar a mais nova. */
export function parseDataFatura(s: string | null): number {
  if (!s) return 0;
  const iso = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])).getTime();
  const br = String(s).match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return new Date(Number(br[3]), Number(br[2]) - 1, Number(br[1])).getTime();
  return 0;
}

export type ListagemBoletos = {
  faturas: Fatura[];
  debug: { attempts: { via: string; n: number }[]; sampleKeys: string[] };
};

/** Todas as faturas achadas na varredura, VENCIMENTO MAIS RECENTE PRIMEIRO (quem chama decide o corte).
 *  ⚠️ O endpoint /listar/boleto-associado-veiculo exige um par de datas e tem LIMITE DE 90 DIAS por
 *  intervalo (doc oficial). Por isso varremos em JANELAS CONTÍGUAS de 88 dias andando pra trás.
 *  Cobertura total: 40 dias pra FRENTE + ~10 meses pra trás (4 x 88 dias). Quem depende desse
 *  período pra afirmar algo na tela tem que usar o MESMO número — ver boleto.service.ts.
 *  As janelas vão EM PARALELO (lote pequeno = nº de janelas). A doc da SGA não declara
 *  limite de requisições, então mantemos o paralelismo conservador. `link_boleto: true` traz o PDF.
 *
 *  ⚠️ A JANELA OLHA PRA FRENTE — e isso é o coração da correção de 31/07/2026. A Loma gera o boleto
 *  por volta do dia 23 com vencimento no dia 10 do mês SEGUINTE, ou seja a fatura nasce ~18 dias no
 *  futuro. Com o antigo `+3 dias` de folga, do dia 23 até o dia 10 seguinte a fatura nova ficava
 *  FORA da janela e o app não a mostrava — 18 dias invisíveis por mês, todo mês (provado ao vivo na
 *  placa HEM0A76: boleto 752459, emitido 23/07/2026, vencendo 10/08/2026, invisível em 31/07). */
const FATURA_JANELAS = 4; // ~10 meses pra trás (4 x 88 dias)
const JANELA_DIAS = 88; // < limite de 90 dias por consulta
const LOOKAHEAD_DIAS = 40; // cobre o vencimento do dia 10 do mês seguinte com folga
export async function listarUltimasFaturas(
  placa: string,
  codigo: string | null,
): Promise<ListagemBoletos> {
  const p = String(placa).replace(/\s/g, "").toUpperCase();
  const DAY = 864e5;
  const attempts: { via: string; n: number }[] = [];
  const acc = new Map<string, Record<string, unknown>>();

  const varrer = async (ident: Record<string, unknown>, tag: string) => {
    // Todas as janelas em PARALELO (lote de FATURA_JANELAS ~4).
    const lotes = await Promise.all(
      Array.from({ length: FATURA_JANELAS }, async (_, i) => {
        // Janelas contíguas: o fim de uma é o início da anterior (sem buraco entre elas).
        const fim = new Date(Date.now() + (LOOKAHEAD_DIAS - i * JANELA_DIAS) * DAY);
        const ini = new Date(fim.getTime() - JANELA_DIAS * DAY);
        const body = {
          ...ident,
          data_vencimento_inicial: fmtBr(ini),
          data_vencimento_final: fmtBr(fim),
          link_boleto: true,
        };
        try {
          const rows = asArray(await authed("post", "/listar/boleto-associado-veiculo", body));
          attempts.push({ via: `${tag}_win${i}`, n: rows.length });
          return rows;
        } catch {
          attempts.push({ via: `${tag}_win${i}_ERR`, n: -1 });
          return [] as Record<string, unknown>[];
        }
      }),
    );
    for (const rows of lotes)
      for (const r of rows) {
        const key = String(r.nosso_numero ?? r.codigo_boleto ?? JSON.stringify(r));
        if (!acc.has(key)) acc.set(key, r);
      }
  };

  await varrer({ placa: p }, "placa");
  if (acc.size === 0 && codigo) await varrer({ codigo_associado: codigo }, "codigo");

  const allRows = [...acc.values()];
  const sampleKeys = allRows[0] ? Object.keys(allRows[0]) : [];
  const faturas = allRows
    .map(pickFatura)
    .sort((a, b) => parseDataFatura(b.vencimento) - parseDataFatura(a.vencimento));
  return { faturas, debug: { attempts, sampleKeys } };
}

/** Situação financeira do veículo (fonte real da inadimplência) — dá vencimento + nosso_numero do aberto. */
export async function situacaoFinanceiraVeiculo(
  placa: string,
): Promise<{ placa: string; situacao: string | null; vencimento: string | null; nossoNumero: string | null } | null> {
  const p = String(placa).replace(/\s/g, "").toUpperCase();
  const data = await authed("get", `/buscar/situacao-financeira-veiculo/${p}`);
  const rec = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!rec) return null;
  return {
    placa: p,
    situacao: readStr(rec, ["situacao_financeira", "descricao_situacao_veiculo"]) || null,
    vencimento: readStr(rec, ["data_vencimento"]) || null,
    nossoNumero: readStr(rec, ["nosso_numero"]) || null,
  };
}

export type Evento = {
  protocolo: string | null;
  data: string | null; // ISO (data_evento)
  situacao: string | null; // situacao_evento (texto)
  descricao: string | null; // área/tipo do evento
  motivo: string | null;
  codigoSituacao: string | null;
};

// Palavras que indicam evento ENCERRADO (não-aberto). A doc SGA não expõe um flag
// aberto/fechado; filtramos por essas palavras na descrição da situação. ⚠️ Lista a
// CALIBRAR com os nomes reais das situações da Loma (validar ao vivo).
const EVENTO_ENCERRADO = /(FINALIZ|ENCERR|CANCEL|INDEFER|ARQUIV|CONCLU|QUITAD|NEGAD|REPROV|PAGO|BAIXAD)/;

/** true se o evento parece estar EM ABERTO (sem situação → tratado como aberto, não esconde). */
export function eventoEmAberto(situacao: string | null): boolean {
  if (!situacao) return true;
  return !EVENTO_ENCERRADO.test(normalizeText(situacao));
}

/** Eventos (sinistros/acionamentos) de um veículo por placa ou código.
 *  Doc SGA: GET listar/evento-veiculo/:placa_ou_codigo → { eventos: [...] }. */
export async function listarEventosVeiculo(placaOuCodigo: string): Promise<Evento[]> {
  const key = String(placaOuCodigo).replace(/\s/g, "").toUpperCase();
  if (!key) return [];
  const data = await authed("get", `/listar/evento-veiculo/${key}`);
  const arr = Array.isArray(data)
    ? (data as Record<string, unknown>[])
    : ((data as { eventos?: unknown } | null)?.eventos as Record<string, unknown>[] | undefined) ?? [];
  return arr.map((row) => ({
    protocolo: readStr(row, ["protocolo", "codigo_evento"]) || null,
    data: readStr(row, ["data_evento", "data_cadastro_evento"]) || null,
    situacao: readStr(row, ["situacao_evento", "descricao_situacao_evento"]) || null,
    descricao: readStr(row, ["descricao_evento_area", "descricao_evento"]) || null,
    motivo: readStr(row, ["descricao_motivo"]) || null,
    codigoSituacao: readStr(row, ["codigo_situacao_evento"]) || null,
  }));
}

/** 2ª via completa de um boleto por nosso_numero (linha digitável + link PDF + PIX) — numa chamada. */
export async function buscarBoleto(nossoNumero: string): Promise<Fatura | null> {
  const nn = String(nossoNumero).replace(/\D/g, "");
  if (!nn) return null;
  const data = await authed("get", `/buscar/boleto/${nn}`);
  const rec = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  return rec ? pickFatura(rec) : null;
}

export type AlteracaoSituacao = {
  codigoAlteracao: string;
  codigoAssociado: string;
  cpf: string;
  valorAnterior: string | null;
  valorPosterior: string;
  dataAlteracao: string; // ISO, combina data_alteracao + hora_alteracao
};

/** Mudanças de codigo_situacao de associados num período (máx. ~7 dias por chamada, doc oficial).
 *  Sem `valor_posterior` (testado ao vivo 24/07: filtro é opcional) devolve TODAS as transições,
 *  de qualquer código — é o que alimenta o histórico local (situacao_historico). */
export async function listarAlteracoesSituacaoAssociado(dataInicial: Date, dataFinal: Date): Promise<AlteracaoSituacao[]> {
  const data = await authed("post", "/listar/alteracao-associados/", {
    data_inicial: fmtBr(dataInicial),
    data_final: fmtBr(dataFinal),
    campos: ["codigo_situacao"],
  });
  const arr = asArray(data);
  return arr
    .map((row) => {
      const codigoAlteracao = readStr(row, ["codigo_alteracao"]);
      const codigoAssociado = readStr(row, ["codigo_associado"]);
      const cpf = readStr(row, ["cpf_associado"]).replace(/\D/g, "");
      const valorPosterior = readStr(row, ["valor_posterior"]);
      if (!codigoAlteracao || !codigoAssociado || !cpf || !valorPosterior) return null;
      const dataAlt = readStr(row, ["data_alteracao"]).slice(0, 10); // yyyy-mm-dd
      const hora = readStr(row, ["hora_alteracao"]) || "00:00:00";
      return {
        codigoAlteracao,
        codigoAssociado,
        cpf,
        valorAnterior: readStr(row, ["valor_anterior"]) || null,
        valorPosterior,
        dataAlteracao: dataAlt ? `${dataAlt}T${hora}` : new Date().toISOString(),
      };
    })
    .filter((x): x is AlteracaoSituacao => x !== null);
}

export type SituacaoCatalogoItem = { codigo: string; descricao: string };

/** Catálogo codigo_situacao → descrição (ATIVO/INADIMPLENTE/...). Muda raramente — sincronizar
 *  periodicamente (mesmo cron do histórico), não a cada consulta. */
export async function listarCatalogoSituacao(): Promise<SituacaoCatalogoItem[]> {
  const data = await authed("get", "/listar/situacao/todos");
  const arr = asArray(data);
  return arr
    .map((row) => ({
      codigo: readStr(row, ["codigo_situacao"]),
      descricao: readStr(row, ["descricao_situacao", "descricao"]),
    }))
    .filter((x) => x.codigo && x.descricao);
}

export function _resetForTests() {
  cachedToken = null;
}
