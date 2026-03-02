import { useState } from 'react';

type Props = {
  name: string;
  input: Record<string, unknown>;
  output?: string;
};

const toolColors: Record<string, string> = {
  Bash: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  Read: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  Edit: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  Write: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  Grep: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300',
  Glob: 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300',
};

const defaultColor = 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300';

export function ToolUseBlock({ name, input, output }: Props) {
  const [expanded, setExpanded] = useState(false);
  const color = toolColors[name] ?? defaultColor;

  return (
    <div className="rounded border border-gray-200 dark:border-gray-700 overflow-hidden my-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs font-medium ${color} hover:opacity-80 transition-opacity`}
      >
        <span className="inline-block rounded px-1.5 py-0.5 text-xs font-mono">
          {name}
        </span>
        <span className="ml-auto text-[10px] opacity-60">
          {expanded ? 'collapse' : 'expand'}
        </span>
      </button>
      {expanded && (
        <div className="p-2 space-y-2 bg-gray-50 dark:bg-gray-800/50">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">Input</div>
            <pre className="text-xs font-mono whitespace-pre-wrap break-all text-gray-700 dark:text-gray-300 max-h-60 overflow-y-auto">
              {formatInput(input)}
            </pre>
          </div>
          {output != null && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">Output</div>
              <pre className="text-xs font-mono whitespace-pre-wrap break-all text-gray-700 dark:text-gray-300 max-h-60 overflow-y-auto">
                {output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatInput(input: Record<string, unknown>): string {
  // For simple single-field inputs like { command: "ls" }, just show the value
  const keys = Object.keys(input);
  if (keys.length === 1 && typeof input[keys[0]] === 'string') {
    return input[keys[0]] as string;
  }
  return JSON.stringify(input, null, 2);
}
