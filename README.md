# Statistics

Tablero de indicadores de gestión de las sucursales. Lee las *Estadísticas de ventas* (FRMD-F-SC-018) en el navegador y las guarda en Supabase.

- `web/index.html`: el tablero completo (una sola página). Arriba del todo están `SUPABASE_URL` y `SUPABASE_ANON_KEY`.
- `supabase/setup.sql`: crea la tabla `archivos` y sus permisos (todos leen, solo el correo administrador escribe).
- `netlify.toml`: Netlify publica la carpeta `web`.

## Pruebas

```
npm install
npm test -- "ruta/a/OCTUBRE AV BOLIVAR.xls"
npm run revisar -- "ruta/a/carpeta de un mes"
```

## Carga diaria

Es la versión real de la demostración `/prueba/`: cada sucursal carga a diario sus cierres (ventas, clientes, facturas, unidades, incidencias) y la gerencia general, la vicepresidencia y la presidencia cargan las metas del mes. Vive en el mismo proyecto de Supabase, pero en tablas aparte (`carga_...`): **no toca el tablero ni la tabla `archivos`**. La dirección web es `/carga/` (por ejemplo `https://tu-sitio.netlify.app/carga/`).

- `web/carga/`: la página de carga.
- `supabase/carga.sql`: las tablas, los permisos y las reglas de la carga.
- `scripts/crear-usuarios-carga.js`: crea los 36 usuarios (32 sucursales, incluidos Call Center y Página Web, `gerencia`, `vicepresidencia`, `presidencia` y `admin`). Cada uno entra con su usuario (por ejemplo `juncal`) y su clave.
  El Call Center y la Página Web cargan como una sucursal más (usuarios `call-center` y `pagina-web`).

Hay un solo mes de inicio (noviembre 2026) y, sin meta cargada, una sucursal no puede guardar cierres. Cada sucursal corrige sus días hasta que cierra el mes; después solo el usuario `admin` puede reabrirlo.

### Pasos que solo tú puedes hacer, en este orden

1. **Pegar el SQL.** En Supabase abre *SQL Editor > New query*, pega todo el contenido de `supabase/carga.sql` y pulsa *Run*. Se puede ejecutar más de una vez sin problema.
2. **Cerrar el registro abierto (obligatorio, antes de crear los usuarios).** En Supabase: *Authentication > Sign In / Providers* (o *Settings*) y desactiva *Allow new users to sign up*. Si queda abierto, alguien podría registrar antes un correo como `admin@carga.invalid` con su propia clave y quedarse con esa cuenta; el programa se niega a continuar si encuentra usuarios que él no creó, pero cerrar el registro evita el problema de raíz.
3. **Crear el archivo de claves.** En la carpeta del proyecto crea `.env.carga-claves.json` con una clave para cada uno de los 36 usuarios, así (los textos de ejemplo no son claves reales):
   ```
   {"av-bolivar": "una clave tuya", "boqueron": "otra clave", "...": "...", "gerencia": "...", "vicepresidencia": "...", "presidencia": "...", "admin": "..."}
   ```
   Cada clave debe tener 12 caracteres o más (mejor 14 o más, aleatorias: los nombres de usuario se pueden adivinar, así que la clave es la única barrera), ser distinta de las demás y distinta del nombre de usuario. Faltan o sobran usuarios: el programa te lo dice. Este archivo no se sube a GitHub (git lo ignora); no lo envíes ni lo pegues en ningún chat. Guarda las claves en un gestor de claves y borra este archivo cuando ya no haga falta.
4. **Crear los usuarios.** En Supabase, *Project Settings > API*, ten a mano la clave `service_role` (es secreta: nunca en el repositorio ni en un chat). En una terminal normal, dentro de la carpeta del proyecto:
   ```
   npm run usuarios:carga
   npm run usuarios:carga -- --aplicar
   ```
   El primero solo muestra qué haría y no cambia nada; el segundo crea los usuarios. Al ejecutar el segundo, el programa te pide la dirección del proyecto (la que aparece en *Project Settings > API*) y la clave secreta: pégala cuando la pida; no se ve en pantalla al escribirla ni queda en el historial. (Si prefieres, la dirección puede ir en una variable: `set SUPABASE_URL=https://TU-PROYECTO.supabase.co` en cmd, o `$env:SUPABASE_URL="..."` en PowerShell.) Si ya escribiste alguna vez la clave secreta en PowerShell, borra esa línea del archivo `%APPDATA%\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt`. Si Supabase rechaza el correo interno `@carga.invalid`, el programa se detiene en el primer usuario y lo explica: avísame y usamos un dominio tuyo.
