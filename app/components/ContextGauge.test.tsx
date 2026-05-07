// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ContextGauge } from './ContextGauge';

describe('ContextGauge percent label', () => {
  it('rounds displayed percentage down', () => {
    render(<ContextGauge percent={69.8465} compacted={false} />);

    expect(screen.getByText('69')).toBeTruthy();
    expect(screen.queryByText('70')).toBeNull();
  });

  it('still displays 70 once percent reaches 70 exactly', () => {
    render(<ContextGauge percent={70} compacted={false} />);

    expect(screen.getByText('70')).toBeTruthy();
  });

  it('disables compact button when no compact action available', () => {
    render(<ContextGauge percent={70} compacted={false} />);

    expect(screen.getByTitle('Compact context').hasAttribute('disabled')).toBe(true);
  });

  it('opens confirm dialog when compact action is available', () => {
    const onCompact = vi.fn();
    render(<ContextGauge percent={70} compacted={false} onCompact={onCompact} />);

    fireEvent.click(screen.getByTitle('Compact context'));

    expect(screen.getByText('Compact context?')).toBeTruthy();
  });
});
