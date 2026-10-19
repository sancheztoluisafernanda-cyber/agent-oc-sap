'use strict';

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...hijos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const h of hijos.flat()) if (h != null) n.append(h);
  return n;
}

const cop = (n) => `COP ${Number(n).toLocaleString('es-CO')}`;
const ESTADOS = { creada: 'OC creada', pendiente_confirmacion: 'Requiere tu confirmación', bloqueada: 'Bloqueada' };

const estado = { caso: null, confirmado: false, historial: [], ocupado: false, ultimaPendiente: null };

function limpiarVacio() {
  const v = document.querySelector('.vacio');
  if (v) v.remove();
}

function scrollAbajo() {
  const c = $('mensajes');
  c.scrollTop = c.scrollHeight;
}

function agregar(nodo) {
  limpiarVacio();
  $('mensajes').append(nodo);
  scrollAbajo();
}

function mensajeUsuario(texto) {
  agregar(el('div', { class: 'msg user' }, texto));
}

function mensajeError(texto) {
  agregar(el('div', { class: 'msg error', role: 'alert' }, texto));
}

function hallazgos(lista, tipo) {
  if (!lista.length) return null;
  return el(
    'ul',
    { class: 'hallazgos' },
    lista.map((h) =>
      el(
        'li',
        { class: tipo },
        el('strong', {}, `${tipo === 'bloqueo' ? 'Bloqueo' : 'Confirmar'} · ${h.control}: `),
        h.mensaje,
        el('small', {}, `Sugerencia: ${h.accion_sugerida}`),
      ),
    ),
  );
}

function derivados(d) {
  if (!d) return null;
  const filas = [
    d.proveedor_nit && ['NIT del proveedor', d.proveedor_nit],
    d.indicador_iva && ['Indicador de IVA', d.indicador_iva],
    d.condiciones_pago && ['Condiciones de pago', d.condiciones_pago],
  ].filter(Boolean);
  if (!filas.length) return null;
  return el(
    'details',
    { open: '' },
    el('summary', {}, 'Completado desde maestros'),
    el('table', {}, filas.map(([k, v]) => el('tr', {}, el('th', {}, k), el('td', {}, v)))),
  );
}

function tablaPayload(p) {
  if (!p) return null;
  const filas = [
    ['Solicitud', p.solicitud_id],
    ['Proveedor', `${p.proveedor.nombre} (NIT ${p.proveedor.nit}, SAP ${p.proveedor.codigo_sap})`],
    ['Centro de costo', `${p.centro_costo} · ${p.subarea}`],
    ['Descripción', p.descripcion],
    ['Cantidad × unitario', `${p.cantidad} × ${cop(p.valor_unitario)}`],
    ['Valor neto', cop(p.valor_neto)],
    ['IVA', `${p.iva.codigo} (${p.iva.tasa * 100}%) · ${cop(p.iva.monto)}`],
    ['Total', cop(p.valor_total)],
    ['Condiciones de pago', p.condiciones_pago],
    ['Aprobador', `${p.aprobador.nombre} <${p.aprobador.email}>`],
    ['Retroactiva', p.retroactiva ? 'Sí' : 'No'],
  ];
  return el(
    'details',
    {},
    el('summary', {}, 'OC tal como quedaría en SAP'),
    el('table', {}, filas.map(([k, v]) => el('tr', {}, el('th', {}, k), el('td', {}, String(v))))),
  );
}

function llamadas(calls) {
  if (!calls.length) return null;
  return el(
    'details',
    {},
    el('summary', {}, `Herramientas ejecutadas (${calls.length})`),
    calls.map((c) => {
      const ok = c.output && c.output.ok;
      const json = JSON.stringify(c.output, null, 2);
      return el(
        'details',
        {},
        el('summary', {}, `${ok ? '✓' : '✗'} ${c.tool} · ${c.ms} ms`),
        el('pre', {}, json.length > 2500 ? `${json.slice(0, 2500)}\n…(recortado)` : json),
      );
    }),
  );
}

function mensajeAgente(data) {
  const r = data.result;
  const hijos = [
    el(
      'div',
      {},
      el('span', { class: `badge ${r.estado}` }, ESTADOS[r.estado] + (r.numero_oc ? ` · ${r.numero_oc}` : '')),
      r.retroactiva ? el('span', { class: 'badge retro' }, 'RETROACTIVA') : null,
    ),
    el('p', { class: 'texto' }, data.respuesta),
    hallazgos(r.bloqueos, 'bloqueo'),
    hallazgos(r.confirmaciones, 'confirmacion'),
    derivados(r.derivados),
    tablaPayload(r.payload),
    llamadas(r.tools_called),
  ];

  if (r.estado === 'pendiente_confirmacion') {
    const boton = el(
      'button',
      { class: 'primary', type: 'button', onclick: () => confirmar(boton) },
      'Confirmar y crear OC',
    );
    hijos.push(el('div', { class: 'acciones' }, boton));
    estado.ultimaPendiente = boton;
  }
  agregar(el('div', { class: 'msg agente' }, hijos));
}

async function enviar(mensaje) {
  if (estado.ocupado || !estado.caso) return;
  estado.ocupado = true;
  setBusy(true);
  try {
    const resp = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        caso_id: estado.caso,
        confirmado: estado.confirmado,
        mensaje,
        historial: estado.historial,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `Error ${resp.status}`);
    estado.historial.push({ role: 'user', content: mensaje }, { role: 'assistant', content: data.respuesta });
    mensajeAgente(data);
  } catch (e) {
    mensajeError(`No se pudo procesar la solicitud: ${e.message}`);
  } finally {
    estado.ocupado = false;
    setBusy(false);
  }
}

function confirmar(boton) {
  boton.disabled = true;
  estado.confirmado = true;
  const texto = 'Confirmo los puntos señalados, procede con la creación de la OC.';
  mensajeUsuario(texto);
  enviar(texto);
}

function setBusy(b) {
  $('procesar').disabled = b;
  $('texto').disabled = b;
  $('form').querySelector('button').disabled = b;
  document.querySelectorAll('.acciones button').forEach((x) => (x.disabled = b || estado.confirmado));
}

function reiniciar() {
  estado.caso = $('caso').value;
  estado.confirmado = false;
  estado.historial = [];
  $('mensajes').replaceChildren(
    el('p', { class: 'vacio' }, `Caso ${estado.caso} seleccionado. Pulsa "Procesar solicitud" para empezar.`),
  );
}

function procesar() {
  reiniciar();
  const texto = `Procesa la solicitud ${estado.caso}`;
  mensajeUsuario(texto);
  enviar(texto);
}

async function iniciar() {
  try {
    const [casos, salud] = await Promise.all([
      fetch('/casos').then((r) => r.json()),
      fetch('/health').then((r) => r.json()),
    ]);
    $('modo').textContent = salud.modelo ? 'Con modelo' : 'Sin modelo (flujo determinístico)';
    $('caso').replaceChildren(...casos.casos.map((c) => el('option', { value: c }, c)));
    reiniciar();
  } catch (e) {
    mensajeError('No se pudo conectar con el servidor.');
  }

  $('caso').addEventListener('change', reiniciar);
  $('procesar').addEventListener('click', procesar);
  $('form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const texto = $('texto').value.trim();
    if (!texto) return;
    $('texto').value = '';
    mensajeUsuario(texto);
    enviar(texto);
  });
}

iniciar();
