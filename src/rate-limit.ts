// Token bucket rate limiting, per client. Each client has a bucket of `capacity` tokens that refills at
// `refillPerSecond`; a request takes one token, and an empty bucket means 429 until the next token arrives.
// A short burst up to the capacity passes, a steady flood is held to the refill rate.
//
// The buckets live in this process's memory, which fits one long-running server. With several instances (a load
// balancer in front of replicas, or serverless functions) each instance counts on its own, so a client gets the
// limit once per instance: that deployment needs a shared store such as Redis, or the platform's rate limiting.

export interface RateLimitOptions {
  capacity: number;
  refillPerSecond: number;
  // Tests pass a fake clock.
  now?: () => number;
}

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

interface Bucket {
  tokens: number;
  updatedAt: number;
}

// Forgetting a client only gives it a full bucket again, so a cap keeps memory bounded when many addresses call.
const MAX_CLIENTS = 10_000;

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(private readonly options: RateLimitOptions) {
    this.now = options.now ?? Date.now;
  }

  take(client: string): RateLimitResult {
    const { capacity, refillPerSecond } = this.options;
    const time = this.now();
    const bucket = this.buckets.get(client) ?? { tokens: capacity, updatedAt: time };
    // Tokens earned since the client's last request, up to a full bucket.
    const tokens = Math.min(capacity, bucket.tokens + ((time - bucket.updatedAt) / 1000) * refillPerSecond);
    const allowed = tokens >= 1;

    // Delete, then set: a Map keeps insertion order, so the first key is always the least recently seen client.
    this.buckets.delete(client);
    this.buckets.set(client, { tokens: allowed ? tokens - 1 : tokens, updatedAt: time });
    if (this.buckets.size > MAX_CLIENTS) this.buckets.delete(this.buckets.keys().next().value as string);

    if (allowed) return { allowed };
    return { allowed, retryAfterSeconds: Math.ceil((1 - tokens) / refillPerSecond) };
  }
}
