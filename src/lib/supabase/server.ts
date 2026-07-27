// Client Supabase server-side, só pra Auth (sessão do painel /admin). As queries de dado do app
// continuam via Drizzle/postgres-js direto no DATABASE_URL — isso aqui NÃO troca a forma como
// lemos audit_consulta/situacao_historico, é só a peça de login.
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // chamado de um Server Component (sem permissão de escrever cookie) — o middleware/
            // layout já cuida de renovar a sessão quando necessário.
          }
        },
      },
    },
  );
}
