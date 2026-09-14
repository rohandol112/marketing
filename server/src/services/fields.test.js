import test from 'node:test';
import assert from 'node:assert/strict';
import { MANUAL_FIELDS } from './leads.js';

/**
 * Regression guard.
 *
 * `review_count` and `rating` were missing from MANUAL_FIELDS, so every
 * verification silently threw them away. Confidence went up, opportunity never
 * moved, and nothing in the system said why - the queue just stayed stuck.
 *
 * These are the fields the verification flow sends. If one of them stops being
 * editable, the flow breaks silently again, so assert the contract directly.
 */
const VERIFY_SENDS = [
  'name', 'phone', 'website', 'address', 'locality',
  'rating', 'review_count', 'ig_followers', 'years_in_business',
];

test('every field the verification flow sends is actually editable', () => {
  const missing = VERIFY_SENDS.filter((f) => !MANUAL_FIELDS.includes(f));
  assert.deepEqual(
    missing, [],
    'these are sent on verify but would be silently dropped: ' + missing.join(', ')
  );
});

test('the two fields that drive the demand score are editable', () => {
  // Without these the whole verification step is theatre.
  assert.ok(MANUAL_FIELDS.includes('review_count'));
  assert.ok(MANUAL_FIELDS.includes('rating'));
});
