import { useState } from 'react';
import { useTRPC } from '~/lib/trpc';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import DirectoryBrowser from './DirectoryBrowser';

interface Repo {
  id: number;
  name: string;
  displayName: string;
  path: string;
  host: 'github' | 'bitbucket';
  setupCommands: string | null;
}

interface RepoFormProps {
  repo?: Repo;
  onDone: () => void;
}

export default function RepoForm({ repo, onDone }: RepoFormProps) {
  const [name, setName] = useState(repo?.name ?? '');
  const [displayName, setDisplayName] = useState(repo?.displayName ?? '');
  const [path, setPath] = useState(repo?.path ?? '');
  const [host, setHost] = useState<'github' | 'bitbucket'>(repo?.host ?? 'github');
  const [setupCommands, setSetupCommands] = useState(repo?.setupCommands ?? '');
  const [showBrowser, setShowBrowser] = useState(false);

  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const createMutation = useMutation(trpc.repos.create.mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.repos.list.queryKey() });
      onDone();
    },
  }));

  const updateMutation = useMutation(trpc.repos.update.mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.repos.list.queryKey() });
      onDone();
    },
  }));

  const isValid = name.trim() && displayName.trim() && path.trim();
  const isPending = createMutation.isPending || updateMutation.isPending;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid) return;

    const data = {
      name: name.trim(),
      displayName: displayName.trim(),
      path: path.trim(),
      host,
      setupCommands: setupCommands || undefined,
    };

    if (repo) {
      updateMutation.mutate({ id: repo.id, ...data });
    } else {
      createMutation.mutate(data);
    }
  }

  return (
    <>
      <form onSubmit={handleSubmit} className="border border-gray-200 rounded-lg p-4 bg-gray-50">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">
          {repo ? 'Edit Repository' : 'Add Repository'}
        </h3>

        <div className="space-y-3">
          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name (slug)</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="my-repo"
              className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          {/* Display Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Display Name</label>
            <input
              type="text"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder="My Repository"
              className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          {/* Path */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Path</label>
            <div className="flex items-center gap-2">
              <span className="flex-1 px-3 py-1.5 text-sm bg-white border border-gray-300 rounded text-gray-700 truncate">
                {path || <span className="text-gray-400">No directory selected</span>}
              </span>
              <button
                type="button"
                onClick={() => setShowBrowser(true)}
                className="px-3 py-1.5 text-sm text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded"
              >
                Browse
              </button>
            </div>
          </div>

          {/* Host */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Host</label>
            <select
              value={host}
              onChange={e => setHost(e.target.value as 'github' | 'bitbucket')}
              className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
            >
              <option value="github">GitHub</option>
              <option value="bitbucket">Bitbucket</option>
            </select>
          </div>

          {/* Setup Commands */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Setup Commands</label>
            <textarea
              value={setupCommands}
              onChange={e => setSetupCommands(e.target.value)}
              placeholder={"Commands to run in worktree after creation, e.g.\nyarn install\ncp .env.example .env"}
              rows={3}
              className="w-full px-3 py-1.5 text-sm font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
        </div>

        {/* Error display */}
        {(createMutation.error || updateMutation.error) && (
          <p className="mt-2 text-sm text-red-600">
            {createMutation.error?.message || updateMutation.error?.message}
          </p>
        )}

        {/* Actions */}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onDone}
            className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-200 rounded"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!isValid || isPending}
            className="px-3 py-1.5 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isPending ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>

      {showBrowser && (
        <DirectoryBrowser
          initialPath={path || '/home/ryan'}
          onSelect={(selected) => {
            setPath(selected);
            setShowBrowser(false);
          }}
          onCancel={() => setShowBrowser(false)}
        />
      )}
    </>
  );
}
