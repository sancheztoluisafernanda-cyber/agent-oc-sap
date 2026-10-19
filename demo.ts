import * as fs from 'fs';
import * as path from 'path';
import { procesarCaso } from './src/agent';
import { OUT_ROOT } from './src/config';
import { AgentResult } from './src/types';

type Estado = AgentResult['estado'];

// Resultado esperado por caso: sin confirmar y confirmando (reto, sección 3.1).
const ESPERADO: Record<string, { sinConfirmar: Estado; confirmando: Estado; retroactiva?: boolean }> = {
  'sol-001': { sinConfirmar: 'creada', confirmando: 'creada' },
  'sol-002': { sinConfirmar: 'bloqueada', confirmando: 'bloqueada' },
  'sol-003': { sinConfirmar: 'bloqueada', confirmando: 'bloqueada' },
  'sol-004': { sinConfirmar: 'pendiente_confirmacion', confirmando: 'creada' },
  'sol-005': { sinConfirmar: 'pendiente_confirmacion', confirmando: 'creada', retroactiva: true },
  'sol-006': { sinConfirmar: 'pendiente_confirmacion', confirmando: 'creada' },
};

const SIMBOLO: Record<Estado, string> = { creada: '✓', bloqueada: '✗', pendiente_confirmacion: '?' };

function linea(fase: string, r: AgentResult, ms: number): string {
  const detalle = [...r.bloqueos, ...r.confirmaciones].map((h) => h.control).join(', ');
  return `${r.caso_id} [${fase}] ${SIMBOLO[r.estado]} ${r.estado}${r.numero_oc ? ` ${r.numero_oc}` : ''}${r.retroactiva ? ' [RETROACTIVA]' : ''}${detalle ? ` (${detalle})` : ''}  ${ms.toFixed(0)}ms`;
}

async function main() {
  fs.rmSync(OUT_ROOT, { recursive: true, force: true });
  const t0 = performance.now();
  const fallos: string[] = [];
  const resultados: Record<string, { sinConfirmar: AgentResult; confirmando?: AgentResult }> = {};

  for (const [caso, esperado] of Object.entries(ESPERADO)) {
    const t1 = performance.now();
    const r1 = await procesarCaso(caso, { confirmado: false });
    console.log(linea('sin confirmar', r1, performance.now() - t1));
    resultados[caso] = { sinConfirmar: r1 };
    if (r1.estado !== esperado.sinConfirmar) fallos.push(`${caso}: esperaba ${esperado.sinConfirmar} y fue ${r1.estado}`);

    if (r1.estado === 'pendiente_confirmacion') {
      const t2 = performance.now();
      const r2 = await procesarCaso(caso, { confirmado: true });
      console.log(linea('confirmada', r2, performance.now() - t2));
      resultados[caso].confirmando = r2;
      if (r2.estado !== esperado.confirmando) fallos.push(`${caso}: confirmada esperaba ${esperado.confirmando} y fue ${r2.estado}`);
      if (esperado.retroactiva !== undefined && r2.retroactiva !== esperado.retroactiva) {
        fallos.push(`${caso}: retroactiva esperada ${esperado.retroactiva}`);
      }
    }
  }

  for (const [caso, r] of Object.entries(resultados)) {
    if ((r.confirmando ?? r.sinConfirmar).estado !== 'creada') continue;
    const pdf = path.join(OUT_ROOT, caso, 'aprobacion.pdf');
    const ok = fs.existsSync(pdf) && fs.readFileSync(pdf).subarray(0, 5).toString() === '%PDF-';
    if (!ok) fallos.push(`${caso}: falta o es inválido ${pdf}`);
  }

  const total = performance.now() - t0;
  fs.writeFileSync(path.join(OUT_ROOT, 'demo-results.json'), JSON.stringify(resultados, null, 2) + '\n');
  console.log(`\nTiempo total: ${(total / 1000).toFixed(2)}s`);
  console.log(`Log de control: ${path.join(OUT_ROOT, 'control.csv')}`);
  console.log(`SAP simulado:   ${path.join(OUT_ROOT, 'sap', 'ordenes.jsonl')}`);
  if (total > 5000) fallos.push(`la demo tardó ${(total / 1000).toFixed(2)}s (límite 5s)`);

  if (fallos.length) {
    console.error('\nFALLOS:\n- ' + fallos.join('\n- '));
    process.exit(1);
  }
  console.log('\nOK: 6/6 casos con el resultado esperado');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
