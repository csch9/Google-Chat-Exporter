'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadBackground() {
  const event = { addListener() {} };
  const stored = {};
  const session = {};
  const chrome = {
    action: {
      badge: '',
      async setBadgeText({ text }) { this.badge = text; },
      async setBadgeBackgroundColor() {}
    },
    runtime: { onInstalled: event, onMessage: { addListener(fn) { this.listener = fn; } }, async sendMessage() {}, lastError: null },
    contextMenus: { removeAll(callback) { callback(); }, create() {}, onClicked: event },
    tabs: { async query() { return []; }, async sendMessage() {} },
    scripting: { async executeScript() {} },
    storage: { local: {
      async get(key) { return key ? { [key]: stored[key] } : { ...stored }; },
      async set(values) { Object.assign(stored, values); },
      async remove(keys) { [].concat(keys).forEach(key => delete stored[key]); }
    }, session: {
      async get(key) { return { [key]: session[key] }; },
      async set(values) { Object.assign(session, values); }
    } },
    downloads: { download(_options, callback) { callback(1); },
      async search() { return [{ state: 'complete' }]; },
      onChanged: { addListener(fn) { this.listener = fn; } }
    }
  };
  const context = vm.createContext({
    chrome,
    AbortController,
    Blob,
    console,
    URL,
    Uint8Array,
    TextEncoder,
    atob: typeof atob !== 'undefined' ? atob : (b64) => Buffer.from(b64, 'base64').toString('binary'),
    btoa,
    clearTimeout,
    encodeURIComponent,
    importScripts() {},
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    setTimeout,
    unescape
  });
  const filename = path.join(__dirname, '..', 'chrome', 'background.js');
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context;
}

test('large HTML exports are split into ZIP volumes below the string limit', async () => {
  const context = loadBackground();
  const zips = [];
  context.JSZip = class {
    constructor() { this.paths = []; zips.push(this); }
    file(p) { this.paths.push(p); }
    async generateAsync() { return 'eA=='; }
  };
  const downloads = [];
  context.chrome.downloads.download = (options, callback) => { downloads.push(options.filename); callback(downloads.length); };
  vm.runInContext('ZIP_PART_BASE64_BUDGET = 10', context);
  const mediaFiles = ['a', 'b', 'c'].map(n => ({ path: `media/${n}`, base64: 'x'.repeat(6) }));
  const result = await context.packageHtml({ conversationName: 'Big', messages: [], mediaFiles, exportDate: new Date().toISOString(), history: {} });
  assert.equal(result.parts, 3);
  assert.deepEqual(zips.map(z => z.paths), [['index.html', 'styles.css', 'media/a'], ['media/b'], ['media/c']]);
  assert.equal(downloads.length, 3);
  assert.match(downloads[0], /_part1of3\.zip$/);
  assert.equal(result.downloadId, 3);
});

test('export stats go into the first ZIP part and the TXT header', async () => {
  const context = loadBackground();
  const zips = [];
  context.JSZip = class {
    constructor() { this.files = {}; zips.push(this); }
    file(p, data) { this.files[p] = data; }
    async generateAsync() { return 'eA=='; }
  };
  const urls = [];
  context.chrome.downloads.download = (options, callback) => { urls.push(options.url); callback(urls.length); };
  const stats = { extension: 'Google Chat Exporter', extensionVersion: '3.0.0', messages: 2, exportSeconds: 754,
    firstMessageAt: '2022-08-30T10:00:00.000Z', lastMessageAt: '2026-10-24T10:00:00.000Z',
    scan: { reason: 'idle', seconds: 720, segments: 3, stallRetries: 2 } };
  await context.packageHtml({ conversationName: 'C', messages: [], mediaFiles: [], exportDate: new Date().toISOString(), history: {}, stats });
  assert.equal(JSON.parse(zips[0].files['export-info.json']).extensionVersion, '3.0.0');

  await context.packageTxt({ conversationName: 'C', messages: [], exportDate: new Date().toISOString(), history: {}, stats });
  const text = Buffer.from(urls.at(-1).split(',')[1], 'base64').toString('utf8');
  assert.match(text, /Scan: +12m 0s, 3 segments, 2 stall retries, ended: idle/);
  assert.match(text, /Total: +12m 34s/);
  assert.match(text, /Exporter: +Google Chat Exporter 3\.0\.0/);
});

test('safeResourceUrl permits HTTPS and safe packaged media paths', () => {
  const context = loadBackground();
  assert.equal(context.safeResourceUrl('https://example.com/a.png'), 'https://example.com/a.png');
  assert.equal(context.safeResourceUrl('media/4_photo.png'), 'media/4_photo.png');
});

