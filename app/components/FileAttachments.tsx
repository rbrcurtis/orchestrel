import { useRef, useState } from 'react';
import { Paperclip } from 'lucide-react';
import { addAttachmentFiles } from '~/lib/file-attachments';

type Props = {
  files: File[];
  errors: string[];
  disabled?: boolean;
  onFilesChange: (files: File[]) => void;
  onErrorsChange: (errors: string[]) => void;
  children: (props: {
    onPaste: (e: React.ClipboardEvent) => void;
    openPicker: () => void;
    dragging: boolean;
  }) => React.ReactNode;
};

export function FileAttachments({
  files,
  errors,
  disabled = false,
  onFilesChange,
  onErrorsChange,
  children,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function add(incoming: FileList | File[]) {
    if (disabled) return;
    const result = addAttachmentFiles(files, Array.from(incoming));
    onFilesChange(result.files);
    onErrorsChange(result.errors);
  }

  function handlePaste(e: React.ClipboardEvent) {
    if (disabled) return;
    const images = Array.from(e.clipboardData.items)
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (!images.length) return;
    e.preventDefault();
    add(images);
  }

  return (
    <div
      onDragOver={(e) => {
        if (disabled) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        add(e.dataTransfer.files);
      }}
    >
      {files.length > 0 && (
        <div className="mb-2 flex flex-wrap justify-end gap-1.5 pr-[46px] sm:pr-[38px]">
          {files.map((file, i) => (
            <span
              key={`${file.name}-${file.size}-${file.lastModified}`}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-elevated px-2 py-0.5 text-xs text-muted-foreground"
            >
              <span className="max-w-[120px] truncate">{file.name}</span>
              <button
                type="button"
                onClick={() => onFilesChange(files.filter((_, index) => index !== i))}
                className="text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {errors.length > 0 && (
        <div className="mb-1 text-right text-xs text-destructive sm:pr-[38px]">
          {errors.join(' • ')}
        </div>
      )}
      {children({ onPaste: handlePaste, openPicker: () => inputRef.current?.click(), dragging })}
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) add(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}

export function FilePickerButton({ onClick, disabled = false }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
      title="Attach files"
    >
      <Paperclip className="size-4" />
    </button>
  );
}
