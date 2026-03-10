import { useState, useRef, useEffect } from 'react';
import { Input } from '~/components/ui/input';
import { useCardStore } from '~/stores/context';
import type { Column } from '../../src/shared/ws-protocol';

interface AddCardFormProps {
  column: string;
  onClose: () => void;
}

export function AddCardForm({ column, onClose }: AddCardFormProps) {
  const [title, setTitle] = useState('');
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cards = useCardStore();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function submit() {
    const trimmed = title.trim();
    if (!trimmed) return;
    setPending(true);
    try {
      await cards.createCard({ title: trimmed, column: column as Column });
      setTitle('');
      onClose();
    } finally {
      setPending(false);
    }
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
        disabled={pending}
      />
    </div>
  );
}
