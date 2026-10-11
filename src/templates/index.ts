// Biblioteca de modelos: plantillas paramétricas listas para usar. Cada una arma el historial
// completo con sus medidas en la tabla de parámetros.
import type { CadDocument } from '../document/types';
import { TemplateBuilder, type TemplateKernel } from './builder';
import { buildCaja } from './caja';
import { buildSsc } from './ssc';

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  /** Nombre de archivo sugerido. */
  fileName: string;
}

interface TemplateDef extends TemplateInfo {
  build(t: TemplateBuilder): void;
}

const TEMPLATES: TemplateDef[] = [
  {
    id: 'caja-transportadora',
    name: 'Caja transportadora',
    description: 'Hard surface: cuerpo con esquinas y bordes biselados, junta de tapa con labios, paneles ranurados, asas y trabas.',
    fileName: 'caja-transportadora',
    build: buildCaja,
  },
  {
    id: 'caja-ssc',
    name: 'Caja de seguridad SSC',
    description: 'Hard surface: aristas redondeadas, junta a media altura, costillas en la tapa, paneles con escalón, tapas laterales con tornillos y asa, patas.',
    fileName: 'caja-ssc',
    build: buildSsc,
  },
];

export const TEMPLATE_LIST: TemplateInfo[] = TEMPLATES.map(({ build: _b, ...info }) => info);

export function buildTemplate(id: string, kernel: TemplateKernel): CadDocument {
  const def = TEMPLATES.find((t) => t.id === id);
  if (!def) throw new Error(`No existe la plantilla ${id}`);
  const t = new TemplateBuilder(kernel);
  def.build(t);
  return t.doc;
}
