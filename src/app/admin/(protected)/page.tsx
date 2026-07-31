"use client";

// /admin — painel administrativo EXTERNO (fora do Bitrix, login próprio via Supabase Auth,
// checado no layout pai). Mostra quem de cada executivo usou o app de consulta, quando, quanto.
// KPIs + série diária + top executivos são derivados da audit_consulta (ver src/lib/db/metrics.ts);
// a tabela de baixo é a trilha crua com filtro + paginação por cursor + export Excel.

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Loader2, Download, Shield, RefreshCw, LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Row = {
  id: number;
  eventTime: string;
  actorUserId: string;
  actorNome: string | null;
  action: string;
  target: string | null;
  queryParam: string | null;
  result: string;
  recordsReturned: number | null;
  sourceIp: string | null;
  // `fonte: "hinova"` marca queda do SGA (ver resultadoDetalhado); `motivo` serve aos dois casos.
  metadata: { motivo?: string; fonte?: string } | null;
};

type Cursor = { eventTime: string; id: number } | null;

type Metricas = {
  totalHoje: number;
  total7d: number;
  total30d: number;
  taxaErro30d: number;
  topExecutivos: { actorUserId: string; actorNome: string | null; total: number }[];
  serieDiaria: { dia: string; total: number }[];
};

const ACAO_LABEL: Record<string, string> = {
  CONSULTA_2A_VIA: "Consulta",
  DOWNLOAD_PDF: "Baixou PDF",
  COPIA_LINHA: "Copiou código",
  COPIA_PIX: "Copiou PIX",
};
const RESULT_BADGE: Record<string, string> = {
  ok: "bg-green/15 text-green",
  recorrente: "bg-third/15 text-graphite",
  nao_encontrado: "bg-gray-soft text-gray-text",
  negado: "bg-red-soft/30 text-red",
  erro: "bg-red-soft/30 text-red",
  selecionar_placa: "bg-secondary/15 text-secondary",
};
const MOTIVO_LABEL: Record<string, string> = {
  associado: "CPF não localizado no cadastro",
  placa: "Associado sem veículo cadastrado",
  sem_faturas: "Sem boleto no período consultável",
};
function resultadoDetalhado(r: Pick<Row, "result" | "metadata">): string {
  // Queda da Hinova entra como `erro` (pra taxa de erro continuar certa) com a causa no metadata.
  // Mostrar isso aqui é o que permite medir a frequência das quedas do SGA sem abrir o banco.
  if (r.result === "erro" && r.metadata?.fonte === "hinova") {
    const MOTIVO: Record<string, string> = { "5xx": "erro no servidor", timeout: "não respondeu no prazo", rede: "conexão caiu" };
    const m = r.metadata?.motivo ? MOTIVO[String(r.metadata.motivo)] : null;
    return m ? `Hinova fora do ar (${m})` : "Hinova fora do ar";
  }
  if (r.result === "nao_encontrado") {
    const motivo = r.metadata?.motivo ? MOTIVO_LABEL[r.metadata.motivo] : null;
    return motivo ? `Não encontrado: ${motivo}` : "Não encontrado";
  }
  const LABEL: Record<string, string> = {
    ok: "Com fatura",
    recorrente: "Cartão recorrente",
    negado: "Negado",
    erro: "Erro",
    selecionar_placa: "Mais de 1 veículo — selecionar placa",
  };
  return LABEL[r.result] ?? r.result;
}

