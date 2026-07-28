"use client";

// Importação de Leads — só líderes comerciais. Cola nome+telefone (do Excel), gera prévia (marca
// duplicado por telefone), escolhe o executivo, confirma. Sempre cai em Comercial → Lista 300.

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { AlertCircle, Check, Loader2, Upload, Users } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const BX24: any;

function useBitrixAuth() {
  const [auth, setAuth] = useState<{ access_token: string; domain: string; member_id: string } | null>(null);
  useEffect(() => {
    try {
      if (typeof BX24 !== "undefined") {
        BX24.init(() => {
          const a = BX24.getAuth();
          if (a) setAuth({ access_token: a.access_token, domain: a.domain, member_id: a.member_id });
          try { BX24.fitWindow?.(); } catch {}
        });
      }
    } catch {
      /* fora do Bitrix (dev) — segue sem auth */
    }
  }, []);
  return auth;
}

const LIMITE_LINHAS = 200;

type Executivo = { id: string; nome: string };
type LinhaPreview =
  | { status: "ok"; nome: string; telefone: string }
  | { status: "duplicado"; nome: string; telefone: string }
  | { status: "invalido"; nome: string; telefone: string; motivo: string };

async function chamarApi<T>(url: string, body: unknown, signal: AbortSignal): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error || "Falha na requisição.");
  return data as T;
}

/** Cola do Excel = TAB entre colunas, quebra de linha entre linhas. */
function parseColado(texto: string): { nome: string; telefone: string }[] {
  return texto
    .split(/\r?\n/)
    .map((linha) => linha.split("\t"))
    .filter((cols) => cols.some((c) => c.trim()))
    .map((cols) => ({ nome: (cols[0] || "").trim(), telefone: (cols[1] || "").trim() }));
}