test('safeResourceUrl rejects active, insecure, and traversing URLs', () => {
  const context = loadBackground();
  for (const value of [
    'javascript:alert(1)',
    'data:text/html,unsafe',
    'http://example.com/file.png',
    'media/../index.html',
    '../media/file.png'
  ]) {
    assert.equal(context.safeResourceUrl(value), '', value);
  }
});

test('rendered media never emits a rejected URL', () => {
  const context = loadBackground();
  const html = context.renderMediaHtml({
    type: 'image',
    url: 'javascript:alert(1)',
    name: '<unsafe>.png'
  });
  assert.doesNotMatch(html, /javascript:/i);
  assert.match(html, /&lt;unsafe&gt;\.png/);
  assert.match(html, /\[unavailable\]/);
});

test('external media links isolate the opened page', () => {
  const context = loadBackground();
  const html = context.renderMediaHtml({
    type: 'image',
    url: 'https://example.com/photo.png',
    name: 'photo.png'
  });
  assert.match(html, /rel="noopener noreferrer"/);
});

test('background cancellation aborts the matching request and prevents retries', async () => {
  const c = loadBackground();
  let signal;
  let calls = 0;
  c.fetch = (_url, options) => {
    calls++;
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  };
  const sender = { tab: { id: 10 }, frameId: 2 };
  const listener = c.chrome.runtime.onMessage.listener;
  const response = new Promise(resolve => listener({ action: 'downloadMediaBg', requestId: 'one', url: 'https://example.com/a' }, sender, resolve));
  listener({ action: 'cancelMediaBg', requestId: 'one' }, { tab: { id: 11 }, frameId: 2 }, () => {});
  assert.equal(signal.aborted, false, 'another tab cannot cancel this request');
  listener({ action: 'cancelMediaBg', requestId: 'one' }, sender, () => {});
  assert.equal((await response).success, false);
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
  assert.equal(vm.runInContext('mediaRequests.size', c), 0);
});

test('staged export chunks are merged into one package and cleared afterwards', async () => {
  const c = loadBackground();
  let download;
  c.chrome.downloads.download = (options, callback) => { download = options; callback(1); };
  const listener = c.chrome.runtime.onMessage.listener;
  const sender = { tab: { id: 5 }, frameId: 0 };
  const send = msg => new Promise(resolve => { if (!listener(msg, sender, resolve)) resolve(); });
  await send({ action: 'stagePackageParts', stageId: 's1', messages: [{ sender: 'A', timestamp: '1', text: 'one', media: [] }] });
  await send({ action: 'stagePackageParts', stageId: 's1', messages: [{ sender: 'B', timestamp: '2', text: 'two', media: [] }] });
  const payload = { conversationName: 'Fixture', exportDate: new Date().toISOString(), history: { reason: 'idle' } };
  const response = await send({ action: 'packageAndDownload', format: 'txt', stageId: 's1', payload, expected: { messages: 2, mediaFiles: 0 } });
  assert.equal(response.success, true);
  const text = Buffer.from(download.url.split(',')[1], 'base64').toString();
  assert.match(text, /one/);
  assert.match(text, /two/);
  assert.equal(vm.runInContext('stagedPackages.size', c), 0);
  const lost = await send({ action: 'packageAndDownload', format: 'txt', stageId: 'missing', payload });
  assert.equal(lost.success, false);
  // Simulates a worker restart after the first chunk: only the later chunk reached this stage.
  await send({ action: 'stagePackageParts', stageId: 's2', messages: [{ sender: 'B', timestamp: '2', text: 'two', media: [] }] });
  const partial = await send({ action: 'packageAndDownload', format: 'txt', stageId: 's2', payload, expected: { messages: 2, mediaFiles: 0 } });
  assert.equal(partial.success, false);
  assert.match(partial.error, /incomplete/);
});

test('a multi-part checkpoint advances only when every part has completed', async () => {
  const c = loadBackground();
  const states = { 1: 'interrupted', 2: 'complete' };
  c.chrome.downloads.search = async ({ id }) => [{ state: states[id] }];
  const key = 'gceCheckpoint:' + 'a'.repeat(64);
  await c.queueCheckpoint([1, 2], { key, value: { timestamp: 100, fingerprints: [] } });
  assert.equal((await c.chrome.storage.local.get(key))[key], undefined, 'an interrupted earlier part blocks the checkpoint');
  assert.equal((await c.chrome.storage.local.get('gcePending:1'))['gcePending:1'], undefined);

  states[1] = 'in_progress';
  await c.queueCheckpoint([1, 2], { key, value: { timestamp: 100, fingerprints: [] } });
  assert.equal((await c.chrome.storage.local.get(key))[key], undefined);
  states[1] = 'complete';
  c.chrome.downloads.onChanged.listener({ id: 1, state: { current: 'complete' } });
  await vm.runInContext('checkpointQueue', c);
  assert.equal((await c.chrome.storage.local.get(key))[key].timestamp, 100);
  assert.equal((await c.chrome.storage.local.get('gcePending:2'))['gcePending:2'], undefined);
});

