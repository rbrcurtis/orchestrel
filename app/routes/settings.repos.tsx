import { useState } from 'react';
import { Link } from 'react-router';
import { useTRPC } from '~/lib/trpc';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import RepoForm from '~/components/RepoForm';

interface Repo {
  id: number;
  name: string;
  displayName: string;
  path: string;
  host: 'github' | 'bitbucket';
  setupCommands: string | null;
  createdAt: string;
}

export default function SettingsRepos() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data: repos, isLoading } = useQuery(trpc.repos.list.queryOptions());
  const [editingRepo, setEditingRepo] = useState<Repo | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  const deleteMutation = useMutation(trpc.repos.delete.mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.repos.list.queryKey() });
    },
  }));

  function handleDelete(id: number) {
    deleteMutation.mutate({ id });
  }

  function closeForm() {
    setEditingRepo(null);
    setShowAddForm(false);
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Link
              to="/"
              className="text-gray-500 hover:text-gray-700"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
            </Link>
            <h1 className="text-xl font-bold text-gray-900">Repository Settings</h1>
          </div>
          {!showAddForm && !editingRepo && (
            <button
              onClick={() => setShowAddForm(true)}
              className="px-3 py-1.5 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded"
            >
              Add Repository
            </button>
          )}
        </div>

        {/* Add form */}
        {showAddForm && (
          <div className="mb-6">
            <RepoForm onDone={closeForm} />
          </div>
        )}

        {/* Edit form */}
        {editingRepo && (
          <div className="mb-6">
            <RepoForm repo={editingRepo} onDone={closeForm} />
          </div>
        )}

        {/* Repo list */}
        {isLoading && (
          <p className="text-sm text-gray-500">Loading repositories...</p>
        )}

        {repos && repos.length === 0 && !showAddForm && (
          <div className="text-center py-12 text-gray-500">
            <p className="text-sm">No repositories configured yet.</p>
            <button
              onClick={() => setShowAddForm(true)}
              className="mt-2 text-sm text-blue-600 hover:text-blue-800"
            >
              Add your first repository
            </button>
          </div>
        )}

        {repos && repos.length > 0 && (
          <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-200">
            {repos.map((repo) => (
              <div key={repo.id} className="px-4 py-3 flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900 text-sm">{repo.displayName}</span>
                    <span
                      className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
                        repo.host === 'github'
                          ? 'bg-gray-100 text-gray-700'
                          : 'bg-blue-100 text-blue-700'
                      }`}
                    >
                      {repo.host === 'github' ? 'GitHub' : 'Bitbucket'}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 truncate mt-0.5">{repo.path}</p>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => {
                      setShowAddForm(false);
                      setEditingRepo(repo as Repo);
                    }}
                    className="px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 rounded"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(repo.id)}
                    disabled={deleteMutation.isPending}
                    className="px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
