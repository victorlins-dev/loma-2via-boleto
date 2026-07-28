// bitrix-crm.ts — cliente CRM do Bitrix via WEBHOOK DE ENTRADA dedicado (não o token OAuth pessoal
// de quem está logado). SERVER-ONLY, escrita real em produção (cria Contato + Negócio de verdade).
//
// Por que webhook e não o access_token do líder logado: a escrita precisa criar Negócio ATRIBUÍDO A
// OUTRA PESSOA (o executivo escolhido) — isso normalmente exige permissão de CRM "atribuir pra
// outros" no funil, que nem todo líder necessariamente tem configurada. Centralizar numa credencial
// só evita depender da permissão individual de cada líder; quem decide QUEM pode usar a tela é o
// nosso próprio gate de "é líder" (ver import-leads.service.ts), não a permissão nativa do Bitrix.
//
// Usado só pela feature de Importação de Leads (src/app/importar-leads, src/app/api/leads/*).

import axios from "axios";
import qs from "qs";

const HTTP_TIMEOUT_MS = 15000;
const BATCH_CHUNK = 25; // 2 comandos por lead (contato+negócio) => até 50 por chamada batch (limite Bitrix)

// "Diretoria Comercial" — raiz da árvore de departamentos comerciais (SUPREMACIA, CHAMPIONS, ROCKET,
// TITANS, INVICTUS, DINASTIA, Novos Executivos, Legado, etc). Se a org reestruturar os departamentos,
// atualizar este ID (confirmado via department.get em 27/07: dept 69 = "Diretoria Comercial").
const DEPTO_RAIZ_COMERCIAL = 69;

// Funil Comercial (categoria 17), etapa "Lista 300" — confirmado via crm.stage.list.
const CATEGORY_ID_COMERCIAL = 17;
const STAGE_ID_LISTA_300 = "C17:UC_JG9RMJ";

export function isConfigured(): boolean {
  return !!process.env.BITRIX_CRM_WEBHOOK_URL;
}

function base(): string {
  const url = process.env.BITRIX_CRM_WEBHOOK_URL;
  if (!url) throw new Error("BITRIX_CRM_WEBHOOK_URL ausente");
  return url.replace(/\/$/, "");
}

async function call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await axios.get(`${base()}/${method}`, {
    params,
    paramsSerializer: (p) => qs.stringify(p, { arrayFormat: "indices", encode: true }),
    timeout: HTTP_TIMEOUT_MS,
  });
  if (res.data?.error) throw new Error(`Bitrix ${method}: ${res.data.error_description || res.data.error}`);
  return res.data.result as T;
}

type BatchResponse = { result: Record<string, unknown>; result_error: Record<string, { error?: string; error_description?: string }> };

/** `cmd`: chave arbitrária -> "metodo?query_string_ja_montada". Máx 50 comandos por chamada
 *  (limite do Bitrix) — quem chama já deve ter dividido em chunks. */
async function batch(cmd: Record<string, string>): Promise<BatchResponse> {
  const body = qs.stringify({ halt: 0, cmd }, { arrayFormat: "indices", encode: true });
  const res = await axios.post(`${base()}/batch`, body, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: HTTP_TIMEOUT_MS,
  });
  if (res.data?.error) throw new Error(`Bitrix batch: ${res.data.error_description || res.data.error}`);
  return res.data.result as BatchResponse;
}

function buildCmd(method: string, params: Record<string, unknown>): string {
  return `${method}?${qs.stringify(params, { arrayFormat: "indices", encode: true })}`;
}

type Departamento = { id: number; parent: number | null; ufHead: number | null };

async function listarTodosDepartamentos(): Promise<Departamento[]> {
  const out: Departamento[] = [];
  let start = 0;
  for (;;) {
    const data = await call<{ ID: string; PARENT?: string; UF_HEAD?: string }[]>("department.get", { start });
    for (const d of data) {
      out.push({
        id: Number(d.ID),
        parent: d.PARENT ? Number(d.PARENT) : null,
        ufHead: d.UF_HEAD ? Number(d.UF_HEAD) : null,
      });
    }
    if (data.length < 50) break; // página cheia = pode ter próxima; incompleta = acabou
    start += 50;
  }
  return out;
}

/** IDs de todos os departamentos sob DEPTO_RAIZ_COMERCIAL (inclusive), via árvore de PARENT. */
function departamentosComerciais(todos: Departamento[]): number[] {
  const porId = new Map(todos.map((d) => [d.id, d]));
  const éDescendente = (id: number): boolean => {
    let atual = porId.get(id);
    let guard = 0;
    while (atual && guard++ < 20) {
      if (atual.id === DEPTO_RAIZ_COMERCIAL) return true;
      atual = atual.parent ? porId.get(atual.parent) : undefined;
    }
    return false;
  };
  return todos.filter((d) => éDescendente(d.id)).map((d) => d.id);
}

