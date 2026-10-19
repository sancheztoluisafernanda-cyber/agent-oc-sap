import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { chat } from './agent';
import { CASO_ID_RE, FIXTURES_DIR, UI_DIR } from './config';
import { hayModelo } from './llm';
import { ChatRequestSchema } from './types';

export const app = express();
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

app.post('/chat', async (req, res) => {
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
