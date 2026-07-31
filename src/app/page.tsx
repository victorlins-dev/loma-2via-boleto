"use client";

// Painel do executivo — simples e direto: abre já identificado (sem login). Pesquisa por CPF, placa,
// ou os dois (basta um). Se vier só CPF com vários veículos, mostra um SELETOR de placa. Vê a fatura
// EM ABERTO em destaque no topo (sem clicar em nada) + as últimas pagas abaixo, baixa o PDF ou copia
// a linha/PIX, e sai. Estética = app de cotação da Loma.

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Search, Download, Copy, Check, Loader2, AlertCircle, CreditCard, FileText, Car, ChevronRight, ShieldCheck, ShieldAlert, Wallet, Siren, CalendarClock, CheckCircle2, ServerCrash } from "lucide-react";

type Fatura = {
  nossoNumero: string | null;
  valor: string | null;
  vencimento: string | null;
  emissao: string | null;
  situacao: string | null;
  pago: boolean;
  aberto: boolean;
  linhaDigitavel: string | null;
  linkBoleto: string | null;
  pixCopiaCola: string | null;
};
type PlacaOpcao = { placa: string; modelo: string | null; situacao: string };
type SituacaoInfo = {
  associado: string | null;
  financeira: string | null;
  notaAssociado?: string | null;
  notaFinanceira?: string | null;
};
type Evento = {
  protocolo: string | null;
  data: string | null;
  situacao: string | null;
  descricao: string | null;
  motivo: string | null;
  codigoSituacao: string | null;
};
type Resultado =
  | { result: "ok"; associadoNome: string | null; codigo: string | null; placa: string; modelo: string | null; situacao: SituacaoInfo; eventos: Evento[]; emAberto: Fatura[]; anteriores: Fatura[] }
  | { result: "selecionar_placa"; associadoNome: string | null; codigo: string | null; veiculos: PlacaOpcao[] }
  | { result: "recorrente"; associadoNome: string | null; codigo: string | null; placa: string; situacao: SituacaoInfo; eventos: Evento[]; mensagem: string }
  | { result: "nao_encontrado"; motivo: "associado" | "placa" | "sem_faturas"; associadoNome?: string | null; placa?: string; situacao?: SituacaoInfo; eventos?: Evento[] };

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

// Data (ISO ou BR) → timestamp local à meia-noite. 0 quando não dá pra ler.
function parseData(s: string | null): number {
  if (!s) return 0;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])).getTime();
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return new Date(Number(br[3]), Number(br[2]) - 1, Number(br[1])).getTime();
  return 0;
}

// Valor do SGA → padrão brasileiro. A Hinova responde tanto "120.10" (ponto decimal) quanto
// "1.234,56" (padrão BR, visto em valor_pagamento) — normaliza os dois e sempre imprime com vírgula.
function fmtValor(v: string | null): string {
  if (!v) return "—";
  const s = String(v).trim();
  const num = Number(s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, ""));
  if (!isFinite(num)) return s;
  return num.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Regra da cobrança (Amanda, reunião de 30/07/2026): "em aberto" pagável é até 15 dias após o
// vencimento. Passado isso o associado NÃO consegue mais pagar aquele boleto — a cobrança gera um
// link próprio (IUGU, fora do trilho que o SGA reconcilia).
// Decisão do Victor (31/07/2026): passado o prazo, a tela NÃO entrega mais linha digitável, PDF nem
// PIX — entregar código que não paga não tem sentido. No lugar, encaminha pra cobrança.
// Se o prazo real do banco for outro, é só mudar este número: a regra vive só aqui.
const DIAS_PAGAVEL_APOS_VENCIMENTO = 15;

