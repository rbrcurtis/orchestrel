import { useState } from 'react';
import { useTRPC } from '~/lib/trpc';
import { useQuery } from '@tanstack/react-query';

interface DirectoryBrowserProps {
  initialPath?: string;
  onSelect: (path: string) => void;
  onCancel: () => void;
}

export default function DirectoryBrowser({ initialPath = '/home/ryan', onSelect, onCancel }: DirectoryBrowserProps) {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const trpc = useTRPC();

  const { data, isLoading } = useQuery(trpc.repos.browse.queryOptions({ path: currentPath }));

  const segments = currentPath.split('/').filter(Boolean);

  function navigateTo(path: string) {
    setCurrentPath(path);
  }

  function navigateToBreadcrumb(idx: number) {
    const path = '/' + segments.slice(0, idx + 1).join('/');
    setCurrentPath(path);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4 flex flex-col max-h-96">
        {/* Header with breadcrumb */}
        <div className="px-4 pt-4 pb-2 border-b border-gray-200">
          <div className="flex items-center gap-1 text-sm overflow-x-auto whitespace-nowrap">
            <button
              onClick={() => setCurrentPath('/')}
              className="text-blue-600 hover:text-blue-800 font-medium"
            >
              /
            </button>
            {segments.map((seg, i) => (
              <span key={i} className="flex items-center gap-1">
                <span className="text-gray-400">/</span>
                <button
                  onClick={() => navigateToBreadcrumb(i)}
                  className="text-blue-600 hover:text-blue-800"
                >
                  {seg}
                </button>
              </span>
            ))}
          </div>
          {data?.isGitRepo && (
            <span className="inline-flex items-center gap-1 mt-1 text-xs font-medium text-green-700 bg-green-100 rounded px-2 py-0.5">
              <span className="w-2 h-2 rounded-full bg-green-500" />
              Git Repository
            </span>
          )}
        </div>

        {/* Directory list */}
        <div className="flex-1 overflow-y-auto">
          {isLoading && (
            <div className="p-4 text-sm text-gray-500">Loading...</div>
          )}
          {data?.error && (
            <div className="p-4 text-sm text-red-600">{data.error}</div>
          )}
          {data && !data.error && data.dirs.length === 0 && (
            <div className="p-4 text-sm text-gray-500">No subdirectories</div>
          )}
          {data?.dirs.map((dir) => (
            <button
              key={dir.path}
              onClick={() => navigateTo(dir.path)}
              className="w-full text-left px-4 py-2 hover:bg-gray-100 flex items-center gap-2 text-sm border-b border-gray-50"
            >
              <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
              </svg>
              <span className="text-gray-800">{dir.name}</span>
            </button>
          ))}
        </div>

        {/* Footer actions */}
        <div className="px-4 py-3 border-t border-gray-200 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded"
          >
            Cancel
          </button>
          <button
            onClick={() => onSelect(currentPath)}
            disabled={!data?.isGitRepo}
            className="px-3 py-1.5 text-sm text-white bg-green-600 hover:bg-green-700 rounded disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Select
          </button>
        </div>
      </div>
    </div>
  );
}