export default function ImportarLeadsPage() {
  const auth = useBitrixAuth();
  const [semAcesso, setSemAcesso] = useState(false);
  const [executivos, setExecutivos] = useState<Executivo[]>([]);
  const [executivoId, setExecutivoId] = useState("");
  const [colado, setColado] = useState("");
  const [preview, setPreview] = useState<LinhaPreview[] | null>(null);
  const [cortadas, setCortadas] = useState(0);
  const [marcadas, setMarcadas] = useState<boolean[]>([]);
  const [loading, setLoading] = useState<"preview" | "importar" | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [resumo, setResumo] = useState<{ criados: number; ignorados: number; erros: { nome: string; telefone: string; motivo: string }[] } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    chamarApi<{ executivos: Executivo[] }>("/api/leads/executivos", { auth }, controller.signal)
      .then((d) => setExecutivos(d.executivos))
      .catch((e) => {
        if (e instanceof Error && /restrito a líderes/i.test(e.message)) setSemAcesso(true);
        else setErro(e instanceof Error ? e.message : "Falha ao carregar executivos.");
      });
    return () => controller.abort();
  }, [auth]);

  const gerarPreview = useCallback(async () => {
    setErro(null);
    setResumo(null);
    const linhas = parseColado(colado);
    if (!linhas.length) {
      setErro("Cole ao menos uma linha (nome + TAB + telefone).");
      return;
    }
    const cortou = Math.max(0, linhas.length - LIMITE_LINHAS);
    const processadas = linhas.slice(0, LIMITE_LINHAS);
    setLoading("preview");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);
    try {
      const data = await chamarApi<{ preview: LinhaPreview[]; cortadas: number }>(
        "/api/leads/preview",
        { auth, linhas: processadas },
        controller.signal,
      );
      setPreview(data.preview);
      setCortadas(cortou);
      setMarcadas(data.preview.map((l) => l.status === "ok"));
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao gerar prévia.");
    } finally {
      clearTimeout(timeoutId);
      setLoading(null);
    }
  }, [auth, colado]);

  const confirmarImportacao = useCallback(async () => {
    if (!preview) return;
    if (!executivoId) {
      setErro("Escolha o executivo antes de confirmar.");
      return;
    }
    const selecionadas = preview.filter((_, i) => marcadas[i]).map((l) => ({ nome: l.nome, telefone: l.telefone }));
    if (!selecionadas.length) {
      setErro("Nenhuma linha marcada pra importar.");
      return;
    }
    setErro(null);
    setLoading("importar");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 55000);
    try {
      const data = await chamarApi<{ criados: number; ignorados: number; erros: { nome: string; telefone: string; motivo: string }[] }>(
        "/api/leads/importar",
        { auth, executivoId, linhas: selecionadas },
        controller.signal,
      );
      setResumo(data);
      setPreview(null);
      setColado("");
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao importar.");
    } finally {
      clearTimeout(timeoutId);
      setLoading(null);
    }
  }, [auth, executivoId, preview, marcadas]);

  const toggleMarcada = (i: number) => setMarcadas((prev) => prev.map((v, idx) => (idx === i ? !v : v)));

  if (semAcesso) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <div className="bg-white rounded-2xl shadow-sm p-7 max-w-md text-center">
          <AlertCircle className="w-8 h-8 text-gray mx-auto mb-3" />
          <p className="font-bold text-graphite">Acesso restrito</p>
          <p className="text-sm text-gray mt-1">Essa tela é só pra líderes comerciais.</p>
        </div>
      </div>
    );
  }

  const totalMarcadas = marcadas.filter(Boolean).length;

  return (
    <div className="min-h-screen">
      <header className="bg-primary sticky top-0 z-50 flex justify-center items-center h-24 shadow-sm">
        <Image src="/logo.webp" alt="Loma" width={160} height={32} priority />
      </header>

      <main className="container mx-auto px-4 py-10">
        <div className="max-w-2xl mx-auto space-y-5">
          <div>
            <p className="text-primary font-bold text-sm uppercase tracking-widest">Comercial</p>
            <h1 className="text-3xl font-black text-graphite">
              Importar <span className="text-primary">leads</span>
            </h1>
            <p className="text-base text-gray mt-1.5">
              Cole nome e telefone (2 colunas, direto do Excel). Cai sempre em Comercial → Lista 300, atribuído ao
              executivo escolhido. Limite de {LIMITE_LINHAS} linhas por importação.
            </p>
          </div>

          <div className="bg-white rounded-2xl shadow-sm p-7 space-y-5">
            <div>
              <label className="block text-sm font-bold uppercase tracking-wider text-gray mb-1.5">
                <Users className="w-4 h-4 inline mr-1 -mt-0.5" /> Vincular ao executivo
              </label>
              <select
                value={executivoId}
                onChange={(e) => setExecutivoId(e.target.value)}
                className="w-full p-4 bg-white rounded-2xl border-2 border-gray-light focus:border-primary outline-none shadow-sm text-lg"
              >
                <option value="">Selecione…</option>
                {executivos.map((ex) => (
                  <option key={ex.id} value={ex.id}>{ex.nome}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-bold uppercase tracking-wider text-gray mb-1.5">
                Nome + telefone (colar do Excel)
              </label>
              <textarea
                value={colado}
                onChange={(e) => setColado(e.target.value)}
                rows={8}
                placeholder={"João da Silva\t11999998888\nMaria Souza\t11988887777"}
                className="w-full p-4 bg-white rounded-2xl border-2 border-gray-light focus:border-primary outline-none shadow-sm font-mono text-sm"
              />
            </div>

            <button
              onClick={gerarPreview}
              disabled={loading !== null}
              className="w-full py-4 rounded-xl font-bold text-white bg-primary hover:bg-black transition-all shadow-lg shadow-primary/20 flex justify-center items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed text-sm uppercase tracking-wider"
            >
              {loading === "preview" ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
              {loading === "preview" ? "Gerando prévia…" : "Gerar prévia"}
            </button>

            {erro && (
              <div className="flex items-center gap-2 text-red text-sm bg-red-soft/20 rounded-xl p-3">
                <AlertCircle className="w-4 h-4 shrink-0" /> {erro}
              </div>
            )}
          </div>

          {cortadas > 0 && (
            <div className="flex items-center gap-2 text-secondary text-sm bg-secondary/10 rounded-xl p-3">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {cortadas} linha(s) além do limite de {LIMITE_LINHAS} foram cortadas.
            </div>
          )}

          {preview && (
            <div className="bg-white rounded-2xl shadow-sm p-5 space-y-3">
              <p className="text-sm font-semibold text-graphite">
                {totalMarcadas} de {preview.length} selecionadas
              </p>
              <div className="max-h-96 overflow-y-auto space-y-2">
                {preview.map((l, i) => (
                  <label
                    key={i}
                    className={`flex items-center gap-3 p-3 rounded-xl border ${
                      l.status === "invalido" ? "border-gray-light opacity-50" : "border-gray-light"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={marcadas[i] || false}
                      disabled={l.status === "invalido"}
                      onChange={() => toggleMarcada(i)}
                    />
                    <span className="flex-1">
                      <span className="block font-semibold text-graphite">{l.nome || "(sem nome)"}</span>
                      <span className="block text-xs text-gray">{l.telefone}</span>
                    </span>
                    {l.status === "ok" && <span className="text-xs font-semibold text-green">OK</span>}
                    {l.status === "duplicado" && (
                      <span className="text-xs font-semibold text-secondary">Já existe no CRM</span>
                    )}
                    {l.status === "invalido" && <span className="text-xs font-semibold text-red">{l.motivo}</span>}
                  </label>
                ))}
              </div>

              <button
                onClick={confirmarImportacao}
                disabled={loading !== null || totalMarcadas === 0}
                className="w-full py-4 rounded-xl font-bold text-white bg-primary hover:bg-black transition-all shadow-lg shadow-primary/20 flex justify-center items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed text-sm uppercase tracking-wider"
              >
                {loading === "importar" ? <Loader2 className="w-5 h-5 animate-spin" /> : <Check className="w-5 h-5" />}
                {loading === "importar" ? "Importando…" : `Confirmar importação (${totalMarcadas})`}
              </button>
            </div>
          )}

          {resumo && (
            <div className="bg-white rounded-2xl shadow-sm p-5 space-y-2">
              <p className="font-bold text-graphite">Importação concluída</p>
              <p className="text-sm text-gray-text">
                {resumo.criados} criado(s) · {resumo.ignorados} ignorado(s) (formato inválido) ·{" "}
                {resumo.erros.length} erro(s)
              </p>
              {resumo.erros.length > 0 && (
                <ul className="text-sm text-red space-y-1">
                  {resumo.erros.map((e, i) => (
                    <li key={i}>
                      {e.nome} ({e.telefone}): {e.motivo}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
