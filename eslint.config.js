import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

// ---------------------------------------------------------------------------
// Local rule: no-overflow-auto
// Prevents native scrollbar classes (overflow-auto, overflow-x-auto,
// overflow-y-auto) in JSX. Use Radix ScrollArea instead.
// Disable per-line with: // eslint-disable-next-line local/no-overflow-auto
// ---------------------------------------------------------------------------
const OVERFLOW_RE = /\boverflow-(?:x-auto|y-auto|auto)\b/;

const noOverflowAutoRule = {
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
      // className="..." or className={`...`}
      JSXAttribute(node) {
        if (node.name?.name !== 'className') return;
        const val = node.value;
        if (!val) return;
        // className="literal"
        if (val.type === 'Literal' && typeof val.value === 'string') {
          check(val, val.value);
        }
        // className={"literal"} or className={`template`}
        if (val.type === 'JSXExpressionContainer') {
          const expr = val.expression;
          if (expr.type === 'Literal' && typeof expr.value === 'string') {
            check(expr, expr.value);
          }
          if (expr.type === 'TemplateLiteral') {
            for (const q of expr.quasis) check(q, q.value.raw);
          }
        }
      },
      // Catches cn(...), clsx(...), [].join(" ") patterns — any string literal
      // inside app/**/*.tsx that contains overflow-auto
      'CallExpression Literal'(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
      'CallExpression TemplateLiteral > TemplateElement'(node) {
        check(node, node.value.raw);
      },
      // Array literals used for className: ["foo", "overflow-x-auto"].join(...)
      'ArrayExpression Literal'(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
    };
  },
};

const localPlugin = { rules: { 'no-overflow-auto': noOverflowAutoRule } };

export default [
  // Ignore patterns
  { ignores: ['node_modules/**', 'build/**', '.react-router/**', 'data/**', '.worktrees/**'] },

  // TypeScript files
  {
    files: ['app/**/*.{ts,tsx}', 'src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooks,
      local: localPlugin,
    },
    rules: {
      // Start from eslint recommended
      ...js.configs.recommended.rules,

      // TypeScript recommended
      ...tsPlugin.configs['flat/recommended'].reduce((acc, cfg) => ({ ...acc, ...cfg.rules }), {}),

      // React hooks
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // Overrides
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],

      // No native scrollbars — use Radix ScrollArea
      'local/no-overflow-auto': 'error',
    },
  },
];