export default function AdminDashboard() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<Cursor>(null);
  const [temMais, setTemMais] = useState(false);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [de, setDe] = useState("");
  const [ate, setAte] = useState("");
  const [result, setResult] = useState("");

  const [metricas, setMetricas] = useState<Metricas | null>(null);

  useEffect(() => {
    fetch("/api/admin/metrics")
      .then((r) => r.json())
      .then((data) => {
        if (!data?.semBanco) setMetricas(data);
      })
      .catch(() => {});
  }, []);

  const carregar = useCallback(
    async (proximaPagina: boolean) => {
      setLoading(true);
      setErro(null);
      try {
        const r = await fetch("/api/admin/consultas", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filtros: { de: de || undefined, ate: ate || undefined, result: result || undefined },
            cursor: proximaPagina ? cursor : null,
          }),
        });
        const data = await r.json();
        if (!r.ok) {
          setErro(data?.error || "Não foi possível carregar.");
          if (!proximaPagina) setRows([]);
          return;
        }
        setRows((prev) => (proximaPagina ? [...prev, ...(data.rows || [])] : data.rows || []));
        setCursor(data.proximoCursor ?? null);
        setTemMais(Boolean(data.proximoCursor));
      } catch {
        setErro("Falha de conexão.");
      } finally {
        setLoading(false);
      }
    },
    [cursor, de, ate, result],
  );

  useEffect(() => {
    carregar(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [de, ate, result]);

  const exportExcel = useCallback(async () => {
    if (!rows.length) return;
    const XLSX = await import("xlsx");
    const dados = rows.map((r) => ({
      "Data/hora": new Date(r.eventTime).toLocaleString("pt-BR"),
      Executivo: r.actorNome ?? r.actorUserId,
      "ID do usuário": r.actorUserId,
      Ação: ACAO_LABEL[r.action] ?? r.action,
      Resultado: resultadoDetalhado(r),
      Consulta: r.queryParam ?? "",
      "ID Associado": r.target ?? "",
      Faturas: r.recordsReturned ?? "",
      IP: r.sourceIp ?? "",
    }));
    const planilha = XLSX.utils.json_to_sheet(dados);
    planilha["!cols"] = [
      { wch: 18 }, { wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 32 }, { wch: 22 }, { wch: 12 }, { wch: 9 }, { wch: 15 },
    ];
    const livro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(livro, planilha, "Auditoria");
    XLSX.writeFile(livro, `auditoria-consultas-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }, [rows]);

  const sair = useCallback(async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/admin/login");
    router.refresh();
  }, [router]);

  const maxSerie = metricas ? Math.max(1, ...metricas.serieDiaria.map((d) => d.total)) : 1;
  const maxExecutivo = metricas ? Math.max(1, ...metricas.topExecutivos.map((e) => e.total)) : 1;

  return (
    <div className="min-h-screen">
      <header className="bg-primary sticky top-0 z-50 flex justify-center items-center h-20 shadow-sm relative">
        <Image src="/logo.webp" alt="Loma" width={130} height={26} priority />
        <button
          onClick={sair}
          className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-1.5 text-white/90 hover:text-white text-sm font-medium"
        >
          <LogOut className="w-4 h-4" /> Sair
        </button>
      </header>

      <main className="container mx-auto px-4 py-8">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center gap-2 mb-1">
            <Shield className="w-4 h-4 text-primary" />
            <p className="text-primary font-bold text-xs uppercase tracking-widest">Auditoria — acesso restrito</p>
          </div>
          <h1 className="text-2xl font-black text-graphite mb-5">Consultas do App de Consulta do Associado</h1>

          {metricas && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                <div className="bg-white rounded-2xl shadow-sm p-4">
                  <p className="text-3xl font-black text-graphite tabular-nums">{metricas.totalHoje}</p>
                  <p className="text-xs font-bold uppercase tracking-wider text-gray mt-1">Hoje</p>
                </div>
                <div className="bg-white rounded-2xl shadow-sm p-4">
                  <p className="text-3xl font-black text-graphite tabular-nums">{metricas.total7d}</p>
                  <p className="text-xs font-bold uppercase tracking-wider text-gray mt-1">Últimos 7 dias</p>
                </div>
                <div className="bg-white rounded-2xl shadow-sm p-4">
                  <p className="text-3xl font-black text-graphite tabular-nums">{metricas.total30d}</p>
                  <p className="text-xs font-bold uppercase tracking-wider text-gray mt-1">Últimos 30 dias</p>
                </div>
                <div className="bg-white rounded-2xl shadow-sm p-4">
                  <p className={`text-3xl font-black tabular-nums ${metricas.taxaErro30d > 0.05 ? "text-red" : "text-graphite"}`}>
                    {(metricas.taxaErro30d * 100).toFixed(1)}%
                  </p>
                  <p className="text-xs font-bold uppercase tracking-wider text-gray mt-1">Taxa de erro (30d)</p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
                <div className="md:col-span-2 bg-white rounded-2xl shadow-sm p-4">
                  <p className="text-xs font-bold uppercase tracking-wider text-gray mb-3">Consultas por dia (30d)</p>
                  <div className="flex gap-[3px] h-32 pb-5">
                    {metricas.serieDiaria.map((d, i) => {
                      const [, mes, dia] = d.dia.split("-");
                      const dataCurta = `${dia}/${mes}`;
                      const mostrarData = i === 0 || i === metricas.serieDiaria.length - 1 || i % 5 === 0;
                      return (
                        <div key={d.dia} className="relative flex-1 h-full group">
                          <div
                            className="absolute bottom-0 left-0 w-full bg-primary/70 group-hover:bg-primary rounded-t-sm transition-colors"
                            style={{ height: `${Math.max(4, (d.total / maxSerie) * 100)}%` }}
                          />
                          <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 -top-8 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
                            <span className="rounded-md bg-graphite text-white text-[11px] font-semibold px-2 py-1 whitespace-nowrap shadow-sm">
                              {dataCurta} · {d.total}
                            </span>
                          </div>
                          {mostrarData && (
                            <span className="absolute -bottom-5 left-1/2 -translate-x-1/2 text-[9px] text-gray whitespace-nowrap">
                              {dataCurta}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="bg-white rounded-2xl shadow-sm p-4">
                  <p className="text-xs font-bold uppercase tracking-wider text-gray mb-3">Top executivos (30d)</p>
                  <div className="space-y-2">
                    {metricas.topExecutivos.length === 0 && <p className="text-sm text-gray">Sem dado no período.</p>}
                    {metricas.topExecutivos.map((e) => (
                      <div key={e.actorUserId}>
                        <div className="flex justify-between text-xs text-gray-text mb-0.5">
                          <span className="truncate">{e.actorNome || e.actorUserId}</span>
                          <span className="font-bold tabular-nums">{e.total}</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-gray-soft">
                          <div
                            className="h-1.5 rounded-full bg-primary"
                            style={{ width: `${(e.total / maxExecutivo) * 100}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}

          <div className="bg-white rounded-2xl shadow-sm p-4 flex flex-wrap items-end gap-3 mb-4">
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-gray mb-1">De</label>
              <input type="date" value={de} onChange={(e) => setDe(e.target.value)} className="p-2.5 rounded-xl border border-gray-light outline-none focus:border-primary" />
            </div>
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-gray mb-1">Até</label>
              <input type="date" value={ate} onChange={(e) => setAte(e.target.value)} className="p-2.5 rounded-xl border border-gray-light outline-none focus:border-primary" />
            </div>
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-gray mb-1">Resultado</label>
              <select value={result} onChange={(e) => setResult(e.target.value)} className="p-2.5 rounded-xl border border-gray-light outline-none focus:border-primary bg-white">
                <option value="">Todos</option>
                <option value="ok">Com fatura</option>
                <option value="recorrente">Cartão</option>
                <option value="nao_encontrado">Não encontrado</option>
                <option value="erro">Erro</option>
              </select>
            </div>
            <button onClick={() => carregar(false)} disabled={loading} className="py-2.5 px-4 rounded-xl font-bold text-white bg-primary hover:bg-black transition-all flex items-center gap-2 text-sm">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Filtrar
            </button>
            <button onClick={exportExcel} disabled={!rows.length} className="py-2.5 px-4 rounded-xl font-bold text-gray-text bg-white border border-gray-light hover:bg-gray-soft transition-all flex items-center gap-2 text-sm disabled:opacity-50 ml-auto">
              <Download className="w-4 h-4" /> Exportar Excel
            </button>
          </div>

          {erro && <div className="bg-red-soft/20 text-red rounded-xl p-3 text-sm mb-4">{erro}</div>}

          <div className="bg-white rounded-2xl shadow-sm overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray text-xs uppercase tracking-wider border-b border-gray-soft">
                  <th className="p-3 font-semibold">Data/hora</th>
                  <th className="p-3 font-semibold">Executivo</th>
                  <th className="p-3 font-semibold">Ação</th>
                  <th className="p-3 font-semibold">Consulta</th>
                  <th className="p-3 font-semibold">ID Associado</th>
                  <th className="p-3 font-semibold">Result.</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && loading ? (
                  <tr><td colSpan={6} className="p-6 text-center text-gray"><Loader2 className="w-5 h-5 animate-spin inline" /></td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={6} className="p-6 text-center text-gray">Nenhuma consulta no período.</td></tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r.id} className="border-b border-gray-soft/60">
                      <td className="p-3 whitespace-nowrap text-gray-text">{new Date(r.eventTime).toLocaleString("pt-BR")}</td>
                      <td className="p-3 text-graphite font-medium">{r.actorNome || r.actorUserId}</td>
                      <td className="p-3 text-gray-text">{ACAO_LABEL[r.action] ?? r.action}</td>
                      <td className="p-3 text-gray-text font-mono text-xs">{r.queryParam || "—"}</td>
                      <td className="p-3 text-gray-text">{r.target || "—"}</td>
                      <td className="p-3">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${RESULT_BADGE[r.result] || "bg-gray-soft text-gray-text"}`}>{resultadoDetalhado(r)}</span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            {temMais && (
              <div className="p-3 flex justify-center border-t border-gray-soft">
                <button
                  onClick={() => carregar(true)}
                  disabled={loading}
                  className="py-2 px-4 rounded-xl font-bold text-gray-text bg-white border border-gray-light hover:bg-gray-soft transition-all text-sm disabled:opacity-50"
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin inline" /> : "Carregar mais"}
                </button>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
