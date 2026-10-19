import { z } from 'zod';

const FechaHora = z.string().datetime({ offset: true });
const FechaDia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ---------- Fixtures de entrada ----------

export const CorreoSchema = z.object({
  id: z.string(),
  de: z.string(),
  para: z.string(),
  asunto: z.string(),
  fecha: FechaHora,
  cuerpo: z.string(),
  adjuntos: z.array(z.string()).default([]),
  nota_fixture: z.string().optional(),
});
export type Correo = z.infer<typeof CorreoSchema>;

export const SolicitudSchema = z.object({
  solicitud_id: z.string(),
  solicitante: z.string(),
  proveedor_nombre: z.string(),
  proveedor_nit: z.string().optional(),
  descripcion: z.string(),
  centro_costo: z.string(),
  subarea: z.string(),
  cantidad: z.number().positive(),
  valor_unitario: z.number().positive(),
  valor_total: z.number().positive(),
  moneda: z.string(),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: FechaDia,
});
export type Solicitud = z.infer<typeof SolicitudSchema>;

export const AprobacionSchema = z.object({
  de: z.string(),
  para: z.string(),
  cc: z.array(z.string()).default([]),
  fecha: FechaHora,
  asunto: z.string(),
  cuerpo: z.string(),
});
export type Aprobacion = z.infer<typeof AprobacionSchema>;

// Texto crudo (cotizacion.txt, factura.txt); factura solo existe en algunos casos
export const TextoCrudoSchema = z.string();

// ---------- Maestros ----------

export const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
});
export type Proveedor = z.infer<typeof ProveedorSchema>;

export const AprobadorSchema = z.object({
  email: z.string(),
  nombre: z.string(),
  tope: z.number().nonnegative(),
});
export type Aprobador = z.infer<typeof AprobadorSchema>;

export const CentroCostoSchema = z.object({
  centro_costo: z.string(),
  nombre: z.string(),
  subareas: z.array(z.string()),
  aprobadores: z.array(AprobadorSchema),
});
export type CentroCosto = z.infer<typeof CentroCostoSchema>;

export const IndicadorIvaSchema = z.object({
  codigo: z.string(),
  descripcion: z.string(),
  tasa: z.number().min(0).max(1),
});
export type IndicadorIva = z.infer<typeof IndicadorIvaSchema>;

export const CondicionPagoSchema = z.object({
  codigo: z.string(),
  descripcion: z.string(),
  dias: z.number().int().nonnegative(),
});
export type CondicionPago = z.infer<typeof CondicionPagoSchema>;

export const MaestrosSchema = z.object({
  proveedores: z.array(ProveedorSchema),
  centros_costo: z.array(CentroCostoSchema),
  iva: z.array(IndicadorIvaSchema),
  condiciones_pago: z.array(CondicionPagoSchema),
});
export type Maestros = z.infer<typeof MaestrosSchema>;

// ---------- Contrato comun de tools ----------

export const ToolErrorSchema = z.object({ ok: z.literal(false), error: z.string() });
export type ToolError = z.infer<typeof ToolErrorSchema>;
const ok = <T extends z.ZodTypeAny>(data: T) => z.object({ ok: z.literal(true), data });

// ---------- Tool 1: loadMaestros ----------

export const LoadMaestrosInputSchema = z.object({ maestros_dir: z.string() });
export type LoadMaestrosInput = z.infer<typeof LoadMaestrosInputSchema>;
export const LoadMaestrosOutputSchema = z.union([ok(MaestrosSchema), ToolErrorSchema]);

// ---------- Tool 2: oc_leer_paquete ----------

export const LeerPaqueteInputSchema = z.object({ caso_dir: z.string() });
export type LeerPaqueteInput = z.infer<typeof LeerPaqueteInputSchema>;

export const PaqueteSchema = z.object({
  correo: CorreoSchema.nullable(),
  solicitud: SolicitudSchema.nullable(),
  cotizacion: z.string().nullable(),
  aprobacion: AprobacionSchema.nullable(),
  factura: z.string().nullable().optional(),
  faltantes: z.array(z.string()),
});
export type Paquete = z.infer<typeof PaqueteSchema>;
export const LeerPaqueteOutputSchema = z.union([ok(PaqueteSchema), ToolErrorSchema]);

