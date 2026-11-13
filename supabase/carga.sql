-- Statistics · carga diaria por sucursal. Tablas separadas del tablero: public.archivos no se toca.
-- Pégalo completo en Supabase > SQL Editor > New query y pulsa Run. Se puede ejecutar varias veces.
-- Para eliminar esta versión sin afectar al tablero: ver el bloque comentado al final.
-- Probado sin red con `npm run test:carga-rls` (Postgres dentro de Node).

-- ───────── 1. Configuración (una sola fila) ─────────
create table if not exists public.carga_config (
  id      boolean primary key default true check (id),
  inicio  text   not null default '2026-11' check (inicio ~ '^\d{4}-(0[1-9]|1[0-2])$'), -- primer mes que cargan las sucursales
  zona    text   not null default 'America/Caracas',                                     -- define qué día es "hoy"
  reabren text[] not null default '{admin}'                                              -- roles que reabren un mes
);
insert into public.carga_config (id) values (true) on conflict do nothing;

-- ───────── 2. Sucursales (lista fija; el id es el nombre de usuario) ─────────
create table if not exists public.carga_sucursales (
  id     text primary key check (id ~ '^[a-z0-9-]{2,40}$'),
  nombre text not null
);
insert into public.carga_sucursales (id, nombre) values
  ('av-bolivar','Av. Bolívar'),('boqueron','Boquerón'),('cocuizas','Cocuizas'),('cortijos','Cortijos'),
  ('ejercito','Ejército'),('express-chimborazo','Express Chimborazo'),('express-piar','Express Piar'),
  ('express-tipuro','Express Tipuro'),('floresta','Floresta'),('furrial','Furrial'),('gobernacion','Gobernación'),
  ('guaritos','Guaritos'),('hospital','Hospital'),('juncal','Juncal'),('la-cascada','La Cascada'),('la-cruz','La Cruz'),
  ('las-avenidas','Las Avenidas'),('las-brisas','Las Brisas'),('mercado','Mercado'),('paramaconi','Paramaconi'),
  ('parque-morichal','Parque Morichal'),('plaza-7','Plaza 7'),('poderoso-av-la-paz','Poderoso Av La Paz'),
  ('poderoso-hospital','Poderoso Hospital'),('poderoso-juncal','Poderoso Juncal'),('poderoso-tipuro','Poderoso Tipuro'),
  ('punta-de-mata','Punta De Mata'),('samanes','Samanes'),('servimas','Servimas'),('tipuro-palma-real','Tipuro Palma Real'),
  -- Canales que se miden como si fueran tiendas (mismas reglas que cualquier sucursal).
  ('call-center','Call Center'),('pagina-web','Página Web')
on conflict (id) do nothing;   -- al volver a ejecutar solo entran las que falten; las existentes no se tocan

-- ───────── 3. Usuarios de carga: rol y sucursal. Solo los escribe la service key. ─────────
create table if not exists public.carga_usuarios (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  usuario  text not null unique check (usuario ~ '^[a-z0-9-]{2,40}$'),
  rol      text not null check (rol in ('sucursal','gerencia','vicepresidencia','presidencia','admin')),
  sucursal text references public.carga_sucursales(id),
  creado   timestamptz not null default now(),
  check ((rol = 'sucursal') = (sucursal is not null))
);
create unique index if not exists carga_usuarios_sucursal_uq on public.carga_usuarios (sucursal) where sucursal is not null;

