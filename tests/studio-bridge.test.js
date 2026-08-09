import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearStudioCapabilityCache,
  parseStudioPairingCode,
  forgetStudioDevice,
  refreshStudioDevicePairing,
  requestStudioDevicePairing,
  restoreLatestExportArchive,
  sendArchiveToStudio,
  sendArchiveToTrustedStudio,
  transferSignatureMessage,
} from '../apps/userscript/src/studio-bridge.js';
import { createArchive, createManifest } from '../apps/userscript/src/archive.js';
import { ERROR_CODES } from '../apps/userscript/src/errors.js';
import { MemoryJobStore } from '../apps/userscript/src/storage.js';

test.beforeEach(() => clearStudioCapabilityCache());

function bridgeTestArchive(runId = 'bridge-test') {
  const manifest = createManifest({
    runId,
    scope: { type: 'all' },
    complete: true,
    items: [],
    exportedAt: '2026-07-16T00:00:00Z',
  });
  return createArchive({ manifest, items: [], includeReadable: false });
}

function respondToCapabilities(options, overrides = {}) {
  if (!options.url.endsWith('/api/v1/capabilities')) return false;
  options.onload({
    status: 200,
    responseText: JSON.stringify({
      data: {
        archive_import: true,
        archive_contract: {
          schema_versions: [1, 2],
          write_spec_version: '2.1.0',
          read_zip_methods: ['store', 'deflate'],
          write_zip_method: 'store',
          extensions: {},
          max_archive_bytes: 200 * 1024 * 1024,
          ...overrides,
        },
      },
    }),
  });
  return true;
}

test('parses a Studio pairing code', () => {
  assert.deepEqual(parseStudioPairingCode('8080:0123456789ABCDEF0123456789ABCDEF'), {
    port: 8080,
    token: '0123456789abcdef0123456789abcdef',
  });
  assert.throws(() => parseStudioPairingCode('8080-short'), /格式不正确/);
});

test('uploads only the archive to the paired local endpoint', async () => {
  let requestOptions;
  const archive = bridgeTestArchive();
  const result = await sendArchiveToStudio(
    '8080:0123456789abcdef0123456789abcdef',
    archive,
    (options) => {
      if (respondToCapabilities(options)) return;
      requestOptions = options;
      options.onload({ status: 202, responseText: JSON.stringify({ data: { status: 'awaiting_confirmation' } }) });
    },
  );
  assert.equal(requestOptions.method, 'POST');
  assert.equal(requestOptions.url, 'http://127.0.0.1:8080/api/v1/bridge/pairings/0123456789abcdef0123456789abcdef/archive');
  assert.ok(requestOptions.data instanceof FormData);
  assert.equal(result.status, 'awaiting_confirmation');
});

