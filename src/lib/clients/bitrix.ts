// bitrix.ts — validação de sessão do Bitrix (fail-closed) + checagem de admin. SERVER-ONLY.
//
// 🔒 PIN DE PORTAL (correção do gate 22/07): validamos SEMPRE contra o portal FIXADO no servidor
// (env BITRIX_PORTAL_DOMAIN), NUNCA contra o domínio que o navegador mandou. Assim, só um token
// válido DAQUELE portal passa — um token de qualquer outro portal Bitrix é rejeitado. Sem isso, o
// endpoint viraria porta aberta pra exfiltrar dado de associado.
//
// Refs oficiais: apidocs.bitrix24.com (app.info, user.admin, user.current).

import axios from "axios";

export type BitrixUser = { id: string; nome: string | null; isAdmin: boolean };

const PINNED_DOMAIN = (process.env.BITRIX_PORTAL_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
// member_id extra (opcional): se setado, exige que o member_id do request bata (defesa em profundidade).
const ALLOWED_MEMBER = process.env.BITRIX_ALLOWED_MEMBER_ID || "";

export function portalConfigurado(): boolean {
  return !!PINNED_DOMAIN;
}
export function memberPermitido(memberId: string): boolean {
  return !ALLOWED_MEMBER || String(memberId || "") === ALLOWED_MEMBER;
}

function restUrl(method: string): string {
  return `https://${PINNED_DOMAIN}/rest/${method}`;
}

/** Valida o access_token contra o portal FIXADO (fail-closed). true se válido. */
export async function validarSessao(accessToken: string): Promise<boolean> {
  if (!PINNED_DOMAIN || !accessToken) return false; // sem portal configurado = recusa
  try {
    const res = await axios.get(restUrl("app.info"), {
      params: { auth: accessToken },
      timeout: 10000,
      validateStatus: (s) => s === 200 || s === 401,
    });
    return res.status === 200 && !!res.data?.result;
  } catch {
    return false; // fail-closed
  }
}

/** Dados do usuário atual (pelo token) + se é admin. Sempre contra o portal fixado. */
export async function usuarioAtual(accessToken: string): Promise<BitrixUser | null> {
  if (!PINNED_DOMAIN || !accessToken) return null;
  try {
    const [cur, adm] = await Promise.all([
      axios.get(restUrl("user.current"), { params: { auth: accessToken }, timeout: 10000 }),
      axios.get(restUrl("user.admin"), { params: { auth: accessToken }, timeout: 10000, validateStatus: () => true }),
    ]);
    const u = cur.data?.result;
    if (!u?.ID) return null;
    const nome = [u.NAME, u.LAST_NAME].filter(Boolean).join(" ") || u.EMAIL || null;
    return { id: String(u.ID), nome, isAdmin: adm.data?.result === true };
  } catch {
    return null;
  }
}
