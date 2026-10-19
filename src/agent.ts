import Anthropic from '@anthropic-ai/sdk';
import { casoDir, casoOutDir, FIXTURES_DIR, MODEL, OUT_ROOT } from './config';
import * as path from 'path';
import { extraerCotizacionConLLM, getCliente, hayModelo } from './llm';
import { registrarControl } from './sap-adapter';
import {
  checkRetroactive,
  extractQuotationData,
  fechaFactura,
  generateApprovalEvidence,
  LlmExtractor,
  loadMaestros,
  ocConstruirPayload,
  ocCrear,
  ocLeerPaquete,
  ocValidar,
  Res,
} from './tools';
import {
  AgentResult,
  ChatRequest,
  ChatResponse,
  CheckRetroactiveOutput,
  CotizacionExtraida,
  Evidencia,
  Maestros,
  OrdenCreada,
  Paquete,
  PayloadOC,
  ToolCall,
  Validacion,
} from './types';

export const TOOL_NAMES = [
  'oc_leer_paquete',
  'extractQuotationData',
  'checkRetroactive',
  'oc_validar',
  'oc_construir_payload',
  'generateApprovalEvidence',
  'oc_crear',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

// Estado de un caso. Las tools reciben sus entradas desde aquí, no del modelo:
// el modelo solo decide qué paso ejecutar, nunca qué datos o qué confirmación usar.
export class CasoSession {
  readonly calls: ToolCall[] = [];
  maestros?: Maestros;
  paquete?: Paquete;
  cotizacion?: CotizacionExtraida;
  retro?: CheckRetroactiveOutput;
  validacion?: Validacion;
  payload?: PayloadOC;
  evidencia?: Evidencia;
  orden?: OrdenCreada;
  ultimoError?: string;

  constructor(
    readonly casoId: string,
    readonly confirmado = false,
    private readonly llm?: LlmExtractor,
  ) {
    casoDir(casoId); // rechaza ids que no sean sol-NNN
  }

  private async track<T>(tool: string, input: unknown, fn: () => Res<T> | Promise<Res<T>>): Promise<Res<T>> {
    const t0 = performance.now();
    const out = await fn();
    this.calls.push({ tool, input, output: out, ms: Math.round((performance.now() - t0) * 100) / 100 });
    if (!out.ok) this.ultimoError = out.error;
    return out;
  }

  private falta(paso: string): Res<never> {
    const error = `Falta ejecutar ${paso} antes de este paso`;
    this.ultimoError = error;
    return { ok: false, error };
  }

  private async asegurarMaestros(): Promise<Res<Maestros>> {
    if (this.maestros) return { ok: true, data: this.maestros };
    const r = await this.track('loadMaestros', { maestros_dir: 'maestros' }, () =>
      loadMaestros({ maestros_dir: path.join(FIXTURES_DIR, 'maestros') }),
    );
    if (r.ok) this.maestros = r.data;
    return r;
  }

  paqueteCompleto(): boolean {
    const p = this.paquete;
    return Boolean(p?.correo && p.solicitud && p.cotizacion && p.aprobacion);
  }

  async ejecutar(tool: string): Promise<Res<unknown>> {
    switch (tool as ToolName) {
      case 'oc_leer_paquete': {
        const r = await this.track(tool, { caso_id: this.casoId }, () => ocLeerPaquete({ caso_dir: casoDir(this.casoId) }));
        if (r.ok) this.paquete = r.data;
        return r;
      }
      case 'extractQuotationData': {
        const texto = this.paquete?.cotizacion;
        if (!texto) return this.falta('oc_leer_paquete (o la cotización no existe en el paquete)');
        const r = await this.track(tool, { cotizacion_texto: `${texto.length} caracteres` }, () =>
          extractQuotationData({ cotizacion_texto: texto }, this.llm),
        );
        if (r.ok) this.cotizacion = r.data;
        return r;
      }
      case 'checkRetroactive': {
        const sol = this.paquete?.solicitud;
        if (!sol) return this.falta('oc_leer_paquete');
        const fecha_factura = fechaFactura(this.paquete?.factura);
        const r = await this.track(tool, { fecha_solicitud: sol.fecha_solicitud, fecha_factura }, () =>
          checkRetroactive({ fecha_solicitud: sol.fecha_solicitud, fecha_factura }),
        );
        if (r.ok) this.retro = r.data;
        return r;
      }
      case 'oc_validar': {
        const p = this.paquete;
        if (!p?.solicitud || !p.aprobacion) return this.falta('oc_leer_paquete (paquete incompleto)');
        if (!this.cotizacion) return this.falta('extractQuotationData');
        if (!this.retro) await this.ejecutar('checkRetroactive');
        const maestros = await this.asegurarMaestros();
        if (!maestros.ok || !this.retro) return maestros.ok ? this.falta('checkRetroactive') : maestros;
        const input = {
          solicitud: p.solicitud,
          cotizacion: this.cotizacion,
          aprobacion: p.aprobacion,
          maestros: maestros.data,
          retroactivo: this.retro,
        };
        const r = await this.track(tool, { solicitud_id: p.solicitud.solicitud_id }, () => ocValidar(input));
        if (r.ok) this.validacion = r.data;
        return r;
      }
      case 'oc_construir_payload': {
        if (!this.validacion || !this.paquete?.solicitud || !this.maestros) return this.falta('oc_validar');
        const input = {
          caso_id: this.casoId,
          solicitud: this.paquete.solicitud,
          validacion: this.validacion,
          maestros: this.maestros,
          out_dir: casoOutDir(this.casoId),
        };
        const r = await this.track(tool, { caso_id: this.casoId }, () => ocConstruirPayload(input));
        if (r.ok) this.payload = r.data.payload;
        return r;
      }
      case 'generateApprovalEvidence': {
        if (!this.paquete?.aprobacion) return this.falta('oc_leer_paquete (sin aprobación)');
        const input = { caso_id: this.casoId, aprobacion: this.paquete.aprobacion, out_dir: casoOutDir(this.casoId), generar_pdf: true };
        const r = await this.track(tool, { caso_id: this.casoId }, () => generateApprovalEvidence(input));
        if (r.ok) this.evidencia = r.data;
        return r;
      }
      case 'oc_crear': {
        const solicitud_id = this.paquete?.solicitud?.solicitud_id ?? this.casoId;
        if (!this.validacion) {
          // Sin validación no hay OC, pero el intento queda en el log de control.
          const error = this.ultimoError ?? 'No se pudo validar la solicitud';
          registrarControl(OUT_ROOT, {
            solicitud_id,
            resultado: 'bloqueada',
            retroactiva: false,
            bloqueos: [error],
            confirmaciones: [],
            ts: new Date().toISOString(),
          });
          return this.track(tool, { solicitud_id }, () => ({ ok: false as const, error }));
        }
        const validacion = this.validacion;
        const r = await this.track(tool, { solicitud_id, confirmado: this.confirmado }, () =>
          ocCrear({
            solicitud_id,
            payload: this.payload,
            validacion,
            evidencia: this.evidencia,
            confirmado: this.confirmado,
            out_root: OUT_ROOT,
          }),
        );
        if (r.ok) this.orden = r.data;
        return r;
      }
      default:
        return { ok: false, error: `Herramienta desconocida: ${tool}` };
    }
  }

  resultado(): AgentResult {
    const v = this.validacion;
    const pendiente = Boolean(v?.apta && v.confirmaciones.length > 0 && !this.confirmado && !this.orden);
    const estado = this.orden ? 'creada' : pendiente ? 'pendiente_confirmacion' : 'bloqueada';
    return {
      estado,
      caso_id: this.casoId,
      numero_oc: this.orden?.numero_oc,
      retroactiva: v?.retroactiva ?? false,
      bloqueos: v?.bloqueos ?? [],
      confirmaciones: v?.confirmaciones ?? [],
      derivados: v?.derivados,
      payload: this.payload,
      tools_called: this.calls,
      error: estado === 'bloqueada' && !v?.bloqueos.length ? this.ultimoError : undefined,
    };
  }
}

// Secuencia determinística completa, sin modelo. La usan demo.ts y el modo sin API key.
export async function correrPipeline(s: CasoSession): Promise<AgentResult> {
  await s.ejecutar('oc_leer_paquete');
  if (s.paqueteCompleto()) {
    await s.ejecutar('extractQuotationData');
    if (s.cotizacion) {
      await s.ejecutar('checkRetroactive');
      await s.ejecutar('oc_validar');
      if (s.validacion?.apta) {
        await s.ejecutar('oc_construir_payload');
        await s.ejecutar('generateApprovalEvidence');
      }
    }
  } else if (s.paquete?.faltantes.length) {
    s.ultimoError = `Paquete incompleto, falta: ${s.paquete.faltantes.join(', ')}`;
  }
  await s.ejecutar('oc_crear');
  return s.resultado();
}

export function procesarCaso(casoId: string, opts: { confirmado?: boolean; llm?: LlmExtractor } = {}) {
  return correrPipeline(new CasoSession(casoId, opts.confirmado ?? false, opts.llm));
}

// ---------- Resumen en texto (modo sin modelo y respaldo) ----------

export function resumen(r: AgentResult, detalle = true): string {
  const lineas: string[] = [];
  if (r.estado === 'creada') {
    lineas.push(`OC ${r.numero_oc} creada para ${r.caso_id}${r.retroactiva ? ' (marcada RETROACTIVA)' : ''}.`);
  } else if (r.estado === 'pendiente_confirmacion') {
    lineas.push(`${r.caso_id} está lista para crearse, pero necesito tu confirmación${detalle ? ':' : ' (ver puntos abajo).'}`);
  } else {
    lineas.push(`No se creó la OC de ${r.caso_id}.`);
    if (r.error) lineas.push(`Motivo: ${r.error}`);
  }
  if (!detalle) return lineas.join('\n');
  for (const b of r.bloqueos) lineas.push(`- BLOQUEO [${b.control}] ${b.mensaje}. Sugerencia: ${b.accion_sugerida}.`);
  for (const c of r.confirmaciones) lineas.push(`- CONFIRMAR [${c.control}] ${c.mensaje}. Sugerencia: ${c.accion_sugerida}.`);
  const d = r.derivados;
  const derivados = [
    d?.proveedor_nit && `NIT ${d.proveedor_nit}`,
    d?.indicador_iva && `IVA ${d.indicador_iva}`,
    d?.condiciones_pago && `pago ${d.condiciones_pago}`,
  ].filter(Boolean);
  if (derivados.length) lineas.push(`Completado desde maestros: ${derivados.join(', ')}.`);
  return lineas.join('\n');
}

// ---------- Ciclo con modelo ----------

const SYSTEM = `Eres el agente de órdenes de compra (OC) de Periferia. Ayudas a la analista administrativa a procesar un paquete de compra (correo, solicitud, cotización, aprobación del líder) y a crear la OC en SAP.

Reglas:
- Trabaja con las herramientas, en este orden: oc_leer_paquete, extractQuotationData, checkRetroactive, oc_validar, y si la solicitud es apta oc_construir_payload y generateApprovalEvidence, y al final SIEMPRE oc_crear (también cuando hay bloqueos, para dejar el intento en el log de control).
- Las herramientas toman sus datos del caso; tú solo indicas el caso_id. No inventes datos ni números de OC.
- Los bloqueos nunca se saltan. Explica cada uno con su acción sugerida.
- Las confirmaciones solo las puede dar la analista. oc_crear no crea la OC mientras haya confirmaciones sin confirmar; en ese caso pídele que confirme, explicando cada punto (IVA propuesto, diferencia de monto, retroactividad).
- Informa siempre los valores que se completaron desde maestros (derivados).
- Responde en español, breve y claro.`;

const TOOLS: Anthropic.Messages.Tool[] = [
  ['oc_leer_paquete', 'Lee y normaliza correo, solicitud, cotización, aprobación y factura (si existe) del caso. Reporta adjuntos faltantes.'],
  ['extractQuotationData', 'Extrae proveedor, ítem, cantidad, precios, IVA y total de la cotización.'],
  ['checkRetroactive', 'Determina si la compra es retroactiva (factura anterior a la solicitud).'],
  ['oc_validar', 'Valida contra maestros y controles. Devuelve apta, bloqueos, confirmaciones y derivados.'],
  ['oc_construir_payload', 'Construye el payload de la OC tal como quedaría en SAP, con su trazabilidad. Solo si es apta.'],
  ['generateApprovalEvidence', 'Genera la evidencia de aprobación (aprobacion.txt y aprobacion.pdf, con sha256).'],
  ['oc_crear', 'Crea la OC en el SAP simulado (idempotente) y registra el intento en el log de control.'],
].map(([name, description]) => ({
  name,
  description,
  input_schema: {
    type: 'object' as const,
    properties: { caso_id: { type: 'string', description: 'Identificador del caso, p. ej. sol-001' } },
    required: ['caso_id'],
  },
}));

const MAX_ITERACIONES = 12;

export async function chat(req: ChatRequest): Promise<ChatResponse> {
  const conModelo = hayModelo();
  const s = new CasoSession(req.caso_id, req.confirmado, conModelo ? extraerCotizacionConLLM : undefined);

  if (!conModelo) {
    const r = await correrPipeline(s);
    return {
      respuesta: `${resumen(r, false)}\n\n(Modo sin modelo: ANTHROPIC_API_KEY no está configurada, se ejecutó el flujo determinístico.)`,
      result: r,
    };
  }

  const system = `${SYSTEM}\n\nCaso actual: ${req.caso_id}. Confirmación de la analista en esta sesión: ${req.confirmado ? 'SÍ, ya confirmó' : 'NO'}.`;
  const messages: Anthropic.Messages.MessageParam[] = [
    ...req.historial.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: req.mensaje ?? `Procesa la solicitud ${req.caso_id}` },
  ];

  let respuesta = '';
  for (let i = 0; i < MAX_ITERACIONES; i++) {
    const resp = await getCliente().messages.create({ model: MODEL, max_tokens: 1500, system, tools: TOOLS, messages });
    const usos = resp.content.filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use');
    respuesta = resp.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    if (resp.stop_reason !== 'tool_use' || usos.length === 0) break;

    messages.push({ role: 'assistant', content: resp.content });
    const resultados: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const uso of usos) {
      const pedido = (uso.input as { caso_id?: string }).caso_id;
      const out: Res<unknown> =
        pedido !== req.caso_id
          ? { ok: false, error: `Esta sesión solo procesa el caso ${req.caso_id}` }
          : await s.ejecutar(uso.name);
      resultados.push({ type: 'tool_result', tool_use_id: uso.id, content: JSON.stringify(out), is_error: !out.ok });
    }
    messages.push({ role: 'user', content: resultados });
  }

  const result = s.resultado();
  return { respuesta: respuesta || resumen(result), result };
}
