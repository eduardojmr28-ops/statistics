#!/usr/bin/env node
// Crea (o actualiza) los usuarios de la carga diaria en Supabase (los 36 definitivos, o solo algunos con --solo).
//   node scripts/crear-usuarios-carga.js                  solo informa qué haría (no se conecta)
//   node scripts/crear-usuarios-carga.js --aplicar        crea los que faltan y los registra en public.carga_usuarios
//   node scripts/crear-usuarios-carga.js --cambiar-claves cambia la clave de los usuarios que ya existen
//   node scripts/crear-usuarios-carga.js --solo admin,juncal   trabaja solo con esos usuarios (se combina con lo anterior)
//   node scripts/crear-usuarios-carga.js --autoprueba     prueba la lógica pura, sin red
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY: variables de entorno si están puestas; si faltan, el programa las pide por teclado
// (la clave secreta se escribe sin mostrarse). Así no queda en el historial de la terminal. Las claves salen de .env.carga-claves.json (raíz, ignorado por git);
// CARGA_ARCHIVO_CLAVES (opcional) apunta a otro archivo. Cada usuario vale un texto (la clave) o {"correo":"...","clave":"..."}.
// Node 18+, solo fetch. Nunca imprime claves ni la service key.
'use strict';
const fs = require('fs');
const path = require('path');

const DOMINIO_USUARIOS = 'carga.invalid';   // igual que DOMINIO_USUARIOS en web/carga/index.html
const ARCHIVO_CLAVES = process.env.CARGA_ARCHIVO_CLAVES || path.join(__dirname, '..', '.env.carga-claves.json');
const MIN_CLAVE = 12;
// Mismos ids que public.carga_sucursales en supabase/carga.sql
const SUCURSALES = ['av-bolivar', 'boqueron', 'call-center', 'cocuizas', 'cortijos', 'ejercito', 'express-chimborazo', 'express-piar',
  'express-tipuro', 'floresta', 'furrial', 'gobernacion', 'guaritos', 'hospital', 'juncal', 'la-cascada', 'la-cruz',
  'las-avenidas', 'las-brisas', 'mercado', 'pagina-web', 'paramaconi', 'parque-morichal', 'plaza-7', 'poderoso-av-la-paz',
  'poderoso-hospital', 'poderoso-juncal', 'poderoso-tipuro', 'punta-de-mata', 'samanes', 'servimas', 'tipuro-palma-real'];
const DIRECCION = ['gerencia', 'vicepresidencia', 'presidencia'];

// ───────── Lógica pura ─────────
function listaEsperada() {
  return [
    ...SUCURSALES.map(u => ({ usuario: u, rol: 'sucursal', sucursal: u })),
    ...DIRECCION.map(u => ({ usuario: u, rol: u, sucursal: null })),
    { usuario: 'admin', rol: 'admin', sucursal: null },
  ];
}
const correoDe = usuario => `${usuario}@${DOMINIO_USUARIOS}`;
const correoValido = c => typeof c === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c);
// Un usuario que ya existe solo es de confianza si lo creó este script (lleva app_metadata.carga = true).
const esConfiable = u => !!(u && u.app_metadata && u.app_metadata.carga === true);
// La service key solo viaja por https (o por localhost / 127.0.0.1 en pruebas locales).
const urlSegura = url => typeof url === 'string' && (/^https:\/\/[^/\s]+/.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url));

// --solo a,b,c -> { lista, errores }. Sin --solo (solo === null) devuelve la lista completa.
function elegirUsuarios(esperada, solo) {
  if (solo === null || solo === undefined) return { lista: esperada, errores: [] };
  const nombres = String(solo).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!nombres.length) return { lista: [], errores: ['--solo necesita al menos un usuario, por ejemplo --solo admin,juncal.'] };
  const ids = esperada.map(e => e.usuario);
  const errores = [];
  const desconocidos = nombres.filter(n => !ids.includes(n));
  if (desconocidos.length) errores.push(`--solo incluye usuarios que no existen: ${desconocidos.join(', ')}`);
  if (new Set(nombres).size !== nombres.length) errores.push('--solo repite algún usuario.');
  return { lista: esperada.filter(e => nombres.includes(e.usuario)), errores };
}

// Interpreta el valor de un usuario: texto (clave) u objeto {correo, clave}. El correo efectivo siempre en minúsculas.
function entradaDe(usuario, valor) {
  if (typeof valor === 'string') return { clave: valor, correo: correoDe(usuario), propio: false };
  if (valor && typeof valor === 'object' && !Array.isArray(valor)) {
    const correo = typeof valor.correo === 'string' ? valor.correo.trim().toLowerCase() : valor.correo;
    return { clave: valor.clave, correo, propio: true };
  }
  return null;
}

