[Read in English](README.md)

# TokenScope · Dashboard de tokens de Claude Code

[![Licencia: MIT](https://img.shields.io/badge/licencia-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A518-3c873a.svg)](https://nodejs.org)
[![Sin dependencias](https://img.shields.io/badge/dependencias-0-brightgreen.svg)](package.json)
[![100% local](https://img.shields.io/badge/datos-100%25%20local-4f46e5.svg)](#qué-hace-y-qué-no-hace-con-tus-datos)

**TokenScope** es un dashboard local, sin dependencias y de código abierto que muestra **a dónde van tus tokens de Claude Code** y señala los hábitos que los malgastan: sesiones demasiado largas, cachés perdidas tras una pausa, resultados de herramientas enormes, un modelo caro usado para tareas simples y el uso de subagentes.

Lee los archivos que Claude Code ya guarda en tu ordenador y sirve un dashboard en tu propia máquina. **Nada sale de tu ordenador.** No hay cuenta, ni subida de datos, ni telemetría.

> ¿Para qué sirve? Para responder en un minuto a preguntas como *«¿qué proyecto me está consumiendo el límite?»*, *«¿por qué esta sesión gastó 2 millones de tokens?»* o *«¿qué hago distinto para gastar menos?»*.

## Qué hace

- Totales por tipo de token (entrada, salida, escritura de caché y lectura de caché), por modelo y por día.
- Un ranking de tus sesiones más caras, con un gráfico del tamaño del contexto turno a turno y marcas para pausas, `/clear`, `/compact` y saltos bruscos.
- Duración activa que no cuenta las pausas largas, el lapso total de cada sesión y una línea base del contexto habitual de una sesión nueva.
- Diagnósticos con un impacto estimado en tokens y un consejo concreto para cada uno, además de tus 3 errores más frecuentes.
- Un historial guardado, para que las estadísticas sobrevivan cuando Claude Code borre las sesiones antiguas.
- Exportación del resumen a JSON o PNG, modo claro y oscuro, español e inglés, y funciona en móviles y ventanas pequeñas.

## Las tres vistas

| Vista | Qué encontrarás |
| --- | --- |
| **Resumen** | Totales y KPIs del periodo, tokens por día, reparto por modelo, tendencia y tus 3 errores más frecuentes. |
| **Sesiones** | Ranking por tokens ponderados, búsqueda por tarea y detalle de cada sesión con el contexto turno a turno. |
| **Diagnósticos** | Todos los problemas detectados, ordenados por impacto, con un consejo concreto para cada uno. |

Filtra por rango (últimos 7 días, 30 días o todo), por fechas y por proyecto, y cambia entre medir **tokens** o **tokens ponderados** (una aproximación al precio relativo: la lectura de caché cuenta mucho menos y la salida cuenta más).

## Requisitos

- Node.js 18 o superior (compruébalo con `node -v`).
- Mac, Linux o Windows.
- Nada más. No hay dependencias de npm que instalar.

## Instalación

La forma más rápida, sin clonar nada:

```bash
npx tokenscope
```

O instálalo de forma global para tener el comando siempre a mano:

```bash
npm install -g tokenscope
tokenscope
```

Si prefieres el código fuente:

```bash
git clone https://github.com/fredarcito/tokenscope.git
cd tokenscope
npm start
```

Eso es todo: no hay que instalar nada más.

También puedes ejecutarlo directamente desde GitHub, sin pasar por npm:

```bash
npx github:fredarcito/tokenscope
```

## Primer uso

Usa estos tres comandos, en este orden, la primera vez:

```
npm run example
npm run check
npm start
```

1. **`npm run example`** abre el dashboard con datos inventados, para que veas cómo es todo antes de tocar tus propios archivos.
2. **`npm run check`** lee tus archivos reales de Claude Code e imprime un informe que te dice si la herramienta los entiende. El formato de los archivos de Claude Code no está documentado oficialmente y puede cambiar entre versiones, así que conviene hacerlo una vez. El informe solo contiene recuentos y nombres de campos, por lo que puedes pegarlo en un issue.
3. **`npm start`** abre el dashboard con tus propios datos.

Todo lo que muestra el dashboard se vuelve a leer cada vez que recargas la página.

## Crear un acceso directo (alias)

Sustituye la ruta por la carpeta donde clonaste el proyecto.

**Mac y Linux** (añade la línea a `~/.zshrc` o `~/.bashrc` y abre una terminal nueva):

```
alias claude-tokens='npm --prefix "$HOME/tokenscope" start'
```

**Windows (PowerShell)**. Abre tu perfil con `notepad $PROFILE` (si no existe, créalo antes con `New-Item -Path $PROFILE -Force`) y añade:

```
function claude-tokens { npm --prefix "$HOME\tokenscope" start }
```

Abre una ventana nueva de PowerShell y escribe `claude-tokens`.

## Ajustar los umbrales

Los umbrales por defecto están en `src/config.js`. No hace falta editar ese archivo: crea `config.json` en la carpeta propia de la herramienta y escribe solo los valores que quieras cambiar.

| Sistema | Dónde crear `config.json` |
| --- | --- |
| Mac / Linux | `~/.claude-token-dashboard/config.json` |
| Windows | `%USERPROFILE%\.claude-token-dashboard\config.json` |

Ejemplo:

```json
{
  "lang": "es",
  "thresholds": {
    "longSession": { "contextTokens": 150000, "turns": 80 },
    "cacheMiss": { "gapSeconds": 300, "cacheWriteTokens": 30000 }
  }
}
```

| Ajuste | Por defecto | Significado |
| --- | --- | --- |
| `lang` | `null` | Idioma por defecto del dashboard: `"es"` o `"en"`. |
| `thresholds.longSession.contextTokens` | 100000 | Un tramo de trabajo es "demasiado largo" por encima de este tamaño de contexto... |
| `thresholds.longSession.turns` | 60 | ...o tras tantos turnos sin `/clear` ni `/compact`. |
| `thresholds.cacheMiss.gapSeconds` | 300 | Pausa suficiente para que caduque la caché del prompt. |
| `thresholds.cacheMiss.cacheWriteTokens` | 20000 | Escritura de caché tras la pausa que cuenta como caché perdida. |
| `thresholds.hugeToolResult.chars` | 20000 | Un resultado de herramienta con más caracteres que esto es "enorme". |
| `thresholds.expensiveModel.modelPattern` | `"opus"` | Los modelos cuyo nombre contenga este texto se tratan como los caros. |
| `thresholds.expensiveModel.shortOutputTokens` | 150 | Un turno con menos salida que esto cuenta como tarea simple. |
| `thresholds.expensiveModel.minShortTurns` | 5 | Número mínimo de turnos simples para avisar. |
| `thresholds.expensiveModel.minShortShare` | 0.5 | Parte mínima (de 0 a 1) de los turnos caros que debe ser simple. |
| `thresholds.subagents.minTokens` | 20000 | El uso de subagentes por debajo de esto no se avisa. |
| `thresholds.pause.gapSeconds` | 300 | Los huecos más largos que esto se marcan como pausas en el gráfico de sesión. |
| `thresholds.spike.minIncreaseTokens` | 30000 | Los saltos de contexto mayores que esto se marcan como picos. |
| `weights` | 1 / 5 / 1.25 / 0.1 | Aproximación de los precios publicados por Anthropic para entrada / salida / escritura de caché / lectura de caché. Revisa la página de precios; no varía por modelo. |

Los valores no válidos se ignoran (se usa el valor por defecto) y se muestra un aviso en la terminal y en el dashboard.

### Cómo funcionan los diagnósticos

| Diagnóstico | Cuándo aparece | Estimación del impacto |
| --- | --- | --- |
| Sesión demasiado larga | Contexto por encima del límite, o demasiados turnos sin `/clear` ni `/compact`. | Tokens leídos desde que se cruzó el límite. |
| Caché perdida tras una pausa | Un hueco de más de 5 minutos seguido de una escritura grande de caché (no cuenta tras `/clear` ni `/compact`). | Los tokens de caché escritos otra vez. |
| Sesión retomada tras pausa | Tras un hueco de más de 5 minutos, un turno no inicial escribe al menos 20.000 tokens en caché y al menos el 80 % del contexto del turno anterior, sin `/clear` ni `/compact` intermedio. | Se agrupan por sesión los casos y los tokens de caché reescritos. |
| Resultado de herramienta enorme | Un `tool_result` de más de 20.000 caracteres. | Caracteres divididos entre 4. |
| Modelo caro para tareas simples | Muchos turnos con Opus y salida muy corta. | Tokens de esos turnos. |
| Uso de subagentes | Líneas marcadas con `isSidechain`, agrupadas por sesión. | Tokens usados por los subagentes. |

El impacto es un recuento de tokens, no dinero. Úsalo para comparar problemas del mismo tipo y detectar los mayores.

La duración activa suma los intervalos entre mensajes únicos del usuario y del asistente, y descarta los huecos superiores a 30 minutos (`IDLE_THRESHOLD_MS` en `src/config.js`). La tabla de sesiones muestra por separado el tiempo activo y el lapso total. La línea base del Resumen es la mediana del contexto del primer turno de las sesiones filtradas; incluye el prompt del sistema, herramientas, servidores MCP y archivos `CLAUDE.md`, parte escrita en caché y parte leída, y no es contexto heredado de otra sesión.

Las líneas del asistente se normalizan una sola vez: se deduplican dentro de su sesión por `message.id` (con request ID / UUID como respaldo), y se elige el usage con mayor salida; en empate, la última línea. Se excluyen del total las respuestas sintéticas, sin usage o con todos los contadores a cero. Las líneas JSON corruptas se omiten y se cuentan en el aviso de calidad de datos.

Ejecuta `npm run verify -- --session <id-de-sesión> [--project <nombre>] [--data <ruta>] [--lang es|en]` para leer en streaming una transcripción cruda y comparar de forma independiente los recuentos, totales, contexto inicial, tiempo activo, lapso total y título de tarea con los datos normalizados del dashboard.

## Qué hace y qué no hace con tus datos

En lenguaje sencillo:

- **Solo se ejecuta en tu ordenador.** El servidor escucha en `127.0.0.1`, nunca en tu red, y no se envían datos a ninguna parte.
- **Solo lee la carpeta de Claude Code.** Nunca modifica, mueve ni borra tus archivos de Claude Code.
- **Solo escribe en un sitio:** `~/.claude-token-dashboard/` (el historial y tus ajustes opcionales). Nunca dentro del repositorio.
- **El historial guardado contiene resúmenes y etiquetas breves de tarea/proyecto:** tokens por día y por sesión, diagnósticos y título de tarea. Sin prompts, sin código ni salida de herramientas.
- **Otras páginas web no pueden leer tus datos.** La dirección de la página lleva un token secreto aleatorio que se crea cada vez que arrancas la herramienta, el servidor rechaza las peticiones con cualquier otro nombre de host y no envía permisos entre sitios (CORS).
- **No ejecuta comandos** salvo el que abre tu navegador (`open`, `xdg-open` o `start`).
- **Se carga una sola cosa de internet:** la librería de gráficos Chart.js, desde un CDN, con la versión fijada y una comprobación de integridad. Tus datos no forman parte de esa petición. Si no tienes conexión, los gráficos no cargan, pero las tablas y los diagnósticos siguen funcionando.
- **El dashboard muestra vistas previas cortas** de los resultados de herramientas enormes (las primeras líneas), para que puedas reconocerlos. Solo se ven en tu pantalla. No se guardan en el historial ni se incluyen en las exportaciones.
- **Las exportaciones** (JSON o imagen) pueden incluir nombres de tareas y proyectos, cifras y diagnósticos, pero nunca prompts, código ni salida de herramientas.
- **Nunca subas archivos `.jsonl` reales.** El `.gitignore` ya los bloquea fuera de `example/`.

## Avanzado

Normalmente solo necesitas los tres comandos de npm de arriba. Ellos llaman a `bin/cli.js`, que acepta estos argumentos:

| Argumento | Qué hace |
| --- | --- |
| `--example` | Usa los archivos inventados de `example/`. No se lee ni se escribe historial. |
| `--check` | Imprime el informe del parser y termina. |
| `--data <ruta>` | Lee los `.jsonl` de esta carpeta (todas las subcarpetas). |
| `--lang <es\|en>` | Idioma de la salida de la terminal. |
| `--no-open` | No abre el navegador automáticamente. |
| `--help`, `--version` | Muestra la ayuda o la versión. |

Pasa los argumentos a través de npm después de `--`, por ejemplo `npm run check -- --lang en`, o llama al archivo directamente: `node bin/cli.js --data ./mi-copia`.

Variables de entorno:

| Variable | Qué hace |
| --- | --- |
| `PORT` | Puerto en el que escuchar (por defecto 3000). Si está ocupado, se usa el siguiente libre. |
| `CLAUDE_DATA_DIR` | Carpeta con los datos de Claude Code. `--data` tiene prioridad sobre ella. |
| `CLAUDE_TOKEN_DASHBOARD_HOME` | Usa otra carpeta en lugar de `~/.claude-token-dashboard` (útil para pruebas). |

De dónde se leen los datos por defecto: `~/.claude/projects` en Mac y Linux, `%USERPROFILE%\.claude\projects` en Windows.

Idioma de la terminal: `--lang`, después `"lang"` en `config.json`, después el idioma de tu sistema (`LC_ALL`, `LC_MESSAGES`, `LANG` o la configuración regional del sistema). Idioma del dashboard: tu última elección (guardada en el navegador), después `"lang"` en `config.json`, después el idioma del navegador (español si empieza por `es`, inglés en cualquier otro caso).

Si el formato de los archivos de Claude Code cambia, `npm run check` te dice qué función de `src/parser.js` hay que revisar.

### Estructura del proyecto

```
bin/cli.js          punto de entrada y lectura de argumentos
src/main.js         flujo del programa
src/server.js       servidor HTTP local y medidas de seguridad
src/parser.js       lee los archivos .jsonl (defensivo)
src/diagnostics.js  detecta los problemas
src/history.js      historial guardado
src/data.js         construye los datos que recibe el dashboard
src/config.js       umbrales por defecto, rutas y protección de rutas
src/check.js        npm run check
src/i18n/           traducciones (en.json, es.json) y utilidades
public/index.html   el dashboard (con CSS y JS dentro)
example/            archivos .jsonl inventados
```

## Añadir un idioma

1. Copia `src/i18n/en.json` a `src/i18n/<código>.json` (por ejemplo `fr.json`) y traduce todos los valores. Deja las claves y los `{marcadores}` exactamente como están.
2. Añade una entrada `"lang.<código>"` a **todos** los archivos de traducción (el texto del botón, por ejemplo `"lang.fr": "FR"`).
3. Añade el código a `SUPPORTED` en `src/i18n/index.js`.

El dashboard muestra un botón por cada idioma y la terminal lo detecta a partir del idioma de tu sistema. Mantén el código, los comandos, los nombres de archivo y los comentarios en inglés.

## Cómo contribuir

Los issues y pull requests son bienvenidos.

- Ejecuta `npm run example` y `npm run check -- --data example` antes de abrir un pull request.
- Mantén el proyecto sin dependencias de npm.
- Todo texto visible debe existir en `src/i18n/en.json` y en `src/i18n/es.json` con las mismas claves. Nunca escribas texto para el usuario directamente en el código.
- Nunca añadas transcripciones reales al repositorio. Amplía los archivos de `example/` con datos inventados.
- Si Claude Code cambia su formato de archivos, abre un issue con la salida de `npm run check` (es seguro compartirla).

## Licencia

MIT. Consulta [LICENSE](LICENSE).
