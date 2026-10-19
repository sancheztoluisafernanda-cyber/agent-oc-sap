# SOLUCION.md — Agente de Órdenes de Compra SAP

## 1. Qué hace

Recibe el paquete de una compra (correo, solicitud, cotización, aprobación del líder y, a veces, la factura), lo valida contra los maestros, arma la OC como quedaría en SAP, guarda la evidencia de aprobación y crea la OC en un SAP simulado. Lo que no cumple control no se crea; lo dudoso se devuelve a la analista para que confirme.

**Resultado con los 6 fixtures** (`npm run demo`, 0,04 s):

| Caso | Sin confirmar | Con confirmación | Motivo |
|---|---|---|---|
| sol-001 | OC creada | – | Flujo normal |
| sol-002 | Bloqueada | – | NIT 901999000 no existe en proveedores |
| sol-003 | Bloqueada | – | `fvargas` no es aprobador de CC-2020 (sí lo es Rocío Torres, tope $30M; la solicitud es de $74M) |
| sol-004 | Pide confirmación | OC creada | Cotización $26,5M vs. solicitud $25M (aprobada por $25M) |
| sol-005 | Pide confirmación | OC creada, `retroactiva = true` | Factura del 10-ago, solicitud del 27-ago (17 días antes) |
| sol-006 | Pide confirmación | OC creada | IVA no informado; se propone C1 (19%) del maestro. NIT y condiciones de pago (Z030) se derivan del proveedor |

## 2. Cómo ejecutarlo

```bash
npm install
npm run demo         # 6 casos sin modelo; sale con código 1 si algún resultado difiere
npm run dev          # servidor + chat en http://localhost:3000
```

Variables (`.env.example`): `ANTHROPIC_API_KEY` (solo por entorno, nunca en el repo, el front ni los logs), `ANTHROPIC_MODEL` (por defecto `claude-sonnet-5-5`), `PORT`. Sin clave, `/chat` ejecuta el mismo flujo sin modelo.

Salidas en `out/`: `sap/ordenes.jsonl`, `control.csv` y, por caso, `<caso>/trazabilidad.json`, `<caso>/aprobacion.txt` y `<caso>/aprobacion.pdf`.

**Despliegue (Render).** `render.yaml` define el servicio: build `npm install && npm run build`, start `npm start`, health check en `/health`. La clave `ANTHROPIC_API_KEY` se configura en el panel de Render, no en el repo. `/chat` limita las peticiones por IP (`CHAT_RATE_LIMIT`, 30 cada 10 minutos por defecto) para proteger el gasto de la clave, ya que el reto no incluye autenticación.

## 3. Ciclo del agente

```
oc_leer_paquete → extractQuotationData → checkRetroactive → oc_validar
        → (si apta) oc_construir_payload → generateApprovalEvidence
        → oc_crear   (siempre, también con bloqueos, para registrar el intento)
```

Con modelo, Claude conduce ese bucle de llamadas a herramientas (máximo 12 vueltas). Dos reglas de diseño evitan que el modelo pueda saltarse un control:

1. **El modelo solo elige el paso.** Cada herramienta que ve recibe únicamente `caso_id`. Los datos salen de `CasoSession` (estado del caso en el servidor), no de lo que el modelo escriba.
2. **El modelo no confirma.** `confirmado` llega desde el cliente (botón "Confirmar y crear OC") y la sesión lo inyecta en `oc_crear`. Aunque el modelo lo pida, no puede crear una OC con confirmaciones pendientes.

## 4. Herramientas (`src/tools.ts`, contratos en `src/types.ts`)

Todas validan su entrada con Zod y devuelven `{ ok: true, data }` o `{ ok: false, error }`; ninguna lanza excepciones.

| Herramienta | Qué hace |
|---|---|
| `loadMaestros` | Lee proveedores, centros de costo, IVA y condiciones de pago |
| `oc_leer_paquete` | Normaliza el paquete. Un adjunto ausente es `null` y se lista en `faltantes`; un JSON malformado da error legible |
| `extractQuotationData` | Parser determinístico de la cotización; el modelo entra solo si el formato no coincide |
| `checkRetroactive` | Retroactiva si la factura es anterior a la solicitud |
| `oc_validar` | Devuelve `apta`, `bloqueos[]`, `confirmaciones[]` y `derivados` |
| `oc_construir_payload` | Arma la OC y guarda `trazabilidad.json` (cada campo apunta a `solicitud`, `maestro.*` o `derivado`) |
| `generateApprovalEvidence` | Escribe `aprobacion.txt` y `aprobacion.pdf` con el mismo contenido (de, para, cc, fecha, asunto, cuerpo) y el `sha256` del contenido |
| `oc_crear` | Crea en el SAP simulado; ver sección 6 |

## 5. Controles de `oc_validar`