// De dónde sale cada dato de conexión: variable de entorno o teclado. Sin terminal interactiva y con algo faltante, error.
function origenConexion(url, service, interactivo) {
  const faltan = [];
  if (!url) faltan.push('SUPABASE_URL');
  if (!service) faltan.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!faltan.length) return { pedirUrl: false, pedirClave: false, error: null };
  if (!interactivo) return { pedirUrl: false, pedirClave: false, error: `Falta ${faltan.join(' y ')} y no hay una terminal interactiva para pedirla. Ejecuta el programa desde una terminal normal, o define la variable de entorno.` };
  return { pedirUrl: !url, pedirClave: !service, error: null };
}
// Teclas de una entrada oculta: devuelve { texto, fin, cancelar }. Enter termina, Ctrl+C cancela, Backspace borra.
function aplicarTeclas(texto, teclas) {
  for (const ch of teclas) {
    if (ch === '\r' || ch === '\n') return { texto, fin: true, cancelar: false };
    if (ch === '\u0003') return { texto, fin: false, cancelar: true };
    if (ch === '\u007f' || ch === '\b') texto = texto.slice(0, -1);
    else if (ch >= ' ') texto += ch;
  }
  return { texto, fin: false, cancelar: false };
}
function pedir(pregunta, oculto) {
  return new Promise((resolve, reject) => {
    const entrada = process.stdin;
    process.stderr.write(pregunta);
    if (!oculto) {
      const rl = require('readline').createInterface({ input: entrada, output: process.stderr, terminal: true });
      rl.question('', r => { rl.close(); resolve(r.trim()); });
      return;
    }
    let texto = '';
    entrada.setRawMode(true); entrada.resume(); entrada.setEncoding('utf8');
    const alRecibir = d => {
      const r = aplicarTeclas(texto, d);
      texto = r.texto;
      if (r.fin || r.cancelar) {
        entrada.setRawMode(false); entrada.pause(); entrada.removeListener('data', alRecibir);
        process.stderr.write('\n');
        r.cancelar ? reject(new Error('Cancelado.')) : resolve(texto.trim());
      }
    };
    entrada.on('data', alRecibir);
  });
}

// Valida solo los usuarios de `lista`; las demás llaves del archivo se ignoran si ignorarOtros. Nunca incluye el valor de una clave.
function validarClaves(claves, lista = listaEsperada(), ignorarOtros = false) {
  const errores = [];
  if (!claves || typeof claves !== 'object' || Array.isArray(claves)) return ['El archivo de claves debe ser un objeto {"usuario":"clave", ...}.'];
  const ids = lista.map(e => e.usuario);
  const llaves = Object.keys(claves);
  const faltan = ids.filter(u => !llaves.includes(u));
  const sobran = ignorarOtros ? [] : llaves.filter(u => !ids.includes(u));
  if (faltan.length) errores.push(`Faltan usuarios: ${faltan.join(', ')}`);
  if (sobran.length) errores.push(`Usuarios que no existen: ${sobran.join(', ')}`);
  const claveVista = new Map();
  const correoVisto = new Map();
  for (const u of ids) {
    if (!(u in claves)) continue;
    const en = entradaDe(u, claves[u]);
    if (!en) { errores.push(`El valor de "${u}" debe ser un texto (la clave) o un objeto {"correo":"...","clave":"..."}.`); continue; }
    if (en.propio && !correoValido(en.correo)) errores.push(`El correo de "${u}" no es válido.`);
    if (typeof en.clave !== 'string') { errores.push(`La clave de "${u}" debe ser un texto.`); continue; }
    if (en.clave.length < MIN_CLAVE) errores.push(`La clave de "${u}" tiene menos de ${MIN_CLAVE} caracteres.`);
    if (en.clave.toLowerCase() === u.toLowerCase()) errores.push(`La clave de "${u}" es igual al usuario.`);
    if (en.propio && correoValido(en.correo) && en.clave.toLowerCase() === en.correo) errores.push(`La clave de "${u}" es igual al correo.`);
    if (claveVista.has(en.clave)) errores.push(`Las claves de "${claveVista.get(en.clave)}" y "${u}" son iguales.`);
    else claveVista.set(en.clave, u);
    if (typeof en.correo === 'string') {
      if (correoVisto.has(en.correo)) errores.push(`Los usuarios "${correoVisto.get(en.correo)}" y "${u}" tienen el mismo correo.`);
      else correoVisto.set(en.correo, u);
    }
  }
  return errores;
}

