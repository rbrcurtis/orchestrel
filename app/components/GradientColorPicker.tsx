import { useCallback, useRef } from 'react';
import { GRADIENT_CSS, gradientColorAt, gradientPositionOf } from '~/lib/gradient-color';

interface GradientColorPickerProps {
  value: string;
  onChange: (hex: string) => void;
}

export function GradientColorPicker({ value, onChange }: GradientColorPickerProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const position = value ? gradientPositionOf(value) : 0;

  const sample = useCallback(
    (clientX: number) => {
      const bar = barRef.current;
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      onChange(gradientColorAt(t));
    },
    [onChange],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const bar = barRef.current;
      if (!bar) return;
      bar.setPointerCapture(e.pointerId);
      sample(e.clientX);
    },
    [sample],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!barRef.current?.hasPointerCapture(e.pointerId)) return;
      sample(e.clientX);
    },
    [sample],
  );

  return (
    <div
      ref={barRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      className="relative h-6 rounded cursor-crosshair select-none touch-none"
      style={{ background: GRADIENT_CSS }}
    >
      {/* Marker */}
      <div
        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-5 rounded-full border-2 border-white shadow-md pointer-events-none"
        style={{
          left: `${position * 100}%`,
          backgroundColor: value || '#00f0ff',
          boxShadow: `0 0 6px ${value || '#00f0ff'}88, 0 1px 3px rgba(0,0,0,0.4)`,
        }}
      />
    </div>
  );
}
