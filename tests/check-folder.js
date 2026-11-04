// Runs every Excel under a folder through the page's parser and reports what the dashboard would see: node check-folder.js <folder>
const fs=require('fs'),path=require('path'),vm=require('vm'),XLSX=require('xlsx');
const html=fs.readFileSync(__dirname+'/../web/index.html','utf8');
const P=vm.runInNewContext(html.match(/<script id="parser">([\s\S]*?)<\/script>/)[1]+';({parseWorkbook,storeKey,SUCURSALES,isPoderoso})',{XLSX});
const roster=new Set(P.SUCURSALES.map(P.storeKey));
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):/\.xlsx?$/i.test(e.name)?[path.join(d,e.name)]:[]);
const seen=new Map();
for(const f of walk(process.argv[2])){
  let r;try{r=P.parseWorkbook(XLSX.readFile(f),path.basename(f));}catch(e){console.log('ERROR LECTURA',f,e.message);continue;}
  const rel=path.relative(process.argv[2],f);
  if(r.kind!=='sucursal'){console.log('NO RECONOCIDO',rel,r.kind);continue;}
  for(const s of r.registros){
    const k=s.key+'|'+s.mes,flags=[];
    if(!s.mes)flags.push('SIN MES');
    if(!roster.has(s.key))flags.push('NO ESTA EN LISTA');
    if(!s.meta)flags.push('SIN META');
    if(s.enOtraMoneda)flags.push('DEPTOS EN OTRA MONEDA');
    if(!s.dias.length)flags.push('SIN DIAS');
    if(seen.has(k))flags.push('DUPLICADO con '+seen.get(k));
    seen.set(k,rel);
    console.log([rel,s.nombre,s.mes||'?','meta',s.meta,'venta',Math.round(s.total),(s.meta?Math.round(s.total/s.meta*1000)/10+'%':''),'dias',s.dias.length,flags.join(' | ')].join('  '));
  }
}
