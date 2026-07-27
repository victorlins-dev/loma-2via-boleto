"use client";

// /admin/login — login do painel administrativo (fora do Bitrix). Email/senha via Supabase Auth
// (mesmo projeto que já hospeda o Postgres do app). Contas são criadas manualmente pelo Victor no
// painel do Supabase (Authentication → Users) — não existe cadastro próprio aqui de propósito.

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Loader2, Lock } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export default function AdminLogin() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErro(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password: senha });
    setLoading(false);
    if (error) {
      setErro("Email ou senha inválidos.");
      return;
    }
    router.push("/admin");
    router.refresh();
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-primary flex justify-center items-center h-20 shadow-sm">
        <Image src="/logo.webp" alt="Loma" width={130} height={26} priority />
      </header>

      <main className="flex-1 flex items-center justify-center px-4">
        <form onSubmit={entrar} className="w-full max-w-sm bg-white rounded-2xl shadow-sm p-7">
          <div className="flex items-center gap-2 mb-1">
            <Lock className="w-4 h-4 text-primary" />
            <p className="text-primary font-bold text-xs uppercase tracking-widest">Acesso restrito</p>
          </div>
          <h1 className="text-xl font-black text-graphite mb-6">Painel Admin</h1>

          <label className="block text-xs font-bold uppercase tracking-wider text-gray mb-1">Email</label>
          <input
            type="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full p-2.5 rounded-xl border border-gray-light outline-none focus:border-primary mb-4"
          />

          <label className="block text-xs font-bold uppercase tracking-wider text-gray mb-1">Senha</label>
          <input
            type="password"
            required
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            className="w-full p-2.5 rounded-xl border border-gray-light outline-none focus:border-primary mb-5"
          />

          {erro && <div className="bg-red-soft/20 text-red rounded-xl p-3 text-sm mb-4">{erro}</div>}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-xl font-bold text-white bg-primary hover:bg-black transition-all flex items-center justify-center gap-2 text-sm disabled:opacity-60"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />} Entrar
          </button>
        </form>
      </main>
    </div>
  );
}
