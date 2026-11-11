# Statistics — contexto del proyecto

Tablero de indicadores de gestión de las sucursales (ver `README.md`). Idioma de trabajo con el dueño: **español**.

- `web/index.html`: el tablero completo (una sola página); `web/prueba/`: demostración con datos en el navegador.
- `supabase/setup.sql`: tabla `archivos` y permisos. `netlify.toml`: Netlify publica `web/`.
- Pruebas: `npm test -- "<archivo.xls>"` y `npm run revisar -- "<carpeta de un mes>"`. Los Excel reales nunca entran al repositorio.

## Método de trabajo (el mismo de Autelix)

El dueño da la instrucción en español y Claude la ejecuta **por su cuenta y de principio a fin**:

- **Siempre divide el trabajo** en las partes que hagan falta y reparte cada una al modelo adecuado (tabla de abajo). No hace falta que el dueño lo pida.
- **Analiza, verifica, valida y prueba** antes de dar algo por terminado: pruebas que pasan, revisión de otro agente y evidencia (salida de pruebas, captura de la vista previa). Si algo falla, se corrige y se vuelve a probar sin consultar.
- **Solo vuelve al dueño cuando necesita que él valide algo**: una decisión que es suya (publicar, borrar datos, cambiar algo que ya definió, elegir entre opciones de diseño o reglas del negocio) o un resultado que solo él puede confirmar con los datos reales. No pide permiso para pasos intermedios ni avisa de cada avance.
- Al terminar, un resumen corto: qué quedó hecho, cómo se comprobó y qué falta, si falta algo.

### Jerarquía de modelos
Claude hace de **coordinador** en la conversación y reparte el trabajo a agentes (herramienta Agent, parámetro `model`) según la dificultad. No se gasta un modelo grande en una tarea chica.

| Nivel | Modelo | Para qué |
|---|---|---|
| Rápido | **Haiku** (`haiku`) | Búsquedas simples, localizar archivos, documentación corta |
| Estándar | **Sonnet** (`sonnet`) | Cambios normales, ejecutar pruebas, interfaz |
| Profundo | **Opus** (`opus`) | Planificar, arquitectura, depurar errores difíciles, revisar |
| Máximo | **Fable 5.2** (`fable`) | Solo lo muy complicado. **Disponible hasta el 16-nov-2026 inclusive**; desde el 17-nov-2026 lo muy complicado pasa a Opus |

### Flujo
1. **Planificar** (Opus, o Fable si es muy complicado): solo en cambios grandes o ambiguos.
2. **Ejecutar** (Sonnet; Opus/Fable si es complejo): un agente implementa.
3. **Revisar** (otro agente aparte): quien escribe el código no lo aprueba.
4. **Verificar** con pruebas y evidencia (`npm test`, `npm run revisar`, vista previa de `web/`).

- Las tareas independientes se lanzan en paralelo.
- Lo trivial (un texto, un valor, un comando) lo hace Claude directamente, sin agentes.
- Cada informe de agente se comprueba antes de decírselo al dueño (es su informe, no una prueba).
- Al dueño se le resume en español claro: qué quedó hecho, qué se verificó y qué falta.

### Cómo puede dirigir el dueño
- **"Usa Opus/Sonnet/Fable para esto"**: se fuerza ese modelo.
- **"Modo simple" / "modo completo"** (`/modo-simple`, `/modo-completo`): trabajo ligero u orquestación completa con agentes.
- Para tareas largas e independientes (una rama o PR propia) se pueden abrir sesiones separadas.

## Reglas
- Publicar (Netlify / `main`) solo si el dueño lo pide explícitamente.
- Ningún dato real de la empresa ni Excel de sucursales en el repositorio.