// ---------- Tool 3: extractQuotationData (LLM) ----------

export const ExtractQuotationInputSchema = z.object({ cotizacion_texto: z.string() });
export type ExtractQuotationInput = z.infer<typeof ExtractQuotationInputSchema>;

export const CotizacionExtraidaSchema = z.object({
  proveedor_nombre: z.string(),
  proveedor_nit: z.string().optional(),
  fecha: FechaDia.optional(),
  descripcion: z.string(),
  cantidad: z.number().positive(),
  precio_unitario: z.number().positive(),
  base_gravable: z.number().nonnegative().optional(),
  iva_monto: z.number().nonnegative().optional(),
  iva_tasa: z.number().min(0).max(1).optional(),
  total: z.number().positive(),
});
export type CotizacionExtraida = z.infer<typeof CotizacionExtraidaSchema>;
export const ExtractQuotationOutputSchema = z.union([ok(CotizacionExtraidaSchema), ToolErrorSchema]);

// ---------- Tool 4: oc_validar ----------

export const HallazgoSchema = z.object({
  control: z.string(),
  mensaje: z.string(),
  accion_sugerida: z.string(),
});
export type Hallazgo = z.infer<typeof HallazgoSchema>;

export const DerivadosSchema = z.object({
  proveedor_nit: z.string().optional(),
  proveedor_codigo_sap: z.string().optional(),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  aprobador_email: z.string().optional(),
  aprobador_nombre: z.string().optional(),
});
export type Derivados = z.infer<typeof DerivadosSchema>;

export const ValidarInputSchema = z.object({
  solicitud: SolicitudSchema,
  cotizacion: CotizacionExtraidaSchema,
  aprobacion: AprobacionSchema,
  maestros: MaestrosSchema,
  retroactivo: z.object({ is_retroactive: z.boolean(), days_late: z.number().int() }),
});
export type ValidarInput = z.infer<typeof ValidarInputSchema>;

export const ValidacionSchema = z.object({
  apta: z.boolean(),
  bloqueos: z.array(HallazgoSchema),
  confirmaciones: z.array(HallazgoSchema),
  derivados: DerivadosSchema,
  retroactiva: z.boolean(),
  dias_retroactivo: z.number().int().optional(),
});
export type Validacion = z.infer<typeof ValidacionSchema>;
export const ValidarOutputSchema = z.union([ok(ValidacionSchema), ToolErrorSchema]);

// ---------- Tool 5: checkRetroactive ----------

export const CheckRetroactiveInputSchema = z.object({
  fecha_solicitud: FechaDia,
  fecha_factura: FechaDia.optional(),
});
export type CheckRetroactiveInput = z.infer<typeof CheckRetroactiveInputSchema>;
export const CheckRetroactiveOutputSchema = z.object({
  is_retroactive: z.boolean(),
  days_late: z.number().int(),
});
export type CheckRetroactiveOutput = z.infer<typeof CheckRetroactiveOutputSchema>;

// ---------- Tool 6: oc_construir_payload ----------

export const FuenteSchema = z.enum(['solicitud', 'cotizacion', 'derivado'])
  .or(z.string().regex(/^maestro\.[a-z_]+$/));
export type Fuente = z.infer<typeof FuenteSchema>;

export const PayloadOCSchema = z.object({
  solicitud_id: z.string(),
  proveedor: z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string() }),
  centro_costo: z.string(),
  subarea: z.string(),
  descripcion: z.string(),
  cantidad: z.number().positive(),
  valor_unitario: z.number().positive(),
  valor_neto: z.number().nonnegative(),
  iva: z.object({ codigo: z.string(), tasa: z.number(), monto: z.number() }),
  valor_total: z.number().positive(),
  moneda: z.string(),
  condiciones_pago: z.string(),
  aprobador: z.object({ email: z.string(), nombre: z.string() }),
  retroactiva: z.boolean(),
});
export type PayloadOC = z.infer<typeof PayloadOCSchema>;

