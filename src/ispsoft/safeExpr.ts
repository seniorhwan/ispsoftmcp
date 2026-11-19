// Pure zero-eval recursive-descent mathematical & boolean expression engine for ST/breakpoint expressions.
// Eliminates dynamic Function()/eval() execution and accelerates repeated loop evaluations via bounded AST caching.
// Supports both pure-numeric ASTs and symbolic ST ASTs so hot loops evaluate cached ASTs without re-parsing or regex substitution.

export type ExprNode =
  | { kind: 'num'; value: number }
  | { kind: 'var'; name: string }
  | { kind: 'unary'; op: '!' | '-' | '+'; arg: ExprNode }
  | {
      kind: 'binary';
      op:
        | '||'
        | '&&'
        | '|'
        | '^'
        | '&'
        | '=='
        | '!='
        | '<'
        | '<='
        | '>'
        | '>='
        | '+'
        | '-'
        | '*'
        | '/'
        | '%';
      left: ExprNode;
      right: ExprNode;
    };

type Token =
  | { type: 'num'; value: number }
  | { type: 'var'; name: string }
  | { type: 'op'; value: string }
  | { type: 'lparen' }
  | { type: 'rparen' };

const AST_CACHE_LIMIT = 2048;
const SYMBOLIC_AST_CACHE_LIMIT = 4096;
const MAX_EXPR_LENGTH = 8192;
const MAX_PARSE_DEPTH = 96;
const astCache = new Map<string, ExprNode | null>();
const symbolicAstCache = new Map<string, ExprNode | null>();

