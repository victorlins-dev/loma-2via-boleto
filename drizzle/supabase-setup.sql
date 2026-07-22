-- supabase-setup.sql — rodar UMA VEZ no SQL Editor do Supabase (cria a tabela de auditoria).
-- Cria exatamente o que o app espera (src/lib/db/schema.ts). Não usa a Data API do Supabase
-- (o app conecta direto via Postgres). Multi-empresa NÃO se aplica na v1 (uma empresa só).

create table if not exists audit_consulta (
  id               bigint generated always as identity primary key,
  event_time       timestamptz not null default now(),
  actor_user_id    text not null,          -- id do usuário Bitrix (executivo)
  actor_nome       text,
  action           text not null,          -- CONSULTA_2A_VIA | DOWNLOAD_PDF | COPIA_LINHA | COPIA_PIX
  target           text,                   -- código do associado consultado
  query_param      text,                   -- CPF/placa MASCARADO (nunca em claro)
  result           text not null,          -- ok | negado | nao_encontrado | recorrente | erro
  records_returned integer,
  source_ip        text,
  session_id       text,
  user_agent       text,
  metadata         jsonb
);

-- BRIN em event_time: tabela append-only cresce em ordem de tempo → índice minúsculo e rápido p/ período.
create index if not exists audit_event_time_brin on audit_consulta using brin (event_time);
create index if not exists audit_actor_idx        on audit_consulta (actor_user_id, event_time);
create index if not exists audit_target_idx       on audit_consulta (target);

-- IMUTABILIDADE (append-only): bloqueia UPDATE e DELETE via trigger — vale pra qualquer role,
-- inclusive o da aplicação. O valor probatório vem de ninguém poder alterar/apagar o registro depois.
create or replace function audit_no_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'audit_consulta e append-only: UPDATE/DELETE bloqueados';
end;
$$;

drop trigger if exists audit_immutable on audit_consulta;
create trigger audit_immutable
  before update or delete on audit_consulta
  for each row execute function audit_no_mutation();
