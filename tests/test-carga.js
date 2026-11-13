// Runs web/carga/index.html headless against an in-memory fake of supabase-js: node tests/test-carga.js
// No network and no real project: the fake only mimics the tables, functions, row-level security and errors of supabase/carga.sql.
process.env.TZ = 'UTC';   // times on screen must come out in Caracas time whatever the machine's zone
const fs = require('fs'), path = require('path'), assert = require('assert'), { execSync } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom'), XLSX = require('xlsx');
const RAIZ = path.join(__dirname, '..');
const html = fs.readFileSync(process.env.CARGA_HTML || path.join(RAIZ, 'web/carga/index.html'), 'utf8');   // CARGA_HTML: run against a modified copy
const errors = [];
const vc = new VirtualConsole();
vc.on('error', (...a) => errors.push(a.join(' '))); vc.on('jsdomError', e => errors.push(e.message));
const dom = new JSDOM(html.replace(/<script src=[^>]*><\/script>/g, ''), { runScripts: 'outside-only', url: 'https://statistics.example/carga/', virtualConsole: vc });
const w = dom.window;
w.addEventListener('error', e => errors.push(e.message));
process.on('unhandledRejection', e => errors.push('unhandled: ' + (e?.message || e)));
w.eval(fs.readFileSync(path.join(RAIZ, 'web/carga/vendor/xlsx.full.min.js'), 'utf8'));   // the page's own SheetJS copy (vendor/)
assert.equal(w.XLSX.version, '0.20.3'); w.matchMedia = () => ({ addEventListener() {} });
w.Chart = class { constructor(_el, cfg) { this.config = cfg; this.data = cfg.data; this.options = cfg.options || {}; } destroy() {} update() {} };
w.Chart.defaults = { font: {} };

// ---------- fake Supabase ----------
const HOY = '2026-11-12', INICIO = '2026-11';
const T = { carga_cierres: [], carga_meses: [], carga_metas: [], carga_paginas: [] };
const USUARIOS = {};   // email -> { uid, ctx }
const sucursal = (id, hoy = HOY) => USUARIOS[id + '@carga.invalid'] = { uid: 'u-' + id, ctx: { usuario: id, rol: 'sucursal', sucursal: id, hoy, inicio: INICIO, reabren: ['admin'] } };
['juncal', 'boqueron', 'la-cruz', 'floresta', 'samanes'].forEach(id => sucursal(id));
sucursal('cocuizas', '2026-11-05');
['call-center', 'pagina-web'].forEach(id => sucursal(id));   // sales channels log in like a branch   // the server says it is the 5th, whatever the machine's clock says
['gerencia', 'vicepresidencia', 'presidencia', 'admin'].forEach(r => USUARIOS[r + '@carga.invalid'] = { uid: 'u-' + r, ctx: { usuario: r, rol: r, sucursal: null, hoy: HOY, inicio: INICIO, reabren: ['admin'] } });
USUARIOS['tablero@carga.invalid'] = { uid: 'u-tablero', ctx: null };   // e.g. the dashboard's admin account: signed in, but no carga_usuarios row
const ctxDe = uid => Object.values(USUARIOS).find(u => u.uid === uid)?.ctx ?? null;
const DIRECCION = ['gerencia', 'vicepresidencia', 'presidencia'];

let session = null, authCb = null, opciones = null, ultimoLogin = null, estadoCanal = null;
const llamadas = [], upserts = [], rangos = [], filtros = [], salidas = [], vivo = {}, fallas = [];   // fallas: one-shot errors for the next call of that name
const modo = { sinVivo: false, signOutFalla: false, retraso: 0 };
const ahora = () => new Date().toISOString();
const quien = () => ctxDe(session?.user.id)?.usuario || 'sistema';
const ordenar = (rs, cols) => rs.sort((a, b) => { for (const c of cols) { if (a[c] < b[c]) return -1; if (a[c] > b[c]) return 1; } return 0; });
// Row-level security like carga.sql: a branch reads only its own rows; an account without a carga_usuarios row reads nothing.
const visible = (tabla, r) => { if (!(tabla in { carga_cierres: 1, carga_meses: 1, carga_metas: 1 })) return true;
  const c = ctxDe(session?.user.id); return !!c && (c.rol !== 'sucursal' || r.sucursal === c.sucursal); };
const mesCerrado = (s, m) => T.carga_meses.some(r => r.sucursal === s && r.mes === m && r.cerrado);
const err = (message, code = 'P0001') => ({ data: null, error: { code, message } });
function query(tabla) {
  const fs_ = [], orden = [];
  const q = {
    select: () => q,
    gte: (c, v) => { filtros.push([tabla, c, v]); fs_.push(r => r[c] >= v); return q; },
    order: c => { orden.push(c); return q; },
    range: async (a, b) => { rangos.push([tabla, a, b]);   // the snapshot is taken when the request starts; the answer may come later
      const rs = ordenar(T[tabla].filter(r => visible(tabla, r) && fs_.every(f => f(r))), orden).slice(a, b + 1).map(r => ({ ...r }));
      if (modo.retraso) await new Promise(r => setTimeout(r, modo.retraso)); return { data: rs, error: null }; },
    upsert: (fila, opts) => ({ select: () => ({ single: async () => {
      upserts.push({ tabla, fila: { ...fila }, opts }); if (modo.retraso) await new Promise(r => setTimeout(r, modo.retraso));
      const f = fallas.findIndex(x => x.nombre === tabla); if (f >= 0) return { data: null, error: fallas.splice(f, 1)[0].error };
      const fila2 = { ...fila, usuario: quien(), ts: ahora() };
      const i = T[tabla].findIndex(r => r.sucursal === fila.sucursal && r.fecha === fila.fecha);
      i >= 0 ? T[tabla][i] = fila2 : T[tabla].push(fila2);
      return { data: { ...fila2 }, error: null };
    } }) }),
  };
  return q;
}
const RPC = {
  carga_contexto: () => ({ data: ctxDe(session?.user.id), error: null }),
  carga_hoy: () => ({ data: ctxDe(session?.user.id)?.hoy || HOY, error: null }),
  carga_cerrar_mes: a => { const c = ctxDe(session.user.id); const row = { sucursal: c.sucursal, mes: a.p_mes, cerrado: true, analisis: a.p_analisis, top: a.p_top, sin_rot: a.p_sin_rot, usuario: c.usuario, ts: ahora(), reabierto_por: null, reabierto_ts: null };
    T.carga_meses = T.carga_meses.filter(r => !(r.sucursal === row.sucursal && r.mes === row.mes)); T.carga_meses.push(row); return { data: { ...row }, error: null }; },
  carga_reabrir_mes: a => { const r = T.carga_meses.find(x => x.sucursal === a.p_sucursal && x.mes === a.p_mes && x.cerrado);
    if (!r) return err('CARGA_NO_CERRADO: ese mes no está cerrado');
    Object.assign(r, { cerrado: false, reabierto_por: quien(), reabierto_ts: ahora() }); return { data: { ...r }, error: null }; },
  // All or nothing, like the SQL: a closed month's goal can't be created, changed or removed; a goal in use can't be removed.
  carga_guardar_metas: a => {
    if (!DIRECCION.includes(ctxDe(session?.user.id)?.rol)) return err('CARGA_SIN_PERMISO: solo gerencia general, vicepresidencia y presidencia cargan metas', '42501');
    const antes = Object.fromEntries(T.carga_metas.filter(r => r.mes === a.p_mes).map(r => [r.sucursal, Number(r.meta)]));
    for (const s of new Set([...Object.keys(antes), ...Object.keys(a.p_metas)])) {
      const nuevo = s in a.p_metas ? Number(a.p_metas[s]) : undefined;
      if (nuevo === antes[s]) continue;
      if (mesCerrado(s, a.p_mes)) return err(`CARGA_MES_CERRADO: el mes ${a.p_mes} ya está cerrado para esa sucursal`);
      if (nuevo === undefined && T.carga_cierres.some(r => r.sucursal === s && r.fecha.startsWith(a.p_mes))) return err(`CARGA_META_EN_USO: la sucursal ya tiene cierres en ${a.p_mes}, no se puede quitar su meta`);
    }
    T.carga_metas = T.carga_metas.filter(r => r.mes !== a.p_mes);
    Object.entries(a.p_metas).forEach(([s, v]) => T.carga_metas.push({ mes: a.p_mes, sucursal: s, meta: v, usuario: quien(), ts: ahora() }));
    return { data: T.carga_metas.filter(r => r.mes === a.p_mes).map(r => ({ ...r })), error: null }; },
};
w.supabase = { createClient: (url, key, opts) => { opciones = { url, key, opts }; return {
  auth: {
    getSession: async () => ({ data: { session } }),
    onAuthStateChange: cb => { authCb = cb; return { data: { subscription: { unsubscribe() {} } } }; },
    signInWithPassword: async o => { ultimoLogin = o; const u = USUARIOS[o.email];
      if (o.password === 'rate') return { data: {}, error: { message: 'Request rate limit reached' } };
      if (!u || o.password !== 'buena') return { data: {}, error: { message: 'Invalid login credentials' } };
      session = { user: { id: u.uid } }; opciones.opts.auth.storage.setItem('statistics-carga-auth', JSON.stringify(session)); authCb('SIGNED_IN', session); return { data: { session }, error: null }; },
    // Like auth-js 2.65.0: if the logout request fails (no internet) it returns {error} and keeps the session, without notifying.
    signOut: async o => { salidas.push(o);
      if (modo.signOutFalla) return { error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 } };
      session = null; opciones.opts.auth.storage.removeItem('statistics-carga-auth'); authCb('SIGNED_OUT', null); return { error: null }; },
  },
  from: tabla => query(tabla),
  rpc: async (nombre, args) => { llamadas.push({ nombre, args }); const f = fallas.findIndex(x => x.nombre === nombre);
    if (f >= 0) return { data: null, error: fallas.splice(f, 1)[0].error };
    return RPC[nombre](args); },
  channel: () => { const ch = { on: (_e, filtro, cb) => { vivo[filtro.table] = cb; return ch; },
    subscribe: cb => { estadoCanal = cb; if (!modo.sinVivo) setTimeout(() => cb('SUBSCRIBED'), 0); return ch; } }; return ch; },
  removeChannel: () => {},
}; } };

