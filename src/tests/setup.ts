/**
 * Test setup.
 *
 * `fake-indexeddb` gives the storage layer a real IndexedDB implementation
 * under Node, so the idempotency tests exercise the actual index behaviour
 * (including the unique fingerprint index) rather than a stub.
 */
import 'fake-indexeddb/auto';