/** IDs dos usuários chefes (UF_HEAD) de qualquer departamento comercial — nossa definição de "líder". */
export async function listarChefesComerciais(): Promise<Set<string>> {
  const todos = await listarTodosDepartamentos();
  const comerciais = new Set(departamentosComerciais(todos));
  const chefes = new Set<string>();
  for (const d of todos) {
    if (comerciais.has(d.id) && d.ufHead) chefes.add(String(d.ufHead));
  }
  return chefes;
}

export type ExecutivoComercial = { id: string; nome: string };

/** Todos os usuários ativos dos departamentos comerciais — pra popular o dropdown "vincular a". */
export async function listarExecutivosComerciais(): Promise<ExecutivoComercial[]> {
  const todos = await listarTodosDepartamentos();
  const deptoIds = departamentosComerciais(todos);
  if (!deptoIds.length) return [];
  const usuarios = await call<{ ID: string; NAME?: string; LAST_NAME?: string; EMAIL?: string }[]>("user.get", {
    filter: { UF_DEPARTMENT: deptoIds, ACTIVE: true },
  });
  const vistos = new Set<string>();
  const out: ExecutivoComercial[] = [];
  for (const u of usuarios) {
    if (vistos.has(u.ID)) continue;
    vistos.add(u.ID);
    const nome = [u.NAME, u.LAST_NAME].filter(Boolean).join(" ") || u.EMAIL || `Usuário ${u.ID}`;
    out.push({ id: u.ID, nome });
  }
  return out.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}

/** Pra cada telefone (na mesma ordem), diz se já existe algum Contato no CRM com esse telefone. */
export async function buscarDuplicadosPorTelefone(telefones: string[]): Promise<boolean[]> {
  const out: boolean[] = new Array(telefones.length).fill(false);
  for (let offset = 0; offset < telefones.length; offset += BATCH_CHUNK * 2) {
    const chunk = telefones.slice(offset, offset + BATCH_CHUNK * 2);
    const cmd: Record<string, string> = {};
    chunk.forEach((tel, i) => {
      cmd[`d${offset + i}`] = buildCmd("crm.duplicate.findbycomm", {
        entity_type: "CONTACT",
        type: "PHONE",
        values: [tel],
      });
    });
    const { result } = await batch(cmd);
    chunk.forEach((_tel, i) => {
      const key = `d${offset + i}`;
      const matches = result[key] as { CONTACT?: string[] } | undefined;
      out[offset + i] = !!matches?.CONTACT?.length;
    });
  }
  return out;
}

export type CriarLeadInput = { nome: string; telefone: string };
export type CriarLeadResultado =
  | { ok: true; contatoId: string; negocioId: string }
  | { ok: false; motivo: string };

/** Cria Contato (nome+telefone) + Negócio vinculado (Comercial → Lista 300, atribuído ao executivo),
 *  em lote, na MESMA ordem de entrada. Duas passadas (contatos, depois negócios) em vez de usar o
 *  encadeamento $result[] do Bitrix dentro de um único batch — mais simples de depurar e de mapear
 *  falha por linha. */
export async function criarLeadsComercial(leads: CriarLeadInput[], executivoId: string): Promise<CriarLeadResultado[]> {
  const out: CriarLeadResultado[] = new Array(leads.length);

  for (let offset = 0; offset < leads.length; offset += BATCH_CHUNK) {
    const chunk = leads.slice(offset, offset + BATCH_CHUNK);

    const cmdContatos: Record<string, string> = {};
    chunk.forEach((l, i) => {
      cmdContatos[`c${i}`] = buildCmd("crm.contact.add", {
        fields: { NAME: l.nome, PHONE: [{ VALUE: l.telefone, VALUE_TYPE: "WORK" }] },
        params: { REGISTER_SONET_EVENT: "N" },
      });
    });
    const { result: rc, result_error: ec } = await batch(cmdContatos);

    const cmdNegocios: Record<string, string> = {};
    chunk.forEach((l, i) => {
      const contatoId = rc[`c${i}`];
      if (!contatoId) return; // sem contato, não tenta criar o negócio
      cmdNegocios[`n${i}`] = buildCmd("crm.deal.add", {
        fields: {
          TITLE: l.nome,
          CATEGORY_ID: CATEGORY_ID_COMERCIAL,
          STAGE_ID: STAGE_ID_LISTA_300,
          CONTACT_ID: contatoId,
          ASSIGNED_BY_ID: executivoId,
        },
        params: { REGISTER_SONET_EVENT: "N" },
      });
    });
    const { result: rn, result_error: en } = Object.keys(cmdNegocios).length
      ? await batch(cmdNegocios)
      : { result: {}, result_error: {} };

    chunk.forEach((_l, i) => {
      const idx = offset + i;
      const contatoId = rc[`c${i}`] as string | undefined;
      if (!contatoId) {
        out[idx] = { ok: false, motivo: ec[`c${i}`]?.error_description || "Falha ao criar contato" };
        return;
      }
      const negocioId = rn[`n${i}`] as string | undefined;
      if (!negocioId) {
        out[idx] = { ok: false, motivo: en[`n${i}`]?.error_description || "Falha ao criar negócio (contato criado)" };
        return;
      }
      out[idx] = { ok: true, contatoId: String(contatoId), negocioId: String(negocioId) };
    });
  }

  return out;
}