export const TrazabilidadSchema = z.record(z.string(), FuenteSchema);
export type Trazabilidad = z.infer<typeof TrazabilidadSchema>;

export const ConstruirPayloadInputSchema = z.object({
  caso_id: z.string(),
  solicitud: SolicitudSchema,
  validacion: ValidacionSchema,
  maestros: MaestrosSchema,
  out_dir: z.string(),
});
export type ConstruirPayloadInput = z.infer<typeof ConstruirPayloadInputSchema>;

export const ConstruirPayloadOutputSchema = z.union([
  ok(z.object({ payload: PayloadOCSchema, trazabilidad: TrazabilidadSchema, trazabilidad_path: z.string() })),
  ToolErrorSchema,
]);

// ---------- Tool 7: generateApprovalEvidence ----------

export const GenerarEvidenciaInputSchema = z.object({
  caso_id: z.string(),
  aprobacion: AprobacionSchema,
  out_dir: z.string(),
  generar_pdf: z.boolean().default(false),
});
export type GenerarEvidenciaInput = z.infer<typeof GenerarEvidenciaInputSchema>;

export const EvidenciaSchema = z.object({
  txt_path: z.string(),
  pdf_path: z.string().optional(),
  sha256: z.string().length(64),
});
export type Evidencia = z.infer<typeof EvidenciaSchema>;
export const GenerarEvidenciaOutputSchema = z.union([ok(EvidenciaSchema), ToolErrorSchema]);

// ---------- Tool 8: oc_crear ----------

export const CrearOCInputSchema = z.object({
  solicitud_id: z.string(),
  payload: PayloadOCSchema.optional(),
  validacion: ValidacionSchema,
  evidencia: EvidenciaSchema.optional(),
  confirmado: z.boolean().default(false),
  out_root: z.string(),
});
export type CrearOCInput = z.infer<typeof CrearOCInputSchema>;

export const OrdenCreadaSchema = z.object({
  numero_oc: z.string().regex(/^45\d{8}$/),
  fecha: FechaHora,
  ya_existia: z.boolean(),
});
export type OrdenCreada = z.infer<typeof OrdenCreadaSchema>;
export const CrearOCOutputSchema = z.union([ok(OrdenCreadaSchema), ToolErrorSchema]);

export const ResultadoControlSchema = z.enum(['creada', 'bloqueada', 'pendiente_confirmacion']);
export type ResultadoControl = z.infer<typeof ResultadoControlSchema>;

export const FilaControlSchema = z.object({
  solicitud_id: z.string(),
  resultado: ResultadoControlSchema,
  numero_oc: z.string().optional(),
  retroactiva: z.boolean(),
  bloqueos: z.array(z.string()),
  confirmaciones: z.array(z.string()),
  ts: FechaHora,
});
export type FilaControl = z.infer<typeof FilaControlSchema>;

// ---------- Resultado del agente / chat ----------

export const ToolCallSchema = z.object({
  tool: z.string(),
  input: z.unknown(),
  output: z.unknown(),
  ms: z.number(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const AgentResultSchema = z.object({
  estado: ResultadoControlSchema,
  caso_id: z.string(),
  numero_oc: z.string().optional(),
  retroactiva: z.boolean(),
  bloqueos: z.array(HallazgoSchema),
  confirmaciones: z.array(HallazgoSchema),
  derivados: DerivadosSchema.optional(),
  payload: PayloadOCSchema.optional(),
  tools_called: z.array(ToolCallSchema),
  error: z.string().optional(),
});
export type AgentResult = z.infer<typeof AgentResultSchema>;

export const ChatRequestSchema = z.object({
  caso_id: z.string(),
  confirmado: z.boolean().default(false),
  mensaje: z.string().optional(),
  historial: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).default([]),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ChatResponseSchema = z.object({
  respuesta: z.string(),
  result: AgentResultSchema,
});
export type ChatResponse = z.infer<typeof ChatResponseSchema>;
