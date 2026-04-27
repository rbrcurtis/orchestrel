// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
});
