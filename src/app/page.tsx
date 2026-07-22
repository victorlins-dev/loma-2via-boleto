"use client";

// Painel do executivo — simples e direto: abre já identificado (sem login). Pesquisa por CPF, placa,
// ou os dois (basta um). Se vier só CPF com vários veículos, mostra um SELETOR de placa. Vê as 3
// últimas faturas, baixa o PDF ou copia a linha/PIX, e sai. Estética = app de cotação da Loma.

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Search, Download, Copy, Check, Loader2, AlertCircle, CreditCard, FileText, Car, ChevronRight, ShieldCheck, ShieldAlert, Wallet } from "lucide-react";

type Fatura = {
  nossoNumero: string | null;
  valor: string | null;
  vencimento: string | null;
  situacao: string | null;
  pago: boolean;
  linhaDigitavel: string | null;
  linkBoleto: string | null;
  pixCopiaCola: string | null;
};
type PlacaOpcao = { placa: string; modelo: string | null; situacao: string };
type SituacaoInfo = { associado: string | null; financeira: string | null };
type Resultado =
  | { result: "ok"; associadoNome: string | null; codigo: string | null; placa: string; modelo: string | null; situacao: SituacaoInfo; faturas: Fatura[] }
  | { result: "selecionar_placa"; associadoNome: string | null; codigo: string | null; veiculos: PlacaOpcao[] }
  | { result: "recorrente"; associadoNome: string | null; codigo: string | null; placa: string; situacao: SituacaoInfo; mensagem: string }
  | { result: "nao_encontrado"; motivo: "associado" | "placa" | "sem_faturas" };

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

function formatCpf(v: string) {
  const d = v.replace(/\D/g, "").slice(0, 11);
  return d
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
}

