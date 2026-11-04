-- Statistics: tabla de archivos cargados.
-- Pégalo completo en Supabase > SQL Editor > New query y pulsa Run.
-- El correo del administrador aparece 2 veces; cámbialo ahí si cambia el administrador.

create table if not exists public.archivos (
  id     uuid primary key default gen_random_uuid(),
  name   text   not null,
  r      jsonb  not null,
  orden  bigint not null,
  creado timestamptz not null default now()
);

alter table public.archivos enable row level security;

-- Cualquiera que abra el link puede ver los datos.
drop policy if exists "todos leen" on public.archivos;
create policy "todos leen" on public.archivos
  for select using (true);

-- Solo el administrador puede subir y eliminar.
drop policy if exists "admin sube" on public.archivos;
create policy "admin sube" on public.archivos
  for insert to authenticated
  with check ((auth.jwt() ->> 'email') = 'eduardojmr28@gmail.com');

drop policy if exists "admin elimina" on public.archivos;
create policy "admin elimina" on public.archivos
  for delete to authenticated
  using ((auth.jwt() ->> 'email') = 'eduardojmr28@gmail.com');

-- Para que los cambios aparezcan en vivo a quien tenga el tablero abierto.
do $$ begin
  alter publication supabase_realtime add table public.archivos;
exception when duplicate_object then null; end $$;
