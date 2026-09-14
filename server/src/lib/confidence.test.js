import test from 'node:test';
import assert from 'node:assert/strict';
import { computeConfidence, DEFAULT_CONFIDENCE_CONFIG } from './confidence.js';
import { evaluate } from '../services/lifecycle.js';
import { DEFAULT_SCORING_CONFIG } from './scoring.js';

const cfg = DEFAULT_CONFIDENCE_CONFIG;

const fromPlaces = {
  name: 'Narenkumar Jewellers',
  normalized_category: 'jewellery_store',
  google_place_id: 'ChIJabc123',
  business_status: 'OPERATIONAL',
  phone_normalized: '+912025551234',
  website: 'https://narenkumar.example',
  website_status: 'ok',
  address: '12 MG Road, Pune',
  lat: 18.5, lng: 73.8,
  rating: 4.6, review_count: 1240,
  ig_handle: 'narenkumar',
  field_provenance: {},
};

const fromRecall = {
  name: 'Shri Ram Jewellers',
  normalized_category: 'jewellery_store',
  google_place_id: null,
  business_status: null,
  phone_normalized: null,
  website: null,
  website_status: 'none',
  address: null,
  lat: null, lng: null,
  rating: null, review_count: null,
  field_provenance: { provider: 'gemini_recall' },
};

test('a Places-sourced lead reaches high confidence', () => {
  const r = computeConfidence(fromPlaces, cfg);
  assert.ok(r.confidence >= 80, 'expected high confidence, got ' + r.confidence);
  assert.equal(r.level, 'high');
  assert.equal(r.assignable, true);
});

test('a model-recalled lead is low confidence and not assignable', () => {
  const r = computeConfidence(fromRecall, cfg);
  assert.ok(r.confidence < 60, 'expected low confidence, got ' + r.confidence);
  assert.equal(r.level, 'low');
  assert.equal(r.assignable, false);
});

test('confidence names what is missing, most valuable first', () => {
  const r = computeConfidence(fromRecall, cfg);
  assert.ok(r.breakdown.missing.length > 0);
  assert.match(r.breakdown.missing[0].label, /Existence not confirmed/);
  assert.equal(r.breakdown.missing[0].worth, cfg.weights.identity);
});

test('a human Maps check can stand in for a Place ID', () => {
  // Without a Places key the Place ID is unobtainable. If it were the only way
  // to establish identity, no lead could ever clear the assignment floor and
  // the pipeline would dead-end at "verified".
  const humanChecked = {
    ...fromRecall,
    phone_normalized: '+912025554444',
    address: 'Aundh Road, Pune',
    business_status: 'OPERATIONAL',
    rating: 4.5,
    review_count: 640,
    ig_followers: 410,
    website: 'https://soni.example',
    website_status: 'ok',
    verified_at: new Date().toISOString(),
    field_provenance: { verification: { method: 'human_maps_check' } },
  };
  const r = computeConfidence(humanChecked, cfg);
  assert.ok(
    r.assignable,
    'a fully hand-verified lead must be able to reach a rep, got ' + r.confidence + '%'
  );
  assert.match(r.breakdown.signals.map((x) => x.label).join(' | '), /Confirmed by a person/);
});

test('the same human check is not counted twice', () => {
  const humanOnly = {
    ...fromRecall,
    verified_at: new Date().toISOString(),
    field_provenance: { verification: { method: 'human_maps_check' } },
  };
  const r = computeConfidence(humanOnly, cfg);
  const identityPts = r.breakdown.signals.filter((x) => /Confirmed by a person/.test(x.label));
  assert.equal(identityPts.length, 1, 'human verification must pay for identity once, not twice');
});

test('a recalled candidate cannot enter the sales pipeline', () => {
  const e = evaluate(fromRecall, DEFAULT_SCORING_CONFIG, cfg);
  assert.equal(e.discovery_status, 'discovered');
  assert.equal(e.assignable, false);
});

test('a verified Places lead qualifies', () => {
  const e = evaluate(fromPlaces, DEFAULT_SCORING_CONFIG, cfg);
  assert.equal(e.discovery_status, 'qualified');
  assert.equal(e.assignable, true);
});

test('human verification promotes a candidate out of discovered', () => {
  const verified = {
    ...fromRecall,
    phone_normalized: '+912025559999',
    address: 'Baner Road, Pune',
    rating: 4.5,
    review_count: 210,
    ig_followers: 380,
    business_status: 'OPERATIONAL',
    verified_at: new Date().toISOString(),
    field_provenance: { verification: { method: 'human_maps_check' } },
  };
  const e = evaluate(verified, DEFAULT_SCORING_CONFIG, cfg);
  assert.notEqual(e.discovery_status, 'discovered');
  assert.ok(e.confidence > computeConfidence(fromRecall, cfg).confidence);
});

test('opportunity and confidence move independently', () => {
  // Same business facts, but one is evidenced and one is asserted.
  const asserted = { ...fromPlaces, google_place_id: null, verified_at: null, field_provenance: {} };
  const a = evaluate(fromPlaces, DEFAULT_SCORING_CONFIG, cfg);
  const b = evaluate(asserted, DEFAULT_SCORING_CONFIG, cfg);
  assert.equal(a.score, b.score, 'opportunity should not change');
  assert.ok(a.confidence > b.confidence, 'confidence should');
});
