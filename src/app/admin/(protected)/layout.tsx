// Guard central do painel admin. Todo mundo que cair em /admin (exceto /admin/login, que fica
// FORA deste route group de propósito — senão vira loop de redirect) passa por aqui: sem sessão
// Supabase válida, volta pro login. Nenhuma página dentro de (protected) precisa reimplementar
// esse check.
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function ProtectedAdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/admin/login");

  return <>{children}</>;
}