-- Quién soy, según el servidor. SECURITY DEFINER para que las políticas puedan leer carga_usuarios.
create or replace function public.carga_usuario() returns text language sql stable security definer set search_path = '' as
$$ select u.usuario from public.carga_usuarios u where u.user_id = (select auth.uid()) $$;
create or replace function public.carga_rol() returns text language sql stable security definer set search_path = '' as
$$ select u.rol from public.carga_usuarios u where u.user_id = (select auth.uid()) $$;
create or replace function public.carga_sucursal() returns text language sql stable security definer set search_path = '' as
$$ select u.sucursal from public.carga_usuarios u where u.user_id = (select auth.uid()) $$;
-- Dirección: los tres cargos que escriben metas. El admin NO está aquí.
create or replace function public.carga_es_direccion() returns boolean language sql stable security definer set search_path = '' as
$$ select coalesce(public.carga_rol() in ('gerencia','vicepresidencia','presidencia'), false) $$;
-- Quien lee todas las sucursales (incluidos Call Center y Página Web): dirección y admin.
create or replace function public.carga_lee_todo() returns boolean language sql stable security definer set search_path = '' as
$$ select coalesce(public.carga_rol() in ('gerencia','vicepresidencia','presidencia','admin'), false) $$;
create or replace function public.carga_hoy() returns date language sql stable security definer set search_path = '' as
$$ select (now() at time zone (select c.zona from public.carga_config c))::date $$;

-- ───────── 4. Cierres diarios ─────────
-- Los numéricos rechazan 'NaN' de forma explícita: en Postgres 'NaN' >= 0 es verdadero.
create table if not exists public.carga_cierres (
  sucursal text          not null references public.carga_sucursales(id),
  fecha    date          not null,
  farm     numeric(12,2) not null check (farm >= 0 and farm <> 'NaN'),
  misc     numeric(12,2) not null check (misc >= 0 and misc <> 'NaN'),
  cli      integer       not null check (cli  >= 0),
  fac      integer       not null check (fac  >= 0),
  unid     integer       not null check (unid >= 0),
  inc      integer       not null check (inc  >= 0),
  com      text          not null default '' check (char_length(com) <= 500),
  usuario  text          not null default 'sistema',   -- lo fija el servidor
  ts       timestamptz   not null default now(),       -- lo fija el servidor
  primary key (sucursal, fecha),
  -- Día sin operación: facturas en 0 solo si todo lo demás está en 0. Si hubo venta, facturas > 0.
  constraint carga_cierres_sin_operacion check (fac > 0 or (farm = 0 and misc = 0 and cli = 0 and unid = 0))
);
-- Fechas en un rango razonable: sin 'infinity', '-infinity' ni fechas antes de Cristo (to_char ignora la era).
-- Va aparte del create table para que también se agregue si la tabla ya existía.
do $$ begin
  alter table public.carga_cierres add constraint carga_cierres_fecha_rango
    check (fecha >= date '2020-01-01' and fecha < date '2100-01-01');
exception when duplicate_object then null; end $$;
-- Lo mismo con 'NaN', por si la tabla se creó con una versión anterior de este archivo.
do $$ begin
  alter table public.carga_cierres add constraint carga_cierres_sin_nan check (farm <> 'NaN' and misc <> 'NaN');
exception when duplicate_object then null; end $$;
create index if not exists carga_cierres_fecha_idx on public.carga_cierres (fecha, sucursal);

