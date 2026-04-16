const OVERFLOW_RE = /\boverflow-(?:x-auto|y-auto|auto|x-scroll|y-scroll|scroll)\b/;

const SERVER_PATH_RE = /\/src\/(server|orcd)\//;
const TEST_FILE_RE = /\.(test|spec)\.[cm]?tsx?$|__tests__\//;

function isServerFile(filename) {
  if (typeof filename !== 'string') return false;
  if (TEST_FILE_RE.test(filename)) return false;
  return SERVER_PATH_RE.test(filename);
}

function isLogCall(node) {
  if (!node || node.type !== 'ExpressionStatement') return false;
  let call = node.expression;
  if (call?.type === 'AwaitExpression') call = call.argument;
  if (!call || call.type !== 'CallExpression') return false;
  const callee = call.callee;
  if (!callee) return false;
  if (callee.type === 'Identifier') {
    return /^(log|debug)$/i.test(callee.name);
  }
  if (callee.type === 'MemberExpression' && callee.property?.type === 'Identifier') {
    const method = callee.property.name;
    if (!/^(log|error|warn|info|debug|trace)$/.test(method)) return false;
    const obj = callee.object;
    if (obj?.type === 'Identifier') {
      return /^(console|logger|log)$/i.test(obj.name);
    }
    if (obj?.type === 'MemberExpression' && obj.property?.type === 'Identifier') {
      return /^(console|logger|log)$/i.test(obj.property.name);
    }
  }
  return false;
}

const noOverflowAuto = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow native-scrollbar overflow classes; use Radix ScrollArea.' },
    messages: {
      forbidden: '"{{ cls }}" exposes native scrollbars. Use <ScrollArea> from ~/components/ui/scroll-area instead.',
    },
    schema: [],
  },
  create(context) {
    const reported = new Set();
    function check(node, raw) {
      if (reported.has(node)) return;
      const m = raw.match(OVERFLOW_RE);
      if (m) {
        reported.add(node);
        context.report({ node, messageId: 'forbidden', data: { cls: m[0] } });
      }
    }
    return {
      JSXAttribute(node) {
        if (node.name?.name !== 'className') return;
        const val = node.value;
        if (!val) return;
        if (val.type === 'Literal' && typeof val.value === 'string') check(val, val.value);
        if (val.type === 'JSXExpressionContainer') {
          const expr = val.expression;
          if (expr.type === 'Literal' && typeof expr.value === 'string') check(expr, expr.value);
          if (expr.type === 'TemplateLiteral') {
            for (const q of expr.quasis) check(q, q.value.raw);
          }
        }
      },
      'CallExpression Literal'(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
      'CallExpression TemplateLiteral > TemplateElement'(node) {
        check(node, node.value.raw);
      },
      'ArrayExpression Literal'(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
    };
  },
};

const logInCatch = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require a log call as the first statement of every catch block in server code so errors are never silently swallowed.',
    },
    messages: {
      missing:
        'catch block must log as its first statement (console.error / logger.* with session id when available).',
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.();
    if (!isServerFile(filename)) return {};
    return {
      CatchClause(node) {
        const body = node.body?.body ?? [];
        if (body.length === 0 || !isLogCall(body[0])) {
          context.report({ node: node.body ?? node, messageId: 'missing' });
        }
      },
    };
  },
};

function findEnclosingFunction(node) {
  let cur = node.parent;
  while (cur) {
    if (
      cur.type === 'FunctionDeclaration' ||
      cur.type === 'FunctionExpression' ||
      cur.type === 'ArrowFunctionExpression'
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

function isFinalReturnOfFunction(returnNode) {
  const parent = returnNode.parent;
  if (!parent || parent.type !== 'BlockStatement') return false;
  const fn = parent.parent;
  if (
    !fn ||
    (fn.type !== 'FunctionDeclaration' &&
      fn.type !== 'FunctionExpression' &&
      fn.type !== 'ArrowFunctionExpression')
  ) {
    return false;
  }
  const body = parent.body;
  return body[body.length - 1] === returnNode;
}

function hasLogBefore(returnNode) {
  let node = returnNode;
  while (node && node.parent) {
    const parent = node.parent;
    if (parent.type === 'BlockStatement') {
      const idx = parent.body.indexOf(node);
      for (let i = idx - 1; i >= 0; i--) {
        if (isLogCall(parent.body[i])) return true;
      }
      const grand = parent.parent;
      if (
        !grand ||
        grand.type === 'FunctionDeclaration' ||
        grand.type === 'FunctionExpression' ||
        grand.type === 'ArrowFunctionExpression'
      ) {
        return false;
      }
      node = grand;
      continue;
    }
    if (
      parent.type === 'FunctionDeclaration' ||
      parent.type === 'FunctionExpression' ||
      parent.type === 'ArrowFunctionExpression'
    ) {
      return false;
    }
    node = parent;
  }
  return false;
}

const logBeforeEarlyReturn = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require a log call immediately before any early return in server code to catch silent early exits that hide bugs.',
    },
    messages: {
      missing:
        'Early return must be preceded by a log call (include session id when available). Silent returns hide bugs.',
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.();
    if (!isServerFile(filename)) return {};
    return {
      ReturnStatement(node) {
        if (!findEnclosingFunction(node)) return;
        if (isFinalReturnOfFunction(node)) return;
        if (!hasLogBefore(node)) {
          context.report({ node, messageId: 'missing' });
        }
      },
    };
  },
};

export default {
  meta: { name: 'orchestrel' },
  rules: {
    'no-overflow-auto': noOverflowAuto,
    'log-in-catch': logInCatch,
    'log-before-early-return': logBeforeEarlyReturn,
  },
};
