import { describe, expect, it } from 'vitest';
import { badgeText } from './badge';

describe('badgeText', () => {
  it('shows the total across accounts, nothing when zero, and caps at 99+', () => {
    expect(badgeText({})).toBe('');
    expect(badgeText({ a: 0 })).toBe('');
    expect(badgeText({ a: 2, b: 3 })).toBe('5');
    expect(badgeText({ a: 150 })).toBe('99+');
  });
});
