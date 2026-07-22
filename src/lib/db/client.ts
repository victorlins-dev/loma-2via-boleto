// client.ts — conexão Drizzle sobre Postgres (Supabase). SERVER-ONLY.
//
// ⚠️ Em serverless (Vercel) cada invocação pode abrir sua própria conexão → estoura o limite do
// Postgres. Por isso usamos SEMPRE a connection string do POOLER do Supabase (Supavisor, modo
// TRANSACTION, porta 6543) — e `prepare: false` (o pooler transaction não suporta prepared statements
// persistentes). Em DEV local sem DATABASE_URL, `db` fica null (auditoria vira best-effort).

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
export const hasDb = !!url;
// prepare:false = exigência do pooler transaction; ssl:"require" = o pooler do Supabase exige SSL.
const client = url ? postgres(url, { prepare: false, ssl: "require" }) : null;
export const db = client ? drizzle(client, { schema }) : null;
export { schema };
