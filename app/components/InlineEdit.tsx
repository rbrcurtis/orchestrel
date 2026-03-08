import { useState, useRef, useEffect } from "react";
import { Pencil } from "lucide-react";

interface InlineEditProps {
  value: string;
  onSave: (newValue: string) => Promise<void>;
  multiline?: boolean;
  className?: string;
  editClassName?: string;
  placeholder?: string;
  disabled?: boolean;
  minLength?: number;
  maxLength?: number;
}

export function InlineEdit({
  value,
  onSave,
  multiline = false,
  className = "",
  editClassName = "",
  placeholder = "Click to edit...",
  disabled = false,
  minLength,
  maxLength,
}: InlineEditProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      const len = inputRef.current.value.length;
      inputRef.current.setSelectionRange(len, len);
    }
  }, [editing]);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  function startEdit() {
    if (disabled) return;
    setDraft(value);
    setError(null);
    setEditing(true);
  }

  function handleCancel() {
    setDraft(value);
    setError(null);
    setEditing(false);
  }

  function validate(val: string): string | null {
    if (minLength !== undefined && val.length < minLength) {
      return `Minimum ${minLength} characters required.`;
    }
    if (maxLength !== undefined && val.length > maxLength) {
      return `Maximum ${maxLength} characters allowed.`;
    }
    return null;
  }

  async function handleSave() {
    const trimmed = draft.trim();
    const validationError = validate(trimmed);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (trimmed === value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
      setEditing(false);
    } catch (err) {
      console.error("InlineEdit save failed:", err);
      setError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      handleCancel();
      return;
    }
    if (!multiline && e.key === "Enter") {
      e.preventDefault();
      handleSave();
      return;
    }
    if (multiline && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSave();
    }
  }

  const overLimit = maxLength !== undefined && draft.length > maxLength;

  if (!editing) {
    return (
      <div
        className={[
          "group flex cursor-pointer items-start gap-1 rounded px-1 py-0.5 transition-colors hover:bg-muted/50",
          disabled ? "cursor-default" : "",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={startEdit}
        role={disabled ? undefined : "button"}
        tabIndex={disabled ? undefined : 0}
        onKeyDown={(e) => {
          if (!disabled && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            startEdit();
          }
        }}
      >
        <span
          className={[
            "flex-1 whitespace-pre-wrap break-words",
            value ? "" : "text-muted-foreground",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {value || placeholder}
        </span>
        {!disabled && (
          <Pencil className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        )}
      </div>
    );
  }

  const sharedInputClass = [
    "w-full rounded border border-ring bg-background px-2 py-1 text-sm text-foreground outline-none",
    "focus:ring-2 focus:ring-ring focus:ring-offset-1 focus:ring-offset-background",
    editClassName,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={["flex flex-col gap-1.5", className].filter(Boolean).join(" ")}>
      {multiline ? (
        <textarea
          ref={inputRef as React.RefObject<HTMLTextAreaElement>}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={saving}
          className={[sharedInputClass, "min-h-[100px] resize-y"].join(" ")}
          placeholder={placeholder}
        />
      ) : (
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleSave}
          disabled={saving}
          className={sharedInputClass}
          placeholder={placeholder}
        />
      )}

      {maxLength !== undefined && (
        <span
          className={[
            "text-right text-xs",
            overLimit ? "text-destructive" : "text-muted-foreground",
          ].join(" ")}
        >
          {draft.length} / {maxLength}
        </span>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      {multiline && (
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={handleCancel}
            disabled={saving}
            className="rounded border border-border bg-background px-3 py-1 text-sm text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || overLimit}
            className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </div>
  );
}
