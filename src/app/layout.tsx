import type { Metadata } from "next";
import { Poppins } from "next/font/google";
import Script from "next/script";
import "./globals.css";

// Poppins de verdade (o app de cotação esqueceu de carregar — aqui não repetimos o erro).
const poppins = Poppins({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-poppins",
  display: "swap",
});

export const metadata: Metadata = {
  title: "2ª via de boleto — Loma",
  icons: { icon: "/favicon-32x32.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={poppins.variable}>
      <head>
        {/* SDK do Bitrix — dá a sessão do usuário logado SILENCIOSAMENTE (sem tela de login). */}
        <Script src="https://api.bitrix24.com/api/v1/" strategy="beforeInteractive" />
      </head>
      <body className="font-sans antialiased bg-gray-50 text-graphite">{children}</body>
    </html>
  );
}
