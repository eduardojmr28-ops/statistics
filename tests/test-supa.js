// Runs web/index.html headless against an in-memory fake of supabase-js: node test-supa.js <sucursal.xls>
const fs = require('fs'), assert = require('assert'), { JSDOM } = require('jsdom'), XLSX = require('xlsx');
const html = fs.readFileSync(__dirname + '/../web/index.html', 'utf8').replace(/<script src=[^>]*><\/script>/g, '');
const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://statistics.example/' });
const w = dom.window, errors = [];
w.addEventListener('error', e => errors.push(e.message));
w.XLSX = XLSX; w.Chart = class { constructor() {} destroy() {} }; w.Chart.defaults = { font: {} };
w.matchMedia = () => ({ addEventListener() {} });

// fake: rows table, a session flag, and an RLS rule like the SQL (only admin@x writes)
let rows = [], session = null, authCb = null, otp = null, live = null;
const rls = () => session?.user.email === 'admin@x' ? null : { message: 'new row violates row-level security policy' };
w.supabase = { createClient: () => ({
  auth: {
    getSession: async () => ({ data: { session } }),
    onAuthStateChange: cb => { authCb = cb; },
    signInWithOtp: async o => { otp = o; return { error: null }; },
    signOut: async () => { session = null; authCb('SIGNED_OUT', null); },
  },
  from: () => ({
    select: () => ({ order: async () => ({ data: [...rows].sort((a, b) => a.orden - b.orden), error: null }) }),
    insert: async items => { const e = rls(); if (!e) rows.push(...items.map((x, i) => ({ id: 'u' + rows.length + i, ...x }))); return { error: e }; },
    delete: () => ({ in: async (_c, ids) => { const e = rls(); if (!e) rows = rows.filter(r => !ids.includes(r.id)); return { error: e }; } }),
  }),
  channel: () => ({ on: (_e, _f, cb) => { live = cb; return { subscribe() {} }; } }),
}) };

const code = [...html.matchAll(/<script(?: id="parser")?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
w.eval(code.replace(/const SUPABASE_URL='[^']*'/, "const SUPABASE_URL='https://x.supabase.co'") + ';window.handleFiles=handleFiles;');
const $ = s => w.document.querySelector(s);
const file = { name: process.argv[2].split(/[\\/]/).pop(), arrayBuffer: async () => fs.readFileSync(process.argv[2]) };
const tick = () => new Promise(r => setTimeout(r, 20));

(async () => {
  await tick();
  // visitor: sees login, no upload area, a write attempt is refused by "RLS"
  assert.ok(!$('#login').hidden && $('#drop').hidden && $('#salir').hidden, 'visitor view');
  await w.handleFiles([file]);
  assert.equal(rows.length, 0); assert.match($('#dbNote').textContent, /permiso/);

  // login sends a magic link without creating users
  $('#correo').value = 'admin@x'; $('#login').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick();
  assert.equal(otp.email, 'admin@x'); assert.equal(otp.options.shouldCreateUser, false);

  // admin: can upload, the table fills, then delete
  session = { user: { email: 'admin@x' } }; authCb('SIGNED_IN', session); await tick();
  assert.ok($('#login').hidden && !$('#drop').hidden && !$('#salir').hidden, 'admin view');
  await w.handleFiles([file]);
  assert.equal(rows.length, 1); assert.equal($('#nArch').textContent, '1');
  const saved = rows[0];
  assert.ok(!$('#s-tabla').hidden, 'dashboard shows data');
  $('#archivos').querySelector('[data-del]').click(); await tick();
  assert.equal(rows.length, 0); assert.equal($('#nArch').textContent, '0');

  // another viewer's change arrives through realtime
  rows.push({ ...saved, id: 'z' });
  await live(); assert.equal($('#nArch').textContent, '1');

  $('#salir').click(); await tick();
  assert.ok(!$('#login').hidden && $('#drop').hidden, 'signed out');
  assert.deepEqual(errors, []);
  console.log('SUPABASE OK');
})().catch(e => { console.error(e); process.exit(1); });
