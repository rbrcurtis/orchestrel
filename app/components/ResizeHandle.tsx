import { useCallback, useEffect, useRef } from 'react';

const STORAGE_KEY = 'orchestrel-panel-width';
const DEFAULT_WIDTH = 400;
const MIN_WIDTH = 300;

// Touch devices (iPad) only show one card column in the board, so the session
// panel takes the other two thirds and the board keeps a third of the width.
// Mouse-driven desktops keep the narrow panel so the board can show several
// columns.
function defaultWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_WIDTH;
  if (!window.matchMedia('(pointer: coarse)').matches) return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.round((window.innerWidth * 2) / 3));
}

function getStoredWidth(): number {
  if (typeof window === 'undefined') return defaultWidth();
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    const n = Number(stored);
    if (n >= MIN_WIDTH) return n;
  }
  return defaultWidth();
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

  // Pointer events, not mouse events: iOS never turns a touch drag into the
  // mousemove stream that a mouse drag produces, so the handle was dead on iPad.
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = panelRef.current?.getBoundingClientRect().width ?? widthRef.current;

    function onPointerMove(ev: PointerEvent) {
      if (ev.pointerId !== e.pointerId) return;
      const newWidth = Math.max(MIN_WIDTH, startWidth + (startX - ev.clientX));
      widthRef.current = newWidth;
      if (panelRef.current) {
        panelRef.current.style.width = `${newWidth}px`;
      }
    }

    function onPointerUp(ev: PointerEvent) {
      if (ev.pointerId !== e.pointerId) return;
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(STORAGE_KEY, String(widthRef.current));
    }

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
  }, []);

  return { panelRef, initialWidth: widthRef.current, onPointerDown };
}

interface ResizeHandleProps {
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  color?: string | null;
}

export function ResizeHandle({ onPointerDown, color }: ResizeHandleProps) {
  return (
    <div
      onPointerDown={onPointerDown}
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