test('pairs once and signs each trusted Studio transfer', async () => {
  let stored = null;
  const storage = {
    async get() { return stored; },
    async set(value) { stored = structuredClone(value); },
    async delete() { stored = null; },
  };
  let publicKeySPKI;
  const pairingRequest = await requestStudioDevicePairing({
    port: 8080,
    name: 'Test Toolkit',
    storage,
    request(options) {
      const body = JSON.parse(options.data);
      publicKeySPKI = body.public_key_spki;
      options.onload({
        status: 201,
        responseText: JSON.stringify({ data: { token: 'request-token', status: 'pending', verification_code: '482731', expires_at: '2099-01-01T00:00:00Z' } }),
      });
    },
  });
  assert.equal(pairingRequest.verificationCode, '482731');
  const connection = await refreshStudioDevicePairing({
    state: pairingRequest,
    storage,
    request(options) {
      assert.match(options.url, /device-requests\/request-token$/);
      options.onload({
        status: 200,
        responseText: JSON.stringify({ data: { status: 'approved', device_id: 'device-1', instance_id: 'studio-1' } }),
      });
    },
  });
  assert.equal(connection.status, 'paired');

  const archive = bridgeTestArchive('trusted-bridge-test');
  let verified = false;
  const result = await sendArchiveToTrustedStudio(archive, {
    state: connection,
    storage,
    request(options) {
      if (respondToCapabilities(options)) return;
      if (options.url.endsWith('/bridge/challenges')) {
        options.onload({ status: 201, responseText: JSON.stringify({ data: { challenge: 'challenge-1', instance_id: 'studio-1' } }) });
        return;
      }
      if (options.url.endsWith('/bridge/transfers')) {
        const body = JSON.parse(options.data);
        const publicKey = crypto.subtle.importKey(
          'spki',
          Uint8Array.from(atob(publicKeySPKI), (value) => value.charCodeAt(0)),
          { name: 'ECDSA', namedCurve: 'P-256' },
          false,
          ['verify'],
        );
        Promise.resolve(publicKey)
          .then((key) => crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            key,
            Uint8Array.from(atob(body.signature), (value) => value.charCodeAt(0)),
            new TextEncoder().encode(transferSignatureMessage({
              deviceId: body.device_id,
              instanceId: body.instance_id,
              challenge: body.challenge,
              filename: body.filename,
              size: body.size,
              sha256: body.sha256,
            })),
          ))
          .then((valid) => {
            verified = valid;
            options.onload({ status: 201, responseText: JSON.stringify({ data: { id: 'transfer-1', upload_ticket: 'ticket-1' } }) });
          });
        return;
      }
      assert.match(options.url, /bridge\/transfers\/transfer-1\/archive$/);
      assert.equal(options.headers.Authorization, 'Bearer ticket-1');
      options.onload({ status: 202, responseText: JSON.stringify({ data: { status: 'awaiting_confirmation', preflight: { counts: { valid_items: 1 } } } }) });
    },
  });
  assert.equal(verified, true);
  assert.equal(result.status, 'awaiting_confirmation');
  let revokeRequest;
  const forgotten = await forgetStudioDevice({
    state: connection,
    storage,
    request(options) {
      if (options.url.endsWith('/bridge/challenges')) {
        options.onload({ status: 201, responseText: JSON.stringify({ data: { challenge: 'revoke-1', instance_id: 'studio-1' } }) });
        return;
      }
      revokeRequest = JSON.parse(options.data);
      options.onload({ status: 200, responseText: JSON.stringify({ data: { status: 'revoked' } }) });
    },
  });
  assert.equal(forgotten.revoked, true);
  assert.equal(revokeRequest.device_id, 'device-1');
  assert.ok(revokeRequest.signature);
  assert.equal(stored, null);
});

test('cancelling a pending pairing aborts its active Studio request', async () => {
  const state = {
    version: 2,
    status: 'pending',
    port: 8080,
    requestToken: 'request-token',
  };
  const controller = new AbortController();
  let requestAborted = false;
  const refreshing = refreshStudioDevicePairing({
    state,
    signal: controller.signal,
    storage: {
      async get() { return state; },
      async set() {},
      async delete() {},
    },
    request() {
      return {
        abort() {
          requestAborted = true;
        },
      };
    },
  });

  controller.abort();
  await assert.rejects(refreshing, (error) => error.code === ERROR_CODES.CANCELLED);
  assert.equal(requestAborted, true);
});

test('an approval cannot overwrite a replaced pending pairing request', async () => {
  const original = {
    version: 2,
    status: 'pending',
    port: 8080,
    requestToken: 'old-request',
    privateKeyPKCS8: 'old-private-key',
    publicKeySPKI: 'old-public-key',
  };
  const replacement = {
    ...original,
    requestToken: 'new-request',
    privateKeyPKCS8: 'new-private-key',
    publicKeySPKI: 'new-public-key',
  };
  let stored = original;
  let responseOptions;
  const storage = {
    async get() { return stored; },
    async set(value) { stored = value; },
    async delete() { stored = null; },
  };
  const refreshing = refreshStudioDevicePairing({
    state: original,
    storage,
    request(options) {
      responseOptions = options;
    },
  });

  stored = replacement;
  responseOptions.onload({
    status: 200,
    responseText: JSON.stringify({
      data: { status: 'approved', device_id: 'old-device', instance_id: 'old-studio' },
    }),
  });

  await assert.rejects(refreshing, (error) => error.code === ERROR_CODES.CANCELLED);
  assert.equal(stored, replacement);
});

