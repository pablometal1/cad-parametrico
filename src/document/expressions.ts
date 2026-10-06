// Expresiones numéricas: `ancho / 2`, `max(largo, 10) + 2`, `sin(30) * r`.
// Números con punto decimal (un número suelto también acepta coma: "35,5"). Ángulos en grados.

export type Expr =
  | { k: 'num'; v: number }
  | { k: 'var'; name: string }
  | { k: 'neg'; e: Expr }
  | { k: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: Expr; b: Expr }
  | { k: 'call'; fn: string; args: Expr[] };

export class ExpressionError extends Error {
  constructor(message: string, readonly position?: number) {
    super(message);
    this.name = 'ExpressionError';
  }
}

const DEG = Math.PI / 180;

/** Funciones disponibles: [aridad mínima, aridad máxima, implementación]. */
const FUNCTIONS: Record<string, [number, number, (...a: number[]) => number]> = {
  sin: [1, 1, (x) => Math.sin(x * DEG)],
  cos: [1, 1, (x) => Math.cos(x * DEG)],
  tan: [1, 1, (x) => Math.tan(x * DEG)],
  asin: [1, 1, (x) => Math.asin(x) / DEG],
  acos: [1, 1, (x) => Math.acos(x) / DEG],
  atan: [1, 1, (x) => Math.atan(x) / DEG],
  atan2: [2, 2, (y, x) => Math.atan2(y, x) / DEG],
  sqrt: [1, 1, Math.sqrt],
  abs: [1, 1, Math.abs],
  round: [1, 1, Math.round],
  floor: [1, 1, Math.floor],
  ceil: [1, 1, Math.ceil],
  pow: [2, 2, Math.pow],
  hypot: [1, Infinity, Math.hypot],
  min: [1, Infinity, Math.min],
  max: [1, Infinity, Math.max],
};
const CONSTANTS: Record<string, number> = { pi: Math.PI };

