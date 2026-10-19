import { PDFDocument, PDFFont, StandardFonts, rgb } from 'pdf-lib';

const PAGE = { w: 595, h: 842 };
const MARGIN = 50;
const SIZE = 10.5;
const LEADING = 14;

// Helvetica estándar solo cubre WinAnsi: lo que no entra se reemplaza por "?".
function limpiar(texto: string, font: PDFFont): string {
  const soportados = new Set(font.getCharacterSet());
  return [...texto.replace(/\t/g, '    ')].map((c) => (soportados.has(c.codePointAt(0)!) ? c : '?')).join('');
}

function envolver(linea: string, font: PDFFont, ancho: number): string[] {
  if (!linea) return [''];
  const salida: string[] = [];
  let actual = '';
  for (const palabra of linea.split(' ')) {
    const prueba = actual ? `${actual} ${palabra}` : palabra;
    if (font.widthOfTextAtSize(prueba, SIZE) <= ancho) {
      actual = prueba;
      continue;
    }
    if (actual) salida.push(actual);
    let resto = palabra;
    while (font.widthOfTextAtSize(resto, SIZE) > ancho) {
      let n = resto.length;
      while (n > 1 && font.widthOfTextAtSize(resto.slice(0, n), SIZE) > ancho) n--;
      salida.push(resto.slice(0, n));
      resto = resto.slice(n);
    }
    actual = resto;
  }
  salida.push(actual);
  return salida;
}

export async function renderizarPdf(titulo: string, contenido: string, sha256: string, fecha: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const normal = await pdf.embedFont(StandardFonts.Helvetica);
  const negrita = await pdf.embedFont(StandardFonts.HelveticaBold);
  const f = new Date(fecha);
  const fijo = Number.isNaN(f.getTime()) ? new Date(0) : f;
  pdf.setTitle(titulo);
  pdf.setProducer('agente-oc-sap');
  pdf.setCreator('agente-oc-sap');
  pdf.setCreationDate(fijo);
  pdf.setModificationDate(fijo);

  const ancho = PAGE.w - 2 * MARGIN;
  let page = pdf.addPage([PAGE.w, PAGE.h]);
  let y = PAGE.h - MARGIN;
  const escribir = (texto: string, font: PDFFont, size = SIZE) => {
    if (y < MARGIN + 30) {
      page = pdf.addPage([PAGE.w, PAGE.h]);
      y = PAGE.h - MARGIN;
    }
    page.drawText(texto, { x: MARGIN, y, size, font, color: rgb(0.1, 0.12, 0.17) });
    y -= LEADING;
  };

  page.drawText(limpiar(titulo, negrita), { x: MARGIN, y, size: 15, font: negrita, color: rgb(0.1, 0.12, 0.17) });
  y -= 28;
  for (const linea of contenido.split('\n')) {
    for (const parte of envolver(limpiar(linea, normal), normal, ancho)) escribir(parte, normal);
  }
  y -= LEADING;
  escribir('Huella del contenido (SHA-256):', negrita);
  escribir(sha256, normal, 9);

  return pdf.save();
}
