// Herramientas de la barra y atajos de teclado (una sola fuente para la barra, el teclado y la ayuda).
import type { DrawTool } from './draw3d/controller';
import type { IconName } from './iconPaths';

export const DRAW_TOOLS: { id: DrawTool; label: string; icon: IconName; key: string }[] = [
  { id: 'point', label: 'Punto (centro de agujero)', icon: 'point', key: 'O' },
  { id: 'line', label: 'Línea', icon: 'line', key: 'L' },
  { id: 'rectangle', label: 'Rectángulo', icon: 'rectangle', key: 'R' },
  { id: 'circle', label: 'Círculo', icon: 'circle', key: 'C' },
  { id: 'arc', label: 'Arco', icon: 'arc', key: 'A' },
  { id: 'centerRect', label: 'Rectángulo desde el centro', icon: 'centerRect', key: 'E' },
  { id: 'polygon', label: 'Polígono regular', icon: 'polygon', key: 'P' },
  { id: 'slot', label: 'Ranura', icon: 'slot', key: 'S' },
];

export type FeatureTool = 'extrude' | 'revolve' | 'sweep' | 'loft' | 'hole' | 'thread' | 'pattern' | 'mirror' | 'fillet' | 'chamfer' | 'shell';

export const FEATURE_TOOLS: { id: FeatureTool; label: string; icon: IconName; key: string; desc: string; sepBefore?: boolean }[] = [
  { id: 'extrude', label: 'Extrusión', icon: 'extrude', key: 'Shift+E', desc: 'Extruir el sketch seleccionado o el último sin usar' },
  { id: 'revolve', label: 'Revolución', icon: 'revolve', key: 'Shift+R', desc: 'Girar el sketch seleccionado alrededor de un eje' },
  { id: 'sweep', label: 'Barrido', icon: 'sweep', key: 'Shift+B', desc: 'Pasar un perfil cerrado a lo largo de una trayectoria (otro sketch con líneas y arcos)' },
  { id: 'loft', label: 'Solevación', icon: 'loft', key: 'Shift+L', desc: 'Unir dos o más perfiles (sketches en distintos planos) con una forma suave' },
  { id: 'hole', label: 'Agujero', icon: 'hole', key: 'Shift+H', desc: 'Agujeros en los puntos de un sketch: pasante, ciego, cajeado o avellanado, con medidas de tornillos e insertos', sepBefore: true },
  { id: 'thread', label: 'Rosca', icon: 'thread', key: 'Shift+T', desc: 'Rosca modelada en la cara cilíndrica seleccionada: interna en un agujero, externa en una barra (tornillos, tapas)' },
  { id: 'pattern', label: 'Patrón', icon: 'pattern', key: 'Shift+P', desc: 'Repetir la extrusión/revolución seleccionada (lineal o circular)', sepBefore: true },
  { id: 'mirror', label: 'Simetría', icon: 'mirror', key: 'Shift+M', desc: 'Reflejar la extrusión/revolución seleccionada respecto de un plano' },
  { id: 'fillet', label: 'Redondeo', icon: 'fillet', key: 'Shift+F', desc: 'Redondear las aristas seleccionadas', sepBefore: true },
  { id: 'chamfer', label: 'Chaflán', icon: 'chamfer', key: 'Shift+C', desc: 'Achaflanar las aristas seleccionadas' },
  { id: 'shell', label: 'Vaciado', icon: 'shell', key: 'Shift+V', desc: 'Vaciar el sólido quitando las caras seleccionadas' },
];

/** Plano de construcción (va junto al menú de sketch, no entre las operaciones). */
export const PLANE_TOOL = {
  label: 'Plano de construcción',
  key: 'Shift+N',
  desc: 'Desde XY/XZ/YZ, otro plano o la cara plana seleccionada: girarlo en un eje y desplazarlo una distancia',
} as const;

/** Atajos de una tecla (sin Ctrl): tecla → herramienta. */
export const DRAW_KEYS: Record<string, DrawTool> = Object.fromEntries(DRAW_TOOLS.map((t) => [t.key.toLowerCase(), t.id]));
export const FEATURE_KEYS: Record<string, FeatureTool> = Object.fromEntries(FEATURE_TOOLS.map((t) => [t.key.slice(-1).toLowerCase(), t.id]));

export const SHORTCUT_SECTIONS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'General',
    rows: [
      ['Ctrl+Z / Ctrl+Y', 'Deshacer / rehacer'],
      ['Ctrl+S', 'Guardar'],
      ['Ctrl+O', 'Abrir'],
      ['Ctrl+E', 'Exportar STL / 3MF / STEP'],
      ['F', 'Encuadrar'],
      ['Esc', 'Quitar selección / cancelar'],
      ['?', 'Esta ayuda'],
    ],
  },
  {
    title: 'Dibujar en 3D',
    rows: [
      ['K', 'Nuevo sketch (elegir plano)'],
      [PLANE_TOOL.key, PLANE_TOOL.label],
      ...DRAW_TOOLS.map((t): [string, string] => [t.key, t.label]),
      ['G', 'Grilla sí/no (mientras se dibuja)'],
      ['Enter', 'Terminar de dibujar'],
    ],
  },
  {
    title: 'Operaciones',
    rows: [
      ...FEATURE_TOOLS.map((t): [string, string] => [t.key, t.label]),
      ['Shift+X', 'Parámetros'],
    ],
  },
  {
    title: 'Modelo 3D',
    rows: [
      ['Clic', 'Seleccionar cara o arista'],
      ['Shift+clic', 'Agregar / quitar de la selección'],
      ['Shift+clic ×2', 'Medir distancia y ángulo entre dos'],
      ['Arrastrar', 'Orbitar'],
      ['Clic der.', 'Arrastrar para desplazar'],
      ['Rueda', 'Zoom'],
      ['Z', 'Sombreado: estándar, arcilla, cromo, cebra, normales'],
      ['Supr', 'Borrar la feature elegida en el historial'],
      ['Alt+↑ / Alt+↓', 'Mover la feature elegida en el historial (o arrastrarla)'],
    ],
  },
  {
    title: 'Editor de sketch',
    rows: [
      ['O L R E C A P S', 'Las mismas herramientas de dibujo'],
      ['G', 'Pasar a construcción'],
      ['Supr', 'Borrar selección'],
      ['Doble clic', 'Editar el valor de una cota'],
      ['Esc', 'Cancelar / seleccionar'],
    ],
  },
];
