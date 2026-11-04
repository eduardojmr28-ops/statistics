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
