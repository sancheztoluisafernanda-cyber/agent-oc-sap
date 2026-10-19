import Anthropic from '@anthropic-ai/sdk';
import { MODEL } from './config';
import { CotizacionExtraida, CotizacionExtraidaSchema } from './types';

let cliente: Anthropic | undefined;

export function hayModelo(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export function getCliente(): Anthropic {
  cliente ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return cliente;
}

// Respaldo para cotizaciones cuyo formato no cubre el parser determinístico.
export async function extraerCotizacionConLLM(texto: string): Promise<CotizacionExtraida> {
  const resp = await getCliente().messages.create({
    model: MODEL,
    max_tokens: 600,
    system:
      'Extraes datos de cotizaciones de proveedores colombianos. Responde SOLO un objeto JSON con las claves: ' +
      'proveedor_nombre, proveedor_nit (solo dígitos, sin puntos ni dígito de verificación), fecha (YYYY-MM-DD), ' +
      'descripcion, cantidad, precio_unitario, base_gravable, iva_monto, iva_tasa (0.19 = 19%), total. ' +
      'Los montos son números sin separadores. Omite las claves que no aparezcan en el texto; no inventes valores.',
    messages: [{ role: 'user', content: texto }],
  });
  const bloque = resp.content.find((b) => b.type === 'text');
  const json = bloque && bloque.type === 'text' ? bloque.text.match(/\{[\s\S]*\}/)?.[0] : undefined;
  if (!json) throw new Error('El modelo no devolvió JSON');
  return CotizacionExtraidaSchema.parse(JSON.parse(json));
}
