// Permisos de supabase/carga.sql sin red ni datos reales: Postgres dentro de Node (PGlite) con un preludio
// que imita Supabase (roles anon/authenticated/service_role, esquema auth, publicación supabase_realtime).
// Uso: npm run test:carga-rls
const fs = require('fs'), assert = require('assert'), { PGlite } = require('@electric-sql/pglite');
const raiz = __dirname + '/..';
const cargaSql = fs.readFileSync(raiz + '/supabase/carga.sql', 'utf8');
// La política de archivos usa el correo del administrador del tablero; en la prueba se cambia por uno ficticio.
const ADMIN_TABLERO = 'admin-tablero@ejemplo.invalid';
const setupSql = fs.readFileSync(raiz + '/supabase/setup.sql', 'utf8').replace(/'[^'\s]+@[^'\s]+'/g, `'${ADMIN_TABLERO}'`);

// Lo mínimo de Supabase que usa carga.sql (auth.uid y auth.jwt como en Supabase: leen los claims del JWT).
const PRELUDIO = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
grant usage on schema auth, public to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
-- Supabase da por defecto todo a los tres roles en lo que se crea en public: el SQL debe quitarlo él mismo.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create publication supabase_realtime;`;

const U = {}; // usuario -> { id, email }
const uid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const casos = [];
let db;

// Ejecuta una sentencia como un usuario (como PostgREST: rol + claims del JWT) y vuelve a superusuario.
async function como(quien, sql, params = []) {
  const u = quien === 'anon' ? null : U[quien];
  assert.ok(quien === 'anon' || u, 'usuario desconocido en la prueba: ' + quien);
  const claims = u ? JSON.stringify({ sub: u.id, email: u.email, role: 'authenticated' }) : JSON.stringify({ role: 'anon' });
  await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)`, [u ? u.id : '', claims]);
  await db.exec(u ? 'set role authenticated' : 'set role anon');
  try { return await db.query(sql, params); }
  finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claims', '', false)`); }
}
const filas = async (quien, sql, params) => (await como(quien, sql, params)).rows;
// Espera un rechazo; `esperado` es una expresión regular sobre "código mensaje".
async function rechaza(quien, sql, params, esperado) {
  let err = null;
  try { await como(quien, sql, params); } catch (e) { err = e; }
  assert.ok(err, `debió rechazarse (${quien}): ${sql}`);
  const txt = `${err.code} ${err.message}`;
  assert.match(txt, esperado, `error inesperado (${quien}): ${txt}`);
  return txt;
}
const su = async (sql, params) => (await db.query(sql, params)).rows;
async function caso(nombre, fn) { await fn(); casos.push(nombre); console.log('  ok', nombre); }

// Fechas en texto 'YYYY-MM-DD' / 'YYYY-MM', calculadas en UTC para no depender del reloj local.
const d = iso => new Date(iso + 'T00:00:00Z');
const iso = x => x.toISOString().slice(0, 10);
const sumaDias = (f, n) => iso(new Date(d(f).getTime() + n * 864e5));
const mesDe = f => f.slice(0, 7);
const mesMas = (m, n) => { const x = d(m + '-01'); x.setUTCMonth(x.getUTCMonth() + n); return iso(x).slice(0, 7); };
const diasDe = m => { const r = []; for (let f = m + '-01'; mesDe(f) === m; f = sumaDias(f, 1)) r.push(f); return r; };

const UPSERT_CIERRE = `insert into public.carga_cierres (sucursal, fecha, farm, misc, cli, fac, unid, inc, com)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  on conflict (sucursal, fecha) do update set farm = excluded.farm, misc = excluded.misc, cli = excluded.cli,
    fac = excluded.fac, unid = excluded.unid, inc = excluded.inc, com = excluded.com
  returning sucursal, fecha::text, farm::text, usuario, ts`;
const cierre = (suc, fecha, farm = 100, fac = 10) => [suc, fecha, farm, 50, 8, fac, 20, 0, ''];
const metas = (quien, mes, obj) => filas(quien, 'select mes, sucursal, meta::text, usuario from public.carga_guardar_metas($1, $2::jsonb)', [mes, JSON.stringify(obj)]);
const cerrar = (quien, mes, analisis = 'Mes normal') => filas(quien, `select sucursal, mes, cerrado, usuario, top from public.carga_cerrar_mes($1, $2, array['  Producto 1 ', '', 'Producto 2'], '{}')`, [mes, analisis]);
const contar = async (tabla, where = 'true', params = []) => +(await su(`select count(*)::int n from ${tabla} where ${where}`, params))[0].n;

const SIN_PERMISO = /42501|permission denied|row-level security|CARGA_SIN_PERMISO/;

