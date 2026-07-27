// Client Supabase browser-side — usado SÓ na tela de login (/admin/login). O resto do painel
// nunca fala com o Supabase client direto; lê dado via nossas próprias API routes (Drizzle).
import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
