import { useTRPC } from '~/lib/trpc';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useRef, useEffect } from 'react';
import { Input } from '~/components/ui/input';

interface AddCardFormProps {
  column: string;
  onClose: () => void;
}

export function AddCardForm({ column, onClose }: AddCardFormProps) {
  const [title, setTitle] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const createMutation = useMutation(trpc.cards.create.mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.cards.list.queryKey() });
      setTitle('');
    },
  }));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function submit() {
    const trimmed = title.trim();
    if (!trimmed) return;
    createMutation.mutate({ title: trimmed, column: column as 'backlog' | 'ready' | 'in_progress' | 'review' | 'done' });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      onClose();
    }
  }

  return (
    <div className="px-2 pb-2">
      <Input
        ref={inputRef}
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={onClose}
        placeholder="Card title..."
        disabled={createMutation.isPending}
      />
    </div>
  );
}
