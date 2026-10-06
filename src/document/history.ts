// Historial de deshacer/rehacer sobre estados inmutables (el documento completo).
//
// Cada cambio guarda el estado anterior. Los cambios con la misma clave de agrupación seguidos
// (arrastrar un manipulador, editar en el panel de una herramienta) forman un solo paso.

export interface RecordOptions {
  /** Clave de agrupación: cambios consecutivos con la misma clave se deshacen juntos. */
  coalesce?: string;
  /** Agrupar sin límite de tiempo (mientras la clave no cambie). */
  sticky?: boolean;
}

export class History<T> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];
  private lastKey: string | null = null;
  private lastTime = 0;

  constructor(
    private readonly limit = 200,
    /** Ventana (ms) para agrupar cambios no "sticky". */
    private readonly windowMs = 1500,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Registra que se va a pasar de `previous` a un estado nuevo. */
  record(previous: T, opts: RecordOptions = {}) {
    const t = this.now();
    const merge =
      opts.coalesce !== undefined && opts.coalesce === this.lastKey && this.undoStack.length > 0 &&
      (opts.sticky || t - this.lastTime < this.windowMs);
    if (!merge) {
      this.undoStack.push(previous);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    this.redoStack = [];
    this.lastKey = opts.coalesce ?? null;
    this.lastTime = t;
  }

  /** Devuelve el estado anterior (o null) y guarda `current` para rehacer. */
  undo(current: T): T | null {
    const prev = this.undoStack.pop();
    if (prev === undefined) return null;
    this.redoStack.push(current);
    this.lastKey = null;
    return prev;
  }

  redo(current: T): T | null {
    const next = this.redoStack.pop();
    if (next === undefined) return null;
    this.undoStack.push(current);
    this.lastKey = null;
    return next;
  }

  /** Olvida lo que se podía rehacer (p. ej. tras cancelar una creación: no debe poder rehacerse). */
  discardRedo() {
    this.redoStack = [];
  }

  /** Corta la agrupación en curso: el próximo cambio será un paso nuevo. */
  breakCoalescing() {
    this.lastKey = null;
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.lastKey = null;
  }

  get depth() {
    return this.undoStack.length;
  }
  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
}
