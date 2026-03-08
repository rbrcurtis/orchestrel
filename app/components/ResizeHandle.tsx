import { useCallback, useEffect, useRef } from 'react';

const STORAGE_KEY = 'dispatcher-panel-width';
const DEFAULT_WIDTH = 400;
const MIN_WIDTH = 300;

function getStoredWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_WIDTH;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    const n = Number(stored);
    if (n >= MIN_WIDTH) return n;
  }
  return DEFAULT_WIDTH;
}

export function useResizablePanel() {
  const panelRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(DEFAULT_WIDTH);

  // Read from localStorage on mount (client-side only)
  useEffect(() => {
    const stored = getStoredWidth();
    widthRef.current = stored;
    if (panelRef.current) {
      panelRef.current.style.width = `${stored}px`;
    }
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthRef.current;

    function onMouseMove(ev: MouseEvent) {
      const delta = startX - ev.clientX;
      const newWidth = Math.max(MIN_WIDTH, startWidth + delta);
      widthRef.current = newWidth;
      if (panelRef.current) {
        panelRef.current.style.width = `${newWidth}px`;
      }
    }

    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(STORAGE_KEY, String(widthRef.current));
    }

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  return { panelRef, initialWidth: widthRef.current, onMouseDown };
}

interface ResizeHandleProps {
  onMouseDown: (e: React.MouseEvent) => void;
  color?: string | null;
}

export function ResizeHandle({ onMouseDown, color }: ResizeHandleProps) {
  return (
    <div
      onMouseDown={onMouseDown}
      className={`w-1 hover:w-1.5 cursor-col-resize transition-colors shrink-0 hidden lg:block ${
        color ? '' : 'bg-border hover:bg-neon-cyan'
      }`}
      style={color ? { backgroundColor: `var(--${color})` } : undefined}
    />
  );
}
