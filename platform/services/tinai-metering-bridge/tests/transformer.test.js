// tests/transformer.test.js
// Unit tests for the Lago event transformer.
// Run with: node --test tests/

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  namespaceToSubscriptionId,
  buildTransactionId,
  transformToLagoEvents,
  chunkEvents,
} from '../src/transformers/lago.js';

describe('namespaceToSubscriptionId', () => {
  it('strips tenant- prefix', () => {
    assert.equal(namespaceToSubscriptionId('tenant-acme-corp'), 'acme-corp');
  });

  it('handles single-segment names', () => {
    assert.equal(namespaceToSubscriptionId('tenant-startup'), 'startup');
  });

  it('throws on wrong prefix', () => {
    assert.throws(
      () => namespaceToSubscriptionId('kube-system'),
      /does not start with expected prefix/
    );
  });
});

describe('buildTransactionId', () => {
  it('returns a 32-char hex string', () => {
    const id = buildTransactionId('tenant-acme', 'compute_seconds', 1000, 2000);
    assert.match(id, /^[0-9a-f]{32}$/);
  });

  it('is deterministic — same inputs same output', () => {
    const a = buildTransactionId('tenant-acme', 'egress_bytes', 1000, 2000);
    const b = buildTransactionId('tenant-acme', 'egress_bytes', 1000, 2000);
    assert.equal(a, b);
  });

  it('differs for different metric codes', () => {
    const a = buildTransactionId('tenant-acme', 'compute_seconds', 1000, 2000);
    const b = buildTransactionId('tenant-acme', 'egress_bytes', 1000, 2000);
    assert.notEqual(a, b);
  });

  it('differs for different windows', () => {
    const a = buildTransactionId('tenant-acme', 'compute_seconds', 1000, 2000);
    const b = buildTransactionId('tenant-acme', 'compute_seconds', 2000, 3000);
    assert.notEqual(a, b);
  });
});

describe('transformToLagoEvents', () => {
  const ns = 'tenant-acme-corp';
  const metrics = {
    compute_seconds: 3600.1234,
    memory_gb_seconds: 7200,
    egress_bytes: 10485760,
  };
  const windowStart = 1700000000000;
  const windowEnd = 1700000900000;

  it('generates one event per metric', () => {
    const events = transformToLagoEvents(ns, metrics, windowStart, windowEnd);
    assert.equal(events.length, 3);
  });

  it('sets correct external_subscription_id', () => {
    const events = transformToLagoEvents(ns, metrics, windowStart, windowEnd);
    assert.ok(events.every(e => e.external_subscription_id === 'acme-corp'));
  });

  it('sets timestamp as unix seconds (not ms)', () => {
    const events = transformToLagoEvents(ns, metrics, windowStart, windowEnd);
    const ts = events[0].timestamp;
    // Unix seconds should be ~1.7B, not ~1.7T (ms)
    assert.ok(ts < 2_000_000_000, `Timestamp ${ts} looks like milliseconds`);
    assert.ok(ts > 1_000_000_000, `Timestamp ${ts} is too small`);
  });

  it('encodes value as string', () => {
    const events = transformToLagoEvents(ns, metrics, windowStart, windowEnd);
    assert.ok(events.every(e => typeof e.properties.value === 'string'));
  });

  it('rounds to 4 decimal places', () => {
    const events = transformToLagoEvents(ns, metrics, windowStart, windowEnd);
    const computeEvent = events.find(e => e.code === 'compute_seconds');
    assert.equal(computeEvent.properties.value, '3600.1234');
  });

  it('uses deterministic transaction_id', () => {
    const events1 = transformToLagoEvents(ns, metrics, windowStart, windowEnd);
    const events2 = transformToLagoEvents(ns, metrics, windowStart, windowEnd);
    events1.forEach((e, i) => {
      assert.equal(e.transaction_id, events2[i].transaction_id);
    });
  });
});

describe('chunkEvents', () => {
  const events = Array.from({ length: 250 }, (_, i) => ({ id: i }));

  it('splits into correct number of chunks', () => {
    const chunks = chunkEvents(events, 100);
    assert.equal(chunks.length, 3);
  });

  it('last chunk has remainder', () => {
    const chunks = chunkEvents(events, 100);
    assert.equal(chunks[2].length, 50);
  });

  it('handles empty array', () => {
    assert.deepEqual(chunkEvents([], 100), []);
  });

  it('handles array smaller than batch size', () => {
    const small = chunkEvents([{ id: 1 }, { id: 2 }], 100);
    assert.equal(small.length, 1);
    assert.equal(small[0].length, 2);
  });
});
