import { useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog';
import { Button } from '~/components/ui/button';

type Props = {
  percent: number;
  compacted: boolean;
  onCompact?: () => void;
};

function getTier(p: number) {
  if (p >= 95) return { color: '#ff00aa', glow: 'drop-shadow(0 0 6px #ff00aa88)' };
  if (p >= 80) return { color: '#ff5e00', glow: 'drop-shadow(0 0 5px #ff5e0066)' };
  if (p >= 60) return { color: '#ffb800', glow: 'drop-shadow(0 0 4px #ffb80066)' };
  return { color: '#00f0ff', glow: 'drop-shadow(0 0 3px #00f0ff66)' };
}

export function ContextGauge({ percent, compacted, onCompact }: Props) {
  const clamped = Math.max(0, Math.min(100, percent));
  const offset = 100 - clamped;
  const { color, glow } = getTier(clamped);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  function handleClick() {
    if (!onCompact) return;
    setConfirmOpen(true);
  }

  function handleConfirm() {
    setConfirmOpen(false);
    onCompact?.();
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={!onCompact}
        className="flex-shrink-0 self-center size-[50px] sm:size-[34px] cursor-pointer disabled:cursor-default rounded-full hover:bg-white/5 transition-colors"
        title="Compact context"
      >
        <svg
          viewBox="0 0 36 36"
          className={compacted ? 'context-gauge-pulse' : undefined}
          style={{ filter: glow, transform: 'rotate(-90deg)', width: '100%', height: '100%' }}
        >
          <style>{`
            @keyframes context-gauge-pulse {
              0% { transform: scale(1); opacity: 1; }
              30% { transform: scale(1.15); opacity: 0.85; }
              100% { transform: scale(1); opacity: 1; }
            }
            .context-gauge-pulse {
              animation: context-gauge-pulse 0.5s ease-out;
              transform-origin: center;
            }
          `}</style>
          {/* track */}
          <circle cx="18" cy="18" r="15.9155" fill="none" stroke="#33334a" strokeWidth="3" />
          {/* fill */}
          <circle
            cx="18"
            cy="18"
            r="15.9155"
            fill="none"
            stroke={color}
            strokeWidth="3"
            strokeDasharray="100"
            strokeDashoffset={offset}
            strokeLinecap="round"
            style={{ transition: 'stroke-dashoffset 0.6s ease, stroke 0.3s ease' }}
          />
          {/* text — counter-rotate so it reads normally */}
          {clamped > 0 && (
            <text
              x="18"
              y="18"
              textAnchor="middle"
              dominantBaseline="central"
              fill={color}
              fontSize="9"
              fontWeight="bold"
              style={{ transform: 'rotate(90deg)', transformOrigin: '18px 18px' }}
            >
              {Math.floor(clamped)}
            </text>
          )}
        </svg>
      </button>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            requestAnimationFrame(() => confirmRef.current?.focus());
          }}
          onEscapeKeyDown={(e) => e.stopPropagation()}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Compact context?</AlertDialogTitle>
            <AlertDialogDescription>
              Summarize the session context using AI. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              ref={confirmRef}
              variant="ghost"
              className="border border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan hover:bg-neon-cyan/20 hover:text-neon-cyan"
              onClick={handleConfirm}
            >
              Compact
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