test('saved TXT and HTML carry incomplete-history warnings', async () => {
  const c = loadBackground();
  let download;
  c.chrome.downloads.download = (options, callback) => { download = options; callback(1); };
  const payload = { conversationName: 'Fixture', messages: [], exportDate: new Date().toISOString(), history: { reason: 'limit', warning: 'May be incomplete' } };
  await c.packageTxt(payload);
  assert.match(Buffer.from(download.url.split(',')[1], 'base64').toString(), /May be incomplete/);
  assert.match(c.generateHtml(payload), /May be incomplete/);
});

test('checkpoint advances only after completed download and survives pending state', async () => {
  const c = loadBackground();
  let state = 'in_progress';
  c.chrome.downloads.search = async () => [{ state }];
  const key = 'gceCheckpoint:' + 'a'.repeat(64);
  const checkpoint = { key, value: { timestamp: 100, fingerprints: ['b'.repeat(64)] } };
  await c.queueCheckpoint(123, checkpoint);
  assert.equal((await c.chrome.storage.local.get(key))[key], undefined);
  assert.ok((await c.chrome.storage.local.get('gcePending:123'))['gcePending:123']);
  state = 'complete';
  c.chrome.downloads.onChanged.listener({ id: 123, state: { current: state } });
  await vm.runInContext('checkpointQueue', c);
  assert.equal((await c.chrome.storage.local.get(key))[key].timestamp, 100);
  assert.equal((await c.chrome.storage.local.get('gcePending:123'))['gcePending:123'], undefined);
  state = 'interrupted';
  await c.queueCheckpoint(124, { key, value: { timestamp: 200, fingerprints: [] } });
  assert.equal((await c.chrome.storage.local.get(key))[key].timestamp, 100);
  state = 'complete';
  await c.queueCheckpoint(125, { key, value: { timestamp: 50, fingerprints: [] } });
  assert.equal((await c.chrome.storage.local.get(key))[key].timestamp, 100, 'late older download cannot rewind checkpoint');
});

test('export mode exports each channel once, then expires when idle', async () => {
  const c = loadBackground();
  const sent = [];
  c.chrome.tabs.query = async () => [{ id: 7 }];
  c.chrome.tabs.sendMessage = async (tabId, msg) => { sent.push([tabId, msg]); };
  const ask = msg => new Promise(resolve => c.chrome.runtime.onMessage.listener(msg, {}, resolve));

  assert.equal((await ask({ action: 'setExportMode', enabled: true })).enabled, true);
  assert.equal(c.chrome.action.badge, 'AUTO');
  assert.equal(JSON.stringify(sent), JSON.stringify([[7, { action: 'exportModeChanged', enabled: true }]]));

  assert.equal((await ask({ action: 'autoExportCandidate', key: 'space-a' })).run, true);
  await ask({ action: 'autoExportDone', key: 'space-a' });
  assert.equal((await ask({ action: 'autoExportCandidate', key: 'space-a' })).run, false, 'full export runs once');
  assert.equal((await ask({ action: 'autoExportCandidate', key: 'space-b' })).run, true);

  await c.chrome.storage.local.set({ gceSettings: { incremental: true } });
  assert.equal((await ask({ action: 'autoExportCandidate', key: 'space-a' })).run, true, 'incremental repeats are cheap');

  const state = (await c.chrome.storage.session.get('gceExportMode')).gceExportMode;
  await c.chrome.storage.session.set({ gceExportMode: { ...state, lastActivity: Date.now() - 11 * 60 * 1000 } });
  assert.equal((await ask({ action: 'getExportMode' })).enabled, false);
  assert.equal(c.chrome.action.badge, '');
  assert.equal((await ask({ action: 'autoExportCandidate', key: 'space-c' })).run, false);
});

test('triggerDownload converts data URLs to blob URLs in Firefox', async () => {
  const c = loadBackground();
  c.navigator = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:115.0) Gecko/20100101 Firefox/115.0' };
  let passedUrl = '';
  c.chrome.downloads.download = (options, cb) => {
    passedUrl = options.url;
    cb(42);
  };
  const dataUrl = 'data:text/plain;charset=utf-8;base64,' + c.btoa('hello world');
  const dlId = await c.triggerDownload(dataUrl, 'test.txt');
  assert.equal(dlId, 42);
  assert.ok(passedUrl.startsWith('blob:'), 'Firefox must receive a blob URL instead of data URL');
});