// Texto do prazo de uma fatura em aberto. Separar "a vencer" de "vencida" é o que evita o executivo
// cobrar de quem ainda não está devendo: o boleto nasce no dia ~23 vencendo dia 10 do mês seguinte,
// então na maior parte do mês a fatura em aberto é uma fatura A VENCER, não um atraso.
function prazoVencimento(s: string | null): { texto: string; atrasada: boolean; diasAtraso: number } | null {
  const t = parseData(s);
  if (!t) return null;
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const dias = Math.round((t - hoje.getTime()) / 864e5);
  if (dias === 0) return { texto: "vence hoje", atrasada: false, diasAtraso: 0 };
  if (dias === 1) return { texto: "vence amanhã", atrasada: false, diasAtraso: 0 };
  if (dias > 1) return { texto: `a vencer em ${dias} dias`, atrasada: false, diasAtraso: 0 };
  const v = Math.abs(dias);
  return { texto: `vencida há ${v} ${v === 1 ? "dia" : "dias"}`, atrasada: true, diasAtraso: v };
}

// Rótulo de seção — mesma pegada do resto do app (caixa-alta, discreto).
function Rotulo({ texto }: { texto: string }) {
  return <p className="px-1 pt-2 text-xs font-bold uppercase tracking-widest text-gray">{texto}</p>;
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
  // Queda da Hinova é avisada com destaque próprio (pedido do Victor 31/07/2026: "o SGA cai muitas
  // vezes, SEMPRE que identificar que a Hinova caiu precisamos avisar"). Sem isso o executivo lê
  // "falha ao consultar" e acha que o app quebrou.
  const [quedaHinova, setQuedaHinova] = useState(false);
  const [res, setRes] = useState<Resultado | null>(null);
  const [copiado, setCopiado] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // O que foi REALMENTE buscado na última consulta — sobrevive à limpeza do formulário (abaixo),
  // pra auditoria de ações (baixar PDF/copiar) saber a que CPF/placa aquele resultado pertence.
  const [buscado, setBuscado] = useState({ cpf: "", placa: "" });

  useEffect(() => {
    try {
      if (typeof BX24 !== "undefined" && containerRef.current) {
        BX24.resizeWindow?.(containerRef.current.clientWidth, containerRef.current.scrollHeight);
      }
    } catch {}
  }, [res, erro, loading]);

  // placaOverride: quando o executivo escolhe uma placa no seletor.
  // cpfOverride: usado pelo "tentar de novo" da queda da Hinova — os campos são zerados depois de
  // consultar, então repetir a busca precisa dos valores guardados em `buscado`, não do estado.
  const consultar = useCallback(
    async (placaOverride?: string, cpfOverride?: string) => {
      setErro(null);
      setQuedaHinova(false);
      const cpfDigits = (cpfOverride ?? cpf).replace(/\D/g, "");
      const placaUsar = (placaOverride ?? placa).trim();
      const temCpf = cpfDigits.length === 11;
      const temPlaca = placaUsar.length >= 5;
      if (!temCpf && !temPlaca) {
        setErro("Informe o CPF completo ou a placa.");
        return;
      }
      setBuscado({ cpf: temCpf ? cpfDigits : "", placa: temPlaca ? placaUsar : "" });
      if (!placaOverride) {
        setRes(null);
        setCpf("");
        setPlaca(""); // zera os campos ao consultar (pedido do Victor)
      }
      setLoading(true);
      // Timeout no fetch: sem isso, se a conexão ficar pendurada (ex: resposta do servidor não chega
      // de volta ao navegador dentro do iframe do Bitrix), a tela trava em "Consultando..." pra sempre,
      // já que fetch() nativo não tem timeout próprio (achado 27/07 — caso placa FSR5550).
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000);
      try {
        const r = await fetch("/api/consulta", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ auth, cpf: temCpf ? cpfDigits : "", placa: temPlaca ? placaUsar : "" }),
          signal: controller.signal,
        });
        const data = await r.json();
        if (!r.ok) {
          if (data?.fonte === "hinova") setQuedaHinova(true);
          setErro(data?.error || "Não foi possível consultar.");
          return;
        }
        setRes(data as Resultado);
      } catch (err) {
        setErro(
          err instanceof DOMException && err.name === "AbortError"
            ? "A consulta demorou demais. Tente novamente."
            : "Falha de conexão. Tente novamente.",
        );
      } finally {
        clearTimeout(timeoutId);
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
          body: JSON.stringify({ auth, action, target, cpf: buscado.cpf, placa: buscado.placa }),
        });
      } catch {}
    },
    [auth, buscado],
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
        {/* Em px, então NÃO acompanha a base rem — reduzido junto com a escala da interface
            (31/07/2026), senão a logo ficava desproporcional no header. */}
        <Image src="/logo.webp" alt="Loma" width={128} height={26} priority />
      </header>

      <main className="container mx-auto px-4 py-10">
        <div className="max-w-2xl mx-auto">
          <div className="mb-7">
            <p className="text-primary font-bold text-sm uppercase tracking-widest">2ª via de boleto</p>
            <h1 className="text-3xl font-black text-graphite">
              Consultar <span className="text-primary">fatura do associado</span>
            </h1>
            <p className="text-base text-gray mt-1.5">
              Informe o CPF, a placa, ou os dois. Você verá a fatura em aberto e as últimas pagas, para baixar ou copiar.
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

            {erro && !quedaHinova && (
              <div className="flex items-center gap-2 text-red text-sm bg-red-soft/20 rounded-xl p-3">
                <AlertCircle className="w-4 h-4 shrink-0" /> {erro}
              </div>
            )}

            {/* Queda da Hinova: aviso próprio, dizendo de quem é a falha. O SGA cai com frequência e
                o executivo não pode achar que o app quebrou nem abrir chamado no lugar errado. */}
            {quedaHinova && (
              <div className="flex gap-3 items-start bg-third/10 border border-third/40 rounded-xl p-4">
                <ServerCrash className="w-5 h-5 text-third shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold text-graphite text-sm">Sistema da Hinova (SGA) fora do ar</p>
                  <p className="text-sm text-gray-text mt-1">
                    A consulta não foi respondida pelo sistema da Hinova. <span className="font-semibold">A falha é
                    lá, não no app.</span> Espere alguns segundos e consulte de novo — normalmente volta rápido.
                  </p>
                  <button
                    onClick={() => consultar(buscado.placa || undefined, buscado.cpf || undefined)}
                    disabled={loading}
                    className="mt-3 px-4 py-2 rounded-xl font-bold text-xs uppercase tracking-wider text-graphite bg-third/25 hover:bg-third/40 transition-all disabled:opacity-50"
                  >
                    Tentar de novo
                  </button>
                </div>
              </div>
            )}
          </div>

          {res && (
            <div className="mt-6 animate-fade-in space-y-3">
              {(res.result === "ok" || res.result === "recorrente" || (res.result === "nao_encontrado" && res.situacao)) && (
                <>
                  <SituacaoCard
                    nome={res.associadoNome ?? null}
                    placa={res.result === "ok" ? `${res.modelo ? `${res.modelo} · ` : ""}${res.placa}` : res.placa || ""}
                    situacao={res.situacao!}
                  />
                  <EventosCard eventos={res.eventos || []} />
                </>
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
                  {/* EM ABERTO primeiro e em destaque — sem precisar clicar em nada. É a pergunta
                      que o executivo tem na mão quando o associado liga: "tem boleto pra pagar?" */}
                  <Rotulo texto={res.emAberto.length > 1 ? "Faturas em aberto" : "Fatura em aberto"} />
                  {res.emAberto.length > 0 ? (
                    res.emAberto.map((f, i) => (
                      <FaturaCard
                        key={f.nossoNumero || `aberto-${i}`}
                        f={f}
                        destaque
                        copiado={copiado}
                        onCopy={copiar}
                        onDownload={(url) => {
                          window.open(url, "_blank", "noopener");
                          registrarAcao("DOWNLOAD_PDF", res.codigo);
                        }}
                        target={res.codigo}
                      />
                    ))
                  ) : (
                    <div className="bg-white rounded-2xl shadow-sm p-5 flex gap-3 items-start">
                      <CheckCircle2 className="w-5 h-5 text-green shrink-0 mt-0.5" />
                      <div>
                        <p className="font-bold text-graphite">Nenhuma fatura em aberto</p>
                        <p className="text-sm text-gray-text mt-0.5">Não há boleto a pagar neste veículo agora.</p>
                      </div>
                    </div>
                  )}

                  {res.anteriores.length > 0 && (
                    <>
                      <Rotulo texto="Faturas anteriores" />
                      {res.anteriores.map((f, i) => (
                        <FaturaCard
                          key={f.nossoNumero || `ant-${i}`}
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
                    {res.motivo === "sem_faturas" &&
                      (res.situacao
                        ? "Nenhum boleto encontrado no período consultável (a Hinova só permite consultar janelas recentes). Veja a situação acima."
                        : "Nenhuma fatura encontrada para essa placa.")}
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
        <div className="flex flex-wrap gap-x-8 gap-y-3 mt-3">
          {situacao.associado && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-gray uppercase tracking-wider">Situação do associado</span>
              <span className={`inline-flex items-center gap-1.5 text-sm font-semibold px-3 py-1.5 rounded-full w-fit ${cor(tomAssoc)}`}>
                {tomAssoc === "ruim" ? <ShieldAlert className="w-4 h-4" /> : <ShieldCheck className="w-4 h-4" />}
                {situacao.associado}
              </span>
              {situacao.notaAssociado && <span className="text-xs text-gray-text">{situacao.notaAssociado}</span>}
            </div>
          )}
          {situacao.financeira && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-gray uppercase tracking-wider">Situação financeira</span>
              <span className={`inline-flex items-center gap-1.5 text-sm font-semibold px-3 py-1.5 rounded-full w-fit ${cor(tomFin)}`}>
                <Wallet className="w-4 h-4" />
                {situacao.financeira}
              </span>
              {situacao.notaFinanceira && <span className="text-xs text-gray-text">{situacao.notaFinanceira}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Eventos EM ABERTO do veículo (sinistros/acionamentos) — pedido do Luan. Só consulta.
function EventosCard({ eventos }: { eventos: Evento[] }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm p-5">
      <div className="flex items-center gap-2 mb-3">
        <Siren className="w-4 h-4 text-secondary" />
        <span className="text-xs text-gray uppercase tracking-widest font-semibold">Eventos em aberto</span>
      </div>
      {eventos.length === 0 ? (
        <p className="text-sm text-gray">Nenhum evento em aberto para este veículo.</p>
      ) : (
        <div className="space-y-3">
          {eventos.map((e, i) => (
            <div key={e.protocolo || i} className="border border-gray-light rounded-xl p-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className="font-bold text-graphite">
                  {e.descricao || "Evento"}
                  {e.protocolo ? <span className="text-gray font-normal"> · nº {e.protocolo}</span> : null}
                </p>
                <p className="text-xs text-gray shrink-0">{fmtData(e.data)}</p>
              </div>
              {e.motivo && <p className="text-sm text-gray-text mt-0.5">{e.motivo}</p>}
              {e.situacao && (
                <span className="inline-block mt-2 text-xs font-semibold px-2.5 py-1 rounded-full bg-secondary/10 text-secondary">
                  {e.situacao}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FaturaCard({
  f,
  destaque = false,
  copiado,
  onCopy,
  onDownload,
  target,
}: {
  f: Fatura;
  destaque?: boolean;
  copiado: string | null;
  onCopy: (texto: string, id: string, action: string, target: string | null) => void;
  onDownload: (url: string) => void;
  target: string | null;
}) {
  const id = f.nossoNumero || `${f.vencimento}`;
  const badge = f.aberto ? "bg-third/15 text-graphite" : "bg-green/15 text-green";
  const prazo = f.aberto ? prazoVencimento(f.vencimento) : null;
  // Fatura em aberto que já passou do prazo: NÃO entrega meio de pagamento nenhum (PDF, linha ou
  // PIX). O associado não consegue pagar por ela — quem gera a cobrança é o setor de cobrança.
  const forcaCobranca = !!prazo && prazo.diasAtraso > DIAS_PAGAVEL_APOS_VENCIMENTO;
  return (
    <div
      className={
        destaque
          ? "bg-white rounded-2xl shadow-sm p-5 border-2 border-primary"
          : "bg-white rounded-2xl shadow-sm p-5"
      }
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-gray uppercase tracking-wider">Vencimento</p>
          <p className={`font-bold text-xl ${destaque ? "text-primary" : "text-graphite"}`}>{fmtData(f.vencimento)}</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-gray uppercase tracking-wider">Valor</p>
          <p className="font-bold text-graphite text-xl">{f.valor ? `R$ ${fmtValor(f.valor)}` : "—"}</p>
        </div>
      </div>
      {f.emissao && <p className="text-xs text-gray mt-1">Boleto gerado em {fmtData(f.emissao)}</p>}
      <div className="flex items-center gap-2 mt-3 flex-wrap">
        {f.situacao && (
          <span className={`inline-block text-xs font-semibold px-2.5 py-1 rounded-full ${badge}`}>{f.situacao}</span>
        )}
        {prazo && (
          <span className={`inline-flex items-center gap-1 text-xs font-semibold ${prazo.atrasada ? "text-red" : "text-gray-text"}`}>
            <CalendarClock className="w-3.5 h-3.5" /> {prazo.texto}
          </span>
        )}
      </div>
      {forcaCobranca && (
        <div className="mt-3 flex gap-2 items-start bg-third/10 rounded-xl p-3">
          <AlertCircle className="w-4 h-4 text-third shrink-0 mt-0.5" />
          <p className="text-xs text-gray-text">
            Fatura vencida há mais de {DIAS_PAGAVEL_APOS_VENCIMENTO} dias — <span className="font-semibold">não é
            mais possível pagar por este boleto</span>. Encaminhe o associado ao{" "}
            <span className="font-semibold">setor de cobrança</span>, que gera o link de pagamento.
          </p>
        </div>
      )}
      {/* Baixa do pagamento leva ATÉ 2 DIAS ÚTEIS (Loma, 31/07/2026): quem pagou ontem ainda aparece
          em aberto aqui e no SGA. Sem esse aviso o executivo diz pro associado que ele não pagou. */}
      {f.aberto && !forcaCobranca && (
        <p className="mt-3 text-xs text-gray">
          A baixa do pagamento leva até 2 dias úteis — se o associado já pagou nos últimos dias, é normal a
          fatura ainda aparecer em aberto.
        </p>
      )}
      <div className="flex gap-2 mt-4">
        {!forcaCobranca && f.linkBoleto && (
          <button
            onClick={() => onDownload(f.linkBoleto!)}
            className="flex-1 py-3 rounded-xl font-bold text-white bg-primary hover:bg-black transition-all flex justify-center items-center gap-2 text-sm"
          >
            <Download className="w-4 h-4" /> PDF
          </button>
        )}
        {!forcaCobranca && f.linhaDigitavel && (
          <button
            onClick={() => onCopy(f.linhaDigitavel!, `linha-${id}`, "COPIA_LINHA", target)}
            className="flex-1 py-3 rounded-xl font-bold text-gray-text bg-white border border-gray-light hover:bg-gray-soft transition-all flex justify-center items-center gap-2 text-sm"
          >
            {copiado === `linha-${id}` ? <Check className="w-4 h-4 text-green" /> : <Copy className="w-4 h-4" />}
            {copiado === `linha-${id}` ? "Copiado" : "Copiar código"}
          </button>
        )}
        {!forcaCobranca && f.pixCopiaCola && (
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
