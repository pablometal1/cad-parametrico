// Componente de íconos SVG propios, para que todas las barras tengan el mismo estilo.
import type { Feature } from '../document/types';
import { ICONS, type IconName } from './iconPaths';

export type { IconName };

export const FEATURE_ICONS: Record<Feature['type'], IconName> = {
  sketch: 'sketch',
  extrude: 'extrude',
  revolve: 'revolve',
  fillet: 'fillet',
  chamfer: 'chamfer',
  shell: 'shell',
  pattern: 'pattern',
  mirror: 'mirror',
  sweep: 'sweep',
  loft: 'loft',
  plane: 'plane',
  hole: 'hole',
};

export function Icon(props: { name: IconName; size?: number; class?: string }) {
  return (
    <svg
      class={`icon${props.class ? ` ${props.class}` : ''}`}
      width={props.size ?? 18}
      height={props.size ?? 18}
      viewBox="0 0 24 24"
      aria-hidden="true"
      innerHTML={ICONS[props.name]}
    />
  );
}

/**
 * Atributos de tooltip para un botón: nombre, atajo y descripción opcional.
 * Lo muestra <TooltipLayer/> (más rápido y legible que el `title` nativo).
 */
export function tip(label: string, key?: string, desc?: string) {
  return {
    'aria-label': label,
    'data-tip': label,
    ...(key ? { 'data-key': key } : {}),
    ...(desc ? { 'data-desc': desc } : {}),
  };
}

export const ICON_NAMES = Object.keys(ICONS) as IconName[];
