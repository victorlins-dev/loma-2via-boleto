// GET /api/admin/metrics — KPIs do painel admin (só sessão Supabase válida).
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buscarMetricas } from "@/lib/db/metrics";

export const runtime = "nodejs";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "sessão ausente" }, { status: 401 });

  const metricas = await buscarMetricas();
  if (!metricas) return NextResponse.json({ semBanco: true });

  return NextResponse.json(metricas);
}
