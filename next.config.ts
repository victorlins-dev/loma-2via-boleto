import type { NextConfig } from "next";

// ⚠️ GOTCHA (pesquisa oficial 22/07): o Bitrix embute o app num IFRAME no domínio do portal
// (*.bitrix24.com.br). Se mandarmos X-Frame-Options ou um CSP frame-ancestors que não inclua o
// Bitrix, o iframe fica BRANCO com HTTP 200 (erro só no console). Então:
//   - NUNCA setar X-Frame-Options aqui.
//   - CSP frame-ancestors liberando só os domínios Bitrix (via env, ajustável por portal).
const frameAncestors =
  process.env.BITRIX_FRAME_ANCESTORS ||
  "https://*.bitrix24.com.br https://*.bitrix24.com";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: `frame-ancestors 'self' ${frameAncestors};`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
