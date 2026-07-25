// backfill-situacao-historico.mjs — roda UMA VEZ, LOCAL (não é parte do runtime do app; sem limite
// de tempo do Vercel). Popula os últimos 12 meses de mudança de situação do associado no Supabase
// (situacao_historico + situacao_catalogo), pra alimentar a feature "INADIMPLENTE desde DD/MM/AAAA".
//
// Depois do backfill, o cron diário (/api/cron/sync-situacao) mantém isso atualizado sozinho —
// custo fixo (~1-2 chamadas/dia na Hinova), independente de quantas consultas os executivos fizerem.
//
// USO: node scripts/backfill-situacao-historico.mjs [dias]   (default 366)

import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import postgres from "postgres";

const ROOT = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1").replace(/\/scripts$/, "");
const envPath = path.join(ROOT, ".env.local");
const env = {};
for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const HOST = env.SGA_HOST.replace(/\/$/, "");
const DIAS = Number(process.argv[2] || 366);
const JANELA = 6; // dias por chamada (doc oficial: máx 7) — 6 pra margem de segurança
const PAUSA_MS = 300; // gentil com a API de produção compartilhada com o bot/cotação

if (!env.DATABASE_URL) throw new Error("DATABASE_URL ausente no .env.local");
const sql = postgres(env.DATABASE_URL, { prepare: false, ssl: "require" });

function hms(d) {
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let cachedToken = null;
async function auth() {
  if (cachedToken) return cachedToken;
  const res = await axios.post(
    `${HOST}/usuario/autenticar`,
    { usuario: env.SGA_USER, senha: env.SGA_PASSWORD },
    { headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.SGA_TOKEN}` } },
  );
  cachedToken = res.data.token_usuario;
  return cachedToken;
}

function asArray(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    if (Array.isArray(data.resultado)) return data.resultado;
    if (Array.isArray(data.data)) return data.data;
  }
  return [];
}

async function buscarJanela(token, dataInicial, dataFinal) {
  const res = await axios.post(
    `${HOST}/listar/alteracao-associados/`,
    { data_inicial: hms(dataInicial), data_final: hms(dataFinal), campos: ["codigo_situacao"] },
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, validateStatus: () => true },
  );
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
  return asArray(res.data);
}

async function catalogo(token) {
  const res = await axios.get(`${HOST}/listar/situacao/todos`, {
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });
  if (res.status !== 200) throw new Error(`catálogo HTTP ${res.status}`);
  return asArray(res.data);
}

async function main() {
  const token = await auth();
  console.log(`autenticado. backfill de ${DIAS} dias, janelas de ${JANELA} dias.`);

  // catálogo primeiro (pequeno, 1x)
  const cat = await catalogo(token);
  if (cat.length) {
    await sql`
      insert into situacao_catalogo ${sql(
        cat.map((c) => ({ codigo_situacao: String(c.codigo_situacao), descricao: String(c.descricao_situacao || c.descricao) })),
        "codigo_situacao",
        "descricao",
      )}
      on conflict (codigo_situacao) do update set descricao = excluded.descricao, sincronizado_em = now()
    `;
    console.log(`catálogo: ${cat.length} situações sincronizadas.`);
  }

  const hoje = new Date();
  let totalLidos = 0;
  let totalNovos = 0;
  let cursor = new Date(hoje);

  while ((hoje - cursor) / 864e5 < DIAS) {
    const fim = new Date(cursor);
    const inicio = new Date(fim.getTime() - JANELA * 864e5);
    const janelaRows = await buscarJanela(token, inicio, fim);

    if (janelaRows.length) {
      const rows = janelaRows
        .map((r) => {
          const codigoAlteracao = String(r.codigo_alteracao || "");
          const codigoAssociado = String(r.codigo_associado || "");
          const cpf = String(r.cpf_associado || "").replace(/\D/g, "");
          const valorPosterior = String(r.valor_posterior ?? "");
          if (!codigoAlteracao || !codigoAssociado || !cpf || !valorPosterior) return null;
          const dataAlt = String(r.data_alteracao || "").slice(0, 10);
          const hora = String(r.hora_alteracao || "00:00:00");
          return {
            codigo_alteracao: codigoAlteracao,
            codigo_associado: codigoAssociado,
            cpf,
            valor_anterior: r.valor_anterior != null ? String(r.valor_anterior) : null,
            valor_posterior: valorPosterior,
            data_alteracao: dataAlt ? `${dataAlt}T${hora}` : new Date().toISOString(),
          };
        })
        .filter(Boolean);

      if (rows.length) {
        const inseridos = await sql`
          insert into situacao_historico ${sql(
            rows,
            "codigo_alteracao",
            "codigo_associado",
            "cpf",
            "valor_anterior",
            "valor_posterior",
            "data_alteracao",
          )}
          on conflict (codigo_alteracao) do nothing
          returning id
        `;
        totalLidos += rows.length;
        totalNovos += inseridos.length;
      }
    }

    console.log(
      `[${hms(inicio)} -> ${hms(fim)}] lidos=${janelaRows.length} | acumulado: lidos=${totalLidos} novos=${totalNovos}`,
    );

    cursor = inicio;
    await sleep(PAUSA_MS);
  }

  console.log(`\nPRONTO. Total lido=${totalLidos}, novos inseridos=${totalNovos}.`);
  await sql.end();
}

main().catch(async (e) => {
  console.error("FALHA:", e.message);
  await sql.end();
  process.exit(1);
});