(async () => {
  db = new PGlite();

  await caso('PGlite soporta set role, RLS y pg_advisory_xact_lock', async () => {
    await db.exec(`create role probe nologin; create table probe_t (o text); alter table probe_t enable row level security;
      create policy p on probe_t for select to probe using (o = 'si'); grant select on probe_t to probe;
      insert into probe_t values ('si'), ('no');`);
    await db.exec('set role probe');
    const r = await db.query('select current_user u, count(*)::int n from probe_t');
    await db.exec('reset role');
    assert.deepEqual(r.rows[0], { u: 'probe', n: 1 });
    await db.exec(`select pg_advisory_xact_lock(hashtext('x')); drop table probe_t; drop role probe;`);
  });

  await caso('preludio Supabase + setup.sql del tablero + carga.sql ejecutado dos veces (idempotente)', async () => {
    await db.exec(PRELUDIO);
    await db.exec(setupSql);
    await db.exec(cargaSql);
    const antes = await su(`select (select count(*)::int from pg_policies where tablename like 'carga_%') pol,
      (select count(*)::int from pg_trigger where tgname like 'carga_%') trg,
      (select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime') pub`);
    // tabla ya existente sin la restricción de rango (instalación anterior): la segunda pasada debe agregarla
    await db.exec('alter table public.carga_cierres drop constraint carga_cierres_fecha_rango');
    await db.exec(cargaSql);
    assert.equal(await contar('pg_constraint', `conname = 'carga_cierres_fecha_rango' and convalidated`), 1);
    const despues =await su(`select (select count(*)::int from pg_policies where tablename like 'carga_%') pol,
      (select count(*)::int from pg_trigger where tgname like 'carga_%') trg,
      (select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime') pub`);
    assert.deepEqual(despues, antes);
    assert.deepEqual(despues[0], { pol: 12, trg: 5, pub: 4 }); // archivos + carga_cierres, carga_meses, carga_metas
    assert.equal(await contar('public.carga_sucursales'), 32);
    assert.deepEqual(await su(`select id, nombre from public.carga_sucursales where id in ('call-center', 'pagina-web') order by id`),
      [{ id: 'call-center', nombre: 'Call Center' }, { id: 'pagina-web', nombre: 'Página Web' }]);
    assert.equal(await contar('public.carga_config'), 1);
    const cfg = (await su('select inicio, zona, reabren from public.carga_config'))[0];
    assert.deepEqual(cfg, { inicio: '2026-11', zona: 'America/Caracas', reabren: ['admin'] });
    const sinRls = await su(`select relname from pg_class where relname like 'carga\\_%' and relkind = 'r' and not relrowsecurity`);
    assert.deepEqual(sinRls, []);
  });

  // Usuarios ficticios. auth.users lo llena Supabase al crear la cuenta; carga_usuarios la escribe el script con la service key.
  const lista = [
    ['juncal', 'sucursal', 'juncal'], ['boqueron', 'sucursal', 'boqueron'], ['gerencia', 'gerencia', null],
    ['vicepresidencia', 'vicepresidencia', null], ['presidencia', 'presidencia', null], ['admin', 'admin', null],
    ['call-center', 'sucursal', 'call-center'],
  ];
  lista.forEach(([u], i) => { U[u] = { id: uid(i + 1), email: u + '@carga.invalid' }; });
  U.tablero = { id: uid(90), email: ADMIN_TABLERO };          // administrador del tablero: sin fila en carga_usuarios
  U.registro = { id: uid(91), email: 'nuevo@ejemplo.invalid' }; // cuenta creada por registro abierto
  for (const u of Object.values(U)) await su('insert into auth.users (id, email) values ($1, $2)', [u.id, u.email]);

  await caso('service_role crea las filas de carga_usuarios (lo que hace el script)', async () => {
    await db.exec('set role service_role');
    try {
      for (const [u, rol, suc] of lista) await db.query(
        `insert into public.carga_usuarios (user_id, usuario, rol, sucursal) values ($1, $2, $3, $4)
         on conflict (user_id) do update set usuario = excluded.usuario, rol = excluded.rol, sucursal = excluded.sucursal`,
        [U[u].id, u, rol, suc]);
    } finally { await db.exec('reset role'); }
    assert.equal(await contar('public.carga_usuarios'), 7);
  });

  // Fechas de la prueba, relativas al "hoy" del servidor: M2 y M1 terminados, M0 en curso.
  // "hoy" en Caracas antes y después de la consulta: si justo cambia el día, cualquiera de los dos es válido.
  const fechaCaracas = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas' }).format(new Date());
  const hoyAntes = fechaCaracas();
  const hoy = (await su('select public.carga_hoy()::text h'))[0].h;
  const hoyDespues = fechaCaracas();
  const M0 = mesDe(hoy), M1 = mesMas(M0, -1), M2 = mesMas(M0, -2), M3 = mesMas(M0, -3), MSIG = mesMas(M0, 1);
  await su('update public.carga_config set inicio = $1', [M2]);
  console.log(`  (hoy ${hoy}; inicio de la carga en la prueba ${M2})`);

  await caso('carga_hoy() es la fecha de Caracas', async () => assert.ok([hoyAntes, hoyDespues].includes(hoy), `${hoy} no es ${hoyAntes} ni ${hoyDespues}`));

  await caso('carga_contexto() de cada rol; null para cuentas sin fila', async () => {
    const ctx = async q => (await filas(q, 'select public.carga_contexto() c'))[0].c;
    assert.deepEqual(await ctx('juncal'), { usuario: 'juncal', rol: 'sucursal', sucursal: 'juncal', hoy, inicio: M2, reabren: ['admin'] });
    assert.equal((await ctx('admin')).rol, 'admin');
    assert.equal((await ctx('gerencia')).sucursal, null);
    assert.equal(await ctx('tablero'), null);
    assert.equal(await ctx('registro'), null);
  });

  // ───── Casos válidos: la dirección guarda metas ─────
  await caso('válido: gerencia, vicepresidencia y presidencia guardan metas con carga_guardar_metas', async () => {
    let r = await metas('gerencia', M2, { juncal: 1000 });
    assert.deepEqual(r, [{ mes: M2, sucursal: 'juncal', meta: '1000.00', usuario: 'gerencia' }]);
    await metas('gerencia', M1, { juncal: 1000, boqueron: 2000 });
    r = await metas('vicepresidencia', M0, { juncal: 1000, boqueron: 2500 });
    assert.equal(r.length, 2); assert.ok(r.every(x => x.usuario === 'vicepresidencia'));
    r = await metas('presidencia', M0, { juncal: 1000, boqueron: 2000 });
    assert.deepEqual(r.map(x => [x.sucursal, x.meta, x.usuario]), [['boqueron', '2000.00', 'presidencia'], ['juncal', '1000.00', 'vicepresidencia']]);
  });

  // ───── Casos válidos: la sucursal guarda, corrige y cierra ─────
  await caso('válido: la sucursal guarda los días de su mes, incluido un día sin operación (todo en 0)', async () => {
    const dias = diasDe(M2);
    for (const f of dias) {
      const r = f === dias[3] ? await filas('juncal', UPSERT_CIERRE, ['juncal', f, 0, 0, 0, 0, 0, 0, 'Cerrado por inventario'])
                              : await filas('juncal', UPSERT_CIERRE, cierre('juncal', f));
      assert.equal(r[0].usuario, 'juncal');
    }
    assert.equal(await contar('public.carga_cierres', 'sucursal = $1 and fecha::text like $2', ['juncal', M2 + '%']), dias.length);
  });

  await caso('válido: la sucursal cierra su mes (el día en cero cuenta como cargado)', async () => {
    const r = await cerrar('juncal', M2);
    assert.deepEqual(r[0], { sucursal: 'juncal', mes: M2, cerrado: true, usuario: 'juncal', top: ['Producto 1', 'Producto 2'] });
  });

  await caso('válido: la sucursal guarda hoy y lo corrige con upsert de la misma clave', async () => {
    await filas('juncal', UPSERT_CIERRE, cierre('juncal', hoy));
    const r = await filas('juncal', UPSERT_CIERRE, cierre('juncal', hoy, 333));
    assert.equal(r[0].farm, '333.00');
    assert.equal(await contar('public.carga_cierres', 'sucursal = $1 and fecha = $2', ['juncal', hoy]), 1);
    assert.equal(await contar('public.carga_bitacora', `tabla = 'carga_cierres' and op = 'UPDATE' and usuario = 'juncal'`), 1);
    await filas('boqueron', UPSERT_CIERRE, cierre('boqueron', hoy));
  });

  // Mes cerrado de boqueron sin meta (solo posible desde el SQL Editor): sirve para el ataque 18 "crear meta en mes cerrado".
  await su(`insert into public.carga_meses (sucursal, mes, cerrado, analisis, usuario) values ('boqueron', $1, true, 'x', 'sistema')`, [M2]);

  // ───── Los 24 ataques de la sección 3 ─────
  await caso('1. sucursal A crea o corrige un cierre con sucursal B: rechazado', async () => {
    await rechaza('juncal', UPSERT_CIERRE, cierre('boqueron', hoy), SIN_PERMISO);
    await rechaza('juncal', `update public.carga_cierres set sucursal = 'boqueron' where sucursal = 'juncal' and fecha = $1`, [hoy], SIN_PERMISO);
    const r = await filas('juncal', `update public.carga_cierres set farm = 1 where sucursal = 'boqueron' returning 1`);
    assert.equal(r.length, 0);
    assert.equal((await su(`select farm::text f from public.carga_cierres where sucursal = 'boqueron' and fecha = $1`, [hoy]))[0].f, '100.00');
  });

  await caso('2. sucursal A lee cierres, meses o metas de B: 0 filas (y no lee la bitácora)', async () => {
    for (const t of ['carga_cierres', 'carga_meses', 'carga_metas'])
      assert.equal((await filas('juncal', `select * from public.${t} where sucursal = 'boqueron'`)).length, 0, t);
    assert.ok((await filas('juncal', `select * from public.carga_cierres`)).every(x => x.sucursal === 'juncal'));
    assert.ok((await filas('juncal', `select * from public.carga_metas`)).length > 0);
    assert.equal((await filas('juncal', 'select * from public.carga_bitacora')).length, 0);
    assert.deepEqual((await filas('juncal', 'select usuario from public.carga_usuarios')).map(x => x.usuario), ['juncal']);
  });

  await caso('3. sucursal cambia su rol o su sucursal en carga_usuarios: sin permiso', async () => {
    await rechaza('juncal', `update public.carga_usuarios set rol = 'gerencia', sucursal = null`, [], /42501|permission denied/);
    await rechaza('juncal', `update public.carga_usuarios set sucursal = 'boqueron'`, [], /42501|permission denied/);
    await rechaza('juncal', `insert into public.carga_usuarios (user_id, usuario, rol) values ($1, 'x2', 'admin')`, [U.registro.id], /42501|permission denied/);
    await rechaza('juncal', `delete from public.carga_usuarios`, [], /42501|permission denied/);
    assert.equal((await su(`select rol from public.carga_usuarios where usuario = 'juncal'`))[0].rol, 'sucursal');
  });

  await caso('4. sucursal escribe en mes cerrado: CARGA_MES_CERRADO', async () => {
    await rechaza('juncal', UPSERT_CIERRE, cierre('juncal', M2 + '-02', 999), /CARGA_MES_CERRADO/);
    await rechaza('juncal', `update public.carga_cierres set farm = 999 where sucursal = 'juncal' and fecha = $1`, [M2 + '-02'], /CARGA_MES_CERRADO/);
  });

  await caso('5. sucursal mueve un cierre de fecha: CARGA_CLAVE', async () => {
    await rechaza('juncal', `update public.carga_cierres set fecha = fecha - 1 where sucursal = 'juncal' and fecha = $1`, [hoy], /CARGA_CLAVE/);
  });

  await caso('6. sucursal reabre su mes escribiendo en carga_meses o por la función: rechazado', async () => {
    await rechaza('juncal', `update public.carga_meses set cerrado = false`, [], /42501|permission denied/);
    await rechaza('juncal', `insert into public.carga_meses (sucursal, mes, cerrado, usuario) values ('juncal', $1, false, 'juncal')`, [M0], /42501|permission denied/);
    await rechaza('juncal', `delete from public.carga_meses`, [], /42501|permission denied/);
    await rechaza('juncal', 'select public.carga_reabrir_mes($1, $2)', ['juncal', M2], /CARGA_SIN_PERMISO/);
    assert.equal((await su(`select cerrado from public.carga_meses where sucursal = 'juncal' and mes = $1`, [M2]))[0].cerrado, true);
  });

  await caso('7. sucursal cierra el mes de otra: imposible, la función no recibe sucursal', async () => {
    const args = (await su(`select pg_get_function_arguments(p.oid) a from pg_proc p where p.proname = 'carga_cerrar_mes'`)).map(x => x.a);
    assert.equal(args.length, 1);
    assert.ok(!/sucursal/.test(args[0]), args[0]);
    await rechaza('juncal', `select public.carga_cerrar_mes('boqueron', $1)`, [M1], /CARGA_MES_INVALIDO/);
    await rechaza('juncal', `select public.carga_cerrar_mes(p_sucursal => 'boqueron', p_mes => $1, p_analisis => 'x')`, [M1], /42883|does not exist/);
    assert.equal(await contar('public.carga_meses', `sucursal = 'boqueron' and mes = $1`, [M1]), 0);
  });

  await caso('8. sucursal cierra con días faltantes o antes de fin de mes: CARGA_FALTAN_DIAS / CARGA_MES_SIN_TERMINAR', async () => {
    for (const f of diasDe(M1).slice(0, 3)) await filas('juncal', UPSERT_CIERRE, cierre('juncal', f));
    await rechaza('juncal', 'select public.carga_cerrar_mes($1, $2)', [M1, 'x'], /CARGA_FALTAN_DIAS: hay 3 de \d+ días/);
    await rechaza('juncal', 'select public.carga_cerrar_mes($1, $2)', [MSIG, 'x'], /CARGA_MES_SIN_TERMINAR/);
    await rechaza('juncal', 'select public.carga_cerrar_mes($1, $2)', [M1, '   '], /CARGA_FALTA_ANALISIS/);
    // y el mes anterior tiene que estar cerrado: se abre un momento el M2 de boqueron y boqueron intenta cerrar M1
    await su(`delete from public.carga_meses where sucursal = 'boqueron'`);
    await rechaza('boqueron', 'select public.carga_cerrar_mes($1, $2)', [M1, 'x'], /CARGA_MES_ANTERIOR_ABIERTO/);
    await su(`insert into public.carga_meses (sucursal, mes, cerrado, analisis, usuario) values ('boqueron', $1, true, 'x', 'sistema')`, [M2]);
    // completar M1 y cerrarlo (válido)
    for (const f of diasDe(M1).slice(3)) await filas('juncal', UPSERT_CIERRE, cierre('juncal', f));
    assert.equal((await cerrar('juncal', M1))[0].cerrado, true);
  });

  await caso('9. sucursal crea, cambia o borra metas, directo o con carga_guardar_metas: rechazado', async () => {
    await rechaza('juncal', `insert into public.carga_metas (mes, sucursal, meta) values ($1, 'juncal', 5)`, [MSIG], SIN_PERMISO);
    assert.equal((await filas('juncal', `update public.carga_metas set meta = 5 where sucursal = 'juncal' returning 1`)).length, 0);
    assert.equal((await filas('juncal', `delete from public.carga_metas where sucursal = 'juncal' returning 1`)).length, 0);
    await rechaza('juncal', 'select * from public.carga_guardar_metas($1, $2::jsonb)', [M0, '{"juncal":5}'], /CARGA_SIN_PERMISO/);
    assert.equal((await su(`select meta::text m from public.carga_metas where sucursal = 'juncal' and mes = $1`, [M0]))[0].m, '1000.00');
  });

  await caso('10. sucursal firma con otro usuario o ts: el servidor los sobrescribe', async () => {
    const f = sumaDias(hoy, -1) >= M0 + '-01' ? sumaDias(hoy, -1) : hoy;
    const r = await filas('juncal', `insert into public.carga_cierres (sucursal, fecha, farm, misc, cli, fac, unid, inc, usuario, ts)
      values ('juncal', $1, 10, 0, 1, 1, 1, 0, 'gerencia', '2000-01-01')
      on conflict (sucursal, fecha) do update set usuario = excluded.usuario, ts = excluded.ts returning usuario, ts`, [f]);
    assert.equal(r[0].usuario, 'juncal');
    assert.ok(new Date(r[0].ts).getUTCFullYear() >= 2026);
    const r2 = await filas('juncal', `update public.carga_cierres set usuario = 'presidencia', ts = '2000-01-01' where sucursal = 'juncal' and fecha = $1 returning usuario, ts`, [f]);
    assert.equal(r2[0].usuario, 'juncal');
    assert.ok(new Date(r2[0].ts).getUTCFullYear() >= 2026);
  });

  await caso('11. sucursal carga un día futuro o anterior al inicio: rechazado', async () => {
    await rechaza('juncal', UPSERT_CIERRE, cierre('juncal', sumaDias(hoy, 1)), /CARGA_FECHA_FUTURA/);
    await rechaza('juncal', UPSERT_CIERRE, cierre('juncal', M3 + '-15'), /CARGA_ANTES_DE_INICIO/);
    await rechaza('juncal', 'select public.carga_cerrar_mes($1, $2)', [M3, 'x'], /CARGA_ANTES_DE_INICIO/);
  });

  await caso('12. sucursal borra un cierre: sin permiso', async () => {
    await rechaza('juncal', `delete from public.carga_cierres where sucursal = 'juncal'`, [], /42501|permission denied/);
    assert.ok(await contar('public.carga_cierres', `sucursal = 'juncal'`) > 0);
  });

  await caso('13. sucursal guarda un cierre sin meta del mes: CARGA_SIN_META', async () => {
    await su(`delete from public.carga_meses where sucursal = 'boqueron'`); // M2 abierto para boqueron, sin meta
    await rechaza('boqueron', UPSERT_CIERRE, cierre('boqueron', M2 + '-10'), /CARGA_SIN_META/);
    await su(`insert into public.carga_meses (sucursal, mes, cerrado, analisis, usuario) values ('boqueron', $1, true, 'x', 'sistema')`, [M2]);
  });

  await caso('14. facturas 0 con venta, clientes o unidades: rechazado; NaN rechazado; todo en 0 aceptado', async () => {
    const f = hoy;
    await rechaza('juncal', UPSERT_CIERRE, ['juncal', f, 10, 0, 0, 0, 0, 0, ''], /23514.*carga_cierres_sin_operacion|carga_cierres_sin_operacion/);
    await rechaza('juncal', UPSERT_CIERRE, ['juncal', f, 0, 10, 0, 0, 0, 0, ''], /carga_cierres_sin_operacion/);
    await rechaza('juncal', UPSERT_CIERRE, ['juncal', f, 0, 0, 3, 0, 0, 0, ''], /carga_cierres_sin_operacion/);
    await rechaza('juncal', UPSERT_CIERRE, ['juncal', f, 0, 0, 0, 0, 4, 0, ''], /carga_cierres_sin_operacion/);
    await rechaza('juncal', UPSERT_CIERRE, ['juncal', f, -1, 0, 1, 1, 1, 0, ''], /23514/);
    await rechaza('juncal', UPSERT_CIERRE, ['juncal', f, 'NaN', 0, 1, 1, 1, 0, ''], /23514/);
    await rechaza('juncal', UPSERT_CIERRE, ['juncal', f, 1, 0, 1, 1, 1, 0, 'x'.repeat(501)], /23514/);
    const r = await filas('juncal', UPSERT_CIERRE, ['juncal', f, 0, 0, 0, 0, 0, 0, '']);
    assert.equal(r[0].farm, '0.00');
    // (el día en cero también contó para cerrar M2, ver "válido: la sucursal cierra su mes")
    await filas('juncal', UPSERT_CIERRE, cierre('juncal', f));
  });

  await caso('15. gerencia, vicepresidencia o presidencia reabren: CARGA_SIN_PERMISO', async () => {
    for (const q of ['gerencia', 'vicepresidencia', 'presidencia'])
      await rechaza(q, 'select public.carga_reabrir_mes($1, $2)', ['juncal', M1], /CARGA_SIN_PERMISO/);
  });

  await caso('16. dirección escribe cierres: rechazado', async () => {
    for (const q of ['gerencia', 'vicepresidencia', 'presidencia']) {
      await rechaza(q, UPSERT_CIERRE, cierre('juncal', hoy), SIN_PERMISO);
      assert.equal((await filas(q, `update public.carga_cierres set farm = 1 returning 1`)).length, 0);
      await rechaza(q, `delete from public.carga_cierres`, [], /42501|permission denied/);
      await rechaza(q, 'select public.carga_cerrar_mes($1, $2)', [M1, 'x'], /CARGA_SIN_PERMISO/);
    }
  });

  await caso('17. dirección quita la meta de una sucursal con cierres en ese mes: CARGA_META_EN_USO (todo o nada)', async () => {
    await rechaza('gerencia', 'select * from public.carga_guardar_metas($1, $2::jsonb)', [M0, '{"boqueron":7777}'], /CARGA_META_EN_USO/);
    assert.equal((await su(`select meta::text m from public.carga_metas where sucursal = 'boqueron' and mes = $1`, [M0]))[0].m, '2000.00');
    await rechaza('gerencia', `delete from public.carga_metas where sucursal = 'juncal' and mes = $1`, [M0], /CARGA_META_EN_USO/);
    assert.equal(await contar('public.carga_metas', `sucursal = 'juncal' and mes = $1`, [M0]), 1);
  });

  await caso('18. dirección crea, cambia o quita la meta de un mes cerrado: CARGA_MES_CERRADO; el mismo valor pasa sin registro', async () => {
    await rechaza('gerencia', 'select * from public.carga_guardar_metas($1, $2::jsonb)', [M1, '{"juncal":1500,"boqueron":2000}'], /CARGA_MES_CERRADO/);
    await rechaza('gerencia', `update public.carga_metas set meta = 1500 where sucursal = 'juncal' and mes = $1`, [M1], /CARGA_MES_CERRADO/);
    await rechaza('gerencia', `delete from public.carga_metas where sucursal = 'juncal' and mes = $1`, [M1], /CARGA_MES_CERRADO/);
    await rechaza('gerencia', 'select * from public.carga_guardar_metas($1, $2::jsonb)', [M2, '{"juncal":1000,"boqueron":10}'], /CARGA_MES_CERRADO/);
    await rechaza('gerencia', `insert into public.carga_metas (mes, sucursal, meta) values ($1, 'boqueron', 10)`, [M2], /CARGA_MES_CERRADO/);
    const bit = await contar('public.carga_bitacora');
    const r = await metas('gerencia', M1, { juncal: 1000, boqueron: 2000 });
    assert.equal(r.find(x => x.sucursal === 'juncal').usuario, 'gerencia');
    await metas('presidencia', M1, { juncal: '1000.00', boqueron: 2000 });
    await filas('vicepresidencia', `insert into public.carga_metas (mes, sucursal, meta) values ($1, 'juncal', 1000)
      on conflict (mes, sucursal) do update set meta = excluded.meta`, [M1]);
    await filas('vicepresidencia', `update public.carga_metas set meta = 1000 where sucursal = 'juncal' and mes = $1`, [M1]);
    assert.equal(await contar('public.carga_bitacora'), bit, 'guardar el mismo valor no debe registrar nada');
    assert.equal((await su(`select usuario from public.carga_metas where sucursal = 'juncal' and mes = $1`, [M1]))[0].usuario, 'gerencia');
    await rechaza('gerencia', 'select * from public.carga_guardar_metas($1, $2::jsonb)', [M0, '{"juncal":1000,"boqueron":"NaN"}'], /23514/);
    await rechaza('gerencia', 'select * from public.carga_guardar_metas($1, $2::jsonb)', [M0, '{"juncal":1000,"boqueron":0}'], /23514/);
    await rechaza('gerencia', 'select * from public.carga_guardar_metas($1, $2::jsonb)', [M0, '{"juncal":1000,"boqueron":2000,"no-existe":5}'], /23503/);
  });

  await caso('19. admin escribe metas (directo o por función) o cierres: rechazado', async () => {
    await rechaza('admin', 'select * from public.carga_guardar_metas($1, $2::jsonb)', [MSIG, '{"juncal":5}'], /CARGA_SIN_PERMISO/);
    await rechaza('admin', `insert into public.carga_metas (mes, sucursal, meta) values ($1, 'juncal', 5)`, [MSIG], SIN_PERMISO);
    assert.equal((await filas('admin', `update public.carga_metas set meta = 5 returning 1`)).length, 0);
    assert.equal((await filas('admin', `delete from public.carga_metas returning 1`)).length, 0);
    await rechaza('admin', UPSERT_CIERRE, cierre('juncal', hoy), SIN_PERMISO);
    assert.equal((await filas('admin', `update public.carga_cierres set farm = 1 returning 1`)).length, 0);
    await rechaza('admin', 'select public.carga_cerrar_mes($1, $2)', [M1, 'x'], /CARGA_SIN_PERMISO/);
    await rechaza('admin', `update public.carga_meses set cerrado = false`, [], /42501|permission denied/);
  });

  await caso('20. admin reabre: aceptado; después la dirección cambia esa meta y la sucursal corrige días', async () => {
    const r = await filas('admin', 'select * from public.carga_reabrir_mes($1, $2)', ['juncal', M1]);
    assert.equal(r[0].cerrado, false); assert.equal(r[0].reabierto_por, 'admin');
    await rechaza('admin', 'select public.carga_reabrir_mes($1, $2)', ['juncal', M1], /CARGA_NO_CERRADO/);
    const m = await metas('gerencia', M1, { juncal: 1500, boqueron: 2000 });
    assert.equal(m.find(x => x.sucursal === 'juncal').meta, '1500.00');
    const c = await filas('juncal', UPSERT_CIERRE, cierre('juncal', M1 + '-05', 444));
    assert.equal(c[0].farm, '444.00');
    const re = await cerrar('juncal', M1, 'Corregido');
    assert.equal(re[0].cerrado, true);
    assert.equal((await su(`select reabierto_por from public.carga_meses where sucursal = 'juncal' and mes = $1`, [M1]))[0].reabierto_por, 'admin');
  });

  await caso('21. admin lee las 32 sucursales, los cierres de todas y la bitácora: aceptado', async () => {
    assert.equal((await filas('admin', 'select * from public.carga_sucursales')).length, 32);
    const suc = new Set((await filas('admin', 'select sucursal from public.carga_cierres')).map(x => x.sucursal));
    assert.deepEqual([...suc].sort(), ['boqueron', 'juncal']);
    assert.equal((await filas('admin', 'select * from public.carga_cierres')).length, await contar('public.carga_cierres'));
    assert.equal((await filas('admin', 'select * from public.carga_meses')).length, await contar('public.carga_meses'));
    assert.equal((await filas('admin', 'select * from public.carga_metas')).length, await contar('public.carga_metas'));
    const bit = await filas('admin', 'select tabla, op, usuario from public.carga_bitacora');
    assert.equal(bit.length, await contar('public.carga_bitacora'));
    assert.ok(bit.some(x => x.tabla === 'carga_meses' && x.op === 'UPDATE' && x.usuario === 'admin'));
    for (const q of ['gerencia', 'vicepresidencia', 'presidencia'])
      assert.equal((await filas(q, 'select * from public.carga_bitacora')).length, bit.length);
  });

  await caso('22. administrador del tablero y cuenta de registro abierto: 0 filas y rechazo en carga_*', async () => {
    for (const q of ['tablero', 'registro']) {
      for (const t of ['carga_config', 'carga_sucursales', 'carga_usuarios', 'carga_cierres', 'carga_meses', 'carga_metas', 'carga_bitacora'])
        assert.equal((await filas(q, `select * from public.${t}`)).length, 0, `${q} lee ${t}`);
      await rechaza(q, UPSERT_CIERRE, cierre('juncal', hoy), SIN_PERMISO);
      await rechaza(q, `insert into public.carga_metas (mes, sucursal, meta) values ($1, 'juncal', 5)`, [MSIG], SIN_PERMISO);
      assert.equal((await filas(q, `update public.carga_metas set meta = 5 returning 1`)).length, 0);
      await rechaza(q, 'select * from public.carga_guardar_metas($1, $2::jsonb)', [MSIG, '{}'], /CARGA_SIN_PERMISO/);
      await rechaza(q, 'select public.carga_cerrar_mes($1, $2)', [M1, 'x'], /CARGA_SIN_PERMISO/);
      await rechaza(q, 'select public.carga_reabrir_mes($1, $2)', ['juncal', M1], /CARGA_SIN_PERMISO/);
      await rechaza(q, `insert into public.carga_usuarios (user_id, usuario, rol) values ($1, 'yo', 'admin')`, [U[q].id], /42501|permission denied/);
    }
  });

  await caso('23. anónimo con la anon key: nada', async () => {
    for (const t of ['carga_config', 'carga_sucursales', 'carga_usuarios', 'carga_cierres', 'carga_meses', 'carga_metas', 'carga_bitacora'])
      await rechaza('anon', `select * from public.${t}`, [], /42501|permission denied/);
    await rechaza('anon', UPSERT_CIERRE, cierre('juncal', hoy), /42501|permission denied/);
    for (const f of ['carga_usuario()', 'carga_rol()', 'carga_sucursal()', 'carga_es_direccion()', 'carga_lee_todo()', 'carga_hoy()', 'carga_contexto()',
                     `carga_guardar_metas('${M0}', '{}')`, `carga_cerrar_mes('${M1}', 'x')`, `carga_reabrir_mes('juncal', '${M1}')`])
      await rechaza('anon', `select public.${f}`, [], /42501|permission denied/);
  });

  await caso('24. usuario de carga (incluido admin) escribe en archivos: rechazado por la política existente', async () => {
    const ins = `insert into public.archivos (name, r, orden) values ('x.xls', '{}', 1)`;
    for (const q of ['juncal', 'gerencia', 'admin']) await rechaza(q, ins, [], /row-level security/);
    assert.equal((await filas('tablero', ins + ' returning 1')).length, 1); // control: el administrador del tablero sí sube
    assert.equal((await filas('admin', `delete from public.archivos returning 1`)).length, 0);
  });

  // ───── Casos de la revisión de seguridad ─────
  // Error exacto: el control de identidad del trigger tiene que responder antes que el RLS y que CARGA_MES_CERRADO.
  const EXACTO = /^42501 CARGA_SIN_PERMISO/;
  const INS_META = `insert into public.carga_metas (mes, sucursal, meta) values ($1, $2, $3)`;
  const UPS_META = INS_META + ' on conflict (mes, sucursal) do update set meta = excluded.meta';

  await caso('R1. cierres en un mes CERRADO de otra sucursal: exactamente CARGA_SIN_PERMISO (sucursal, tablero, registro, dirección, admin)', async () => {
    const plano = UPSERT_CIERRE.replace(/\s+on conflict[\s\S]*?(?=returning)/, '\n  ');
    for (const [q, suc, f] of [['juncal', 'boqueron', M2 + '-10'], ['boqueron', 'juncal', M2 + '-02'], ['tablero', 'juncal', M2 + '-02'],
                               ['registro', 'juncal', M2 + '-02'], ['gerencia', 'juncal', M2 + '-02'], ['admin', 'juncal', M2 + '-02']]) {
      await rechaza(q, plano, cierre(suc, f), EXACTO);
      await rechaza(q, UPSERT_CIERRE, cierre(suc, f, 1), EXACTO);
    }
  });

  await caso('R2. metas de un mes CERRADO: insert y upsert de quien no es dirección dan exactamente CARGA_SIN_PERMISO; update y delete no tocan nada', async () => {
    // juncal tiene meta 1000 en M2, cerrado. boqueron (otra sucursal), juncal (la dueña), tablero, registro y admin.
    for (const q of ['boqueron', 'juncal', 'tablero', 'registro', 'admin']) {
      await rechaza(q, INS_META, [M2, 'juncal', 1000], EXACTO);   // mismo valor (atajo del trigger)
      await rechaza(q, INS_META, [M2, 'juncal', 5], EXACTO);
      await rechaza(q, UPS_META, [M2, 'juncal', 5], EXACTO);
      await rechaza(q, UPS_META, [M2, 'boqueron', 5], EXACTO);    // mes cerrado sin meta
      // En update y delete el RLS (USING) descarta las filas antes del trigger: 0 filas y nada cambia.
      assert.equal((await filas(q, `update public.carga_metas set meta = 5 where mes = $1 returning 1`, [M2])).length, 0);
      assert.equal((await filas(q, `delete from public.carga_metas where mes = $1 returning 1`, [M2])).length, 0);
    }
    assert.deepEqual(await su(`select sucursal, meta::text, usuario from public.carga_metas where mes = $1`, [M2]),
      [{ sucursal: 'juncal', meta: '1000.00', usuario: 'gerencia' }]);
  });

  await caso('R3. fechas extremas (antes de Cristo, infinity, -infinity, fuera de 2020-2099): rechazadas por el control de rango', async () => {
    const RANGO = /^23514 carga_cierres_fecha_rango/;
    for (const f of ['2026-11-05 BC', M2 + '-05 BC', 'infinity', '-infinity', '2019-12-31', '2100-01-01'])
      await rechaza('juncal', UPSERT_CIERRE, cierre('juncal', f), RANGO);
    await rechaza('juncal', `update public.carga_cierres set fecha = '-infinity' where sucursal = 'juncal' and fecha = $1`, [hoy], RANGO);
    // también desde el SQL Editor (sin usuario de la app) y la restricción existe en la tabla
    await assert.rejects(su(`insert into public.carga_cierres (sucursal, fecha, farm, misc, cli, fac, unid, inc) values ('juncal', '2026-11-05 BC', 1, 1, 1, 1, 1, 0)`),
      e => /carga_cierres_fecha_rango/.test(e.message));
    const def = (await su(`select pg_get_constraintdef(oid) d from pg_constraint where conname = 'carga_cierres_fecha_rango'`))[0].d;
    assert.match(def, /2020-01-01.*2100-01-01/);
    // y con la fecha fuera de rango no se puede quitar la meta: no hay cierres "escondidos" en otra era
    assert.equal(await contar('public.carga_cierres', `not isfinite(fecha) or fecha < '2020-01-01'`), 0);
  });

  await caso('R4. catálogo: SECURITY DEFINER con search_path vacío; triggers no ejecutables; anon no ejecuta nada', async () => {
    const def = await su(`select proname, proconfig from pg_proc where proname like 'carga\\_%' and prosecdef order by 1`);
    assert.ok(def.length === 12, 'faltan funciones SECURITY DEFINER: ' + def.map(x => x.proname));
    for (const p of def) assert.deepEqual(p.proconfig, ['search_path=""'], p.proname);
    const todas = await su(`select proname, has_function_privilege('anon', oid, 'execute') anon,
      has_function_privilege('authenticated', oid, 'execute') auth from pg_proc where proname like 'carga\\_%' order by 1`);
    assert.equal(todas.length, 13);
    for (const p of todas) assert.equal(p.anon, false, 'anon ejecuta ' + p.proname);
    for (const t of ['carga_cierres_antes', 'carga_metas_antes', 'carga_bitacora_fn'])
      assert.equal(todas.find(p => p.proname === t).auth, false, 'authenticated ejecuta ' + t);
    assert.ok(todas.filter(p => !/_antes$|_fn$/.test(p.proname)).every(p => p.auth), 'authenticated debe ejecutar las funciones de la app');
  });

  await caso('R5. guardar un cierre o una meta sin cambios no vuelve a firmar ni deja fila en la bitácora', async () => {
    const leer = () => su(`select usuario, ts::text from public.carga_cierres where sucursal = 'juncal' and fecha = $1`, [hoy]);
    const antes = await leer(), bit = await contar('public.carga_bitacora');
    for (let i = 0; i < 5; i++) await filas('juncal', UPSERT_CIERRE, cierre('juncal', hoy));
    await filas('juncal', `update public.carga_cierres set farm = farm, com = com where sucursal = 'juncal' and fecha = $1`, [hoy]);
    assert.deepEqual(await leer(), antes);
    assert.equal(await contar('public.carga_bitacora'), bit);
    const leerMeta = () => su(`select usuario, ts::text from public.carga_metas where sucursal = 'juncal' and mes = $1`, [M0]);
    const mAntes = await leerMeta();
    for (let i = 0; i < 3; i++) await filas('presidencia', UPS_META, [M0, 'juncal', 1000]);
    await metas('gerencia', M0, { juncal: 1000, boqueron: 2000 });
    assert.deepEqual(await leerMeta(), mAntes);
    assert.equal(await contar('public.carga_bitacora'), bit);
    // un cambio real sí firma y registra
    await filas('juncal', UPSERT_CIERRE, cierre('juncal', hoy, 101));
    assert.notDeepEqual(await leer(), antes);
    assert.equal(await contar('public.carga_bitacora'), bit + 1);
  });

  await caso('R6. metas: el atajo "mismo valor" del trigger también firma con el usuario del servidor', async () => {
    // Una carrera con un borrado no se puede producir con una sola conexión: se prueba la función del trigger
    // sobre una tabla gemela sin clave primaria, donde el INSERT entra aunque la meta ya exista con ese valor.
    await db.exec(`create table public.zz_metas_gemela (like public.carga_metas);
      create trigger t before insert on public.zz_metas_gemela for each row execute function public.carga_metas_antes();
      grant insert, select on public.zz_metas_gemela to authenticated;`);
    try {
      const r = await filas('gerencia', `insert into public.zz_metas_gemela (mes, sucursal, meta, usuario, ts)
        values ($1, 'juncal', 1000, 'falso', '2000-01-01') returning usuario, ts`, [M2]);
      assert.equal(r[0].usuario, 'gerencia');
      assert.ok(new Date(r[0].ts).getUTCFullYear() >= 2026);
    } finally { await su('drop table public.zz_metas_gemela'); }
  });

  await caso('Call Center como tienda: guarda su cierre y lee solo lo suyo', async () => {
    assert.equal((await filas('call-center', 'select public.carga_contexto() c'))[0].c.sucursal, 'call-center');
    await rechaza('call-center', UPSERT_CIERRE, cierre('call-center', hoy), /CARGA_SIN_META/);
    await metas('gerencia', M0, { juncal: 1000, boqueron: 2000, 'call-center': 500 });
    const r = await filas('call-center', UPSERT_CIERRE, cierre('call-center', hoy));
    assert.equal(r[0].usuario, 'call-center');
    for (const t of ['carga_cierres', 'carga_metas'])
      assert.deepEqual([...new Set((await filas('call-center', `select sucursal from public.${t}`)).map(x => x.sucursal))], ['call-center'], t);
    await rechaza('call-center', UPSERT_CIERRE, cierre('juncal', hoy), EXACTO);
    assert.equal((await filas('juncal', `select * from public.carga_cierres where sucursal = 'call-center'`)).length, 0);
    assert.ok((await filas('gerencia', `select * from public.carga_cierres where sucursal = 'call-center'`)).length === 1);
  });

  await caso('actualización: carga.sql nuevo sobre una base con las 30 sucursales agrega las 2 nuevas y no toca nada más', async () => {
    // Versión anterior: el archivo indicado en CARGA_SQL_ANTERIOR o, si no, este mismo SQL sin las dos filas nuevas.
    const anterior = process.env.CARGA_SQL_ANTERIOR ? fs.readFileSync(process.env.CARGA_SQL_ANTERIOR, 'utf8')
      : cargaSql.replace(/,\r?\n[^\n]*\r?\n\s*\('call-center','Call Center'\),\('pagina-web','Página Web'\)/, '');
    const otra = new PGlite();
    try {
      await otra.exec(PRELUDIO); await otra.exec(setupSql); await otra.exec(anterior);
      const n = async () => (await otra.query('select count(*)::int n from public.carga_sucursales')).rows[0].n;
      assert.equal(await n(), 30);
      // datos y ajustes que ya tiene el proyecto real
      await otra.exec(`update public.carga_sucursales set nombre = 'Juncal (editado)' where id = 'juncal';
        update public.carga_config set inicio = '2026-12', reabren = '{admin,gerencia}';
        insert into public.carga_metas (mes, sucursal, meta) values ('2026-12', 'juncal', 1234);`);
      const foto = async () => (await otra.query(`select
        (select json_agg(s order by id) from public.carga_sucursales s where id not in ('call-center', 'pagina-web')) suc,
        (select row_to_json(c) from public.carga_config c) cfg,
        (select json_agg(m) from (select mes, sucursal, meta, usuario, ts from public.carga_metas) m) met,
        (select count(*)::int from public.carga_bitacora) bit`)).rows[0];
      const antes = await foto();
      await otra.exec(cargaSql);
      assert.equal(await n(), 32);
      assert.deepEqual(await foto(), antes);
      assert.equal((await otra.query(`select nombre from public.carga_sucursales where id = 'pagina-web'`)).rows[0].nombre, 'Página Web');
      // las restricciones con nombre también entran en una tabla creada con una versión anterior
      const con = (await otra.query(`select conname from pg_constraint where convalidated and conname in
        ('carga_cierres_fecha_rango', 'carga_cierres_sin_nan', 'carga_metas_sin_nan') order by 1`)).rows.map(x => x.conname);
      assert.deepEqual(con, ['carga_cierres_fecha_rango', 'carga_cierres_sin_nan', 'carga_metas_sin_nan']);
    } finally { await otra.close(); }
  });

  await caso('bitácora: registra quién cambió cada tabla y no tiene filas de "sin cambio"', async () => {
    const r = await su(`select tabla, op, usuario, count(*)::int n from public.carga_bitacora group by 1, 2, 3 order by 1, 2, 3`);
    assert.ok(r.some(x => x.tabla === 'carga_cierres' && x.op === 'INSERT' && x.usuario === 'juncal'));
    assert.ok(r.some(x => x.tabla === 'carga_metas' && x.op === 'UPDATE' && x.usuario === 'gerencia'));
    assert.ok(r.some(x => x.tabla === 'carga_meses' && x.op === 'INSERT' && x.usuario === 'juncal'));
    assert.equal(await contar('public.carga_bitacora', `op = 'UPDATE' and antes = despues`), 0);
  });

  await db.close();
  console.log(`\nOK: ${casos.length} casos de permisos de carga.sql`);
})().catch(e => { console.error('\nFALLO:', e && e.stack || e); process.exit(1); });
