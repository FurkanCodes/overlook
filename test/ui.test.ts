import { describe, expect, it } from 'vitest';
import { humanize } from '../ui/format.js';
import { partialPeriod, rowSpans } from '../ui/panels.js';

describe('humanize', () => {
  it('reads ids as labels, keeping acronyms in capitals', () => {
    expect(humanize('refund_rate')).toBe('Refund rate');
    expect(humanize('mrr')).toBe('MRR');
    expect(humanize('user_id')).toBe('User ID');
    expect(humanize('yoy_growth')).toBe('YOY growth');
    expect(humanize('Url')).toBe('Url');
  });
});

describe('rowSpans', () => {
  const desk = { full: 12, half: 6, third: 4 };
  it('leaves full rows alone', () => {
    expect(rowSpans(['third', 'third', 'third', 'full', 'half', 'half'], desk)).toEqual([4, 4, 4, 12, 6, 6]);
  });
  it('fills a row a third and a half leave part-empty', () => {
    expect(rowSpans(['third', 'half', 'full'], desk)).toEqual([6, 6, 12]);
    expect(rowSpans(['third', 'third', 'full'], desk)).toEqual([6, 6, 12]);
    expect(rowSpans(['half', 'full', 'third'], desk)).toEqual([12, 12, 12]);
  });
});

describe('partialPeriod', () => {
  const now = new Date(2026, 10, 19); // 19 Nov 2026
  it('flags a month that is still running', () => {
    expect(partialPeriod(['2026-10-01', '2026-11-01'], now)).toBe('month');
    expect(partialPeriod(['2026-09-01', '2026-10-01'], now)).toBeNull();
  });
  it('flags weeks and days', () => {
    expect(partialPeriod(['2026-11-09', '2026-11-16'], now)).toBe('week');
    expect(partialPeriod(['2026-11-18', '2026-11-19'], now)).toBe('day');
  });
  it('ignores non-periodic spacing and too few points', () => {
    expect(partialPeriod(['2026-01-01', '2026-11-01'], now)).toBeNull();
    expect(partialPeriod(['2026-11-01'], now)).toBeNull();
  });
});