/** Nombres que no pueden usarse como parámetros. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([...Object.keys(FUNCTIONS), ...Object.keys(CONSTANTS)]);

const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{N}_]/u;

export function isValidName(name: string): boolean {
  return /^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) && !RESERVED_NAMES.has(name);
}

/** Si el texto es solo un número (con punto o coma decimal), lo devuelve; si no, null. */
export function plainNumber(text: string): number | null {
  const t = text.trim();
  if (!/^[+-]?(\d+([.,]\d*)?|[.,]\d+)([eE][+-]?\d+)?$/.test(t)) return null;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

type Token =
  | { t: 'num'; v: number; pos: number }
  | { t: 'id'; v: string; pos: number }
  | { t: 'op'; v: string; pos: number }
  | { t: 'end'; pos: number };

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(text.slice(i));
      if (!m) throw new ExpressionError(`Número mal escrito en la posición ${i + 1}`, i);
      out.push({ t: 'num', v: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < text.length && IDENT_PART.test(text[j])) j++;
      out.push({ t: 'id', v: text.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if ('+-*/^(),'.includes(c)) {
      out.push({ t: 'op', v: c, pos: i });
      i++;
      continue;
    }
    throw new ExpressionError(`Carácter no válido "${c}" en la posición ${i + 1}`, i);
  }
  out.push({ t: 'end', pos: text.length });
  return out;
}

/** Analiza una expresión. Lanza ExpressionError con un mensaje en castellano. */
export function parseExpression(text: string): Expr {
  if (!text.trim()) throw new ExpressionError('La expresión está vacía');
  const tokens = tokenize(text);
  let p = 0;
  const peek = () => tokens[p];
  const isOp = (v: string) => {
    const t = peek();
    return t.t === 'op' && t.v === v;
  };
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExpressionError(`Se esperaba "${v}" en la posición ${peek().pos + 1}`, peek().pos);
    p++;
  };

  function additive(): Expr {
    let a = multiplicative();
    while (isOp('+') || isOp('-')) {
      const op = (tokens[p++] as { v: '+' | '-' }).v;
      a = { k: 'bin', op, a, b: multiplicative() };
    }
    return a;
  }
  function multiplicative(): Expr {
    let a = unary();
    while (isOp('*') || isOp('/')) {
      const op = (tokens[p++] as { v: '*' | '/' }).v;
      a = { k: 'bin', op, a, b: unary() };
    }
    return a;
  }
  function unary(): Expr {
    if (isOp('-')) {
      p++;
      return { k: 'neg', e: unary() };
    }
    if (isOp('+')) {
      p++;
      return unary();
    }
    return power();
  }
  function power(): Expr {
    const base = primary();
    if (isOp('^')) {
      p++;
      // Asociativa a derecha: 2^3^2 = 2^(3^2).
      return { k: 'bin', op: '^', a: base, b: unary() };
    }
    return base;
  }
  function primary(): Expr {
    const t = peek();
    if (t.t === 'num') {
      p++;
      return { k: 'num', v: t.v };
    }
    if (t.t === 'id') {
      p++;
      if (isOp('(')) {
        p++;
        const fn = FUNCTIONS[t.v];
        if (!fn) throw new ExpressionError(`Función desconocida "${t.v}"`, t.pos);
        const args: Expr[] = [];
        if (!isOp(')')) {
          args.push(additive());
          while (isOp(',')) {
            p++;
            args.push(additive());
          }
        }
        expect(')');
        if (args.length < fn[0] || args.length > fn[1]) {
          throw new ExpressionError(`"${t.v}" recibe ${fn[0] === fn[1] ? fn[0] : `al menos ${fn[0]}`} argumento(s)`, t.pos);
        }
        return { k: 'call', fn: t.v, args };
      }
      return { k: 'var', name: t.v };
    }
    if (t.t === 'op' && t.v === '(') {
      p++;
      const e = additive();
      expect(')');
      return e;
    }
    if (t.t === 'end') throw new ExpressionError('La expresión está incompleta', t.pos);
    throw new ExpressionError(`"${t.v}" inesperado en la posición ${t.pos + 1}`, t.pos);
  }

  const e = additive();
  if (peek().t !== 'end') {
    const t = peek() as Exclude<Token, { t: 'end' }>;
    throw new ExpressionError(`"${t.v}" inesperado en la posición ${t.pos + 1}`, t.pos);
  }
  return e;
}

/** Evalúa con `lookup` para los nombres. Lanza ExpressionError si el resultado no es finito. */
export function evaluateExpr(e: Expr, lookup: (name: string) => number): number {
  const v = evalNode(e, lookup);
  if (!Number.isFinite(v)) throw new ExpressionError('El resultado no es un número finito (¿división por cero?)');
  return v;
}

function evalNode(e: Expr, lookup: (name: string) => number): number {
  switch (e.k) {
    case 'num':
      return e.v;
    case 'var':
      return e.name in CONSTANTS ? CONSTANTS[e.name] : lookup(e.name);
    case 'neg':
      return -evalNode(e.e, lookup);
    case 'call':
      return FUNCTIONS[e.fn][2](...e.args.map((a) => evalNode(a, lookup)));
    case 'bin': {
      const a = evalNode(e.a, lookup);
      const b = evalNode(e.b, lookup);
      switch (e.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return a / b;
        case '^': return Math.pow(a, b);
      }
    }
  }
}

/** Nombres de parámetros que usa una expresión. */
export function referencedNames(e: Expr, out = new Set<string>()): Set<string> {
  switch (e.k) {
    case 'var':
      if (!(e.name in CONSTANTS)) out.add(e.name);
      break;
    case 'neg':
      referencedNames(e.e, out);
      break;
    case 'bin':
      referencedNames(e.a, out);
      referencedNames(e.b, out);
      break;
    case 'call':
      e.args.forEach((a) => referencedNames(a, out));
      break;
  }
  return out;
}

/** Renombra un parámetro dentro del texto de una expresión, respetando el resto tal cual. */
export function renameInExpression(text: string, from: string, to: string): string {
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch {
    return text;
  }
  let out = '';
  let last = 0;
  tokens.forEach((t, i) => {
    if (t.t !== 'id' || t.v !== from) return;
    // No renombrar funciones con el mismo nombre (seguidas de "(").
    const next = tokens[i + 1];
    if (next.t === 'op' && next.v === '(') return;
    out += text.slice(last, t.pos) + to;
    last = t.pos + from.length;
  });
  return out + text.slice(last);
}
