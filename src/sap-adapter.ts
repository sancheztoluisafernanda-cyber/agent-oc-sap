import * as fs from 'fs';
import * as path from 'path';
import { CrearOCInput, CrearOCInputSchema, FilaControl, OrdenCreada, Validacion } from './types';

const PRIMER_NUMERO = 4500000001;
const CSV_HEADER = 'solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts';

type Res<T> = { ok: true; data: T } | { ok: false; error: string };

interface RegistroOrden {
  numero_oc: string;
  fecha: string;
  solicitud_id: string;
  retroactiva: boolean;
  evidencia_sha256?: string;
  payload: unknown;
}

function leerOrdenes(file: string): RegistroOrden[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RegistroOrden);
}

function csv(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function registrarControl(outRoot: string, fila: FilaControl): void {
  const file = path.join(outRoot, 'control.csv');
  fs.mkdirSync(outRoot, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, CSV_HEADER + '\n');
  const linea = [
    fila.solicitud_id,
    fila.resultado,
    fila.numero_oc ?? '',
    String(fila.retroactiva),
    fila.bloqueos.join(' | '),
    fila.confirmaciones.join(' | '),
    fila.ts,
  ]
    .map(csv)
    .join(',');
  fs.appendFileSync(file, linea + '\n');
}

function mensajes(v: Validacion) {
  return {
    bloqueos: v.bloqueos.map((h) => `${h.control}: ${h.mensaje}`),
    confirmaciones: v.confirmaciones.map((h) => `${h.control}: ${h.mensaje}`),
  };
}

export function crearOrdenSAP(input: CrearOCInput): Res<OrdenCreada> {
  try {
    const i = CrearOCInputSchema.parse(input);
    const ts = new Date().toISOString();
    const base = { solicitud_id: i.solicitud_id, retroactiva: i.validacion.retroactiva, ts, ...mensajes(i.validacion) };

    if (!i.validacion.apta) {
      registrarControl(i.out_root, { ...base, resultado: 'bloqueada' });
      return { ok: false, error: `OC bloqueada: ${base.bloqueos.join('; ')}` };
    }
    if (i.validacion.confirmaciones.length > 0 && !i.confirmado) {
      registrarControl(i.out_root, { ...base, resultado: 'pendiente_confirmacion' });
      return { ok: false, error: `Requiere confirmación del analista: ${base.confirmaciones.join('; ')}` };
    }
    if (!i.payload || !i.evidencia) {
      return { ok: false, error: 'Faltan payload o evidencia de aprobación para crear la OC' };
    }

    const file = path.join(i.out_root, 'sap', 'ordenes.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const ordenes = leerOrdenes(file);

    const existente = ordenes.find((o) => o.solicitud_id === i.solicitud_id);
    if (existente) {
      registrarControl(i.out_root, { ...base, resultado: 'creada', numero_oc: existente.numero_oc });
      return { ok: true, data: { numero_oc: existente.numero_oc, fecha: existente.fecha, ya_existia: true } };
    }

    const siguiente = ordenes.reduce((max, o) => Math.max(max, Number(o.numero_oc) + 1), PRIMER_NUMERO);
    const registro: RegistroOrden = {
      numero_oc: String(siguiente),
      fecha: ts,
      solicitud_id: i.solicitud_id,
      retroactiva: i.validacion.retroactiva,
      evidencia_sha256: i.evidencia.sha256,
      payload: i.payload,
    };
    fs.appendFileSync(file, JSON.stringify(registro) + '\n');
    registrarControl(i.out_root, { ...base, resultado: 'creada', numero_oc: registro.numero_oc });
    return { ok: true, data: { numero_oc: registro.numero_oc, fecha: ts, ya_existia: false } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
