# Agente de Órdenes de Compra SAP

Agente conversacional que lee un paquete de compra (correo, solicitud, cotización y aprobación del líder), lo valida contra los maestros y crea la orden de compra en un SAP simulado. Lo que no cumple control se bloquea; lo dudoso se devuelve a la analista para que confirme.

El planteamiento, las decisiones de diseño, la IA usada y las limitaciones están en [SOLUCION.md](SOLUCION.md).

## Requisitos

- Node 20 o superior (para leer `.env` se necesita 20.12 o superior; con una versión menor, exporta las variables en la terminal)
- Una clave de Anthropic (opcional): sin ella el agente corre el flujo determinístico, sin modelo

## Instalación y uso

```bash
npm install
cp .env.example .env     # opcional: agrega ANTHROPIC_API_KEY
npm run demo             # corre los 6 casos sin modelo
npm run dev              # chat en http://localhost:3000
```

| Comando | Qué hace |
|---|---|
| `npm run demo` | Procesa sol-001 a sol-006 con y sin confirmación; termina con código 1 si algún resultado difiere del esperado |
| `npm run dev` | Servidor con `ts-node`, sin compilar |
| `npm run build` | Compila a `dist/` |
| `npm start` | Ejecuta la versión compilada (requiere `npm run build`) |
| `npm run typecheck` | Verifica los tipos sin generar archivos |

## Variables de entorno

| Variable | Por defecto | Uso |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | Activa el ciclo con modelo. Solo por entorno; nunca va en el repo |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Modelo que conduce el ciclo |
| `PORT` | `3000` | Puerto del servidor |
| `CHAT_RATE_LIMIT` | `30` | Peticiones a `/chat` por IP cada 10 minutos |
| `OC_FIXTURES_DIR` | `fixtures/reto-03` | Carpeta de maestros y solicitudes |
| `OC_OUT_DIR` | `out` | Carpeta de salidas |

## API

| Ruta | Descripción |
|---|---|
| `GET /health` | `{ ok, modelo }`; indica si hay clave configurada |
| `GET /casos` | Lista los casos disponibles (`sol-001` … `sol-006`) |
| `POST /chat` | Procesa un caso. Cuerpo: `{ caso_id, confirmado?, mensaje?, historial? }`. Respuesta: `{ respuesta, result }` |

```bash
curl -X POST localhost:3000/chat -H 'content-type: application/json' \
  -d '{"caso_id":"sol-004","confirmado":true}'
```

`result.estado` es `creada`, `pendiente_confirmacion` o `bloqueada`. Cuando es `pendiente_confirmacion`, la OC se crea volviendo a llamar con `confirmado: true`.

## Casos para probar

| Caso | Resultado esperado |
|---|---|
| sol-001 | OC creada |
| sol-002 | Bloqueada: proveedor inexistente |
| sol-003 | Bloqueada: el aprobador no tiene autoridad en el centro de costo |
| sol-004 | Pide confirmación: la cotización difiere de la solicitud |
| sol-005 | Pide confirmación: compra retroactiva; queda con `retroactiva = true` |
| sol-006 | Pide confirmación: IVA no informado |

## Salidas

Se generan en `out/` (no se versionan):

- `sap/ordenes.jsonl`: OC creadas, con numeración desde 4500000001
- `control.csv`: una fila por cada intento, incluidos los bloqueados y los pendientes
- `<caso>/trazabilidad.json`: origen de cada campo de la OC
- `<caso>/aprobacion.txt` y `<caso>/aprobacion.pdf`: evidencia de aprobación con `sha256`

Para empezar de cero, borra la carpeta `out/`.

## Estructura

```
src/
  agent.ts         sesión del caso, flujo determinístico y ciclo con modelo
  tools.ts         herramientas: lectura, validación, payload, evidencia, creación
  types.ts         esquemas Zod y contratos
  sap-adapter.ts   SAP simulado y control.csv
  evidence-pdf.ts  generación del PDF de evidencia
  llm.ts           cliente Anthropic y extracción de respaldo
  server.ts        Express: API y UI
  config.ts        rutas y variables
  ui/              chat (HTML, CSS y JS sin dependencias)
demo.ts            ejecución sin modelo de los 6 casos
fixtures/reto-03/  maestros y solicitudes del reto
render.yaml        despliegue en Render
```

## Despliegue

`render.yaml` deja listo el servicio en Render: en el panel, **New → Blueprint**, elige este repositorio y completa `ANTHROPIC_API_KEY`. En el plan gratuito el servicio se duerme sin tráfico y el disco se reinicia en cada redeploy, así que `out/` se vacía.