// Quién entra y con qué correo: [{...usuario, correo, propio, clave}] (solo para uso interno; la clave no se imprime).
const entradas = (claves, lista) => lista.map(e => ({ ...e, ...entradaDe(e.usuario, claves[e.usuario]) }));

// ───────── Supabase ─────────
function cliente(url, key) {
  const base = url.replace(/\/+$/, '');
  const cab = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  return async function llamar(metodo, ruta, cuerpo, extra) {
    const r = await fetch(base + ruta, { method: metodo, headers: { ...cab, ...(extra || {}) }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    const texto = await r.text();
    let json = null;
    try { json = texto ? JSON.parse(texto) : null; } catch (_) { /* respuesta que no es JSON */ }
    return { ok: r.ok, status: r.status, json, texto };
  };
}
const mensajeDe = (r, secretos) => {
  let m = (r.json && (r.json.msg || r.json.message || r.json.error_description || r.json.error)) || r.texto || '';
  m = String(m);
  for (const s of secretos) if (s) m = m.split(s).join('***');
  return `HTTP ${r.status}${m ? ': ' + m.slice(0, 200) : ''}`;
};

async function usuariosExistentes(llamar) {
  const mapa = new Map();
  for (let pagina = 1; ; pagina++) {
    const r = await llamar('GET', `/auth/v1/admin/users?page=${pagina}&per_page=200`);
    if (!r.ok) throw new Error(`No se pudo leer la lista de usuarios (${mensajeDe(r, [])})`);
    const lista = (r.json && r.json.users) || [];
    for (const u of lista) if (u.email) mapa.set(u.email.toLowerCase(), { id: u.id, app_metadata: u.app_metadata });
    if (lista.length < 200) return mapa;
  }
}

// Lee --solo a,b o --solo=a,b. null si no se pidió.
function leerSolo(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--solo') return args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : '';
    if (args[i].startsWith('--solo=')) return args[i].slice(7);
  }
  return null;
}

async function ejecutar(args) {
  const aplicar = args.includes('--aplicar');
  const cambiar = args.includes('--cambiar-claves');
  const solo = leerSolo(args);
  let url = process.env.SUPABASE_URL || '';
  let service = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  const { lista, errores: errSolo } = elegirUsuarios(listaEsperada(), solo);
  if (errSolo.length) throw new Error(errSolo.join('\n'));
  const total = lista.length;

  if (!fs.existsSync(ARCHIVO_CLAVES)) throw new Error('No existe .env.carga-claves.json en la raíz del proyecto. Créalo con {"usuario":"clave", ...} (o {"correo":"...","clave":"..."}) para los usuarios que vas a crear.');
  let claves;
  try { claves = JSON.parse(fs.readFileSync(ARCHIVO_CLAVES, 'utf8')); }
  catch (_) { throw new Error('.env.carga-claves.json no es un JSON válido.'); }
  const errores = validarClaves(claves, lista, solo !== null);
  if (errores.length) throw new Error('Hay problemas en .env.carga-claves.json:\n - ' + errores.join('\n - '));
  const quienes = entradas(claves, lista);

  if (!aplicar && !cambiar) {
    console.log('Modo informe: no se conecta ni cambia nada. Con --aplicar se haría lo siguiente.');
    console.log(`  SUPABASE_URL: ${url ? 'definida' : 'se pedirá por teclado'}. SUPABASE_SERVICE_ROLE_KEY: ${service ? 'definida' : 'se pedirá por teclado (sin mostrarse)'}.`);
    console.log(`  Archivo de claves: correcto (${total} usuarios${solo !== null ? ' pedidos con --solo; los demás se ignoran' : ''}, claves de ${MIN_CLAVE} o más caracteres, sin repetidas).`);
    console.log('  Se crearían los usuarios que no existan y se registrarían en public.carga_usuarios:');
    for (const q of quienes) console.log(`   - ${q.usuario.padEnd(22)} rol ${q.rol.padEnd(16)} ${q.propio ? `entra con el correo ${q.correo}` : `entra con el usuario ${q.usuario}`}`);
    console.log('  Los usuarios que ya existen no se tocan (para cambiar su clave: --cambiar-claves).');
    return;
  }
  const origen = origenConexion(url, service, !!(process.stdin.isTTY && process.stderr.isTTY));
  if (origen.error) throw new Error(origen.error);
  if (origen.pedirUrl) url = await pedir('Dirección del proyecto (SUPABASE_URL, https://...): ', false);
  if (origen.pedirClave) service = await pedir('Clave secreta service_role (no se muestra al escribir ni se guarda): ', true);
  if (!url || !service) throw new Error('Faltan la dirección del proyecto o la clave secreta.');
  if (!urlSegura(url)) throw new Error('SUPABASE_URL debe empezar con https:// (solo se admite http://localhost o http://127.0.0.1). Así la service key no viaja sin cifrar.');

  const secretos = [service, ...quienes.map(q => q.clave)];
  const llamar = cliente(url, service);
  const existentes = await usuariosExistentes(llamar);
  // Revisar a todos antes de escribir: un correo que ya existía y no creó este script puede ser de otra persona.
  const sospechosos = quienes.filter(q => existentes.has(q.correo) && !esConfiable(existentes.get(q.correo)));
  if (sospechosos.length) {
    throw new Error(sospechosos.map(q => q.propio
      ? `El correo ${q.correo} (usuario "${q.usuario}") ya tiene una cuenta en el proyecto que no fue creada por este programa (por ejemplo la del administrador del tablero).`
      : `El usuario "${q.usuario}" ya existe y no fue creado por este programa.`).join('\n') +
      '\nRevísalo en Supabase > Authentication > Users (quizá alguien se registró antes). Usa otro correo o avisa antes de seguir. No se registró ni cambió nada.');
  }
  const res = { creados: 0, registrados: 0, clavesCambiadas: 0, sinCambio: 0 };
  let primeraCreacion = true;

  for (const q of quienes) {
    let id = (existentes.get(q.correo) || {}).id;
    if (!id && aplicar) {
      const r = await llamar('POST', '/auth/v1/admin/users', { email: q.correo, password: q.clave, email_confirm: true, app_metadata: { carga: true } });
      if (!r.ok) {
        if (primeraCreacion && r.status >= 400 && r.status < 500) {
          throw new Error(`Supabase rechazó el primer usuario (${q.correo}): ${mensajeDe(r, secretos)}.\n` +
            `Probablemente no acepta el dominio "${DOMINIO_USUARIOS}". No se creó nada más. Plan B: usar un subdominio propio\n` +
            '(por ejemplo carga.sudominio.com) y cambiar DOMINIO_USUARIOS en este script y en web/carga/index.html.');
        }
        throw new Error(`No se pudo crear "${q.usuario}" (${mensajeDe(r, secretos)}). Se detuvo; al volver a ejecutar se retoma donde quedó.`);
      }
      id = r.json && r.json.id;
      existentes.set(q.correo, { id, app_metadata: { carga: true } });
      res.creados++;
    } else if (id && cambiar) {
      const r = await llamar('PUT', `/auth/v1/admin/users/${id}`, { password: q.clave });
      if (!r.ok) throw new Error(`No se pudo cambiar la clave de "${q.usuario}" (${mensajeDe(r, secretos)}).`);
      res.clavesCambiadas++;
    } else if (id) res.sinCambio++;
    primeraCreacion = false;
    if (id && aplicar) {
      const r = await llamar('POST', '/rest/v1/carga_usuarios?on_conflict=user_id',
        { user_id: id, usuario: q.usuario, rol: q.rol, sucursal: q.sucursal },
        { Prefer: 'resolution=merge-duplicates,return=minimal' });
      if (!r.ok) throw new Error(`No se pudo registrar "${q.usuario}" en carga_usuarios (${mensajeDe(r, secretos)}). ¿Ya pegaste supabase/carga.sql?`);
      res.registrados++;
    }
  }
  console.log(`Listo. Usuarios creados: ${res.creados}. Registrados en carga_usuarios: ${res.registrados}. ` +
    `Claves cambiadas: ${res.clavesCambiadas}. Existentes sin tocar: ${res.sinCambio}.`);
}

// ───────── Autoprueba (sin red) ─────────
function autoprueba() {
  const assert = require('assert');
  const esp = listaEsperada();
  const buenas = () => Object.fromEntries(esp.map((e, i) => [e.usuario, `Clave-de-prueba-${String(i).padStart(2, '0')}x`]));
  assert.strictEqual(esp.length, 36, 'deben ser 36 usuarios');
  assert.strictEqual(new Set(esp.map(e => e.usuario)).size, 36, 'usuarios únicos');
  assert.strictEqual(esp.filter(e => e.rol === 'sucursal').length, 32);
  assert(esp.filter(e => e.rol === 'sucursal').every(e => e.sucursal === e.usuario), 'sucursal = usuario');
  assert(esp.filter(e => e.rol !== 'sucursal').every(e => e.sucursal === null), 'dirección y admin sin sucursal');
  assert.deepStrictEqual(esp.slice(-4).map(e => e.rol), ['gerencia', 'vicepresidencia', 'presidencia', 'admin']);
  assert(esp.every(e => /^[a-z0-9-]{2,40}$/.test(e.usuario)), 'ids válidos para carga_usuarios');
  assert.strictEqual(correoDe('juncal'), 'juncal@carga.invalid');
  assert.deepStrictEqual(validarClaves(buenas()), []);
  let c = buenas(); delete c.juncal;
  assert(validarClaves(c).some(m => m.includes('Faltan') && m.includes('juncal')), 'llave faltante');
  c = buenas(); c.fantasma = 'Clave-larga-12345';
  assert(validarClaves(c).some(m => m.includes('no existen') && m.includes('fantasma')), 'llave sobrante');
  c = buenas(); c.juncal = 'corta';
  assert(validarClaves(c).some(m => m.includes('"juncal"') && m.includes('menos de')), 'clave corta');
  assert(!validarClaves(c).join(' ').includes('corta'), 'los errores no incluyen la clave');
  c = buenas(); c.admin = c.gerencia;
  assert(validarClaves(c).some(m => m.includes('son iguales')), 'clave repetida');
  c = buenas(); c.servimas = 'SERVIMAS';
  assert(validarClaves(c).some(m => m.includes('"servimas"') && m.includes('igual al usuario')), 'clave igual al usuario (mayúsculas distintas)');
  c = buenas(); c['plaza-7'] = 12345678901;
  assert(validarClaves(c).some(m => m.includes('"plaza-7"') && m.includes('debe ser un texto')), 'valor que no es texto ni objeto');
  assert(validarClaves(null).length && validarClaves([]).length, 'no es objeto');
  assert(esConfiable({ id: 'x', app_metadata: { carga: true } }), 'existente con marca');
  assert(!esConfiable({ id: 'x', app_metadata: { provider: 'email' } }), 'existente sin marca');
  assert(!esConfiable({ id: 'x', app_metadata: { carga: 'true' } }), 'marca que no es booleana');
  assert(!esConfiable({ id: 'x' }) && !esConfiable({ id: 'x', app_metadata: null }) && !esConfiable(undefined), 'sin app_metadata');
  assert(urlSegura('https://abc.supabase.co') && urlSegura('http://localhost:54321') && urlSegura('http://127.0.0.1:9'), 'urls válidas');
  assert(!urlSegura('http://abc.supabase.co') && !urlSegura('') && !urlSegura(undefined) && !urlSegura('http://localhost.evil.com') && !urlSegura('ftp://x'), 'urls rechazadas');

  // de dónde sale la clave secreta
  assert.deepStrictEqual(origenConexion('https://x', 'k', false), { pedirUrl: false, pedirClave: false, error: null }, 'variables puestas: no pide nada ni sin terminal');
  assert.deepStrictEqual(origenConexion('https://x', '', true), { pedirUrl: false, pedirClave: true, error: null }, 'falta la clave: la pide');
  assert.deepStrictEqual(origenConexion('', 'k', true), { pedirUrl: true, pedirClave: false, error: null }, 'falta la URL: la pide');
  assert.deepStrictEqual(origenConexion('', '', true), { pedirUrl: true, pedirClave: true, error: null });
  assert(/SUPABASE_SERVICE_ROLE_KEY/.test(origenConexion('https://x', '', false).error || ''), 'sin terminal y sin clave: error claro');
  assert.deepStrictEqual(aplicarTeclas('', 'abc\r'), { texto: 'abc', fin: true, cancelar: false }, 'enter termina');
  assert.deepStrictEqual(aplicarTeclas('', 'abx\u007fc'), { texto: 'abc', fin: false, cancelar: false }, 'backspace borra');
  assert.strictEqual(aplicarTeclas('ab', '\u0003').cancelar, true, 'ctrl+c cancela');
  // --solo
  let s = elegirUsuarios(esp, 'admin,gerencia,juncal,floresta');
  assert.deepStrictEqual(s.errores, []);
  assert.deepStrictEqual(s.lista.map(e => e.usuario).sort(), ['admin', 'floresta', 'gerencia', 'juncal']);
  assert.strictEqual(elegirUsuarios(esp, null).lista.length, 36, 'sin --solo, los 36');
  assert(elegirUsuarios(esp, 'admin,nadie').errores.some(m => m.includes('nadie')), '--solo con nombre desconocido');
  assert(elegirUsuarios(esp, '').errores.length, '--solo vacío');
  assert(elegirUsuarios(esp, 'admin,admin').errores.length, '--solo repetido');
  assert.strictEqual(leerSolo(['--solo', 'a,b']), 'a,b');
  assert.strictEqual(leerSolo(['--solo=a,b', '--aplicar']), 'a,b');
  assert.strictEqual(leerSolo(['--aplicar']), null);
  const pocas = { admin: { correo: 'Dueno@Ejemplo.com', clave: 'Clave-admin-123' }, gerencia: 'Clave-gerencia-1', juncal: 'Clave-juncal-12', floresta: 'Clave-floresta-1' };
  assert.deepStrictEqual(validarClaves(pocas, s.lista, true), [], 'solo los pedidos; los demás faltan y se ignoran');
  assert(validarClaves(pocas, esp, false).some(m => m.includes('Faltan')), 'sin --solo exige los 36');
  assert.deepStrictEqual(validarClaves({ ...pocas, 'servimas': '', zzz: 5 }, s.lista, true), [], 'los demás, vacíos o raros, se ignoran');
  c = { ...pocas }; delete c.floresta;
  assert(validarClaves(c, s.lista, true).some(m => m.includes('Faltan') && m.includes('floresta')), 'falta uno de los pedidos');
  // correo propio
  assert.deepStrictEqual(entradaDe('admin', pocas.admin), { clave: 'Clave-admin-123', correo: 'dueno@ejemplo.com', propio: true }, 'correo en minúsculas');
  assert.deepStrictEqual(entradaDe('juncal', 'x'), { clave: 'x', correo: 'juncal@carga.invalid', propio: false });
  assert.strictEqual(entradas(pocas, s.lista).find(q => q.usuario === 'admin').correo, 'dueno@ejemplo.com');
  assert(validarClaves({ ...pocas, admin: { correo: 'sin-arroba', clave: 'Clave-admin-123' } }, s.lista, true).some(m => m.includes('correo de "admin"')), 'correo inválido');
  assert(validarClaves({ ...pocas, admin: { clave: 'Clave-admin-123' } }, s.lista, true).some(m => m.includes('correo de "admin"')), 'objeto sin correo');
  assert(validarClaves({ ...pocas, gerencia: { correo: 'DUENO@ejemplo.com', clave: 'Clave-gerencia-1' } }, s.lista, true).some(m => m.includes('mismo correo')), 'correo repetido');
  assert(validarClaves({ ...pocas, admin: { correo: 'a@b.co', clave: 'corta' } }, s.lista, true).some(m => m.includes('"admin"') && m.includes('menos de')), 'objeto con clave corta');
  assert(!validarClaves({ ...pocas, admin: { correo: 'a@b.co', clave: 'corta' } }, s.lista, true).join(' ').includes('corta'), 'sin claves en los errores (objeto)');
  assert(validarClaves({ ...pocas, admin: { correo: 'juncal@carga.invalid', clave: 'Clave-admin-123' } }, s.lista, true).some(m => m.includes('mismo correo')), 'correo propio igual al sintético de otro');
  console.log('Autoprueba: todo correcto (36 usuarios, roles, llaves faltantes o sobrantes, claves cortas, repetidas o iguales al usuario, existente confiable o no, URL, origen de la clave secreta, --solo, correos propios).');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const conocidos = ['--aplicar', '--cambiar-claves', '--autoprueba'];
  const raros = args.filter((a, i) => !conocidos.includes(a) && !a.startsWith('--solo=') && !(a === '--solo') && !(i > 0 && args[i - 1] === '--solo' && !a.startsWith('--')));
  if (raros.length) { console.error(`Opción desconocida: ${raros.join(' ')}. Opciones: ${conocidos.join(', ')}, --solo usuario1,usuario2.`); process.exit(2); }
  if (args.includes('--autoprueba')) autoprueba();
  else ejecutar(args).catch(e => { console.error('Error: ' + e.message); process.exit(1); });
}
module.exports = { origenConexion, aplicarTeclas, listaEsperada, validarClaves, correoDe, esConfiable, urlSegura, elegirUsuarios, entradaDe, DOMINIO_USUARIOS };
