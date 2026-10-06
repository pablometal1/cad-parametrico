// Archivos del proyecto: descarga, lectura y borrador automático en el navegador.
import { parseDocument, serializeDocument } from '../document/serialize';
import type { CadDocument } from '../document/types';

export const FILE_EXTENSION = '.cad.json';
const DRAFT_KEY = 'cad-parametrico:borrador';

/** Descarga el documento como archivo JSON. */
export function downloadDocument(doc: CadDocument, fileName: string) {
  const blob = new Blob([serializeDocument(doc)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.endsWith(FILE_EXTENSION) ? fileName : fileName + FILE_EXTENSION;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Nombre base de un archivo, sin extensión. */
export function baseName(fileName: string): string {
  return fileName.replace(/\.cad\.json$/i, '').replace(/\.json$/i, '') || 'pieza';
}

export interface Draft {
  doc: CadDocument;
  fileName: string;
  /** Había cambios sin guardar en archivo cuando se guardó el borrador. */
  dirty: boolean;
}

/** Guarda el borrador (solo en este navegador). Falla en silencio si el almacenamiento no está disponible. */
export function saveDraft(draft: Draft) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ fileName: draft.fileName, dirty: draft.dirty, doc: serializeDocument(draft.doc) }));
  } catch {
    // Navegación privada, cuota llena, etc.: el borrador es una comodidad, no es crítico.
  }
}

export function loadDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as { fileName?: string; dirty?: boolean; doc?: string };
    if (typeof o.doc !== 'string') return null;
    return { doc: parseDocument(o.doc), fileName: o.fileName || 'pieza', dirty: !!o.dirty };
  } catch {
    return null;
  }
}
