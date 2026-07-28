// lider-auth.service.ts — gate de acesso da Importação de Leads: sessão Bitrix válida (mesmo padrão
// fail-closed do resto do app) + é "líder" (chefe de algum departamento comercial). Usado pelas 3
// rotas de /api/leads/*.

import { validarSessao, usuarioAtual, memberPermitido, type BitrixUser } from "@/lib/clients/bitrix";
import { listarChefesComerciais } from "@/lib/clients/bitrix-crm";

export type AuthInput = { access_token?: string; domain?: string; member_id?: string };

export type LiderAuthResultado =
  | { ok: true; user: BitrixUser }
  | { ok: false; status: number; erro: string };

const DEV_NO_AUTH = process.env.ALLOW_DEV_NO_AUTH === "1" && process.env.NODE_ENV !== "production";

export async function autenticarLider(auth: AuthInput | undefined): Promise<LiderAuthResultado> {
  const accessToken = auth?.access_token || "";
  const memberId = auth?.member_id || "";

  let user: BitrixUser | null;
  if (DEV_NO_AUTH && !accessToken) {
    user = { id: "dev-local", nome: "Dev Local (líder)", isAdmin: false };
  } else {
    if (!accessToken) return { ok: false, status: 401, erro: "sessão ausente" };
    if (!memberPermitido(memberId)) return { ok: false, status: 403, erro: "portal não autorizado" };
    const valido = await validarSessao(accessToken);
    if (!valido) return { ok: false, status: 401, erro: "sessão inválida" };
    user = await usuarioAtual(accessToken);
    if (!user) return { ok: false, status: 401, erro: "usuário não identificado" };
  }

  if (!DEV_NO_AUTH || accessToken) {
    const chefes = await listarChefesComerciais();
    if (!chefes.has(user.id)) return { ok: false, status: 403, erro: "acesso restrito a líderes comerciais" };
  }

  return { ok: true, user };
}
