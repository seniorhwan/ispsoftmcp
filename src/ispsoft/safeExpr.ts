// Pure zero-eval recursive-descent mathematical & boolean expression engine for ST/breakpoint expressions.
// Eliminates dynamic Function()/eval() execution and accelerates repeated loop evaluations via bounded AST caching.

type ExprNode =
  | { kind: 'num'; value: number }
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
  | { type: 'op'; value: string }
  | { type: 'lparen' }
  | { type: 'rparen' };

const AST_CACHE_LIMIT = 2048;
const MAX_EXPR_LENGTH = 8192;
const MAX_PARSE_DEPTH = 96;
const astCache = new Map<string, ExprNode | null>();

function tokenizeExpr(expr: string): Token[] | null {
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

    const two = expr.slice(i, i + 2);
    if (two === '||' || two === '&&' || two === '==' || two === '!=' || two === '<=' || two === '>=') {
      tokens.push({ type: 'op', value: two });
      i += 2;
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

function evalNode(node: ExprNode, depth = 0): number {
  if (depth > 128) return 0;
  if (node.kind === 'num') return node.value;
  if (node.kind === 'unary') {
    const v = evalNode(node.arg, depth + 1);
    if (node.op === '!') return v ? 0 : 1;
    if (node.op === '-') return -v;
    return +v;
  }
  if (node.op === '||') {
    const l = evalNode(node.left, depth + 1);
    return l ? 1 : evalNode(node.right, depth + 1) ? 1 : 0;
  }
  if (node.op === '&&') {
    const l = evalNode(node.left, depth + 1);
    return l ? (evalNode(node.right, depth + 1) ? 1 : 0) : 0;
  }
  const l = evalNode(node.left, depth + 1);
  const r = evalNode(node.right, depth + 1);
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

  const tokens = tokenizeExpr(expr);
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