function isIdentStart(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function isIdentPart(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95;
}

function tokenizeExpr(expr: string, allowSymbolic: boolean): Token[] | null {
  if (expr.length > MAX_EXPR_LENGTH) return null;
  const tokens: Token[] = [];
  let i = 0;
  const n = expr.length;

  while (i < n) {
    const ch = expr[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen' });
      i += 1;
      continue;
    }
    if ((ch >= '0' && ch <= '9') || (ch === '.' && i + 1 < n && expr[i + 1] >= '0' && expr[i + 1] <= '9')) {
      // Check IEC radix literals: 16#FF, 2#1010, 8#77
      if (allowSymbolic && (expr.startsWith('16#', i) || expr.startsWith('2#', i) || expr.startsWith('8#', i))) {
        const hashIdx = expr.indexOf('#', i);
        const radix = Number(expr.slice(i, hashIdx));
        let end = hashIdx + 1;
        while (end < n) {
          const c = expr[end];
          const valid =
            c === '_' ||
            (radix === 16 && ((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F') || (c >= 'a' && c <= 'f'))) ||
            (radix === 8 && c >= '0' && c <= '7') ||
            (radix === 2 && (c === '0' || c === '1'));
          if (!valid) break;
          end += 1;
        }
        const digits = expr.slice(hashIdx + 1, end).replace(/_/g, '');
        if (!digits) return null;
        const num = parseInt(digits, radix);
        if (!Number.isFinite(num)) return null;
        tokens.push({ type: 'num', value: num });
        i = end;
        continue;
      }

      let end = i + 1;
      let sawDot = ch === '.';
      while (end < n) {
        const c = expr[end];
        if (c >= '0' && c <= '9') {
          end += 1;
        } else if (c === '.' && !sawDot) {
          sawDot = true;
          end += 1;
        } else {
          break;
        }
      }
      const num = Number(expr.slice(i, end));
      if (!Number.isFinite(num)) return null;
      tokens.push({ type: 'num', value: num });
      i = end;
      continue;
    }

    if (allowSymbolic && isIdentStart(ch)) {
      let end = i + 1;
      while (end < n && isIdentPart(expr[end])) {
        end += 1;
      }
      // Allow single-segment dotted access (T0.Q, D0.0, D0.A, Pump.Speed, Step1.X)
      if (end < n && expr[end] === '.' && end + 1 < n && isIdentPart(expr[end + 1])) {
        end += 1;
        while (end < n && isIdentPart(expr[end])) {
          end += 1;
        }
      }
      // Function call (ident followed by '(') or array index (ident followed by '[') -> bail out to full ST evaluator
      let look = end;
      while (look < n && (expr[look] === ' ' || expr[look] === '\t')) look += 1;
      if (look < n && (expr[look] === '(' || expr[look] === '[')) {
        const rawWord = expr.slice(i, end).toUpperCase();
        // Keywords like `NOT (a = b)` or `AND (x > 1)` ARE valid symbolic tokens before '('
        if (rawWord !== 'NOT' && rawWord !== 'AND' && rawWord !== 'OR' && rawWord !== 'XOR' && rawWord !== 'MOD') {
          return null;
        }
      }
      const ident = expr.slice(i, end);
      const up = ident.toUpperCase();
      if (up === 'TRUE') {
        tokens.push({ type: 'num', value: 1 });
      } else if (up === 'FALSE') {
        tokens.push({ type: 'num', value: 0 });
      } else if (up === 'AND') {
        tokens.push({ type: 'op', value: '&&' });
      } else if (up === 'OR') {
        tokens.push({ type: 'op', value: '||' });
      } else if (up === 'XOR') {
        tokens.push({ type: 'op', value: '^' });
      } else if (up === 'NOT') {
        tokens.push({ type: 'op', value: '!' });
      } else if (up === 'MOD') {
        tokens.push({ type: 'op', value: '%' });
      } else {
        tokens.push({ type: 'var', name: ident });
      }
      i = end;
      continue;
    }

    const two = expr.slice(i, i + 2);
    if (two === '||' || two === '&&' || two === '==' || two === '!=' || two === '<=' || two === '>=') {
      tokens.push({ type: 'op', value: two });
      i += 2;
      continue;
    }
    if (allowSymbolic && two === '<>') {
      tokens.push({ type: 'op', value: '!=' });
      i += 2;
      continue;
    }
    if (allowSymbolic && ch === '=') {
      tokens.push({ type: 'op', value: '==' });
      i += 1;
      continue;
    }
    if ('+-*/%!&|^<>'.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i += 1;
      continue;
    }
    return null;
  }
  return tokens;
}

class ExprParser {
  private pos = 0;
  private depth = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): ExprNode | null {
    if (this.tokens.length === 0) return null;
    const node = this.parseLogicalOr();
    if (!node || this.pos !== this.tokens.length) return null;
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private matchOp(...ops: string[]): string | null {
    const t = this.peek();
    if (t && t.type === 'op' && ops.includes(t.value)) {
      this.pos += 1;
      return t.value;
    }
    return null;
  }

  private parseLogicalOr(): ExprNode | null {
    let left = this.parseLogicalAnd();
    if (!left) return null;
    while (this.matchOp('||')) {
      const right = this.parseLogicalAnd();
      if (!right) return null;
      left = { kind: 'binary', op: '||', left, right };
    }
    return left;
  }

  private parseLogicalAnd(): ExprNode | null {
    let left = this.parseBitOr();
    if (!left) return null;
    while (this.matchOp('&&')) {
      const right = this.parseBitOr();
      if (!right) return null;
      left = { kind: 'binary', op: '&&', left, right };
    }
    return left;
  }

  private parseBitOr(): ExprNode | null {
    let left = this.parseBitXor();
    if (!left) return null;
    while (this.matchOp('|')) {
      const right = this.parseBitXor();
      if (!right) return null;
      left = { kind: 'binary', op: '|', left, right };
    }
    return left;
  }

  private parseBitXor(): ExprNode | null {
    let left = this.parseBitAnd();
    if (!left) return null;
    while (this.matchOp('^')) {
      const right = this.parseBitAnd();
      if (!right) return null;
      left = { kind: 'binary', op: '^', left, right };
    }
    return left;
  }

  private parseBitAnd(): ExprNode | null {
    let left = this.parseEquality();
    if (!left) return null;
    while (this.matchOp('&')) {
      const right = this.parseEquality();
      if (!right) return null;
      left = { kind: 'binary', op: '&', left, right };
    }
    return left;
  }

  private parseEquality(): ExprNode | null {
    let left = this.parseRelational();
    if (!left) return null;
    let op: string | null;
    while ((op = this.matchOp('==', '!='))) {
      const right = this.parseRelational();
      if (!right) return null;
      left = { kind: 'binary', op: op as '==' | '!=', left, right };
    }
    return left;
  }

  private parseRelational(): ExprNode | null {
    let left = this.parseAdditive();
    if (!left) return null;
    let op: string | null;
    while ((op = this.matchOp('<', '<=', '>', '>='))) {
      const right = this.parseAdditive();
      if (!right) return null;
      left = { kind: 'binary', op: op as '<' | '<=' | '>' | '>=', left, right };
    }
    return left;
  }

  private parseAdditive(): ExprNode | null {
    let left = this.parseMultiplicative();
    if (!left) return null;
    let op: string | null;
    while ((op = this.matchOp('+', '-'))) {
      const right = this.parseMultiplicative();
      if (!right) return null;
      left = { kind: 'binary', op: op as '+' | '-', left, right };
    }
    return left;
  }

  private parseMultiplicative(): ExprNode | null {
    let left = this.parseUnary();
    if (!left) return null;
    let op: string | null;
    while ((op = this.matchOp('*', '/', '%'))) {
      const right = this.parseUnary();
      if (!right) return null;
      left = { kind: 'binary', op: op as '*' | '/' | '%', left, right };
    }
    return left;
  }

  private parseUnary(): ExprNode | null {
    const op = this.matchOp('!', '-', '+');
    if (op) {
      if (this.depth >= MAX_PARSE_DEPTH) return null;
      this.depth += 1;
      const arg = this.parseUnary();
      this.depth -= 1;
      if (!arg) return null;
      return { kind: 'unary', op: op as '!' | '-' | '+', arg };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ExprNode | null {
    const t = this.peek();
    if (!t) return null;
    if (t.type === 'num') {
      this.pos += 1;
      return { kind: 'num', value: t.value };
    }
    if (t.type === 'var') {
      this.pos += 1;
      return { kind: 'var', name: t.name };
    }
    if (t.type === 'lparen') {
      if (this.depth >= MAX_PARSE_DEPTH) return null;
      this.pos += 1;
      this.depth += 1;
      const inner = this.parseLogicalOr();
      this.depth -= 1;
      const close = this.peek();
      if (!inner || !close || close.type !== 'rparen') return null;
      this.pos += 1;
      return inner;
    }
    return null;
  }
}

function evalNode(node: ExprNode, resolveVar?: (name: string) => number, depth = 0): number {
  if (depth > 128) return 0;
  if (node.kind === 'num') return node.value;
  if (node.kind === 'var') return resolveVar ? resolveVar(node.name) : 0;
  if (node.kind === 'unary') {
    const v = evalNode(node.arg, resolveVar, depth + 1);
    if (node.op === '!') return v ? 0 : 1;
    if (node.op === '-') return -v;
    return +v;
  }
  if (node.op === '||') {
    const l = evalNode(node.left, resolveVar, depth + 1);
    return l ? 1 : evalNode(node.right, resolveVar, depth + 1) ? 1 : 0;
  }
  if (node.op === '&&') {
    const l = evalNode(node.left, resolveVar, depth + 1);
    return l ? (evalNode(node.right, resolveVar, depth + 1) ? 1 : 0) : 0;
  }
  const l = evalNode(node.left, resolveVar, depth + 1);
  const r = evalNode(node.right, resolveVar, depth + 1);
  switch (node.op) {
    case '|':
      return (Math.trunc(l) | Math.trunc(r)) | 0;
    case '^':
      return (Math.trunc(l) ^ Math.trunc(r)) | 0;
    case '&':
      return (Math.trunc(l) & Math.trunc(r)) | 0;
    case '==':
      return l === r ? 1 : 0;
    case '!=':
      return l !== r ? 1 : 0;
    case '<':
      return l < r ? 1 : 0;
    case '<=':
      return l <= r ? 1 : 0;
    case '>':
      return l > r ? 1 : 0;
    case '>=':
      return l >= r ? 1 : 0;
    case '+':
      return l + r;
    case '-':
      return l - r;
    case '*':
      return l * r;
    case '/':
      return r === 0 ? 0 : l / r;
    case '%':
      return r === 0 ? 0 : l % r;
  }
}

export function compileSafeNumericExpr(expr: string): ExprNode | null {
  const cached = astCache.get(expr);
  if (cached !== undefined) return cached;

  const tokens = tokenizeExpr(expr, false);
  const ast = tokens ? new ExprParser(tokens).parse() : null;
  if (astCache.size >= AST_CACHE_LIMIT) {
    const firstKey = astCache.keys().next().value;
    if (firstKey !== undefined) astCache.delete(firstKey);
  }
  astCache.set(expr, ast);
  return ast;
}

export function evaluateSafeNumericExpr(expr: string): number {
  const trimmed = expr.trim();
  if (!trimmed) return 0;
  const ast = compileSafeNumericExpr(trimmed);
  if (!ast) return 0;
  const res = evalNode(ast);
  return Number.isFinite(res) ? res : 0;
}

export function compileSymbolicStExpr(expr: string): ExprNode | null {
  const cached = symbolicAstCache.get(expr);
  if (cached !== undefined) return cached;

  const tokens = tokenizeExpr(expr, true);
  const ast = tokens ? new ExprParser(tokens).parse() : null;
  if (symbolicAstCache.size >= SYMBOLIC_AST_CACHE_LIMIT) {
    const firstKey = symbolicAstCache.keys().next().value;
    if (firstKey !== undefined) symbolicAstCache.delete(firstKey);
  }
  symbolicAstCache.set(expr, ast);
  return ast;
}

export function evaluateSymbolicStAst(ast: ExprNode, resolveVar: (name: string) => number): number {
  const res = evalNode(ast, resolveVar);
  return Number.isFinite(res) ? res : 0;
}
