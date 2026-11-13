// Genera los iconos PNG de web/carga/iconos/ a partir de logo.svg.
// Herramienta necesaria (no está en package.json a propósito):
//   npm install --no-save @resvg/resvg-js
// Uso: node scripts/generar-iconos.js
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const dir = path.join(__dirname, '..', 'web', 'carga', 'iconos');
const logo = fs.readFileSync(path.join(dir, 'logo.svg'), 'utf8');

// Mismo dibujo, pero sin el cuadro redondeado: fondo sólido de marca a sangre y el
// dibujo reducido y centrado dentro del 80 % central (zona segura de iconos maskable).
const defs = logo.match(/<defs>[\s\S]*?<\/defs>/)[0];
const formas = logo.split('<rect width="64" height="64" rx="16" fill="#04342C"/>')[1].replace('</svg>', '');
// El dibujo ocupa x 13-48, y 8.5-51 (centro 30.5, 29.75); se centra (escala 1) en 32,32.
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${defs}
<rect width="64" height="64" fill="#04342C"/>
<g transform="translate(32 32) scale(1) translate(-30.5 -29.75)">${formas}</g></svg>`;

function png(svg, size, nombre) {
  const out = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  fs.writeFileSync(path.join(dir, nombre), out);
  console.log(nombre, size + 'x' + size, out.length + ' bytes');
}
png(logo, 192, 'icono-192.png');
png(logo, 512, 'icono-512.png');
png(maskable, 512, 'icono-maskable-512.png');
png(logo, 180, 'apple-touch-icon.png');
png(logo, 32, 'favicon-32.png');