| Control | Falla ⇒ |
|---|---|
| Proveedor existe y está activo (por NIT; por nombre si falta el NIT) | Bloqueo |
| Centro de costo existe y la subárea le pertenece | Bloqueo |
| Quien aprueba figura en los aprobadores del centro y `valor_total` ≤ su tope | Bloqueo (la acción sugerida lista los aprobadores válidos) |
| El correo contiene una aprobación explícita | Bloqueo |
| `valor_total` = cantidad × valor unitario | Bloqueo |
| IVA o condición de pago informados pero inexistentes en el maestro | Bloqueo |
| Total de la cotización = total de la solicitud | Confirmación |
| IVA no informado (se propone el del proveedor) o tasa de la cotización distinta | Confirmación |
| NIT de la cotización distinto al del proveedor | Confirmación |
| Compra retroactiva | Confirmación |

Los datos que se completan desde el maestro (NIT, condiciones de pago, IVA propuesto) viajan en `derivados` y se muestran a la analista.

## 6. SAP simulado (`src/sap-adapter.ts`)

- Número secuencial desde `4500000001`, una línea JSON por OC en `out/sap/ordenes.jsonl`.
- **Idempotente** por `solicitud_id`: crear dos veces devuelve el mismo número.
- **Cada intento** (creada, bloqueada o pendiente, incluidos paquetes ilegibles) agrega una fila a `out/control.csv`: `solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, ts`. Con ese archivo se mide el porcentaje de OC retroactivas.

## 7. Decisiones y compromisos

- **Reglas en código, no en el prompt.** Se pierde flexibilidad al agregar un control (hay que tocar `tools.ts`) a cambio de resultados repetibles y auditables.
- **Bloqueo vs. confirmación.** Bloqueo: no se crea nunca. Confirmación: se crea solo si la analista confirma. Un dato faltante que el maestro puede completar se deriva y se informa en vez de bloquear.
- **Si la cotización difiere (sol-004), la OC usa los valores de la solicitud**, que son lo que el líder aprobó; la diferencia queda como confirmación.
- **Retroactiva = factura anterior a la solicitud.** El PRD de `documentacion/` decía "correo > solicitud + 7 días", pero con esa regla sol-005 no sería retroactiva; se siguió el enunciado del reto y los fixtures. La tabla completa de divergencias está en la arquitectura.
- **Servidor sin estado de chat.** Cada llamada reconstruye el caso; es seguro por la idempotencia de `oc_crear`. El historial vive en el navegador.
- **Seguridad básica:** `caso_id` validado con `^sol-\d{3}$` (sin recorrer rutas), errores internos al log del servidor y no al cliente, UI sin `innerHTML` y con `Content-Security-Policy`.

## 8. IA usada y para qué

| Herramienta | Uso |
|---|---|
| **Claude Code** (Anthropic), modelos Haiku 4.5 y Sonnet 5.5 | Redacción del PRD de trabajo y de la arquitectura, escritura del código (`src/`, `demo.ts`, UI), revisión contra los fixtures y este documento |
| **Método BMad** (skills instaladas en el proyecto) | Estructura de los documentos de planificación |
| **Claude vía API, en ejecución** | Orquesta los pasos del ciclo y extrae cotizaciones con formato no estándar. No decide reglas ni confirma |

## 9. Limitaciones

- El PDF usa la fuente estándar Helvetica: los caracteres fuera de Latin-1 se reemplazan por `?`.
- La UI se probó manualmente. El ciclo con modelo no se ha verificado con una clave real: sin `ANTHROPIC_API_KEY` el chat corre el flujo determinístico.
- Los fixtures vienen ya convertidos a JSON y texto; no se lee `.xlsx` ni PDF binario.
- La cotización con más de un ítem no se parsea directamente (cae al modelo; sin modelo, error).
- No se compara el monto del texto del correo de aprobación ("25 millones") con la solicitud; solo se exige que haya aprobación explícita.
- En el plan gratuito de Render el disco se reinicia en cada redeploy o al despertar el servicio: `out/` se vacía y los números de OC vuelven a 4500000001.
- Instancia única: los archivos se escriben de forma síncrona y no hay control de concurrencia.
- No se entrega el agente empaquetado como módulo (bonus) ni el enlace público: falta el despliegue.

## 10. Integración con un SAP real (diseño, no implementado)

El único punto que cambia es `crearOrdenSAP`; el resto del agente no se toca porque ya trabaja contra el payload tipado.

1. Mapear el payload a la creación de orden de compra de SAP (BAPI `BAPI_PO_CREATE1` por RFC, o el servicio OData de órdenes de compra en S/4HANA, según la versión del cliente).
2. Enviar `solicitud_id` como referencia externa para conservar la idempotencia en el lado de SAP.
3. Adjuntar `aprobacion.pdf` a la orden como documento asociado y guardar su `sha256`.
4. Reemplazar `ordenes.jsonl` por la respuesta de SAP (número de documento y mensajes) y mantener `control.csv` como registro propio de auditoría.
5. Antes de empezar, confirmar la viabilidad de conexión, que el reto marca como no confirmada.

## 11. Qué haría con más tiempo

Pruebas unitarias por control; despliegue con enlace público; leer `.xlsx` y PDF reales; comparar el monto del correo de aprobación; empaquetar las herramientas como módulo reutilizable.
