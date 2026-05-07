import { useCallback, useEffect, useRef } from 'react';

const STORAGE_KEY = 'orchestrel-panel-width';
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
    const actualWidth = panelRef.current?.getBoundingClientRect().width;
    const startWidth = actualWidth ?? widthRef.current;

    if (actualWidth != null && Math.abs(actualWidth - widthRef.current) > 1) {
      console.warn('[ResizeHandle] widthRef drift:', { ref: widthRef.current, dom: actualWidth });
    }
    console.log('[ResizeHandle] drag start', { startX, startWidth, refWidth: widthRef.current });

    let moveCount = 0;
    function onMouseMove(ev: MouseEvent) {
      const delta = startX - ev.clientX;
      const newWidth = Math.max(MIN_WIDTH, startWidth + delta);
      widthRef.current = newWidth;
      if (panelRef.current) {
        panelRef.current.style.width = `${newWidth}px`;
      }
      if (moveCount++ < 3) {
        console.log('[ResizeHandle] move', { delta, newWidth });
      }
    }

    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(STORAGE_KEY, String(widthRef.current));
      console.log('[ResizeHandle] drag end', { finalWidth: widthRef.current, moves: moveCount });
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
      className={`w-3 -mx-1 cursor-col-resize shrink-0 hidden lg:flex items-stretch justify-center touch-none z-10 ${
        color ? '' : '[&>div]:hover:bg-neon-cyan'
      }`}
    >
      <div
        className={`w-1 transition-colors ${color ? '' : 'bg-border'}`}
        style={color ? { backgroundColor: color } : undefined}
      />
    </div>
  );
}
