import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/rate-limit.js';

function limiter() {
  let time = 0;
  const rateLimiter = new RateLimiter({ capacity: 3, refillPerSecond: 1, now: () => time });
  return { rateLimiter, advance: (ms: number) => (time += ms) };
}

describe('RateLimiter', () => {
  it('lets a burst up to the capacity through, then refuses with the wait until the next token', () => {
    const { rateLimiter } = limiter();
    expect([1, 2, 3].map(() => rateLimiter.take('a').allowed)).toEqual([true, true, true]);
    expect(rateLimiter.take('a')).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('refills over time, never past the capacity', () => {
    const { rateLimiter, advance } = limiter();
    for (let i = 0; i < 3; i++) rateLimiter.take('a');
    advance(1500);
    expect(rateLimiter.take('a').allowed).toBe(true);
    expect(rateLimiter.take('a')).toEqual({ allowed: false, retryAfterSeconds: 1 });
    advance(60_000);
    expect([1, 2, 3, 4].map(() => rateLimiter.take('a').allowed)).toEqual([true, true, true, false]);
  });

  it('keeps a separate bucket per client', () => {
    const { rateLimiter } = limiter();
    for (let i = 0; i < 3; i++) rateLimiter.take('a');
    expect(rateLimiter.take('a').allowed).toBe(false);
    expect(rateLimiter.take('b').allowed).toBe(true);
  });
});