// ---------- seed: goals for November (none for boqueron; two with decimals), one all-zero close for la-cruz, one normal close for floresta ----------
const META = { juncal: 200000.5, 'la-cruz': 110000, floresta: 160000.5, samanes: 130000, cocuizas: 60000, 'call-center': 90000 };
Object.entries(META).forEach(([s, v]) => T.carga_metas.push({ mes: '2026-11', sucursal: s, meta: v, usuario: 'gerencia', ts: '2026-11-01T10:00:00+00:00' }));
const cero = { farm: 0, misc: 0, cli: 0, fac: 0, unid: 0, inc: 0, com: '' };
T.carga_cierres.push({ sucursal: 'la-cruz', fecha: '2026-11-11', ...cero, usuario: 'la-cruz', ts: '2026-11-11T22:00:00+00:00' });
T.carga_cierres.push({ sucursal: 'floresta', fecha: '2026-11-10', farm: 4000, misc: 900.5, cli: 380, fac: 400, unid: 1100, inc: 0, com: '', usuario: 'floresta', ts: '2026-11-10T22:00:00+00:00' });

// service worker: a fake registration that fails, to check it is registered and that the failure stays silent
const swReg = [];
Object.defineProperty(w.navigator, 'serviceWorker', { configurable: true, value: { register: (u, o) => { swReg.push([u, o]); return Promise.reject(new Error('sin service worker')); } } });
const code = [...html.matchAll(/<script(?: id="parser")?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
assert.ok(code.includes('ESPERA_VIVO=15000'), 'la espera de la conexión en vivo es de 15 s');
w.eval(code.replace('ESPERA_VIVO=15000', 'ESPERA_VIVO=400') + ';window.__t={D,U,TIENDAS,cruceProductos,esc,leerTodo,errTxt,hoja,registro,tienda,parseWorkbook,pintar};');
const $ = s => w.document.querySelector(s);
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
// Rendering the whole dashboard in jsdom is slow: wait for a condition instead of a fixed time.
const hasta = async (cond, que, ms = 8000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) assert.fail('tiempo agotado esperando: ' + que); await tick(10); } };
const quieto = () => w.__t.D.cola === null && w.__t.pintar.t == null;   // no read in flight, no repaint pending
const calma = async () => { await tick(); await hasta(quieto, 'repintado'); };
const submit = sel => $(sel).dispatchEvent(new w.Event('submit', { cancelable: true }));
const escribirEn = (id, v) => { $('#' + id).value = v; $('#' + id).dispatchEvent(new w.Event('input', { bubbles: true })); };
const llenar = o => Object.entries(o).forEach(([k, v]) => escribirEn(k, v));
const tab = t => $(`.menu [data-tab="${t}"]`).click();
const ultimas = n => llamadas.filter(c => c.nombre === n);
async function salirDe() { $('#btnSalir').click(); await hasta(() => !$('#loginBox').hidden, 'volver al login'); }
async function entrarComo(usuario) {
  if (!$('.app').hidden) await salirDe();
  $('#lUser').value = usuario; $('#lPass').value = 'buena'; submit('#fLogin');
  await hasta(() => w.__t.D.modo === 'compartido' && w.__t.U.user?.id === usuario && w.__t.D.lectura > 0 && quieto(), 'entrar como ' + usuario);
}
const dondeSesion = () => [w.localStorage.getItem('statistics-carga-auth') != null, w.sessionStorage.getItem('statistics-carga-auth') != null];   // [local, sesión]
const sinRaros = donde => { const t = $('.main').textContent; assert.ok(!/NaN|Infinity|undefined/.test(t), `NaN/undefined en ${donde}: ` + (t.match(/.{0,40}(NaN|Infinity|undefined).{0,40}/) || [''])[0]); };
const sinNaN = (donde) => { const t = $('.main').textContent; assert.ok(!/NaN|Infinity/.test(t), `NaN/Infinity en ${donde}: ` + (t.match(/.{0,40}(NaN|Infinity).{0,40}/) || [''])[0]); };
const fila = (box, nombre) => [...$(box).querySelectorAll('tr')].find(r => r.children[0]?.textContent === nombre);
let casos = 0; const ok = m => { casos++; console.log('  ok ' + m); };

