import * as path from 'path';

export const FIXTURES_DIR = process.env.OC_FIXTURES_DIR ?? path.join(process.cwd(), 'fixtures', 'reto-03');
export const OUT_ROOT = process.env.OC_OUT_DIR ?? path.join(process.cwd(), 'out');
export const UI_DIR = path.join(process.cwd(), 'src', 'ui');
export const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5';

export const CASO_ID_RE = /^sol-\d{3}$/;

export function casoDir(casoId: string): string {
  if (!CASO_ID_RE.test(casoId)) throw new Error(`caso_id inválido: ${casoId}`);
  return path.join(FIXTURES_DIR, 'solicitudes', casoId);
}

export function casoOutDir(casoId: string): string {
  if (!CASO_ID_RE.test(casoId)) throw new Error(`caso_id inválido: ${casoId}`);
  return path.join(OUT_ROOT, casoId);
}