-- ───────── 5. Cierres de mes (solo se escriben con carga_cerrar_mes y carga_reabrir_mes) ─────────
create table if not exists public.carga_meses (
  sucursal      text        not null references public.carga_sucursales(id),
  mes           text        not null check (mes ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  cerrado       boolean     not null,
  analisis      text        not null default '' check (char_length(analisis) <= 2000),
  top           text[]      not null default '{}' check (coalesce(array_length(top, 1), 0) <= 5),
  sin_rot       text[]      not null default '{}' check (coalesce(array_length(sin_rot, 1), 0) <= 5),
  usuario       text        not null,
  ts            timestamptz not null default now(),
  reabierto_por text,
  reabierto_ts  timestamptz,
  primary key (sucursal, mes)
);

-- ───────── 6. Metas (una fila por mes y sucursal) ─────────
create table if not exists public.carga_metas (
  mes      text          not null check (mes ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  sucursal text          not null references public.carga_sucursales(id),
  meta     numeric(12,2) not null check (meta > 0 and meta <> 'NaN'),
  usuario  text          not null default 'sistema',
  ts       timestamptz   not null default now(),
  primary key (mes, sucursal)
);
do $$ begin
  alter table public.carga_metas add constraint carga_metas_sin_nan check (meta <> 'NaN');
exception when duplicate_object then null; end $$;

-- ───────── 7. Bitácora: qué cambió, quién y cuándo (solo se agrega) ─────────
create table if not exists public.carga_bitacora (
  id       bigint generated always as identity primary key,
  tabla    text not null,
  op       text not null,
  sucursal text,
  antes    jsonb,
  despues  jsonb,
  usuario  text not null,
  ts       timestamptz not null default now()
);
create index if not exists carga_bitacora_ts_idx on public.carga_bitacora (ts desc);

-- ───────── 8. Reglas en el servidor ─────────
-- Cierres: solo la sucursal dueña; no se cambia la clave, no se escribe en mes cerrado,
-- ni en días futuros, ni antes del inicio, ni sin meta.
create or replace function public.carga_cierres_antes() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_mes text;
begin
  -- Desde la app, la identidad va primero: así nadie averigua el estado de otra sucursal por el mensaje de error.
  if (select auth.uid()) is not null
     and (public.carga_rol() is distinct from 'sucursal' or new.sucursal is distinct from public.carga_sucursal()) then
    raise exception 'CARGA_SIN_PERMISO: solo la sucursal carga sus cierres' using errcode = '42501';
  end if;
  -- Mismo control que la restricción carga_cierres_fecha_rango, pero antes de usar la fecha:
  -- to_char da null con 'infinity' y '-infinity' y no distingue la era, y eso saltaría los controles de abajo.
  if new.fecha is null or not (new.fecha >= date '2020-01-01' and new.fecha < date '2100-01-01') then
    raise exception using errcode = '23514', constraint = 'carga_cierres_fecha_rango',
      message = 'carga_cierres_fecha_rango: la fecha debe estar entre 2020-01-01 y 2099-12-31';
  end if;
  v_mes := to_char(new.fecha, 'YYYY-MM');
  if tg_op = 'UPDATE' and (new.sucursal <> old.sucursal or new.fecha <> old.fecha) then
    raise exception 'CARGA_CLAVE: no se puede cambiar la sucursal ni la fecha de un cierre';
  end if;
  -- mismo candado que el cierre de mes y que las metas: las operaciones simultáneas sobre un mes se ponen en fila
  perform pg_advisory_xact_lock(hashtext('carga:' || new.sucursal || ':' || v_mes));
  if exists (select 1 from public.carga_meses m where m.sucursal = new.sucursal and m.mes = v_mes and m.cerrado) then
    raise exception 'CARGA_MES_CERRADO: el mes % ya está cerrado', v_mes;
  end if;
  -- Guardar los mismos datos no es un cambio: no se vuelve a firmar y la bitácora no registra nada.
  if tg_op = 'UPDATE' and (new.farm, new.misc, new.cli, new.fac, new.unid, new.inc, new.com)
                          is not distinct from (old.farm, old.misc, old.cli, old.fac, old.unid, old.inc, old.com) then
    return old;
  end if;
  if new.fecha > public.carga_hoy() then
    raise exception 'CARGA_FECHA_FUTURA: no se puede cargar un día que no ha llegado';
  end if;
  if new.fecha < (select to_date(c.inicio || '-01', 'YYYY-MM-DD') from public.carga_config c) then
    raise exception 'CARGA_ANTES_DE_INICIO: ese mes es anterior al inicio de la carga';
  end if;
  if not exists (select 1 from public.carga_metas g where g.sucursal = new.sucursal and g.mes = v_mes) then
    raise exception 'CARGA_SIN_META: la sucursal no tiene meta cargada para %', v_mes;
  end if;
  if (select auth.uid()) is not null then        -- desde la app: el servidor firma; desde SQL Editor se respeta lo enviado
    new.usuario := public.carga_usuario();
    new.ts := now();
  end if;
  return new;
end $$;
drop trigger if exists carga_cierres_antes on public.carga_cierres;
create trigger carga_cierres_antes before insert or update on public.carga_cierres
  for each row execute function public.carga_cierres_antes();

-- Metas: solo la dirección; no se tocan en un mes cerrado; no se quitan si la sucursal ya tiene cierres en ese mes.
-- Guardar el mismo valor no cuenta como cambio (no falla ni vuelve a firmar), ni siquiera en un mes cerrado.
create or replace function public.carga_metas_antes() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_suc text; v_mes text; v_ini date;
begin
  if tg_op = 'DELETE' then v_suc := old.sucursal; v_mes := old.mes;
  else v_suc := new.sucursal; v_mes := new.mes; end if;
  if (select auth.uid()) is not null and not public.carga_es_direccion() then
    raise exception 'CARGA_SIN_PERMISO: solo gerencia general, vicepresidencia y presidencia cargan metas' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    if new.sucursal <> old.sucursal or new.mes <> old.mes then
      raise exception 'CARGA_CLAVE: no se puede cambiar el mes ni la sucursal de una meta';
    end if;
    if new.meta = old.meta then return old; end if;
  end if;
  -- Un INSERT .. ON CONFLICT dispara este trigger como INSERT antes de ver el conflicto:
  -- si la fila ya existe con el mismo valor, no es un cambio y no se revisa nada (pero se firma igual, abajo,
  -- por si un borrado simultáneo hace que el INSERT sí entre).
  if not (tg_op = 'INSERT' and exists (select 1 from public.carga_metas g
                                        where g.mes = v_mes and g.sucursal = v_suc and g.meta = new.meta)) then
    perform pg_advisory_xact_lock(hashtext('carga:' || v_suc || ':' || v_mes));
    if exists (select 1 from public.carga_meses m where m.sucursal = v_suc and m.mes = v_mes and m.cerrado) then
      raise exception 'CARGA_MES_CERRADO: el mes % ya está cerrado para esa sucursal', v_mes;
    end if;
    if tg_op = 'DELETE' then
      v_ini := to_date(v_mes || '-01', 'YYYY-MM-DD');
      if exists (select 1 from public.carga_cierres c
                  where c.sucursal = v_suc and c.fecha >= v_ini and c.fecha < (v_ini + interval '1 month')::date) then
        raise exception 'CARGA_META_EN_USO: la sucursal ya tiene cierres en %, no se puede quitar su meta', v_mes;
      end if;
      return old;
    end if;
  end if;
  if (select auth.uid()) is not null then
    new.usuario := public.carga_usuario();
    new.ts := now();
  end if;
  return new;
end $$;
drop trigger if exists carga_metas_antes on public.carga_metas;
create trigger carga_metas_antes before insert or update or delete on public.carga_metas
  for each row execute function public.carga_metas_antes();

create or replace function public.carga_bitacora_fn() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and to_jsonb(old) = to_jsonb(new) then return null; end if;   -- sin cambio, sin registro
  insert into public.carga_bitacora (tabla, op, sucursal, antes, despues, usuario)
  values (tg_table_name, tg_op,
          case when tg_op = 'DELETE' then old.sucursal else new.sucursal end,
          case when tg_op = 'INSERT' then null else to_jsonb(old) end,
          case when tg_op = 'DELETE' then null else to_jsonb(new) end,
          coalesce(public.carga_usuario(), 'sistema'));
  return null;
end $$;
drop trigger if exists carga_bitacora_cierres on public.carga_cierres;
create trigger carga_bitacora_cierres after insert or update or delete on public.carga_cierres
  for each row execute function public.carga_bitacora_fn();
drop trigger if exists carga_bitacora_meses on public.carga_meses;
create trigger carga_bitacora_meses after insert or update or delete on public.carga_meses
  for each row execute function public.carga_bitacora_fn();
drop trigger if exists carga_bitacora_metas on public.carga_metas;
create trigger carga_bitacora_metas after insert or update or delete on public.carga_metas
  for each row execute function public.carga_bitacora_fn();

-- Guardar las metas de un mes, todo o nada. p_metas = {"juncal": 200000, ...}: las sucursales que no vienen se quitan.
-- SECURITY INVOKER: se aplican el RLS y los triggers de carga_metas tal cual.
create or replace function public.carga_guardar_metas(p_mes text, p_metas jsonb)
returns setof public.carga_metas language plpgsql security invoker set search_path = '' as $$
begin
  if not public.carga_es_direccion() then
    raise exception 'CARGA_SIN_PERMISO: solo gerencia general, vicepresidencia y presidencia cargan metas' using errcode = '42501';
  end if;
  if p_mes is null or p_mes !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'CARGA_MES_INVALIDO: mes inválido'; end if;
  if p_metas is null or jsonb_typeof(p_metas) <> 'object' then raise exception 'CARGA_METAS_INVALIDAS: formato de metas inválido'; end if;
  perform pg_advisory_xact_lock(hashtext('carga:metas:' || p_mes));   -- dos guardados simultáneos del mismo mes, en fila
  delete from public.carga_metas m where m.mes = p_mes and not (p_metas ? m.sucursal);
  insert into public.carga_metas as m (mes, sucursal, meta)
  select p_mes, e.key, (e.value)::numeric from jsonb_each_text(p_metas) e
  on conflict (mes, sucursal) do update set meta = excluded.meta
    where m.meta is distinct from excluded.meta;
  return query select * from public.carga_metas m where m.mes = p_mes order by m.sucursal;
end $$;

-- Cerrar el mes: solo la sucursal, solo el suyo (no recibe la sucursal como parámetro).
create or replace function public.carga_cerrar_mes(p_mes text, p_analisis text, p_top text[] default '{}', p_sin_rot text[] default '{}')
returns public.carga_meses language plpgsql security definer set search_path = '' as $$
declare
  v_suc text := public.carga_sucursal();
  v_usr text := public.carga_usuario();
  v_inicio text; v_ini date; v_fin date; v_n integer;
  v_top text[]; v_rot text[]; v_row public.carga_meses;
begin
  if v_suc is null or public.carga_rol() is distinct from 'sucursal' then
    raise exception 'CARGA_SIN_PERMISO: solo la sucursal cierra su mes' using errcode = '42501';
  end if;
  if p_mes is null or p_mes !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'CARGA_MES_INVALIDO: mes inválido'; end if;
  if btrim(coalesce(p_analisis, '')) = '' then raise exception 'CARGA_FALTA_ANALISIS: falta el análisis del mes'; end if;
  select c.inicio into v_inicio from public.carga_config c;
  if p_mes < v_inicio then raise exception 'CARGA_ANTES_DE_INICIO: ese mes es anterior al inicio de la carga'; end if;
  v_ini := to_date(p_mes || '-01', 'YYYY-MM-DD');
  v_fin := (v_ini + interval '1 month')::date;                      -- primer día del mes siguiente
  if public.carga_hoy() < v_fin - 1 then raise exception 'CARGA_MES_SIN_TERMINAR: el mes todavía no termina'; end if;
  perform pg_advisory_xact_lock(hashtext('carga:' || v_suc || ':' || p_mes));
  if exists (select 1 from public.carga_meses m where m.sucursal = v_suc and m.mes = p_mes and m.cerrado) then
    raise exception 'CARGA_MES_CERRADO: el mes % ya está cerrado', p_mes;
  end if;
  if p_mes > v_inicio and not exists (select 1 from public.carga_meses m
       where m.sucursal = v_suc and m.mes = to_char(v_ini - 1, 'YYYY-MM') and m.cerrado) then
    raise exception 'CARGA_MES_ANTERIOR_ABIERTO: primero hay que cerrar el mes anterior';
  end if;
  -- los días sin operación (todo en cero) son filas como cualquier otra: cuentan como día cargado
  select count(*) into v_n from public.carga_cierres c where c.sucursal = v_suc and c.fecha >= v_ini and c.fecha < v_fin;
  if v_n <> (v_fin - v_ini) then
    raise exception 'CARGA_FALTAN_DIAS: hay % de % días cargados', v_n, (v_fin - v_ini);
  end if;
  select coalesce(array_agg(left(btrim(x), 120) order by o), '{}') into v_top
    from unnest(coalesce(p_top, '{}')) with ordinality as t(x, o) where btrim(x) <> '' and o <= 5;
  select coalesce(array_agg(left(btrim(x), 120) order by o), '{}') into v_rot
    from unnest(coalesce(p_sin_rot, '{}')) with ordinality as t(x, o) where btrim(x) <> '' and o <= 5;
  insert into public.carga_meses as m (sucursal, mes, cerrado, analisis, top, sin_rot, usuario, ts)
  values (v_suc, p_mes, true, left(btrim(p_analisis), 2000), v_top, v_rot, v_usr, now())
  on conflict (sucursal, mes) do update
    set cerrado = true, analisis = excluded.analisis, top = excluded.top, sin_rot = excluded.sin_rot,
        usuario = excluded.usuario, ts = excluded.ts
  returning m.* into v_row;
  return v_row;
end $$;

-- Reabrir: solo los roles de carga_config.reabren (por defecto, solo admin).
create or replace function public.carga_reabrir_mes(p_sucursal text, p_mes text)
returns public.carga_meses language plpgsql security definer set search_path = '' as $$
declare v_rol text := public.carga_rol(); v_row public.carga_meses;
begin
  if v_rol is null or not (v_rol = any (select unnest(c.reabren) from public.carga_config c)) then
    raise exception 'CARGA_SIN_PERMISO: tu usuario no puede reabrir meses' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('carga:' || p_sucursal || ':' || p_mes));
  update public.carga_meses m set cerrado = false, reabierto_por = public.carga_usuario(), reabierto_ts = now()
   where m.sucursal = p_sucursal and m.mes = p_mes and m.cerrado
  returning m.* into v_row;
  if not found then raise exception 'CARGA_NO_CERRADO: ese mes no está cerrado'; end if;
  return v_row;
end $$;

-- Lo que la página necesita al entrar, en una sola llamada. Devuelve null si la cuenta no es de carga.
create or replace function public.carga_contexto() returns json language sql stable security definer set search_path = '' as $$
  select json_build_object('usuario', u.usuario, 'rol', u.rol, 'sucursal', u.sucursal,
                           'hoy', public.carga_hoy(), 'inicio', c.inicio, 'reabren', c.reabren)
    from public.carga_usuarios u cross join public.carga_config c
   where u.user_id = (select auth.uid())
$$;

-- ───────── 9. Permisos ─────────
alter table public.carga_config     enable row level security;
alter table public.carga_sucursales enable row level security;
alter table public.carga_usuarios   enable row level security;
alter table public.carga_cierres    enable row level security;
alter table public.carga_meses      enable row level security;
alter table public.carga_metas      enable row level security;
alter table public.carga_bitacora   enable row level security;

revoke all on public.carga_config, public.carga_sucursales, public.carga_usuarios, public.carga_cierres,
              public.carga_meses, public.carga_metas, public.carga_bitacora from public, anon, authenticated;
grant select on public.carga_config, public.carga_sucursales, public.carga_usuarios,
                public.carga_meses, public.carga_bitacora to authenticated;
grant select, insert, update on public.carga_cierres to authenticated;
grant select, insert, update, delete on public.carga_metas to authenticated;

revoke all on function public.carga_usuario(), public.carga_rol(), public.carga_sucursal(), public.carga_es_direccion(),
  public.carga_lee_todo(), public.carga_hoy(), public.carga_contexto(), public.carga_guardar_metas(text, jsonb),
  public.carga_cerrar_mes(text, text, text[], text[]), public.carga_reabrir_mes(text, text) from public, anon;
grant execute on function public.carga_usuario(), public.carga_rol(), public.carga_sucursal(), public.carga_es_direccion(),
  public.carga_lee_todo(), public.carga_hoy(), public.carga_contexto(), public.carga_guardar_metas(text, jsonb),
  public.carga_cerrar_mes(text, text, text[], text[]), public.carga_reabrir_mes(text, text) to authenticated;
revoke all on function public.carga_cierres_antes(), public.carga_metas_antes(), public.carga_bitacora_fn()
  from public, anon, authenticated;

drop policy if exists "carga: leo mi usuario" on public.carga_usuarios;
create policy "carga: leo mi usuario" on public.carga_usuarios for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "carga: usuarios leen config" on public.carga_config;
create policy "carga: usuarios leen config" on public.carga_config for select to authenticated
  using ((select public.carga_rol()) is not null);

drop policy if exists "carga: usuarios leen sucursales" on public.carga_sucursales;
create policy "carga: usuarios leen sucursales" on public.carga_sucursales for select to authenticated
  using ((select public.carga_rol()) is not null);

drop policy if exists "carga: leer cierres" on public.carga_cierres;
create policy "carga: leer cierres" on public.carga_cierres for select to authenticated
  using ((select public.carga_lee_todo()) or sucursal = (select public.carga_sucursal()));
drop policy if exists "carga: sucursal crea su cierre" on public.carga_cierres;
create policy "carga: sucursal crea su cierre" on public.carga_cierres for insert to authenticated
  with check ((select public.carga_rol()) = 'sucursal' and sucursal = (select public.carga_sucursal()));
drop policy if exists "carga: sucursal corrige su cierre" on public.carga_cierres;
create policy "carga: sucursal corrige su cierre" on public.carga_cierres for update to authenticated
  using      ((select public.carga_rol()) = 'sucursal' and sucursal = (select public.carga_sucursal()))
  with check ((select public.carga_rol()) = 'sucursal' and sucursal = (select public.carga_sucursal()));

drop policy if exists "carga: leer meses" on public.carga_meses;
create policy "carga: leer meses" on public.carga_meses for select to authenticated
  using ((select public.carga_lee_todo()) or sucursal = (select public.carga_sucursal()));

drop policy if exists "carga: leer metas" on public.carga_metas;
create policy "carga: leer metas" on public.carga_metas for select to authenticated
  using ((select public.carga_lee_todo()) or sucursal = (select public.carga_sucursal()));
drop policy if exists "carga: direccion crea metas" on public.carga_metas;
create policy "carga: direccion crea metas" on public.carga_metas for insert to authenticated
  with check ((select public.carga_es_direccion()));
drop policy if exists "carga: direccion cambia metas" on public.carga_metas;
create policy "carga: direccion cambia metas" on public.carga_metas for update to authenticated
  using ((select public.carga_es_direccion())) with check ((select public.carga_es_direccion()));
drop policy if exists "carga: direccion quita metas" on public.carga_metas;
create policy "carga: direccion quita metas" on public.carga_metas for delete to authenticated
  using ((select public.carga_es_direccion()));

drop policy if exists "carga: direccion lee bitacora" on public.carga_bitacora;
create policy "carga: direccion lee bitacora" on public.carga_bitacora for select to authenticated
  using ((select public.carga_lee_todo()));

-- ───────── 10. En vivo ─────────
do $$ begin alter publication supabase_realtime add table public.carga_cierres; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.carga_meses;   exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.carga_metas;   exception when duplicate_object then null; end $$;

-- ───────── Para eliminar la carga diaria sin tocar el tablero ─────────
-- drop table if exists public.carga_bitacora, public.carga_metas, public.carga_meses, public.carga_cierres,
--   public.carga_usuarios, public.carga_sucursales, public.carga_config cascade;
-- drop function if exists public.carga_usuario(), public.carga_rol(), public.carga_sucursal(), public.carga_es_direccion(),
--   public.carga_lee_todo(), public.carga_hoy(), public.carga_contexto(), public.carga_guardar_metas(text,jsonb),
--   public.carga_cerrar_mes(text,text,text[],text[]), public.carga_reabrir_mes(text,text),
--   public.carga_cierres_antes(), public.carga_metas_antes(), public.carga_bitacora_fn();
-- Y borrar los usuarios de carga en Authentication > Users (los que terminan en el dominio de carga).
