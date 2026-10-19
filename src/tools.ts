import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { renderizarPdf } from './evidence-pdf';
import { crearOrdenSAP } from './sap-adapter';
import {
  AprobacionSchema,
  CheckRetroactiveInput,
  CheckRetroactiveInputSchema,
  CheckRetroactiveOutput,
  CondicionPagoSchema,
  ConstruirPayloadInput,
  ConstruirPayloadInputSchema,
  CorreoSchema,
  CotizacionExtraida,
  CotizacionExtraidaSchema,
  CrearOCInput,
  Derivados,
  Evidencia,
  GenerarEvidenciaInput,
  GenerarEvidenciaInputSchema,
  Hallazgo,
  CentroCostoSchema,
  IndicadorIvaSchema,
  LeerPaqueteInput,
  LeerPaqueteInputSchema,
  LoadMaestrosInput,
  LoadMaestrosInputSchema,
  Maestros,
  Paquete,
  PayloadOC,
  PayloadOCSchema,
  ProveedorSchema,
  SolicitudSchema,
  Trazabilidad,
  Validacion,
  ValidarInput,
  ValidarInputSchema,
} from './types';

export type Res<T> = { ok: true; data: T } | { ok: false; error: string };

const good = <T>(data: T): Res<T> => ({ ok: true, data });
const bad = (e: unknown): { ok: false; error: string } => ({
  ok: false,
  error:
    e instanceof z.ZodError
      ? e.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('; ')
      : e instanceof Error
        ? e.message
        : String(e),
});
function safe<T>(fn: () => T): Res<T> {
  try {
    return good(fn());
  } catch (e) {
    return bad(e);
  }
}

const DAY_MS = 86_400_000;
const norm = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const cop = (n: number) => `COP ${n.toLocaleString('es-CO')}`;
const diasEntre = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);

