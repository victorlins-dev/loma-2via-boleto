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
const HTTP_TIMEOUT_MS = 15000;

let cachedToken: string | null = null;

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
};
export type Fatura = {
  nossoNumero: string | null;
  valor: string | null;
  vencimento: string | null;
  situacao: string | null;
  pago: boolean;
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
  if (!cachedToken) await authenticate();
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
  return { nome, cpf, codigo: codigo ? String(codigo) : null, veiculos };
}

export async function buscarPorCpf(cpf: string): Promise<Associado | null> {
  const d = String(cpf).replace(/\D/g, "");
  const data = await authed("get", `/associado/buscar/${d}/cpf`);
  const arr = asArray(data);
  return arr.length ? pickAssociado(arr[0]) : null;
}

/** Detalhe do veículo por placa (best-effort: nome/código do associado + modelo).
 *  Usado quando o executivo pesquisa SÓ por placa (sem CPF). */
export async function buscarVeiculoPorPlaca(
  placa: string,
): Promise<{ nome: string | null; codigo: string | null; modelo: string | null } | null> {
  const p = String(placa).replace(/\s/g, "").toUpperCase();
  const data = await authed("get", `/veiculo/buscar/${p}/placa`);
  const rec = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!rec) return null;
  return {
    nome: readStr(rec, ["nome_associado", "nome"]) || null,
    codigo: readStr(rec, ["codigo_associado", "codigo"]) || null,
    modelo: modeloSimples(readStr(rec, ["descricao_modelo", "modelo"])),
  };
}

function pickFatura(row: Record<string, unknown>): Fatura {
  const situacao = normalizeText(readStr(row, ["situacao_boleto", "status"]));
  const pago = !!(readStr(row, ["data_pagamento"]) || situacao.includes("PAGO"));
  const pix = (row.pix && typeof row.pix === "object" ? row.pix : {}) as Record<string, unknown>;
  return {
    nossoNumero: readStr(row, ["nosso_numero", "codigo_boleto"]) || null,
    valor: readStr(row, ["valor_boleto", "valor", "total_boleto"]) || null,
    vencimento: readStr(row, ["data_vencimento", "data_vencimento_original"]) || null,
    situacao: readStr(row, ["descricao_situacao_boleto", "situacao_boleto", "status"]) || null,
    pago,
    linhaDigitavel: readStr(row, ["linha_digitavel"]) || null,
    linkBoleto: readStr(row, ["link_boleto"]) || null,
    pixCopiaCola: readStr(pix, ["copia_cola", "copiaCola"]) || null,
  };
}

function parseBrDate(s: string | null): number {
  if (!s) return 0;
  const m = String(s).match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return 0;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])).getTime();
}

export type ListagemBoletos = {
  faturas: Fatura[];
  debug: { attempts: { via: string; n: number }[]; sampleKeys: string[] };
};

/** As N últimas faturas (histórico), mais recentes primeiro. Tenta as VARIAÇÕES de endpoint do SGA
 *  (por placa, e por código do associado) porque a listagem varia por conta; usa a 1ª que retornar
 *  linhas. Janela larga (18 meses → +30d). Devolve também um diagnóstico do que cada tentativa trouxe. */
export async function listarUltimasFaturas(
  placa: string,
  codigo: string | null,
  n = 3,
): Promise<ListagemBoletos> {
  const p = String(placa).replace(/\s/g, "").toUpperCase();
  const now = new Date();
  const ini = fmtBr(new Date(now.getTime() - 548 * 864e5));
  const fim = fmtBr(new Date(now.getTime() + 30 * 864e5));
  const attempts: { via: string; n: number }[] = [];

  const tryPost = async (via: string, path: string, body: unknown) => {
    try {
      const d = await authed("post", path, body);
      const a = asArray(d);
      attempts.push({ via, n: a.length });
      return a;
    } catch {
      attempts.push({ via: `${via}_ERR`, n: -1 });
      return [] as Record<string, unknown>[];
    }
  };

  let rows = await tryPost("placa_venc_orig", "/listar/boleto-associado-veiculo", {
    placa: p, data_vencimento_original_inicial: ini, data_vencimento_original_final: fim,
  });
  if (!rows.length && codigo) {
    rows = await tryPost("codigo_periodo", "/listar/boleto-associado/periodo", {
      codigo_associado: codigo, data_vencimento_inicial: ini, data_vencimento_final: fim,
      quantidade_por_pagina: 100, inicio_paginacao: 0,
    });
  }
  if (!rows.length && codigo) {
    rows = await tryPost("codigo_emissao", "/listar/boleto-associado-veiculo", {
      codigo_associado: codigo, data_emissao_inicial: ini, data_emissao_final: fim,
    });
  }
  const sampleKeys = rows[0] ? Object.keys(rows[0]) : [];
  const faturas = rows
    .map(pickFatura)
    .sort((a, b) => parseBrDate(b.vencimento) - parseBrDate(a.vencimento))
    .slice(0, n);
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

/** 2ª via completa de um boleto por nosso_numero (linha digitável + link PDF + PIX) — numa chamada. */
export async function buscarBoleto(nossoNumero: string): Promise<Fatura | null> {
  const nn = String(nossoNumero).replace(/\D/g, "");
  if (!nn) return null;
  const data = await authed("get", `/buscar/boleto/${nn}`);
  const rec = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  return rec ? pickFatura(rec) : null;
}

export function _resetForTests() {
  cachedToken = null;
}
