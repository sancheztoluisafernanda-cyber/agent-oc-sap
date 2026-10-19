import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { chat } from './agent';
import { CASO_ID_RE, FIXTURES_DIR, UI_DIR } from './config';
import { hayModelo } from './llm';
import { ChatRequestSchema } from './types';

export const app = express();
app.set('trust proxy', 1);

// Límite de /chat por IP (en memoria): protege el gasto de la clave de la API en un despliegue público.
const LIMITE = Number(process.env.CHAT_RATE_LIMIT ?? 30);
const VENTANA_MS = 10 * 60_000;
const visitas = new Map<string, { n: number; reinicio: number }>();
function limitar(req: express.Request, res: express.Response, next: express.NextFunction) {
  const ahora = Date.now();
  const ip = req.ip ?? 'desconocida';
  let v = visitas.get(ip);
  if (!v || v.reinicio <= ahora) {
    v = { n: 0, reinicio: ahora + VENTANA_MS };
    visitas.set(ip, v);
  }
  if (++v.n > LIMITE) {
    res.setHeader('Retry-After', String(Math.ceil((v.reinicio - ahora) / 1000)));
    res.status(429).json({ error: 'Demasiadas solicitudes, intenta de nuevo en unos minutos' });
    return;
  }
  if (visitas.size > 5000) for (const [k, x] of visitas) if (x.reinicio <= ahora) visitas.delete(k);
  next();
}
app.use(express.json({ limit: '100kb' }));
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(express.static(UI_DIR));

app.get('/health', (_req, res) => {
  res.json({ ok: true, modelo: hayModelo() });
});

app.get('/casos', (_req, res) => {
  const dir = path.join(FIXTURES_DIR, 'solicitudes');
  const casos = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => CASO_ID_RE.test(n)).sort() : [];
  res.json({ casos });
});

app.post('/chat', limitar, async (req, res) => {
  const parsed = ChatRequestSchema.safeParse(req.body);
  if (!parsed.success || !CASO_ID_RE.test(parsed.data.caso_id)) {
    res.status(400).json({ error: 'Solicitud inválida: se espera { caso_id: "sol-NNN", confirmado?, mensaje?, historial? }' });
    return;
  }
  try {
    res.json(await chat(parsed.data));
  } catch (e) {
    // El detalle (puede incluir datos del proveedor LLM) va al log del servidor, nunca al cliente.
    console.error('[chat] error:', e instanceof Error ? e.message : e);
    res.status(500).json({ error: 'Error interno procesando el caso' });
  }
});

if (require.main === module) {
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    console.log(`Agente OC SAP en http://localhost:${port} (${hayModelo() ? 'con modelo' : 'sin modelo: flujo determinístico'})`);
  });
}
