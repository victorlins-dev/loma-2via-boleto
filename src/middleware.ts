import { NextRequest, NextResponse } from "next/server";

// ⚠️ O Bitrix abre o handler do app e a página de instalação via POST (form-encoded), com o
// contexto (DOMAIN, APP_SID, LANG...) na query string. As páginas do Next respondem só a GET →
// o POST do Bitrix retornava 405 e a tela ficava EM BRANCO (erro real visto no console 22/07).
// Aqui convertemos esse POST num GET (303, preservando a query). A página então carrega e o
// front usa BX24.getAuth() pra pegar a sessão — não precisamos do corpo do POST.
export function middleware(request: NextRequest) {
  if (request.method === "POST") {
    return NextResponse.redirect(request.url, 303);
  }
  return NextResponse.next();
}

// Só o handler ("/") e a instalação ("/install") — as rotas /api/* ficam intactas (POST real).
export const config = { matcher: ["/", "/install"] };