function leerJson<T>(file: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, etiqueta: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${etiqueta}: JSON malformado o ilegible (${e instanceof Error ? e.message : e})`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${etiqueta}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

// ---------- loadMaestros ----------

export function loadMaestros(input: LoadMaestrosInput): Res<Maestros> {
  return safe(() => {
    const { maestros_dir } = LoadMaestrosInputSchema.parse(input);
    const f = (n: string) => path.join(maestros_dir, n);
    return {
      proveedores: leerJson(f('proveedores.json'), z.array(ProveedorSchema), 'proveedores.json'),
      centros_costo: leerJson(f('centros-costo.json'), z.array(CentroCostoSchema), 'centros-costo.json'),
      iva: leerJson(f('indicadores-iva.json'), z.array(IndicadorIvaSchema), 'indicadores-iva.json'),
      condiciones_pago: leerJson(f('condiciones-pago.json'), z.array(CondicionPagoSchema), 'condiciones-pago.json'),
    };
  });
}

// ---------- oc_leer_paquete ----------

export function ocLeerPaquete(input: LeerPaqueteInput): Res<Paquete> {
  return safe(() => {
    const { caso_dir } = LeerPaqueteInputSchema.parse(input);
    const faltantes: string[] = [];
    const existe = (n: string) => {
      const ok = fs.existsSync(path.join(caso_dir, n));
      if (!ok) faltantes.push(n);
      return ok;
    };
    const texto = (n: string) => (existe(n) ? fs.readFileSync(path.join(caso_dir, n), 'utf8') : null);
    const json = <T>(n: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>) => (existe(n) ? leerJson(path.join(caso_dir, n), schema, n) : null);

    const correo = json('correo.json', CorreoSchema);
    const solicitud = json('solicitud.json', SolicitudSchema);
    const cotizacion = texto('cotizacion.txt');
    const aprobacion = json('aprobacion.json', AprobacionSchema);
    // factura.txt es opcional: su ausencia no es un faltante
    const facturaPath = path.join(caso_dir, 'factura.txt');
    const factura = fs.existsSync(facturaPath) ? fs.readFileSync(facturaPath, 'utf8') : null;

    return { correo, solicitud, cotizacion, aprobacion, factura, faltantes };
  });
}

// ---------- extractQuotationData ----------

const monto = (s: string) => Number(s.replace(/\./g, '').replace(',', '.'));

export function parseCotizacion(texto: string): Res<CotizacionExtraida> {
  return safe(() => {
    const pick = (re: RegExp) => texto.match(re)?.[1]?.trim();
    const items = [...texto.matchAll(/^\d+\.\s*(.+?)\s*\|\s*Cantidad:\s*([\d.,]+)\s*\|\s*Precio unitario[^:]*:\s*COP\s*([\d.,]+)/gm)];
    if (items.length !== 1) {
      throw new Error(`Se esperaba 1 ítem en la cotización y se encontraron ${items.length}`);
    }
    const [, descripcion, cantidad, precio] = items[0];
    const nit = texto.match(/^NIT:\s*([\d.]+)-\d/m)?.[1]?.replace(/\./g, '');
    const iva = texto.match(/^IVA\s*(\d+(?:[.,]\d+)?)%:\s*COP\s*([\d.,]+)/m);
    const base = pick(/^Base gravable:\s*COP\s*([\d.,]+)/m);
    const total = pick(/^TOTAL[^:]*:\s*COP\s*([\d.,]+)/m);

    return CotizacionExtraidaSchema.parse({
      proveedor_nombre: pick(/^Proveedor:\s*(.+)$/m),
      proveedor_nit: nit,
      fecha: pick(/^Fecha:\s*(\d{4}-\d{2}-\d{2})/m),
      descripcion,
      cantidad: monto(cantidad),
      precio_unitario: monto(precio),
      base_gravable: base ? monto(base) : undefined,
      iva_monto: iva ? monto(iva[2]) : undefined,
      iva_tasa: iva ? Number(iva[1].replace(',', '.')) / 100 : undefined,
      total: total ? monto(total) : undefined,
    });
  });
}

export type LlmExtractor = (texto: string) => Promise<CotizacionExtraida>;

export async function extractQuotationData(
  input: { cotizacion_texto: string },
  llm?: LlmExtractor,
): Promise<Res<CotizacionExtraida>> {
  const directo = parseCotizacion(input.cotizacion_texto);
  if (directo.ok || !llm) return directo;
  try {
    return good(CotizacionExtraidaSchema.parse(await llm(input.cotizacion_texto)));
  } catch (e) {
    return { ok: false, error: `${directo.error}; extracción con modelo falló: ${bad(e).error}` };
  }
}

// ---------- checkRetroactive ----------

export function fechaFactura(texto: string | null | undefined): string | undefined {
  return texto?.match(/Fecha de emisi[oó]n:\s*(\d{4}-\d{2}-\d{2})/i)?.[1];
}

export function checkRetroactive(input: CheckRetroactiveInput): Res<CheckRetroactiveOutput> {
  return safe(() => {
    const i = CheckRetroactiveInputSchema.parse(input);
    if (!i.fecha_factura) return { is_retroactive: false, days_late: 0 };
    const dias = diasEntre(i.fecha_factura, i.fecha_solicitud);
    return { is_retroactive: dias > 0, days_late: Math.max(dias, 0) };
  });
}

// ---------- oc_validar ----------

export function ocValidar(input: ValidarInput): Res<Validacion> {
  return safe(() => {
    const { solicitud: s, cotizacion: c, aprobacion: a, maestros: m, retroactivo } = ValidarInputSchema.parse(input);
    const bloqueos: Hallazgo[] = [];
    const confirmaciones: Hallazgo[] = [];
    const derivados: Derivados = {};
    const bloquear = (control: string, mensaje: string, accion_sugerida: string) =>
      bloqueos.push({ control, mensaje, accion_sugerida });
    const confirmar = (control: string, mensaje: string, accion_sugerida: string) =>
      confirmaciones.push({ control, mensaje, accion_sugerida });

    // Proveedor
    const prov = s.proveedor_nit
      ? m.proveedores.find((p) => p.nit === s.proveedor_nit)
      : m.proveedores.find((p) => norm(p.nombre) === norm(s.proveedor_nombre));
    if (!prov) {
      bloquear(
        'proveedor',
        s.proveedor_nit
          ? `El proveedor ${s.proveedor_nombre} (NIT ${s.proveedor_nit}) no existe en el maestro de proveedores`
          : `Proveedor "${s.proveedor_nombre}" sin NIT y no identificable en el maestro`,
        'Solicitar el alta del proveedor (o corregir el NIT) antes de reintentar',
      );
    } else {
      derivados.proveedor_codigo_sap = prov.codigo_sap;
      if (!s.proveedor_nit) derivados.proveedor_nit = prov.nit;
      if (!prov.activo) {
        bloquear('proveedor', `El proveedor ${prov.nombre} está inactivo en el maestro`, 'Reactivar el proveedor o escoger otro');
      }
      if (c.proveedor_nit && c.proveedor_nit !== prov.nit) {
        confirmar(
          'proveedor',
          `El NIT de la cotización (${c.proveedor_nit}) no coincide con el del proveedor (${prov.nit})`,
          'Verificar la cotización con el solicitante',
        );
      }
    }

    // Centro de costo, subárea y aprobador
    const cc = m.centros_costo.find((x) => x.centro_costo === s.centro_costo);
    if (!cc) {
      bloquear('centro_costo', `El centro de costo ${s.centro_costo} no existe`, 'Corregir el centro de costo con el solicitante');
    } else {
      if (!cc.subareas.includes(s.subarea)) {
        bloquear('subarea', `La subárea "${s.subarea}" no pertenece al centro ${cc.centro_costo} (${cc.subareas.join(', ')})`, 'Corregir la subárea');
      }
      const ap = cc.aprobadores.find((x) => x.email.toLowerCase() === a.de.toLowerCase());
      if (!ap) {
        bloquear(
          'aprobador',
          `${a.de} no está autorizado a aprobar en ${cc.centro_costo} (${cc.nombre})`,
          `Pedir la aprobación a: ${cc.aprobadores.map((x) => `${x.nombre} (tope ${cop(x.tope)})`).join('; ')}`,
        );
      } else {
        derivados.aprobador_email = ap.email;
        derivados.aprobador_nombre = ap.nombre;
        if (s.valor_total > ap.tope) {
          bloquear(
            'aprobador',
            `${ap.nombre} aprueba hasta ${cop(ap.tope)} y la solicitud es por ${cop(s.valor_total)}`,
            'Escalar a un aprobador con tope suficiente',
          );
        }
      }
    }
    if (!/aprob/i.test(a.cuerpo)) {
      bloquear('aprobacion', 'El correo de aprobación no contiene una aprobación explícita', 'Solicitar al líder una aprobación explícita');
    }

    // Montos
    if (Math.round(s.cantidad * s.valor_unitario) !== s.valor_total) {
      bloquear(
        'monto',
        `valor_total ${cop(s.valor_total)} no es cantidad × valor unitario (${cop(Math.round(s.cantidad * s.valor_unitario))})`,
        'Corregir la solicitud',
      );
    }
    if (c.total !== s.valor_total) {
      confirmar(
        'cotizacion',
        `La cotización suma ${cop(c.total)} y la solicitud ${cop(s.valor_total)} (diferencia ${cop(c.total - s.valor_total)})`,
        c.total > s.valor_total
          ? 'Confirmar si se crea por el monto aprobado o pedir una cotización ajustada / nueva aprobación'
          : 'Confirmar el monto correcto con el solicitante',
      );
    }

    // IVA
    let ivaCodigo = s.indicador_iva;
    if (!ivaCodigo) {
      if (prov) {
        ivaCodigo = prov.indicador_iva_default;
        derivados.indicador_iva = ivaCodigo;
        const t = m.iva.find((x) => x.codigo === ivaCodigo)?.tasa;
        confirmar(
          'iva',
          `Indicador de IVA no informado en la solicitud; el maestro del proveedor sugiere ${ivaCodigo}${t !== undefined ? ` (${t * 100}%)` : ''}`,
          'Confirmar el indicador propuesto o indicar otro',
        );
      } else {
        bloquear('iva', 'Indicador de IVA no informado y no se puede derivar sin proveedor', 'Informar el indicador de IVA');
      }
    }
    const iva = ivaCodigo ? m.iva.find((x) => x.codigo === ivaCodigo) : undefined;
    if (ivaCodigo && !iva) {
      bloquear('iva', `El indicador de IVA ${ivaCodigo} no existe en el maestro`, 'Corregir el indicador');
    }
    if (iva && c.iva_tasa !== undefined && Math.abs(c.iva_tasa - iva.tasa) > 1e-9) {
      confirmar('iva', `La cotización indica IVA ${c.iva_tasa * 100}% y el indicador ${iva.codigo} es ${iva.tasa * 100}%`, 'Verificar el indicador de IVA');
    }

    // Condiciones de pago
    let pagoCodigo = s.condiciones_pago;
    if (!pagoCodigo) {
      if (prov) {
        pagoCodigo = prov.condiciones_pago_default;
        derivados.condiciones_pago = pagoCodigo;
      } else {
        bloquear('condiciones_pago', 'Condiciones de pago no informadas y no se pueden derivar sin proveedor', 'Informar las condiciones de pago');
      }
    }
    if (pagoCodigo && !m.condiciones_pago.some((x) => x.codigo === pagoCodigo)) {
      bloquear('condiciones_pago', `La condición de pago ${pagoCodigo} no existe en el maestro`, 'Corregir las condiciones de pago');
    }

    // Retroactividad (informativa: exige confirmación, no bloquea)
    if (retroactivo.is_retroactive) {
      confirmar(
        'retroactiva',
        `Compra retroactiva: la factura se emitió ${retroactivo.days_late} día(s) antes de la solicitud`,
        'Confirmar para crear la OC marcada como retroactiva y reportarla a la dirección',
      );
    }

    return {
      apta: bloqueos.length === 0,
      bloqueos,
      confirmaciones,
      derivados,
      retroactiva: retroactivo.is_retroactive,
      dias_retroactivo: retroactivo.is_retroactive ? retroactivo.days_late : undefined,
    };
  });
}

// ---------- oc_construir_payload ----------

export function ocConstruirPayload(
  input: ConstruirPayloadInput,
): Res<{ payload: PayloadOC; trazabilidad: Trazabilidad; trazabilidad_path: string }> {
  return safe(() => {
    const { solicitud: s, validacion: v, maestros: m, out_dir } = ConstruirPayloadInputSchema.parse(input);
    if (!v.apta) throw new Error('No se puede construir el payload de una solicitud con bloqueos');

    const d = v.derivados;
    const nit = s.proveedor_nit ?? d.proveedor_nit;
    const prov = m.proveedores.find((p) => p.nit === nit);
    const ivaCodigo = s.indicador_iva ?? d.indicador_iva;
    const iva = m.iva.find((x) => x.codigo === ivaCodigo);
    const pago = s.condiciones_pago ?? d.condiciones_pago;
    if (!prov || !iva || !pago || !d.aprobador_email || !d.aprobador_nombre) {
      throw new Error('Datos insuficientes para construir el payload (proveedor, IVA, pago o aprobador)');
    }

    const neto = Math.round(s.valor_total / (1 + iva.tasa));
    const payload = PayloadOCSchema.parse({
      solicitud_id: s.solicitud_id,
      proveedor: { codigo_sap: prov.codigo_sap, nit: prov.nit, nombre: prov.nombre },
      centro_costo: s.centro_costo,
      subarea: s.subarea,
      descripcion: s.descripcion,
      cantidad: s.cantidad,
      valor_unitario: s.valor_unitario,
      valor_neto: neto,
      iva: { codigo: iva.codigo, tasa: iva.tasa, monto: s.valor_total - neto },
      valor_total: s.valor_total,
      moneda: s.moneda,
      condiciones_pago: pago,
      aprobador: { email: d.aprobador_email, nombre: d.aprobador_nombre },
      retroactiva: v.retroactiva,
    });

    const trazabilidad: Trazabilidad = {
      solicitud_id: 'solicitud',
      'proveedor.codigo_sap': 'maestro.proveedores',
      'proveedor.nit': s.proveedor_nit ? 'solicitud' : 'derivado',
      'proveedor.nombre': 'maestro.proveedores',
      centro_costo: 'solicitud',
      subarea: 'solicitud',
      descripcion: 'solicitud',
      cantidad: 'solicitud',
      valor_unitario: 'solicitud',
      valor_neto: 'derivado',
      'iva.codigo': s.indicador_iva ? 'solicitud' : 'derivado',
      'iva.tasa': 'maestro.indicadores_iva',
      'iva.monto': 'derivado',
      valor_total: 'solicitud',
      moneda: 'solicitud',
      condiciones_pago: s.condiciones_pago ? 'solicitud' : 'derivado',
      'aprobador.email': 'maestro.centros_costo',
      'aprobador.nombre': 'maestro.centros_costo',
      retroactiva: 'derivado',
    };

    fs.mkdirSync(out_dir, { recursive: true });
    const trazabilidad_path = path.join(out_dir, 'trazabilidad.json');
    fs.writeFileSync(trazabilidad_path, JSON.stringify(trazabilidad, null, 2) + '\n');
    return { payload, trazabilidad, trazabilidad_path };
  });
}

// ---------- generateApprovalEvidence ----------

export async function generateApprovalEvidence(input: GenerarEvidenciaInput): Promise<Res<Evidencia>> {
  try {
    const { caso_id, aprobacion: a, out_dir, generar_pdf } = GenerarEvidenciaInputSchema.parse(input);
    const contenido = [
      `De: ${a.de}`,
      `Para: ${a.para}`,
      ...(a.cc.length ? [`Cc: ${a.cc.join(', ')}`] : []),
      `Fecha: ${a.fecha}`,
      `Asunto: ${a.asunto}`,
      '',
      a.cuerpo,
      '',
    ].join('\n');
    const sha256 = crypto.createHash('sha256').update(contenido, 'utf8').digest('hex');

    fs.mkdirSync(out_dir, { recursive: true });
    const txt_path = path.join(out_dir, 'aprobacion.txt');
    fs.writeFileSync(txt_path, `${contenido}\n---\nsha256: ${sha256}\n`);

    let pdf_path: string | undefined;
    if (generar_pdf) {
      pdf_path = path.join(out_dir, 'aprobacion.pdf');
      fs.writeFileSync(pdf_path, await renderizarPdf(`Evidencia de aprobación - ${caso_id}`, contenido, sha256, a.fecha));
    }
    return good({ txt_path, pdf_path, sha256 });
  } catch (e) {
    return bad(e);
  }
}

// ---------- oc_crear ----------

export function ocCrear(input: CrearOCInput) {
  return crearOrdenSAP(input);
}
