"use client";

// /admin — painel de AUDITORIA (só admin). Mostra as últimas consultas: quem, quando, o quê (CPF/placa
// mascarados), resultado, ação. Filtros + export CSV — é o que o Victor mostra pro Leo/Luan.

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { Loader2, Download, Shield, RefreshCw } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const BX24: any;

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
};

export default function Admin() {
  const [auth, setAuth] = useState<{ access_token: string; member_id: string } | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [de, setDe] = useState("");
  const [ate, setAte] = useState("");
  const [result, setResult] = useState("");

  useEffect(() => {
    try {
      if (typeof BX24 !== "undefined") {
        BX24.init(() => {
          const a = BX24.getAuth();
          if (a) setAuth({ access_token: a.access_token, member_id: a.member_id });
        });
      }
    } catch {}
  }, []);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const r = await fetch("/api/admin/consultas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auth, filtros: { de: de || undefined, ate: ate || undefined, result: result || undefined } }),
      });
      const data = await r.json();
      if (!r.ok) {
        setErro(data?.error || "Não foi possível carregar.");
        setRows([]);
        return;
      }
      setRows(data.rows || []);
    } catch {
      setErro("Falha de conexão.");
    } finally {
      setLoading(false);
    }
  }, [auth, de, ate, result]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const exportCsv = useCallback(() => {
    if (!rows?.length) return;
    const head = ["data_hora", "usuario", "usuario_id", "acao", "resultado", "consulta", "associado", "faturas", "ip"];
    const linhas = rows.map((r) =>
      [
        new Date(r.eventTime).toLocaleString("pt-BR"),
        r.actorNome ?? "",
        r.actorUserId,
        ACAO_LABEL[r.action] ?? r.action,
        r.result,
        r.queryParam ?? "",
        r.target ?? "",
        r.recordsReturned ?? "",
        r.sourceIp ?? "",
      ]
        .map((c) => `"${String(c).replace(/"/g, '""')}"`)
        .join(";"),
    );
    const csv = [head.join(";"), ...linhas].join("\n");
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `auditoria-consultas-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [rows]);

  return (
    <div className="min-h-screen">
      <header className="bg-primary sticky top-0 z-50 flex justify-center items-center h-20 shadow-sm">
        <Image src="/logo.webp" alt="Loma" width={130} height={26} priority />
      </header>

      <main className="container mx-auto px-4 py-8">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center gap-2 mb-1">
            <Shield className="w-4 h-4 text-primary" />
            <p className="text-primary font-bold text-xs uppercase tracking-widest">Auditoria — acesso restrito</p>
          </div>
          <h1 className="text-2xl font-black text-graphite mb-5">Consultas de 2ª via</h1>

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
            <button onClick={carregar} disabled={loading} className="py-2.5 px-4 rounded-xl font-bold text-white bg-primary hover:bg-black transition-all flex items-center gap-2 text-sm">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Filtrar
            </button>
            <button onClick={exportCsv} disabled={!rows?.length} className="py-2.5 px-4 rounded-xl font-bold text-gray-text bg-white border border-gray-light hover:bg-gray-soft transition-all flex items-center gap-2 text-sm disabled:opacity-50 ml-auto">
              <Download className="w-4 h-4" /> Exportar CSV
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
                  <th className="p-3 font-semibold">Associado</th>
                  <th className="p-3 font-semibold">Result.</th>
                </tr>
              </thead>
              <tbody>
                {rows === null ? (
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
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${RESULT_BADGE[r.result] || "bg-gray-soft text-gray-text"}`}>{r.result}</span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}
