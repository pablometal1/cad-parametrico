// Tooltip único para toda la app: lee data-tip / data-key / data-desc del elemento bajo el puntero.
import { createSignal, onCleanup, Show } from 'solid-js';

interface TipState {
  label: string;
  key?: string;
  desc?: string;
  x: number;
  y: number;
  below: boolean;
}

const DELAY_MS = 350;

export function TooltipLayer() {
  const [tipState, setTip] = createSignal<TipState | null>(null);
  let box: HTMLDivElement | undefined;
  let current: HTMLElement | null = null;
  let timer: number | undefined;
  // Después de mostrar uno, los siguientes aparecen al instante (recorrer la barra con el mouse).
  let warmUntil = 0;

  const hide = () => {
    window.clearTimeout(timer);
    if (tipState()) warmUntil = performance.now() + 500;
    current = null;
    setTip(null);
  };

  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const below = r.bottom + 70 < window.innerHeight;
    setTip({
      label: el.dataset.tip ?? '',
      key: el.dataset.key,
      desc: el.dataset.desc,
      x: r.left + r.width / 2,
      y: below ? r.bottom + 6 : r.top - 6,
      below,
    });
    // Ya en el DOM: lo corre para que no se salga de la ventana.
    requestAnimationFrame(() => {
      if (!box) return;
      const w = box.offsetWidth;
      const x = r.left + r.width / 2;
      box.style.left = `${Math.max(6, Math.min(window.innerWidth - w - 6, x - w / 2))}px`;
      box.style.visibility = 'visible';
    });
  };

  // pointermove (no pointerover) para que también funcione sobre botones deshabilitados.
  const onMove = (e: PointerEvent) => {
    if (e.buttons) return;
    const at = document.elementFromPoint(e.clientX, e.clientY);
    const el = (at?.closest('[data-tip]') as HTMLElement | null) ?? null;
    if (el === current) return;
    hide();
    if (!el) return;
    current = el;
    if (performance.now() < warmUntil) show(el);
    else timer = window.setTimeout(() => current === el && el.isConnected && show(el), DELAY_MS);
  };

  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerdown', hide, true);
  window.addEventListener('keydown', hide, true);
  window.addEventListener('blur', hide);
  onCleanup(() => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerdown', hide, true);
    window.removeEventListener('keydown', hide, true);
    window.removeEventListener('blur', hide);
    window.clearTimeout(timer);
  });

  return (
    <Show when={tipState()}>
      {(t) => (
        <div
          ref={box}
          class="tooltip"
          classList={{ above: !t().below }}
          style={{ left: `${t().x}px`, top: `${t().y}px`, visibility: 'hidden' }}
          role="tooltip"
        >
          <div class="tooltip-head">
            <span>{t().label}</span>
            <Show when={t().key}><kbd>{t().key}</kbd></Show>
          </div>
          <Show when={t().desc}><div class="tooltip-desc">{t().desc}</div></Show>
        </div>
      )}
    </Show>
  );
}
