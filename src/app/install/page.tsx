"use client";

// /install — página de instalação do app local no Bitrix. O admin abre 1x quando instala o app.
// Registra o placement LEFT_MENU (item do menu lateral apontando pra "/") e chama installFinish
// (sem isso o widget só aparece pra admin). Idempotente: re-rodar não quebra.

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { CheckCircle2, Loader2, AlertCircle } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const BX24: any;

type Estado = "iniciando" | "ok" | "erro";

export default function Install() {
  const [estado, setEstado] = useState<Estado>("iniciando");
  const [msg, setMsg] = useState("Registrando o aplicativo…");

  const instalar = useCallback(() => {
    try {
      if (typeof BX24 === "undefined") {
        setEstado("erro");
        setMsg("Abra esta página dentro do Bitrix (instalação do aplicativo).");
        return;
      }
      BX24.init(() => {
        BX24.callMethod(
          "placement.bind",
          {
            PLACEMENT: "LEFT_MENU",
            HANDLER: `${window.location.origin}/`,
            TITLE: "2ª via de boleto",
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (res: any) => {
            const err = res?.error?.();
            // Se já estava vinculado, o Bitrix retorna erro — tratamos como OK (idempotente).
            if (err && !String(err).toUpperCase().includes("EXIST") && !String(err).toUpperCase().includes("HANDLER_ALREADY")) {
              setEstado("erro");
              setMsg(`Não foi possível registrar o menu: ${err}`);
              return;
            }
            try { BX24.installFinish(); } catch {}
            setEstado("ok");
            setMsg("Aplicativo instalado. O item “2ª via de boleto” já aparece no menu lateral.");
          },
        );
      });
    } catch {
      setEstado("erro");
      setMsg("Falha ao inicializar o aplicativo no Bitrix.");
    }
  }, []);

  useEffect(() => { instalar(); }, [instalar]);

  return (
    <div className="min-h-screen">
      <header className="bg-primary flex justify-center items-center h-20 shadow-sm">
        <Image src="/logo.webp" alt="Loma" width={130} height={26} priority />
      </header>
      <main className="container mx-auto px-4 py-12">
        <div className="max-w-md mx-auto bg-white rounded-2xl shadow-sm p-8 text-center">
          {estado === "iniciando" && <Loader2 className="w-10 h-10 text-primary animate-spin mx-auto" />}
          {estado === "ok" && <CheckCircle2 className="w-10 h-10 text-green mx-auto" />}
          {estado === "erro" && <AlertCircle className="w-10 h-10 text-red mx-auto" />}
          <h1 className="text-xl font-bold text-graphite mt-4">2ª via de boleto</h1>
          <p className="text-sm text-gray-text mt-2">{msg}</p>
          {estado === "erro" && (
            <button
              onClick={instalar}
              className="mt-5 py-3 px-6 rounded-xl font-bold text-white bg-primary hover:bg-black transition-all text-sm uppercase tracking-wider"
            >
              Tentar novamente
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