(async () => {
  await tick();
  // ---- no session: login visible, app hidden; own storage key so the dashboard at / never sees this session ----
  assert.ok(!$('#loginBox').hidden && $('.app').hidden, 'login visible sin sesión');
  assert.equal(opciones.opts?.auth?.storageKey, 'statistics-carga-auth'); assert.equal(opciones.opts.auth.detectSessionInUrl, false, 'detectSessionInUrl:false');
  assert.equal(typeof opciones.opts.auth.storage?.setItem, 'function', 'storage propio');
  assert.equal(JSON.parse(Buffer.from(opciones.key.split('.')[1], 'base64')).role, 'anon', 'solo la anon key');
  assert.equal($('#lUser').placeholder, 'usuario de tu sucursal o tu correo');
  await hasta(() => swReg.length, 'registro del service worker');
  assert.deepEqual(swReg, [['sw.js', { scope: './' }]], 'registra sw.js con scope ./ (https)');
  ok('sin sesión se ve el login; registra el service worker y su fallo no da errores');

  // wrong password: error, field cleared, synthetic e-mail
  $('#lUser').value = ' Juncal '; $('#lPass').value = 'mala'; submit('#fLogin'); await tick();
  assert.equal(ultimoLogin.email, 'juncal@carga.invalid');
  assert.ok(!$('#lErr').hidden); assert.equal($('#lErr').textContent, 'Usuario o clave incorrectos.'); assert.equal($('#lPass').value, '');
  assert.ok($('.app').hidden);
  $('#lPass').value = 'rate'; submit('#fLogin'); await tick();
  assert.match($('#lErr').textContent, /Demasiados intentos/);
  // a real e-mail is used as is (no spaces, lower case); a malformed one never reaches the server
  $('#lUser').value = ' Dueno@Ejemplo.Test '; $('#lPass').value = 'mala'; submit('#fLogin'); await tick();
  assert.equal(ultimoLogin.email, 'dueno@ejemplo.test'); assert.equal($('#lErr').textContent, 'Usuario o clave incorrectos.');
  const previo = ultimoLogin;
  for (const malo of ['dueno@ejemplo', 'dueno@@ejemplo.test', '@ejemplo.test']) {
    $('#lUser').value = malo; $('#lPass').value = 'x'; submit('#fLogin'); await tick();
    assert.equal(ultimoLogin, previo, 'no llama al servidor: ' + malo); assert.match($('#lErr').textContent, /formato válido/);
  }
  assert.ok(/^Usuario o correo/.test($('#lUser').closest('label').textContent));
  ok('clave mala: error y campo limpio; límite de intentos; login con correo real o usuario corto');

  // ---- branch with goal: lands on "Cargar cierre", saves a day without usuario/ts ----
  await entrarComo('juncal');
  assert.deepEqual(dondeSesion(), [true, false], 'la sucursal guarda la sesión en localStorage');
  assert.ok($('#loginBox').hidden && !$('.app').hidden, 'app visible');
  assert.equal(w.document.body.dataset.rol, 'sucursal');
  assert.ok(!$('#v-carga').hidden && $('#fC'), 'cae en Cargar cierre con formulario');
  assert.match($('#sesion').textContent, /En vivo/);
  assert.deepEqual(filtros.filter(f => f[0] === 'carga_cierres').at(-1), ['carga_cierres', 'fecha', '2025-11-01'], 'cierres desde hace 13 meses');
  assert.equal(w.__t.U.fecha, '2026-11-01');
  llenar({ iFarm: '5.000,50', iMisc: '1000', iCli: '600', iFac: '620', iUni: '1800', iInc: '0' });
  submit('#fC'); await tick();
  assert.equal(upserts.length, 1);
  assert.deepEqual(upserts[0].fila, { sucursal: 'juncal', fecha: '2026-11-01', farm: 5000.5, misc: 1000, cli: 600, fac: 620, unid: 1800, inc: 0, com: '' });
  assert.equal(upserts[0].opts.onConflict, 'sucursal,fecha');
  const d1 = () => $('#cargaBox [data-f="2026-11-01"]');
  assert.ok(d1().classList.contains('ok') && /listo/.test(d1().textContent), 'día queda listo');
  assert.equal(w.__t.D.cierres.get('juncal_2026-11-01').usuario, 'juncal', 'firma del servidor');
  ok('sucursal con meta guarda un día (sin usuario ni ts); lee cierres de 13 meses');

  // correct the same day: upsert on the same key, one row; after an error the button still says "Actualizar cierre"
  d1().click(); await tick();
  assert.equal($('#iFarm').value, '5000,5'); assert.match($('#fC button[type=submit]').textContent, /Actualizar/);
  fallas.push({ nombre: 'carga_cierres', error: { code: '', message: 'TypeError: Failed to fetch' } });
  escribirEn('iFarm', '5500'); $('#fC button[type=submit]').click(); await tick();
  assert.equal($('#fC button[type=submit]').textContent, 'Actualizar cierre');
  assert.match($('#fErr').textContent, /Revisa tu conexión/);
  submit('#fC'); await tick();
  assert.equal(upserts.length, 3); assert.equal(upserts[2].fila.fecha, '2026-11-01'); assert.equal(upserts[2].fila.farm, 5500);
  assert.equal(T.carga_cierres.filter(r => r.sucursal === 'juncal' && r.fecha === '2026-11-01').length, 1);
  ok('corregir un día hace upsert de la misma clave; tras un error el botón sigue en "Actualizar cierre"');

  // decimals in counts are refused before reaching the server
  assert.equal(w.__t.U.fecha, '2026-11-02');
  llenar({ iFarm: '100', iMisc: '0', iCli: '1,5', iFac: '2', iUni: '3', iInc: '0' });
  submit('#fC'); await tick();
  assert.ok($('#iCli').classList.contains('err')); assert.equal(upserts.length, 3);
  // day without operation: zero invoices with sales is refused locally; all zeros is saved
  llenar({ iFarm: '100', iMisc: '0', iCli: '0', iFac: '0', iUni: '0', iInc: '0' });
  submit('#fC'); await tick();
  assert.ok($('#iFac').classList.contains('err')); assert.match($('#fErr').textContent, /facturas deben ser mayores que 0/);
  assert.equal(upserts.length, 3, 'no llamó al servidor');
  llenar({ iFarm: '0', iMisc: '0', iCli: '0', iFac: '0', iUni: '0', iInc: '0' });
  assert.match($('#pA').textContent, /Día sin operación/);
  sinNaN('vista previa del día sin operación');
  submit('#fC'); await tick();
  assert.equal(upserts.length, 4); assert.equal(upserts[3].fila.fac, 0); assert.equal(upserts[3].fila.fecha, '2026-11-02');
  assert.ok($('#cargaBox [data-f="2026-11-02"]').classList.contains('ok'));
  ok('día sin operación: todo en 0 se guarda; facturas 0 con venta no llama al servidor');

  // Excel of a month with a day without operation: no NaN in numeric cells, and the dashboard's own reader reads the same totals back
  const t0 = w.__t.tienda('juncal'), reg = w.__t.registro(t0, '2026-11');
  const wb = w.XLSX.utils.book_new(); w.XLSX.utils.book_append_sheet(wb, w.__t.hoja(t0, '2026-11'), 'NOVIEMBRE 2026');
  const wb2 = XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' }), ws = wb2.Sheets[wb2.SheetNames[0]];
  const malas = Object.keys(ws).filter(k => k[0] !== '!' && ws[k].t === 'n' && !isFinite(ws[k].v));
  assert.deepEqual(malas, [], 'celdas numéricas con NaN o Infinity');
  assert.ok(!Object.keys(ws).some(k => k[0] !== '!' && /NaN|Infinity/.test(String(ws[k].w ?? ws[k].v))));
  const leido = w.__t.parseWorkbook(wb2, { name: 'ESTADISTICA DE VENTAS NOVIEMBRE 2026 JUNCAL.xlsx' });
  assert.equal(leido.kind, 'sucursal'); const r0 = leido.registros[0];
  for (const k of ['total', 'farmacia', 'misc', 'facturas', 'clientes', 'unidades', 'metaMes']) if (k in r0) assert.ok(Math.abs(r0[k] - reg[k]) < 1e-6, `${k}: ${r0[k]} vs ${reg[k]}`);
  assert.ok(Math.abs(r0.meta - reg.metaMes) < 1e-6); assert.equal(r0.dias.length, 2); assert.equal(r0.dias[1].fac, 0);
  assert.equal(reg.total, 6500); assert.equal(reg.facturas, 620);
  ok('Excel con día sin operación: sin NaN y el lector del tablero lo vuelve a leer igual');

  // unsaved typing survives realtime events, a dropped channel and the reconnection reload
  assert.equal(w.__t.U.fecha, '2026-11-03');
  $('#iFarm').focus(); llenar({ iFarm: '1234', iCli: '50' }); $('#iFarm').focus();
  const c5 = { sucursal: 'juncal', fecha: '2026-11-05', farm: 900, misc: 100, cli: 90, fac: 95, unid: 200, inc: 0, com: '', usuario: 'juncal', ts: '2026-11-05T23:00:00+00:00' };
  T.carga_cierres.push(c5); vivo.carga_cierres({ eventType: 'INSERT', new: { ...c5 }, old: {} });
  // meanwhile another computer of the same branch saves this very day
  const c3 = { sucursal: 'juncal', fecha: '2026-11-03', farm: 2000, misc: 300, cli: 60, fac: 70, unid: 150, inc: 0, com: 'otra pc', usuario: 'juncal', ts: '2026-11-03T23:00:00+00:00' };
  T.carga_cierres.push(c3); vivo.carga_cierres({ eventType: 'INSERT', new: { ...c3 }, old: {} });
  estadoCanal('CHANNEL_ERROR'); await tick(300);
  assert.equal(w.document.activeElement, $('#iFarm'), 'no repinta mientras escribe');
  assert.equal($('#iFarm').value, '1234');
  $('#iFarm').blur(); await tick(80);
  assert.ok($('#cargaBox [data-f="2026-11-05"]').classList.contains('ok'), 'repintó al salir del formulario');
  assert.match($('#sesion').textContent, /Sin conexión/);
  assert.equal($('#iFarm').value, '1234'); assert.equal($('#iCli').value, '50');
  assert.equal($('#iMisc').value, '300', 'lo no tocado muestra lo guardado por la otra computadora');
  assert.ok($('#iFarm').classList.contains('err') && $('#iCli').classList.contains('err'), 'campos en conflicto marcados');
  assert.match($('#avisoCambio')?.textContent || '', /Otra persona cambió el cierre de este día mientras escribías: revisa antes de guardar/);
  // reconnection: a change that arrives while the reload is reading is not lost
  modo.retraso = 120; const c6 = { ...c5, fecha: '2026-11-06' };
  estadoCanal('SUBSCRIBED'); await tick(40);
  T.carga_cierres.push(c6); vivo.carga_cierres({ eventType: 'INSERT', new: { ...c6 }, old: {} });
  await tick(150); await calma(); modo.retraso = 0;
  assert.ok(w.__t.D.cierres.has('juncal_2026-11-06'), 'evento durante la recarga no se pierde');
  assert.match($('#sesion').textContent, /En vivo/);
  assert.equal($('#iFarm').value, '1234'); assert.equal($('#iCli').value, '50');
  // a date that is not exactly YYYY-MM-DD is ignored
  vivo.carga_cierres({ eventType: 'INSERT', new: { ...c5, fecha: '2026-11-07T00:00:00' }, old: {} }); await calma();
  assert.ok(!w.__t.D.cierres.has('juncal_2026-11-07') && ![...w.__t.D.cierres.keys()].some(k => k.includes('T00')), 'fecha rara ignorada');
  // realtime UPDATE of a close
  vivo.carga_cierres({ eventType: 'UPDATE', new: { ...c5, farm: 950 }, old: { sucursal: 'juncal', fecha: '2026-11-05' } }); await calma();
  assert.equal(w.__t.D.cierres.get('juncal_2026-11-05').farm, 950);
  // saving over a day that changed on the server since the form was painted: no blind save, repaint with a warning; the next save goes
  $('#iFarm').focus(); const nUp = upserts.length;
  Object.assign(c3, { cli: 65, ts: '2026-11-03T23:30:00+00:00' }); T.carga_cierres = T.carga_cierres.map(r => r.sucursal === 'juncal' && r.fecha === '2026-11-03' ? { ...c3 } : r);
  vivo.carga_cierres({ eventType: 'UPDATE', new: { ...c3 }, old: {} });
  submit('#fC'); await tick();
  assert.equal(upserts.length, nUp, 'no guarda a ciegas'); assert.match($('#avisoCambio')?.textContent || '', /Otra persona cambió el cierre/);
  assert.equal($('#iFarm').value, '1234');
  submit('#fC'); await tick();
  assert.equal(upserts.length, nUp + 1); assert.equal(upserts.at(-1).fila.farm, 1234);
  // leaving for a dashboard view drops the unsaved typing
  escribirEn('iCom', 'borrador'); tab('resumen'); await tick(); tab('carga'); await tick();
  assert.notEqual($('#iCom').value, 'borrador', 'borrador descartado al cambiar de vista');
  ok('lo escrito en #fC sigue tras eventos en vivo, CHANNEL_ERROR y la recarga; UPDATE de cierres; fechas raras ignoradas; aviso si el día cambió en el servidor; borrador descartado al salir de la vista');

  // server errors arrive in Spanish
  fallas.push({ nombre: 'carga_cierres', error: { code: 'P0001', message: 'CARGA_SIN_META: la sucursal no tiene meta cargada para 2026-11' } });
  llenar({ iFarm: '10', iMisc: '0', iCli: '1', iFac: '1', iUni: '1', iInc: '0' }); submit('#fC'); await tick();
  assert.match($('#fErr').textContent, /^La dirección todavía no cargó la meta de este mes para tu sucursal\. Tus datos siguen/);
  assert.equal($('#iFarm').value, '10', 'datos siguen en el formulario');
  fallas.push({ nombre: 'carga_cierres', error: { code: '23514', message: 'new row for relation "carga_cierres" violates check constraint "carga_cierres_sin_operacion"' } });
  submit('#fC'); await tick();
  assert.match($('#fErr').textContent, /facturas deben ser mayores que 0/);
  fallas.push({ nombre: 'carga_cierres', error: { code: '42501', message: 'new row violates row-level security policy for table "carga_cierres"' } });
  submit('#fC'); await tick();
  assert.match($('#fErr').textContent, /^Tu usuario no tiene permiso para esto\./);

  // month close: calls carga_cerrar_mes; CARGA_* errors in Spanish; success moves loading to next month
  tab('cierre'); await tick();
  assert.ok(!$('#v-cierre').hidden && $('#fM button[type=submit]').disabled, 'mes incompleto: botón deshabilitado');
  $('#mAn').value = 'Mes tranquilo.'; $('#top0').value = 'ACETAMINOFEN';
  fallas.push({ nombre: 'carga_cerrar_mes', error: { code: 'P0001', message: 'CARGA_MES_CERRADO: el mes 2026-11 ya está cerrado' } });
  submit('#fM'); await tick();
  assert.equal($('#mErr').textContent, 'Ese mes ya está cerrado: no se puede cambiar.');
  fallas.push({ nombre: 'carga_cerrar_mes', error: { code: 'P0001', message: 'CARGA_SIN_META: la sucursal no tiene meta cargada para 2026-11' } });
  submit('#fM'); await tick();
  assert.equal($('#mErr').textContent, 'La dirección todavía no cargó la meta de este mes para tu sucursal.');
  fallas.push({ nombre: 'carga_cerrar_mes', error: { code: 'P0001', message: 'CARGA_FALTAN_DIAS: hay 2 de 30 días cargados' } });
  submit('#fM'); await tick();
  assert.equal($('#mErr').textContent, 'Hay 2 de 30 días cargados.');
  submit('#fM'); await tick();
  const cm = ultimas('carga_cerrar_mes').at(-1).args;
  assert.deepEqual(cm, { p_mes: '2026-11', p_analisis: 'Mes tranquilo.', p_top: ['ACETAMINOFEN'], p_sin_rot: [] });
  assert.ok(!$('#v-carga').hidden && /Cerraste el mes anterior/.test($('#cargaBox').textContent), 'pasa a diciembre');
  ok('cierre de mes con carga_cerrar_mes y errores en español');

  // realtime UPDATE of a month: the admin reopens elsewhere and the branch sees it without reloading
  const mesJ = () => T.carga_meses.find(r => r.sucursal === 'juncal' && r.mes === '2026-11');
  Object.assign(mesJ(), { cerrado: false, reabierto_por: 'admin', reabierto_ts: ahora() });
  vivo.carga_meses({ eventType: 'UPDATE', new: { ...mesJ() }, old: { sucursal: 'juncal', mes: '2026-11' } }); await calma();
  assert.ok($('#fC') || $('#cargaBox [data-f="2026-11-12"]'), 'vuelve a noviembre');
  assert.match($('#vSub').textContent, /Noviembre 2026/);
  Object.assign(mesJ(), { cerrado: true }); vivo.carga_meses({ eventType: 'UPDATE', new: { ...mesJ() }, old: {} }); await calma();
  assert.match($('#cargaBox').textContent, /Cerraste el mes anterior/);
  ok('UPDATE en vivo de meses: el mes reabierto aparece sin recargar');

  // signing out without internet: back to the login anyway, local session removed
  w.localStorage.setItem('statistics-carga-auth', '{"falso":true}');
  modo.signOutFalla = true; await salirDe(); modo.signOutFalla = false;
  assert.deepEqual(salidas.at(-1), { scope: 'local' });
  assert.equal(w.localStorage.getItem('statistics-carga-auth'), null);
  assert.ok($('.app').hidden && w.__t.U.user === null);
  ok('cerrar sesión con error de red vuelve al login (scope local)');

  // ---- branch without goal: notice instead of the form ----
  await entrarComo('boqueron');
  assert.ok(!$('#v-carga').hidden && !$('#fC') && $('#sinMeta'), 'aviso sin meta');
  assert.match($('#sinMeta').textContent, /todavía no cargó la meta de Noviembre 2026/);
  assert.ok($('#cargaBox [data-f="2026-11-01"]'), 'el calendario sigue');
  ok('sucursal sin meta ve el aviso en lugar del formulario');

  // ---- the server's "today" rules, not the machine's clock ----
  await entrarComo('cocuizas');
  assert.ok(!$('#cargaBox [data-f="2026-11-05"]').disabled && $('#cargaBox [data-f="2026-11-06"]').disabled, 'el día 6 no se puede elegir');
  ok('hoy del servidor (día 5): el día 6 no se puede elegir');

  // ---- Call Center: a channel measured like a store, with no ticket group ----
  await entrarComo('call-center');
  assert.ok($('#fC')); assert.match($('#cargaBox').textContent, /Sin mínimo \(canal\)/); sinRaros('carga del canal');
  llenar({ iFarm: '3000', iMisc: '200', iCli: '40', iFac: '45', iUni: '90', iInc: '0' }); sinRaros('vista previa del canal');
  assert.equal($('#pT').className, '', 'sin color de mínimo');
  submit('#fC'); await tick();
  assert.equal(upserts.at(-1).fila.sucursal, 'call-center');
  for (const t of ['resumen', 'ticket', 'sucursal', 'cierre']) { tab(t); await tick(); sinRaros(t); }
  assert.match($('#cierreBox').textContent, /Canal sin mínimo de grupo/);
  assert.match($('#cierreBox').textContent, /5 más vendidos/); assert.match($('#cierreBox').textContent, /5 menos vendidos/);
  $('#mAn').value = 'Mes del canal.'; $('#top0').value = 'ACETAMINOFEN 500MG'; $('#rot0').value = 'GASA ESTERIL';
  submit('#fM'); await tick();
  assert.equal(ultimas('carga_cerrar_mes').at(-1).args.p_mes, '2026-11');
  assert.match($('#cargaBox').textContent, /Cerraste el mes anterior/);
  for (const t of ['resumen', 'ticket', 'sucursal', 'cierre']) { tab(t); await tick(); sinRaros(t + ' tras cerrar'); }
  // the Excel the app makes for the channel (code 31) is read back by the dashboard's reader
  const tc = w.__t.tienda('call-center'); assert.equal(tc.codigo, '31'); assert.equal(w.__t.tienda('pagina-web').codigo, '32'); assert.equal(w.__t.tienda('juncal').codigo, '04');
  const wbc = w.XLSX.utils.book_new(); w.XLSX.utils.book_append_sheet(wbc, w.__t.hoja(tc, '2026-11'), 'NOVIEMBRE 2026');
  const lc = w.__t.parseWorkbook(XLSX.read(XLSX.write(wbc, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' }), { name: 'ESTADISTICA DE VENTAS NOVIEMBRE 2026 CALL CENTER.xlsx' });
  assert.equal(lc.kind, 'sucursal'); const rc = lc.registros[0];
  assert.equal(rc.nombre, 'CALL CENTER'); assert.equal(rc.codigo, '31'); assert.equal(rc.total, 3200); assert.equal(rc.facturas, 45); assert.deepEqual(rc.top, ['ACETAMINOFEN 500MG']); assert.deepEqual(rc.sinRot, ['GASA ESTERIL']);
  ok('Call Center carga un día y cierra el mes sin NaN ni undefined; su Excel (código 31) se vuelve a leer');

  // ---- a branch whose only close is all zeros: no NaN or Infinity anywhere ----
  await entrarComo('la-cruz');
  sinNaN('carga');
  for (const t of ['resumen', 'ticket', 'sucursal', 'cierre']) { tab(t); await tick(); assert.ok(!$('#v-' + t).hidden, t); sinNaN(t); }
  ok('sucursal con un único cierre en cero: sin NaN ni Infinity (resumen, ticket, sucursal, cierre)');

  // ---- gerencia: supervision, saves goals, closed rows disabled, no "Reabrir" ----
  await entrarComo('gerencia');
  assert.deepEqual(dondeSesion(), [false, true], 'gerencia guarda la sesión en sessionStorage, no en localStorage');
  assert.equal(w.document.body.dataset.rol, 'sup'); assert.ok(!$('#v-resumen').hidden);
  sinNaN('resumen de gerencia'); sinRaros('resumen de gerencia');
  tab('ticket'); await tick(); sinRaros('ticket de gerencia');
  assert.match($('#tkGrupos').textContent, /Canales · sin mínimo/); assert.match($('#txTicket').textContent, /Canales \(sin mínimo de grupo\): Call Center/);
  assert.ok(!/Sin grupo asignado/.test($('#txTicket').textContent));
  tab('control'); await tick();
  assert.equal($('#controlBox').querySelectorAll('tbody tr').length, 32, '32 tiendas en Carga del día');
  assert.ok(fila('#controlBox', 'Call Center') && fila('#controlBox', 'Página Web'));
  assert.match($('#vSub').textContent, /de 32 sucursales/);
  sinNaN('control');
  const filaLaCruz = fila('#controlBox', 'La Cruz');
  assert.match(filaLaCruz.textContent, /Sin operación/); assert.match(filaLaCruz.children[3].textContent, /—/);
  assert.equal(filaLaCruz.children[3].className, '');
  assert.match(filaLaCruz.children[6].textContent, /6:00/, 'hora de Caracas (22:00 UTC)');
  ok('vControl: día sin operación sin $NaN; hora en Caracas');

  tab('metas'); await tick();
  assert.equal($('#metasBox').querySelectorAll('input[id^="me-"]').length, 32, '32 metas'); assert.ok($('#me-call-center') && $('#me-pagina-web'));
  assert.ok($('#me-juncal').disabled && /Cerrado/.test($('#me-juncal').closest('label').textContent), 'juncal cerrado: deshabilitado');
  assert.equal($('#me-floresta').value, '160000,5'); assert.equal($('#me-juncal').value, '200000,5');
  assert.ok(!$('#me-floresta').disabled && $('#fMe button[type=submit]'));
  assert.equal($('#me-boqueron').placeholder, '');
  // round trip with decimals, without changes (juncal's month is closed: its value must go back exactly)
  $('#me-juncal').value = '1';   // even if the disabled field were tampered with, the server's value is sent
  submit('#fMe'); await tick();
  let gm = ultimas('carga_guardar_metas').at(-1).args;
  assert.equal(gm.p_mes, '2026-11'); assert.deepEqual(gm.p_metas, META, 'ida y vuelta sin cambios');
  assert.ok($('#meErr').hidden, 'sin error del servidor');
  const metaServidor = (s, v) => { const r = T.carga_metas.find(x => x.mes === '2026-11' && x.sucursal === s);
    if (r) r.meta = v; else T.carga_metas.push({ mes: '2026-11', sucursal: s, meta: v, usuario: 'vicepresidencia', ts: ahora() });
    vivo.carga_metas({ eventType: r ? 'UPDATE' : 'INSERT', new: { mes: '2026-11', sucursal: s, meta: v }, old: {} }); };
  // A: while gerencia types (focus inside, no repaint), vicepresidencia saves samanes and a new goal for boqueron: gerencia's save keeps both
  $('#me-floresta').focus(); escribirEn('me-floresta', '165000'); $('#me-floresta').focus();
  metaServidor('samanes', 999999); metaServidor('boqueron', 50000); await tick(300);
  assert.equal($('#me-samanes').value, '130000', 'el formulario sigue sin repintar');
  submit('#fMe'); await tick();
  gm = ultimas('carga_guardar_metas').at(-1).args;
  assert.deepEqual(gm.p_metas, { ...META, floresta: 165000, samanes: 999999, boqueron: 50000 }, 'A: no borra ni revierte lo guardado por otro');
  // B: a draft equal to the old value doesn't hide the newer one; a real edit over a changed goal is kept, marked and explained
  $('#me-samanes').focus(); escribirEn('me-samanes', '1'); escribirEn('me-samanes', '999999');
  $('#me-cocuizas').focus(); escribirEn('me-cocuizas', '61000');
  metaServidor('samanes', 777777); metaServidor('cocuizas', 62000); await tick(300);
  $('#me-cocuizas').blur(); await tick(80);
  assert.equal($('#me-samanes').value, '777777', 'B: se ve el valor nuevo'); assert.ok(!$('#me-samanes').classList.contains('err'));
  assert.equal($('#me-cocuizas').value, '61000', 'lo escrito se conserva'); assert.ok($('#me-cocuizas').classList.contains('err'), 'marcado');
  assert.match($('#avisoCambio')?.textContent || '', /Otra persona cambió esta meta mientras escribías: revisa antes de guardar \(Cocuizas\)/);
  submit('#fMe'); await tick();
  gm = ultimas('carga_guardar_metas').at(-1).args;
  assert.deepEqual(gm.p_metas, { ...META, floresta: 165000, samanes: 777777, boqueron: 50000, cocuizas: 61000 });
  // changed here and on the server, and saved before any repaint: not sent; repaint with the warning; the next save goes
  $('#me-la-cruz').focus(); escribirEn('me-la-cruz', '111000'); $('#me-la-cruz').focus();
  metaServidor('la-cruz', 115000); const nAntes = ultimas('carga_guardar_metas').length;
  submit('#fMe'); await tick();
  assert.equal(ultimas('carga_guardar_metas').length, nAntes, 'no guarda a ciegas');
  assert.equal($('#me-la-cruz').value, '111000'); assert.match($('#avisoCambio')?.textContent || '', /\(La Cruz\)/);
  submit('#fMe'); await tick();
  assert.equal(ultimas('carga_guardar_metas').at(-1).args.p_metas['la-cruz'], 111000);
  ok('metas: A y B con evento en vivo y foco dentro; aviso de conflicto; no guarda a ciegas');
  // typing in #fMe survives a realtime goal change and a dropped channel
  $('#me-boqueron').focus(); escribirEn('me-boqueron', '70.000'); $('#me-boqueron').focus();
  T.carga_metas.find(r => r.sucursal === 'samanes').meta = 135000;
  vivo.carga_metas({ eventType: 'UPDATE', new: { mes: '2026-11', sucursal: 'samanes', meta: 135000 }, old: {} });
  estadoCanal('CHANNEL_ERROR'); await tick(300);
  assert.equal(w.document.activeElement, $('#me-boqueron')); assert.equal($('#me-boqueron').value, '70.000');
  $('#me-boqueron').blur(); await tick(80);
  assert.equal($('#me-boqueron').value, '70.000', 'sigue lo escrito'); assert.equal($('#me-samanes').value, '135000', 'llegó el cambio en vivo');
  estadoCanal('SUBSCRIBED'); await calma();
  assert.equal($('#me-boqueron').value, '70.000');
  submit('#fMe'); await tick();
  gm = ultimas('carga_guardar_metas').at(-1).args;
  assert.deepEqual(gm.p_metas, { ...META, floresta: 165000, samanes: 135000, boqueron: 70000, cocuizas: 61000, 'la-cruz': 111000 });
  assert.equal(w.__t.D.metas.get('2026-11').boqueron, 70000);
  // the client refuses removing a goal in use; the server too when the client didn't know about the closes
  const nGuardar = ultimas('carga_guardar_metas').length;
  $('#me-la-cruz').value = ''; submit('#fMe'); await tick();
  assert.match($('#meErr').textContent, /No se puede quitar la meta de: La Cruz/);
  assert.equal(ultimas('carga_guardar_metas').length, nGuardar, 'no llamó al servidor');
  $('#me-la-cruz').value = '111000';
  T.carga_cierres.push({ sucursal: 'boqueron', fecha: '2026-11-03', farm: 50, misc: 0, cli: 5, fac: 5, unid: 5, inc: 0, com: '', usuario: 'boqueron', ts: ahora() });
  $('#me-boqueron').value = ''; submit('#fMe'); await tick();
  assert.equal($('#meErr').textContent, 'No se puede quitar la meta de una sucursal que ya cargó cierres en ese mes.');
  assert.equal(w.__t.D.metas.get('2026-11').boqueron, 70000, 'todo o nada');
  ok('gerencia: metas con decimales ida y vuelta, fila cerrada envía el valor del servidor, lo escrito en #fMe sigue, CARGA_META_EN_USO');

  tab('meses'); await tick();
  assert.equal($('#mesesBox').querySelectorAll('tbody tr').length, 32, '32 en Cierres de mes'); assert.ok(fila('#mesesBox', 'Página Web'));
  assert.match($('#mesesBox').textContent, /Cerrado/); assert.equal($('#mesesBox [data-re]'), null, 'gerencia no ve Reabrir');
  ok('gerencia no ve Reabrir; las 32 tiendas en Carga del día, Metas y Cierres de mes; ticket con bloque Canales');

  // realtime: another branch's close shows up in "Carga del día", with the time in Caracas
  tab('control'); await tick();
  assert.match(fila('#controlBox', 'Samanes').textContent, /Pendiente/);
  const nuevo = { sucursal: 'samanes', fecha: '2026-11-11', farm: '3000.00', misc: '500.00', cli: 300, fac: 310, unid: 900, inc: 1, com: '', usuario: 'samanes', ts: '2026-11-11T23:10:00+00:00' };
  T.carga_cierres.push(nuevo); vivo.carga_cierres({ eventType: 'INSERT', new: nuevo, old: {} }); await calma();
  assert.match(fila('#controlBox', 'Samanes').textContent, /Cargado/); assert.match(fila('#controlBox', 'Samanes').textContent, /3\.500,00/);
  assert.match(fila('#controlBox', 'Samanes').children[6].textContent, /7:10/);
  // the day picker keeps the focus while events arrive
  $('#cF').focus(); vivo.carga_cierres({ eventType: 'UPDATE', new: { ...nuevo, inc: 2 }, old: {} }); await tick(300);
  assert.equal(w.document.activeElement, $('#cF'), 'el selector de fecha no pierde el foco'); $('#cF').blur(); await tick(80);
  vivo.carga_metas({ eventType: 'DELETE', new: {}, old: { mes: '2026-11', sucursal: 'boqueron' } }); await calma();
  assert.equal(w.__t.D.metas.get('2026-11').boqueron, undefined, 'DELETE de meta solo con la clave');
  ok('evento en vivo de otra sucursal actualiza Carga del día');

  // ---- vicepresidencia and presidencia also save goals ----
  for (const u of ['vicepresidencia', 'presidencia']) {
    await entrarComo(u);
    tab('metas'); await tick();
    assert.ok(!$('#me-floresta').disabled && $('#fMe button[type=submit]'));
    $('#me-floresta').value = u === 'presidencia' ? '175.000,25' : '170000'; submit('#fMe'); await tick();
    gm = ultimas('carga_guardar_metas').at(-1).args; assert.equal(gm.p_metas.floresta, u === 'presidencia' ? 175000.25 : 170000);
    assert.ok($('#meErr').hidden, u + ': sin error');
  }
  ok('vicepresidencia y presidencia guardan metas con carga_guardar_metas');

  // ---- admin: supervision, goals read-only, only one with "Reabrir"; the armed button survives a repaint ----
  await entrarComo('admin');
  assert.equal(w.document.body.dataset.rol, 'sup');
  tab('metas'); await tick();
  assert.ok([...$('#metasBox').querySelectorAll('input')].every(i => i.disabled) && !$('#fMe button[type=submit]'), 'admin: metas solo lectura');
  tab('meses'); await tick();
  $('#mesesBox [data-re="juncal"]').click(); assert.equal($('#mesesBox [data-re="juncal"]').textContent, 'Confirmar reabrir');
  vivo.carga_cierres({ eventType: 'UPDATE', new: { ...nuevo, inc: 3 }, old: {} }); estadoCanal('CHANNEL_ERROR'); await calma();
  assert.equal($('#mesesBox [data-re="juncal"]').textContent, 'Confirmar reabrir', 'sigue armado tras repintar');
  $('#mesesBox [data-re="juncal"]').click(); await tick();
  assert.deepEqual(ultimas('carga_reabrir_mes').at(-1).args, { p_sucursal: 'juncal', p_mes: '2026-11' });
  assert.equal($('#mesesBox [data-re="juncal"]'), null); assert.ok($('#mesesBox [data-re="call-center"]'), 'el canal cerrado también se puede reabrir');
  assert.equal(w.__t.D.meses.get('juncal_2026-11').cerrado, false);
  estadoCanal('SUBSCRIBED'); await calma();
  ok('admin: supervisión, metas en solo lectura y Reabrir (armado se conserva) con carga_reabrir_mes');

  // ---- Productos: the chain's cross of the 5 best and 5 worst sellers ----
  const recargar = async () => { estadoCanal('CHANNEL_ERROR'); await calma(); estadoCanal('SUBSCRIBED'); await calma(); };
  const mesesGuardados = T.carga_meses; T.carga_meses = [];
  await recargar(); tab('productos'); await tick();
  assert.ok(!$('#v-productos').hidden); assert.match($('#productosBox').textContent, /Todavía no hay meses cerrados/);
  const cerrarMes = (s, top, sin_rot) => ({ sucursal: s, mes: '2026-10', cerrado: true, analisis: 'x', top, sin_rot, usuario: s, ts: '2026-11-01T12:00:00+00:00', reabierto_por: null, reabierto_ts: null });
  T.carga_meses = [...mesesGuardados,
    cerrarMes('juncal', ['ACETAMINOFEN 500MG', 'IBUPROFENO 400MG'], ['GASA ESTERIL']),
    cerrarMes('floresta', ['Acetaminofén 500 mg', '<b>Jarabe</b> 120ml'], ['Ibuprofeno 400 mg']),
    cerrarMes('samanes', ['ibuprofeno 400mg'], ['ACETAMINOFEN 500MG', 'gasa estéril']),
    cerrarMes('la-cruz', [], [])];
  await recargar();
  $('#prM').value = '2026-10'; $('#prM').dispatchEvent(new w.Event('change')); await tick();
  const filasDe = sel => [...$(sel).querySelectorAll('tbody tr')].map(r => [...r.children].map(c => c.textContent));
  const cruce = filasDe('#prCruce');
  assert.equal(cruce.length, 2, 'dos productos para trasladar');
  assert.deepEqual(cruce[0], ['ACETAMINOFEN 500MG', 'Floresta (1.º), Juncal (1.º)', 'Samanes (1.º)'], 'cruce, nombres normalizados y forma más usada');
  assert.match(cruce[1][0], /^ibuprofeno 400 ?mg$/i); assert.deepEqual(cruce[1].slice(1), ['Juncal (2.º), Samanes (1.º)', 'Floresta (1.º)']);
  const mas = filasDe('#pr-mas');
  assert.deepEqual(mas.map(r => r[1]), ['2', '2', '1']); assert.equal(mas[0][0], 'ACETAMINOFEN 500MG'); assert.equal(mas[2][0], '<b>Jarabe</b> 120ml');
  const menos = filasDe('#pr-menos');
  assert.match(menos[0][0], /^gasa est[eé]ril$/i); assert.equal(menos[0][1], '2'); assert.equal(menos[0][2], 'Juncal (1.º), Samanes (2.º)');
  assert.ok($('#productosBox').innerHTML.includes('&lt;b&gt;Jarabe&lt;/b&gt;'), 'nombre escapado');
  assert.ok(![...$('#productosBox').querySelectorAll('b')].some(b => b.textContent === 'Jarabe'), 'sin HTML inyectado');
  assert.match($('#prSuc').textContent, /Cerraron el mes sin llenar sus listas: La Cruz/);
  assert.equal(filasDe('#prSuc').length, 4);
  sinRaros('productos');
  // Excel of the cross
  let libro = null; const xlsxReal = w.XLSX;
  w.XLSX = Object.assign({}, XLSX, { write: (wb, o) => { libro = wb; return XLSX.write(wb, o); } });
  $('#prExcel').click(); await tick(); w.XLSX = xlsxReal;
  assert.ok(libro, 'generó el Excel'); assert.deepEqual(libro.SheetNames, ['Cruce', '5 mas vendidos', '5 menos vendidos', 'Por sucursal']);
  const hc = XLSX.utils.sheet_to_json(libro.Sheets.Cruce, { header: 1 });
  assert.deepEqual(hc[3], ['ACETAMINOFEN 500MG', 'Floresta (1.º), Juncal (1.º)', 'Samanes (1.º)']);
  for (const n of libro.SheetNames) for (const [k, c] of Object.entries(libro.Sheets[n])) if (k[0] !== '!') assert.ok(!/NaN|undefined|Infinity/.test(String(c.v)), 'celda rara en ' + n + '!' + k);
  T.carga_meses = mesesGuardados; await recargar();
  ok('Productos: estado vacío, ranking, cruce, nombres normalizados, HTML escapado, sucursales sin listas y Excel del cruce');

  // ---- gerencia signs out, a branch signs in: nothing of the previous user remains ----
  await entrarComo('gerencia');
  for (const t of ['control', 'meses', 'metas', 'resumen', 'sucursal', 'productos']) { tab(t); await tick(); }
  w.__t.U.fechaCtrl = '2026-11-10'; w.__t.U.mesMeses = '2026-11'; w.__t.U.mesMetas = '2026-12';
  await salirDe();
  for (const b of ['#controlBox', '#metasBox', '#mesesBox', '#productosBox', '#cargaBox', '#cierreBox', '#kpis', '#sesion']) assert.equal($(b).innerHTML, '', b + ' vacío');
  assert.equal(w.__t.U.fechaCtrl, null); assert.equal(w.__t.U.mesMeses, null); assert.equal(w.__t.U.mesMetas, null);
  assert.equal(w.__t.D.cierres.size + w.__t.D.meses.size + w.__t.D.metas.size, 0); assert.equal(w.__t.D.canal, null);
  assert.deepEqual(dondeSesion(), [false, false], 'al salir no queda sesión en ningún almacén');
  await entrarComo('la-cruz');
  assert.deepEqual(dondeSesion(), [true, false], 'de dirección a sucursal: nada queda en sessionStorage');
  for (const t of ['resumen', 'ticket', 'sucursal', 'cierre', 'carga']) { tab(t); await tick(); }
  for (const b of ['#controlBox', '#metasBox', '#mesesBox']) assert.equal($(b).innerHTML, '', b + ' vacío para la sucursal');
  tab('productos'); await tick();
  assert.ok($('#v-productos').hidden && $('#productosBox').innerHTML === '' && !$('#v-carga').hidden, 'la sucursal no ve Productos');
  const copia = w.document.body.cloneNode(true); copia.querySelectorAll('script').forEach(x => x.remove());
  const todo = copia.innerHTML;   // text and attributes of the whole page, without the page's own code
  for (const otra of ['Floresta', 'Samanes', 'Juncal', 'Boquerón', 'Cocuizas', 'Las Brisas']) assert.ok(!todo.includes(otra), 'quedó el nombre de otra sucursal: ' + otra);
  assert.ok(todo.includes('La Cruz'));
  ok('tras cerrar sesión gerencia, la sucursal no ve nada de otras sucursales (RLS en el falso)');

  // ---- a save that finishes after signing out leaves nothing behind ----
  tab('carga'); await tick();
  llenar({ iFarm: '10', iMisc: '0', iCli: '1', iFac: '1', iUni: '1', iInc: '0' });
  modo.retraso = 250; submit('#fC'); await tick(20);
  await salirDe(); await tick(400); modo.retraso = 0;
  assert.equal(w.__t.D.cierres.size, 0, 'nada aplicado'); assert.ok(!/guardado/.test($('#toastP')?.textContent || ''), 'sin aviso de guardado');
  assert.ok($('.app').hidden); assert.deepEqual(errors, []);
  ok('escribir que termina después de cerrar sesión no deja datos');

  // ---- no SUBSCRIBED within the wait: "Sin conexión" with a notice, and the data still shows ----
  modo.sinVivo = true; if (!$('.app').hidden) await salirDe();
  $('#lUser').value = 'floresta'; $('#lPass').value = 'buena'; submit('#fLogin');
  await hasta(() => w.__t.U.user?.id === 'floresta' && w.__t.D.lectura > 0 && quieto() && w.__t.D.cierres.size > 0, 'datos sin conexión en vivo');
  assert.match($('#sesion').textContent, /Sin conexión/); assert.match($('#modoNote').textContent, /conexión en vivo/);
  assert.ok($('#cargaBox [data-f="2026-11-10"]').classList.contains('ok'), 'se ven los datos ya cargados');
  modo.sinVivo = false;
  ok('sin SUBSCRIBED a tiempo: "Sin conexión" con aviso y los datos se ven');

  // ---- pagination: 2500 rows come back whole, in pages of 1000, with the date filter ----
  for (let i = 0; i < 2600; i++) T.carga_paginas.push({ fecha: i < 100 ? '2025-01-01' : '2026-' + String(1 + i % 10).padStart(2, '0') + '-01', sucursal: 's' + String(i).padStart(4, '0') });
  const nr2 = rangos.length, todas = await w.__t.leerTodo('carga_paginas', ['fecha', 'sucursal'], '2025-11-01');
  assert.equal(todas.length, 2500); assert.equal(new Set(todas.map(r => r.sucursal)).size, 2500);
  assert.deepEqual(rangos.slice(nr2).map(r => [r[1], r[2]]), [[0, 999], [1000, 1999], [2000, 2999]]);
  ok('la paginación junta 2500 filas');

  // ---- context null (e.g. the dashboard's admin account): back to the login with a notice ----
  await salirDe();
  $('#lUser').value = 'tablero'; $('#lPass').value = 'buena'; submit('#fLogin');
  await hasta(() => session === null && /no tiene acceso/.test($('#lErr').textContent), 'aviso de cuenta sin acceso');
  assert.ok(!$('#loginBox').hidden && $('.app').hidden);
  assert.equal($('#lErr').textContent, 'Esta cuenta no tiene acceso a la carga diaria.');
  ok('contexto nulo vuelve al login con aviso');

  const E = w.__t.errTxt;
  assert.equal(E({ message: 'CARGA_META_EN_USO: x' }), 'No se puede quitar la meta de una sucursal que ya cargó cierres en ese mes.');
  assert.equal(E({ message: 'CARGA_NO_CERRADO: ese mes no está cerrado' }), 'Ese mes no está cerrado.');
  assert.equal(E({ code: '42501', message: 'CARGA_SIN_PERMISO: solo la sucursal cierra su mes' }), 'Solo la sucursal cierra su mes.');
  assert.equal(E({ code: '22003', message: 'numeric field overflow' }), 'Número demasiado grande.');
  assert.equal(E({ code: '', message: 'TypeError: Failed to fetch' }), 'No se pudo guardar. Revisa tu conexión e intenta de nuevo.');
  assert.ok(!/conexión/.test(E({ code: '23505', message: 'duplicate key value' })), 'sin "revisa tu conexión" si no es de red');
  assert.equal(w.__t.esc(`'"<>&`), '&#39;&quot;&lt;&gt;&amp;', 'esc escapa también la comilla simple');
  ok('errTxt: CARGA_* con su texto, 22003, conexión solo en errores de red');
  assert.deepEqual(errors, [], 'cero errores de consola');
  ok('cero errores de consola');

  // ---------- static checks ----------
  for (const s of ['CLAVE_PRUEBA', 'META_EJ', 'llenarDemo', 'window.claude', "localStorage.setItem('prueba", 'service_role', 'lUsers']) assert.ok(!html.includes(s), 'el HTML no debe contener ' + s);
  ok('sin restos de la demostración ni service_role');
  try { execSync('git diff --quiet -- web/index.html web/prueba/index.html', { cwd: RAIZ, stdio: 'ignore' }); }
  catch { assert.fail('web/index.html o web/prueba/index.html cambiaron'); }
  ok('web/index.html y web/prueba/index.html sin cambios');

  // ---------- every script comes from this site ----------
  const srcs = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']?([^"' >]+)/gi)].map(m => m[1]);
  assert.deepEqual(srcs, ['vendor/xlsx.full.min.js', 'vendor/chart.umd.min.js', 'vendor/supabase.min.js'], 'scripts propios');
  for (const u of srcs) { assert.ok(!/^(https?:)?\/\//i.test(u), 'script de otro origen: ' + u); assert.ok(fs.statSync(path.join(RAIZ, 'web/carga', u)).size > 50000, 'falta ' + u); }
  assert.ok(fs.existsSync(path.join(RAIZ, 'web/carga/vendor/LEEME.txt')));
  ok('la página no carga scripts de otro origen y los tres archivos de vendor/ existen');

  // ---------- installable app: manifest, icons and service worker ----------
  const CARGA = path.join(RAIZ, 'web/carga');
  const enlaces = [...html.matchAll(/<link rel="(manifest|icon|apple-touch-icon)" href="([^"]+)"/g)].map(m => [m[1], m[2]]);
  for (const rel of ['manifest', 'icon', 'apple-touch-icon']) assert.ok(enlaces.some(e => e[0] === rel), 'enlaza ' + rel);
  for (const [, href] of enlaces) assert.ok(fs.existsSync(path.join(CARGA, href)), 'existe ' + href);
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">/);
  const man = JSON.parse(fs.readFileSync(path.join(CARGA, 'manifest.webmanifest'), 'utf8'));
  for (const t of ['192x192', '512x512']) assert.ok(man.icons.some(i => i.sizes === t && /png/.test(i.type)), 'icono ' + t);
  for (const i of man.icons) assert.ok(fs.existsSync(path.join(CARGA, i.src)), 'existe ' + i.src);
  // sw.js in a sandbox: its precache list matches real files, and it never answers Supabase or non-GET requests
  const vm = require('vm'), swSrc = fs.readFileSync(process.env.CARGA_SW || path.join(CARGA, 'sw.js'), 'utf8'), oyentes = {}, guardados = [];
  assert.ok(!/cdn|jsdelivr|cloudflare|unpkg|opaque/i.test(swSrc.replace(/^\s*\/?\*.*$|\/\/.*$/gm, '')), 'sw.js no menciona CDN ni guarda respuestas opacas');
  assert.match(swSrc, /const VERSION = 'v2'/);
  let respuesta = { ok: true, type: 'basic', clone() { return this; } };
  const caja = { self: { addEventListener: (t, fn) => { oyentes[t] = fn; }, skipWaiting() {}, clients: { claim() {} } }, location: new URL('https://statistics.example/carga/sw.js'), URL,
    caches: { open: async () => ({ add: async () => {}, put: async (k, r) => { guardados.push(r); } }), keys: async () => [], match: async () => undefined },
    fetch: async () => respuesta, Response: { error: () => null }, Promise };
  vm.runInNewContext(swSrc + ';this.__cascaron = CASCARON;', caja);
  for (const u of caja.__cascaron.filter(u => u !== './')) assert.ok(fs.existsSync(path.join(CARGA, u)), 'sw.js precachea un archivo que no existe: ' + u);
  for (const u of fs.readdirSync(path.join(CARGA, 'iconos'))) assert.ok(caja.__cascaron.includes('iconos/' + u), 'sw.js no precachea iconos/' + u);
  for (const u of srcs) assert.ok(caja.__cascaron.includes(u), 'sw.js no precachea ' + u);
  const atiende = (url, method = 'GET') => { let r = false; oyentes.fetch({ request: { url, method, mode: 'cors' }, respondWith() { r = true; } }); return r; };
  assert.ok(!atiende('https://qosmkkbcekbdzqfkhfgo.supabase.co/rest/v1/carga_cierres?select=*'), 'no intercepta la API de Supabase');
  assert.ok(!atiende('https://qosmkkbcekbdzqfkhfgo.supabase.co/auth/v1/token?grant_type=password'), 'no intercepta el login');
  assert.ok(!atiende('https://statistics.example/carga/', 'POST'), 'no intercepta lo que no es GET');
  assert.ok(atiende('https://statistics.example/carga/'), 'sí sirve el cascarón');
  assert.ok(!atiende('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js'), 'no atiende CDN');
  // what gets stored: only ok + basic responses, for page requests and for the install precache
  const servir = async res => { await tick(); respuesta = res; guardados.length = 0; let p; oyentes.fetch({ request: { url: 'https://statistics.example/carga/vendor/x.js', method: 'GET', mode: 'cors' }, respondWith(x) { p = x; } }); await p; await tick(); return guardados.length; };
  assert.equal(await servir({ ok: true, type: 'basic', clone() { return this; } }), 1, 'guarda la respuesta basic');
  for (const mala of [{ ok: false, status: 0, type: 'opaque' }, { ok: true, type: 'cors' }, { ok: false, status: 404, type: 'basic' }])
    assert.equal(await servir({ ...mala, clone() { return this; } }), 0, 'no guarda ' + JSON.stringify(mala));
  respuesta = { ok: false, status: 0, type: 'opaque', clone() { return this; } }; guardados.length = 0;
  let inst; oyentes.install({ waitUntil(x) { inst = x; } }); await inst; await tick();
  assert.equal(guardados.length, 0, 'la instalación no guarda respuestas opacas');
  ok('app instalable: manifest JSON con iconos 192 y 512, iconos enlazados existen, sw.js (v2) precachea archivos reales incluidos los de vendor/, no toca supabase.co ni CDN y solo guarda respuestas ok y basic');

  const ids = w.__t.TIENDAS.map(t => t.id).sort();
  assert.equal(ids.length, 32); assert.equal(new Set(ids).size, 32); assert.ok(ids.includes('call-center') && ids.includes('pagina-web'));
  const sqlPath = path.join(RAIZ, 'supabase/carga.sql');
  if (!fs.existsSync(sqlPath)) { console.error('FALLA: falta supabase/carga.sql; no se pueden comparar los 30 ids de sucursal con la base.'); process.exit(1); }
  const sql = fs.readFileSync(sqlPath, 'utf8'), bloque = sql.match(/insert into public\.carga_sucursales[\s\S]*?on conflict/i);
  assert.ok(bloque, 'carga.sql: no encontré el insert de carga_sucursales');
  const idsSql = [...bloque[0].matchAll(/\(\s*'([a-z0-9-]+)'\s*,/g)].map(m => m[1]).sort();
  assert.deepEqual(ids, idsSql, 'los 30 ids de TIENDAS deben ser iguales a los de supabase/carga.sql');
  ok('los 32 ids coinciden con supabase/carga.sql');

  console.log(`CARGA OK (${casos} casos)`);
  process.exit(0);
})().catch(e => { console.error(e); if (errors.length) console.error('Errores de la página:', errors); process.exit(1); });
