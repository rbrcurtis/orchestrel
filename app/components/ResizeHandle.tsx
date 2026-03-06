import { useCallback, useRef } from 'react';

const STORAGE_KEY = 'conductor-panel-width';
const DEFAULT_WIDTH = 400;
const MIN_WIDTH = 300;
const MAX_WIDTH_RATIO = 0.6; // 60% of viewport

function getStoredWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_WIDTH;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    const n = Number(stored);
    const maxW = typeof window !== 'undefined' ? window.innerWidth * MAX_WIDTH_RATIO : 800;
    if (n >= MIN_WIDTH && n <= maxW) return n;
  }
  return DEFAULT_WIDTH;
}

export function useResizablePanel() {
  const panelRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(getStoredWidth());

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthRef.current;

    function onMouseMove(ev: MouseEvent) {
      // Dragging left = making panel wider (panel is on the right)
      const delta = startX - ev.clientX;
      const maxW = window.innerWidth * MAX_WIDTH_RATIO;
      const newWidth = Math.min(maxW, Math.max(MIN_WIDTH, startWidth + delta));
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

export function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      onMouseDown={onMouseDown}
      className="w-1 hover:w-1.5 bg-gray-200 dark:bg-gray-700 hover:bg-blue-400 dark:hover:bg-blue-500 cursor-col-resize transition-colors shrink-0 hidden lg:block"
    />
  );
}