5. **Cargar las metas de noviembre 2026.** Entra en `/carga/` como `gerencia` (o vicepresidencia o presidencia) y carga la meta de cada sucursal. Hasta entonces ninguna sucursal puede guardar cierres.

### Usuarios de prueba (mientras llegan los correos de las sucursales)

Para empezar con pocos usuarios, en `.env.carga-claves.json` pon solo los que vas a crear. Cada uno puede ser una clave (entra con su usuario corto) o un objeto con su correo real. Ejemplo (los valores no son claves reales):

```
{"admin": {"correo": "tu-correo@ejemplo.com", "clave": "una clave tuya"}, "gerencia": "otra clave", "juncal": "otra clave", "floresta": "otra clave"}
```

Con `--solo` el programa trabaja únicamente con esos usuarios e ignora el resto del archivo. Primero el informe y luego la creación:

```
npm run usuarios:carga -- --solo admin,gerencia,juncal,floresta
npm run usuarios:carga -- --solo admin,gerencia,juncal,floresta --aplicar
```

Igual que antes, al aplicar el programa pide la clave secreta por teclado.

El `admin` entra en `/carga/` escribiendo su correo en el campo de usuario; los demás escriben su usuario corto (`gerencia`, `juncal`, `floresta`). Si el correo ya tiene una cuenta en el proyecto (por ejemplo la del administrador del tablero), el programa se detiene sin cambiar nada: usa otro correo. Más adelante se crean los demás usuarios con el mismo comando, sin `--solo`.

### Reabrir un mes

Solo el usuario `admin` puede. Entra en `/carga/` como `admin`, abre la vista de meses, busca la sucursal y el mes cerrado y pulsa *Reabrir*. La sucursal podrá corregir ese mes y volver a cerrarlo; mientras esté reabierto no puede cargar el mes en curso. La gerencia, la vicepresidencia y la presidencia no reabren.

### Reponer una clave

Si una sucursal olvida o cambia su clave: edita su clave en `.env.carga-claves.json`, ejecuta lo siguiente (el programa vuelve a pedir la clave secreta):

```
npm run usuarios:carga -- --cambiar-claves
```

Solo cambia la clave de los usuarios que ya existen; no crea ni borra a nadie. Nota: cualquier usuario puede cambiar su propia clave desde la app de Supabase; eso no le da más permisos y se repone con este mismo comando.

### Eliminar esta versión sin afectar al tablero

1. En el *SQL Editor* ejecuta el bloque comentado al final de `supabase/carga.sql` (quita los `--` de esas líneas). Borra solo tablas y funciones que empiezan por `carga_`.
2. En *Authentication > Users* borra los 36 usuarios cuyo correo termina en `@carga.invalid`.
3. Borra la carpeta `web/carga/`.

El tablero y la tabla `archivos` no se ven afectados.

### Pruebas de la carga diaria

```
npm run test:carga       # la página /carga/ con un Supabase simulado
npm run test:carga-rls   # los permisos de la base de datos (sin conectarse al proyecto real)
node scripts/crear-usuarios-carga.js --autoprueba   # la lista de usuarios y la validación de claves
```

### Qué más trae la carga diaria

- **Call Center y Página Web** cargan como una tienda más (usuarios `call-center` y `pagina-web`), sin mínimo de ticket de grupo.
- **Productos** (solo supervisión): cruza los 5 más vendidos y los 5 menos vendidos que cada tienda escribe al cerrar el mes, y muestra qué producto se vende bien en unas y poco en otras. Se descarga en Excel.
- **Instalable**: en Chrome o Edge aparece "Instalar" en la barra de direcciones; en el teléfono, "Instalar app" o "Añadir a pantalla de inicio". Los iconos están en `web/carga/iconos/` y se regeneran con `node scripts/generar-iconos.js`.
- **Librerías propias** en `web/carga/vendor/` (no dependen de servidores externos; origen y versión en `LEEME.txt`).
- **Sesión**: la de una sucursal queda guardada en su computadora; la de gerencia, vicepresidencia, presidencia y administrador se cierra sola al cerrar la pestaña.
- Las cabeceras de seguridad de `/carga/` están en `netlify.toml`. Si se agrega un servicio externo a la página hay que permitirlo ahí, en `Content-Security-Policy`.
