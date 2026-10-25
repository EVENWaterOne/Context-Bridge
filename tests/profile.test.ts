import test from 'node:test';
import assert from 'node:assert/strict';
import { loadProfile, persistProfile } from '../src/lib/profile.ts';

test('profile handles disabled browser storage and rejects malformed saved identities', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Disabled'); } });
    assert.equal(loadProfile(), null);
    assert.equal(persistProfile({ name: 'Maker', email: 'maker@example.com' }), false);
    assert.equal(persistProfile(null), false);
    for (const raw of ['oops', '{}', '{"name":null,"email":"a"}', '{"name":"","email":"a"}']) {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => raw } });
      assert.equal(loadProfile(), null);
    }
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => '{"name":"Maker","email":"maker@example.com","password":"must-not-survive"}' } });
    assert.deepEqual(loadProfile(), { name: 'Maker', email: 'maker@example.com' });
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