// Normaliza data pro padrão BR (DD/MM/AAAA), aceitando ISO (2026-05-10) ou já-BR (10/05/2026).
function fmtData(s: string | null): string {
  if (!s) return "—";
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[1]}/${br[2]}/${br[3]}`;
  return s;
}

// Copia texto de forma robusta — dentro do iframe do Bitrix o clipboard moderno costuma ser
// bloqueado, então caímos pro método antigo (textarea + execCommand), que funciona no iframe.
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* cai no fallback */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export default function Home() {
  const auth = useBitrixAuth();
  const [cpf, setCpf] = useState("");
  const [placa, setPlaca] = useState("");
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [res, setRes] = useState<Resultado | null>(null);
  const [copiado, setCopiado] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      if (typeof BX24 !== "undefined" && containerRef.current) {
        BX24.resizeWindow?.(containerRef.current.clientWidth, containerRef.current.scrollHeight);
      }
    } catch {}
  }, [res, erro, loading]);

  // placaOverride: quando o executivo escolhe uma placa no seletor.
  const consultar = useCallback(
    async (placaOverride?: string) => {
      setErro(null);
      const cpfDigits = cpf.replace(/\D/g, "");
      const placaUsar = (placaOverride ?? placa).trim();
      const temCpf = cpfDigits.length === 11;
      const temPlaca = placaUsar.length >= 5;
      if (!temCpf && !temPlaca) {
        setErro("Informe o CPF completo ou a placa.");
        return;
      }
      if (!placaOverride) {
        setRes(null);
        setCpf("");
        setPlaca(""); // zera os campos ao consultar (pedido do Victor)
      }
      setLoading(true);
      try {
        const r = await fetch("/api/consulta", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ auth, cpf: temCpf ? cpfDigits : "", placa: temPlaca ? placaUsar : "" }),
        });
        const data = await r.json();
        if (!r.ok) {
          setErro(data?.error || "Não foi possível consultar.");
          return;
        }
        setRes(data as Resultado);
      } catch {
        setErro("Falha de conexão. Tente novamente.");
      } finally {
        setLoading(false);
      }
    },
    [auth, cpf, placa],
  );

  const registrarAcao = useCallback(
    (action: string, target: string | null) => {
      try {
        fetch("/api/acao", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          keepalive: true,
          body: JSON.stringify({ auth, action, target, cpf: cpf.replace(/\D/g, ""), placa: placa.trim() }),
        });
      } catch {}
    },
    [auth, cpf, placa],
  );

  const copiar = useCallback(
    async (texto: string, id: string, action: string, target: string | null) => {
      const ok = await copyText(texto);
      if (ok) {
        setCopiado(id);
        setTimeout(() => setCopiado(null), 1800);
        registrarAcao(action, target);
      } else {
        setErro("Não consegui copiar automaticamente — selecione e copie manualmente.");
      }
    },
    [registrarAcao],
  );

  return (
    <div ref={containerRef} className="min-h-screen">
      <header className="bg-primary sticky top-0 z-50 flex justify-center items-center h-24 shadow-sm">
        <Image src="/logo.webp" alt="Loma" width={160} height={32} priority />
      </header>

      <main className="container mx-auto px-4 py-10">
        <div className="max-w-2xl mx-auto">
          <div className="mb-7">
            <p className="text-primary font-bold text-sm uppercase tracking-widest">2ª via de boleto</p>
            <h1 className="text-3xl font-black text-graphite">
              Consultar <span className="text-primary">fatura do associado</span>
            </h1>
            <p className="text-base text-gray mt-1.5">
              Informe o CPF, a placa, ou os dois. Você verá as 3 últimas faturas para baixar ou copiar.
            </p>
          </div>

          <div className="bg-white rounded-2xl shadow-sm p-7 space-y-5">
            <div>
              <label className="block text-sm font-bold uppercase tracking-wider text-gray mb-1.5">CPF</label>
              <input
                value={cpf}
                onChange={(e) => setCpf(formatCpf(e.target.value))}
                inputMode="numeric"
                placeholder="000.000.000-00"
                className="w-full p-4 bg-white rounded-2xl border-2 border-gray-light focus:border-primary outline-none shadow-sm text-lg transition-all"
              />
            </div>
            <div className="flex items-center gap-3 text-xs uppercase tracking-widest text-gray">
              <span className="flex-1 h-px bg-gray-light" /> e / ou <span className="flex-1 h-px bg-gray-light" />
            </div>
            <div>
              <label className="block text-sm font-bold uppercase tracking-wider text-gray mb-1.5">Placa</label>
              <input
                value={placa}
                onChange={(e) => setPlaca(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 7))}
                placeholder="ABC1D23"
                className="w-full p-4 bg-white rounded-2xl border-2 border-gray-light focus:border-primary outline-none shadow-sm text-lg tracking-widest transition-all"
              />
            </div>
            <button
              onClick={() => consultar()}
              disabled={loading}
              className="w-full py-4 rounded-xl font-bold text-white bg-primary hover:bg-black transition-all shadow-lg shadow-primary/20 flex justify-center items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed text-sm uppercase tracking-wider"
            >
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Search className="w-5 h-5" />}
              {loading ? "Consultando…" : "Consultar faturas"}
            </button>

            {erro && (
              <div className="flex items-center gap-2 text-red text-sm bg-red-soft/20 rounded-xl p-3">
                <AlertCircle className="w-4 h-4 shrink-0" /> {erro}
              </div>
            )}
          </div>

          {res && (
            <div className="mt-6 animate-fade-in space-y-3">
              {(res.result === "ok" || res.result === "recorrente") && (
                <SituacaoCard
                  nome={res.associadoNome}
                  placa={res.result === "ok" ? `${res.modelo ? `${res.modelo} · ` : ""}${res.placa}` : res.placa}
                  situacao={res.situacao}
                />
              )}

              {res.result === "selecionar_placa" && (
                <>
                  <div className="px-1">
                    <p className="font-semibold text-graphite">{res.associadoNome || "Associado"}</p>
                    <p className="text-sm text-gray">Escolha o veículo para ver as faturas:</p>
                  </div>
                  {res.veiculos.map((v) => (
                    <button
                      key={v.placa}
                      onClick={() => consultar(v.placa)}
                      disabled={loading}
                      className="w-full bg-white rounded-2xl shadow-sm p-4 flex items-center gap-3 hover:border-primary border-2 border-transparent transition-all text-left disabled:opacity-50"
                    >
                      <span className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                        <Car className="w-5 h-5 text-primary" />
                      </span>
                      <span className="flex-1">
                        <span className="block font-bold text-graphite">{v.placa}</span>
                        <span className="block text-sm text-gray">{v.modelo || "Veículo"}</span>
                      </span>
                      <ChevronRight className="w-5 h-5 text-gray" />
                    </button>
                  ))}
                </>
              )}

              {res.result === "ok" && (
                <>
                  {res.faturas.map((f, i) => (
                    <FaturaCard
                      key={f.nossoNumero || i}
                      f={f}
                      copiado={copiado}
                      onCopy={copiar}
                      onDownload={(url) => {
                        window.open(url, "_blank", "noopener");
                        registrarAcao("DOWNLOAD_PDF", res.codigo);
                      }}
                      target={res.codigo}
                    />
                  ))}
                </>
              )}

              {res.result === "recorrente" && (
                <div className="bg-white rounded-2xl shadow-sm p-5 flex gap-3">
                  <CreditCard className="w-5 h-5 text-secondary shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold text-graphite">Cobrança no cartão</p>
                    <p className="text-sm text-gray-text mt-1">{res.mensagem}</p>
                  </div>
                </div>
              )}

              {res.result === "nao_encontrado" && (
                <div className="bg-white rounded-2xl shadow-sm p-5 flex gap-3">
                  <AlertCircle className="w-5 h-5 text-gray shrink-0 mt-0.5" />
                  <p className="text-sm text-gray-text">
                    {res.motivo === "associado" && "Não encontramos um associado com esse CPF."}
                    {res.motivo === "placa" && "Não encontramos veículo/placa para essa busca."}
                    {res.motivo === "sem_faturas" && "Nenhuma fatura encontrada para essa placa."}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// Pílula de status: verde = bom (ativo/em dia), vermelho = atenção (inativo/inadimplente),
// cinza = desconhecido. Interpreta o texto cru que o SGA devolve.
function statusTom(texto: string | null, tipo: "associado" | "financeira"): "bom" | "ruim" | "neutro" {
  if (!texto) return "neutro";
  const t = texto.toUpperCase();
  if (tipo === "associado") return t.includes("ATIVO") && !t.includes("INATIVO") ? "bom" : "ruim";
  // financeira: inadimplente/atraso = ruim; em dia/adimplente/regular = bom.
  if (t.includes("INADIMPL") || t.includes("ATRAS") || t.includes("PENDEN")) return "ruim";
  if (t.includes("DIA") || t.includes("ADIMPL") || t.includes("REGULAR") || t.includes("QUITAD")) return "bom";
  return "neutro";
}

function SituacaoCard({
  nome,
  placa,
  situacao,
}: {
  nome: string | null;
  placa: string;
  situacao: SituacaoInfo;
}) {
  const tomAssoc = statusTom(situacao.associado, "associado");
  const tomFin = statusTom(situacao.financeira, "financeira");
  const cor = (tom: "bom" | "ruim" | "neutro") =>
    tom === "bom" ? "bg-green/15 text-green" : tom === "ruim" ? "bg-red/15 text-red" : "bg-gray-soft text-gray-text";
  return (
    <div className="bg-white rounded-2xl shadow-sm p-5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-bold text-graphite text-lg">{nome || "Associado"}</p>
        <p className="text-xs text-gray uppercase tracking-wider text-right shrink-0">{placa}</p>
      </div>
      {(situacao.associado || situacao.financeira) && (
        <div className="flex flex-wrap gap-2 mt-3">
          {situacao.associado && (
            <span className={`inline-flex items-center gap-1.5 text-sm font-semibold px-3 py-1.5 rounded-full ${cor(tomAssoc)}`}>
              {tomAssoc === "ruim" ? <ShieldAlert className="w-4 h-4" /> : <ShieldCheck className="w-4 h-4" />}
              {situacao.associado}
            </span>
          )}
          {situacao.financeira && (
            <span className={`inline-flex items-center gap-1.5 text-sm font-semibold px-3 py-1.5 rounded-full ${cor(tomFin)}`}>
              <Wallet className="w-4 h-4" />
              {situacao.financeira}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function FaturaCard({
  f,
  copiado,
  onCopy,
  onDownload,
  target,
}: {
  f: Fatura;
  copiado: string | null;
  onCopy: (texto: string, id: string, action: string, target: string | null) => void;
  onDownload: (url: string) => void;
  target: string | null;
}) {
  const id = f.nossoNumero || `${f.vencimento}`;
  const statusLabel = f.pago ? "Pago" : f.situacao || "Em aberto";
  const badge = f.pago ? "bg-green/15 text-green" : "bg-third/15 text-graphite";
  return (
    <div className="bg-white rounded-2xl shadow-sm p-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-gray uppercase tracking-wider">Vencimento</p>
          <p className="font-bold text-graphite text-xl">{fmtData(f.vencimento)}</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-gray uppercase tracking-wider">Valor</p>
          <p className="font-bold text-graphite text-xl">{f.valor ? `R$ ${f.valor}` : "—"}</p>
        </div>
      </div>
      {f.situacao && (
        <span className={`inline-block mt-3 text-xs font-semibold px-2.5 py-1 rounded-full ${badge}`}>{f.situacao}</span>
      )}
      <div className="flex gap-2 mt-4">
        {f.linkBoleto && (
          <button
            onClick={() => onDownload(f.linkBoleto!)}
            className="flex-1 py-3 rounded-xl font-bold text-white bg-primary hover:bg-black transition-all flex justify-center items-center gap-2 text-sm"
          >
            <Download className="w-4 h-4" /> PDF
          </button>
        )}
        {f.linhaDigitavel && (
          <button
            onClick={() => onCopy(f.linhaDigitavel!, `linha-${id}`, "COPIA_LINHA", target)}
            className="flex-1 py-3 rounded-xl font-bold text-gray-text bg-white border border-gray-light hover:bg-gray-soft transition-all flex justify-center items-center gap-2 text-sm"
          >
            {copiado === `linha-${id}` ? <Check className="w-4 h-4 text-green" /> : <Copy className="w-4 h-4" />}
            {copiado === `linha-${id}` ? "Copiado" : "Copiar código"}
          </button>
        )}
        {f.pixCopiaCola && (
          <button
            onClick={() => onCopy(f.pixCopiaCola!, `pix-${id}`, "COPIA_PIX", target)}
            className="flex-1 py-3 rounded-xl font-bold text-gray-text bg-white border border-gray-light hover:bg-gray-soft transition-all flex justify-center items-center gap-2 text-sm"
          >
            {copiado === `pix-${id}` ? <Check className="w-4 h-4 text-green" /> : <FileText className="w-4 h-4" />}
            {copiado === `pix-${id}` ? "Copiado" : "PIX"}
          </button>
        )}
      </div>
    </div>
  );
}