test('aborting while an approved pairing is being stored removes the late write', async () => {
  const state = {
    version: 2,
    status: 'pending',
    port: 8080,
    requestToken: 'delayed-request',
    privateKeyPKCS8: 'private-key',
    publicKeySPKI: 'public-key',
  };
  let stored = state;
  let releaseSet;
  let markSetStarted;
  const setStarted = new Promise((resolve) => {
    markSetStarted = resolve;
  });
  const setGate = new Promise((resolve) => {
    releaseSet = resolve;
  });
  const storage = {
    async get() { return stored; },
    async set(value) {
      markSetStarted();
      await setGate;
      stored = value;
    },
    async delete() { stored = null; },
  };
  const controller = new AbortController();
  const refreshing = refreshStudioDevicePairing({
    state,
    signal: controller.signal,
    storage,
    request(options) {
      options.onload({
        status: 200,
        responseText: JSON.stringify({
          data: { status: 'approved', device_id: 'device-late', instance_id: 'studio-late' },
        }),
      });
    },
  });

  await setStarted;
  controller.abort();
  releaseSet();

  await assert.rejects(refreshing, (error) => error.code === ERROR_CODES.CANCELLED);
  assert.equal(stored, null);
});

test('rejects an incompatible Studio before creating a transfer', async () => {
  let uploads = 0;
  await assert.rejects(
    sendArchiveToStudio(
      '8080:0123456789abcdef0123456789abcdef',
      bridgeTestArchive('incompatible-studio'),
      (options) => {
        if (respondToCapabilities(options, { schema_versions: [1] })) return;
        uploads += 1;
      },
    ),
    /schema v2/,
  );
  assert.equal(uploads, 0);
});

test('caches a successful capability negotiation for the same Studio', async () => {
  const archive = bridgeTestArchive('capability-cache');
  let capabilityReads = 0;
  let uploads = 0;
  const request = (options) => {
    if (options.url.endsWith('/api/v1/capabilities')) {
      capabilityReads += 1;
      respondToCapabilities(options);
      return;
    }
    uploads += 1;
    options.onload({ status: 202, responseText: JSON.stringify({ data: { status: 'awaiting_confirmation' } }) });
  };
  await sendArchiveToStudio('8080:0123456789abcdef0123456789abcdef', archive, request);
  await sendArchiveToStudio('8080:fedcba9876543210fedcba9876543210', archive, request);
  assert.equal(capabilityReads, 1);
  assert.equal(uploads, 2);
});

test('restores the latest completed export as a sendable archive', async () => {
  const store = new MemoryJobStore({ now: () => 200 });
  const manifest = {
    schemaVersion: 2,
    toolVersion: '1.3.0',
    runId: 'job-latest',
    exportedAt: '2026-07-16T00:00:00.000Z',
    complete: true,
    scope: { type: 'pids', pids: ['123456'] },
    counts: { expectedHoles: 1, exportedHoles: 1, comments: 0, referencedHoles: 0, failed: 0 },
    errors: [],
  };
  await store.putJob({ id: 'job-latest', type: 'export', state: 'completed', accountFingerprint: 'account', manifest, options: { includeReadable: false }, createdAt: 100 });
  await store.putItem('job-latest', '123456', { pid: '123456', source: 'followed', fetchStatus: 'ok', hole: { pid: 123456, text: 'restored' }, comments: [] });
  const restored = await restoreLatestExportArchive(store, 'account');
  assert.equal(restored.job.id, 'job-latest');
  assert.equal(restored.archive.filename, 'pku-treehole-job-latest.treehole.zip');
  assert.ok(restored.archive.bytes.byteLength > 0);
});
