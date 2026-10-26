'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Reassembles staged export chunks the way the background does, then hands the payload to onPackage.
function packageRecorder(onPackage, tabId = 1, downloadState = () => 'complete') {
  const staged = { messages: [], mediaFiles: [] };
  return async msg => {
    if (msg.action === 'getTabId') return { tabId };
    if (msg.action === 'downloadStates') return { states: Object.fromEntries(msg.ids.map(id => [id, downloadState(id)])) };
    if (msg.action === 'stagePackageParts') {
      staged.messages.push(...(msg.messages || []));
      staged.mediaFiles.push(...(msg.mediaFiles || []));
      return { success: true };
    }
    if (msg.action !== 'packageAndDownload') return {};
    return onPackage({ ...msg.payload, messages: staged.messages.splice(0), mediaFiles: staged.mediaFiles.splice(0) });
  };
}

// Lets the content script's startup (which may resume a segmented scan) finish before a test swaps in shared storage.
const settle = () => new Promise(resolve => setImmediate(resolve));

function loadContent() {
  const event = { addListener() {} };
  const selectors = {
    frameName: 'single_full_screen',
    scrollContainers: [],
    fallbackScrollable: 'div',
    absoluteTimestampAttr: '[data-absolute-timestamp]',
    attrs: { absoluteTimestamp: 'data-absolute-timestamp' }
  };
  const document = {
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  const window = { name: '', addEventListener() {}, dispatchEvent() {} };
  const chrome = {
    storage: { local: { async get() { return {}; } } },
    runtime: {
      getURL(value) { return value; },
      onMessage: event,
      async sendMessage(msg) { return msg?.action === 'getTabId' ? { tabId: 1 } : {}; },
      lastError: null
    }
  };
  class MutationObserver {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
  }
  const context = vm.createContext({
    AbortController,
    URL,
    TextEncoder,
    crypto: require('node:crypto').webcrypto,
    chrome,
    clearTimeout,
    console,
    document,
    fetch: async () => ({ json: async () => selectors }),
    FileReader: class {},
    getComputedStyle: () => ({ overflowY: 'auto' }),
    Map,
    MutationObserver,
    Promise,
    Set,
    setInterval() {},
    setTimeout,
    window
  });
  const filename = path.join(__dirname, '..', 'chrome', 'content.js');
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context;
}

test('restoreScrollPosition preserves distance from the bottom', () => {
  const context = loadContent();
  const container = { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 };
  context.restoreScrollPosition(container, 25);
  assert.equal(container.scrollTop, 775);
});

test('abortable sleep stops promptly with AbortError', async () => {
  const context = loadContent();
  const controller = new AbortController();
  const pending = context.sleep(10_000, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError', message: 'Export cancelled' });
});

test('already-aborted work fails before it starts', () => {
  const context = loadContent();
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => context.throwIfAborted(controller.signal), { name: 'AbortError' });
});

test('virtualized history visits overlapping windows, deduplicates, and completes at idle', async () => {
  const c = loadContent();
  await c.loadSelectors();
  // A virtualized list mutates the DOM on every scroll step.
  c.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() { return [{ target: { nodeType: 1, closest: () => null } }]; }
  };
  const container = { scrollHeight: 1200, clientHeight: 400, scrollTop: 800,
    getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: () => [] };
  c.findScrollContainer = () => container;
  c.extractMessages = () => Array.from({ length: 4 }, (_, i) => {
    const id = Math.floor(container.scrollTop / 100) + i;
    return { _dedupKey: String(id), text: String(id), absoluteTimestamp: id + 1 };
  });
  c.getOldestTimestamp = () => Math.floor(container.scrollTop / 100) + 1;
  const waits = [];
  c.waitForHistoryMutation = async (_el, _height, _oldest, timeout) => { waits.push(timeout); };
  c.sleep = async () => {};
  c.provokeHistoryLoad = async () => false;
  const result = await c.scrollToLoadAll();
  assert.deepEqual(Array.from(result.messages, m => m.text), Array.from({ length: 12 }, (_, i) => String(i)));
  assert.equal(result.reason, 'idle');
  assert.equal(result.warning, '');
  assert.deepEqual(waits.slice(-8), [600, 1200, 1800, 2400, 3000, 3600, 4000, 4000], 'final idle checks back off to a 4 second cap');
  assert.equal(container.scrollTop, 800);
});

test('stalled top nudges the scroll position and unchanged DOM is not re-collected', async () => {
  const c = loadContent();
  await c.loadSelectors();
  const container = { scrollHeight: 1200, clientHeight: 400, scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: () => [] };
  c.findScrollContainer = () => container;
  let extractions = 0;
  c.extractMessages = () => { extractions++; return [{ _dedupKey: 'a', text: 'a', absoluteTimestamp: 1 }]; };
  c.getOldestTimestamp = () => 1;
  c.waitForHistoryMutation = async () => {};
  c.sleep = async () => {};
  const tops = [];
  let top = 0;
  Object.defineProperty(container, 'scrollTop', { get: () => top, set: value => { tops.push(value); top = value; } });
  const result = await c.scrollToLoadAll();
  assert.equal(result.reason, 'idle');
  assert.ok(tops.includes(100), 'first retries nudge the scroll position');
  assert.ok(tops.includes(1200), 'later retries move away and walk back up to the top');
  assert.equal(extractions, 2, 'only the initial and final collections scan an unchanged DOM');
});

test('large exports are staged in bounded chunks and discarded on failure', async () => {
  const c = loadContent();
  const sent = [];
  c.chrome.runtime.sendMessage = async msg => { sent.push(msg); return msg.action === 'packageAndDownload' ? { success: false } : { success: true }; };
  const messages = Array.from({ length: 1200 }, (_, i) => ({ text: String(i) }));
  const mediaFiles = Array.from({ length: 3 }, (_, i) => ({ path: `m${i}`, base64: 'x'.repeat(10_000_000) }));
  await c.sendPackage('html', { conversationName: 'x', messages, mediaFiles, history: {} });
  const parts = sent.filter(m => m.action === 'stagePackageParts');
  assert.deepEqual(parts.filter(m => m.messages).map(m => m.messages.length), [500, 500, 200]);
  assert.deepEqual(parts.filter(m => m.mediaFiles).map(m => m.mediaFiles.length), [2, 1]);
  const final = sent.at(-1);
  assert.equal(final.action, 'packageAndDownload');
  assert.equal(final.payload.messages, undefined, 'bulk data never rides on the final message');
  sent.length = 0;
  c.chrome.runtime.sendMessage = async msg => {
    sent.push(msg.action);
    if (msg.messages) throw new Error('boom');
    return {};
  };
  await assert.rejects(c.sendPackage('txt', { messages: [{ text: 'a' }], mediaFiles: [], history: {} }), /boom/);
  assert.deepEqual(sent, ['stagePackageParts', 'discardStagedPackage']);
});

test('stopping the history scan keeps collected messages, restores position and disconnects its observer', async () => {
  const c = loadContent();
  await c.loadSelectors();
  let disconnected = false;
  c.MutationObserver = class { observe() {} disconnect() { disconnected = true; } takeRecords() { return []; } };
  const container = { scrollHeight: 1200, clientHeight: 400, scrollTop: 800,
    getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: () => [] };
  c.findScrollContainer = () => container;
  c.extractMessages = () => [{ _dedupKey: 'a', text: 'a', absoluteTimestamp: 1 }];
  c.getOldestTimestamp = () => 1;
  const controller = new AbortController();
  const pending = c.scrollToLoadAll(null, 0, controller.signal);
  controller.abort();
  const result = await pending;
  assert.equal(result.reason, 'stopped');
  assert.match(result.warning, /stopped early/);
  assert.deepEqual(Array.from(result.messages, m => m.text), ['a']);
  assert.equal(container.scrollTop, 800);
  assert.ok(disconnected);
});

test('first cancel during the scan exports collected messages without advancing the checkpoint', async () => {
  const c = loadContent();
  await c.loadSelectors();
  c.isInChatFrame = () => true;
  c.getConversationName = () => 'Fixture';
  c.showProgress = () => {};
  c.sleep = async (_ms, signal) => c.throwIfAborted(signal);
  let scanSignal;
  c.scrollToLoadAll = (_progress, _cutoff, signal) => new Promise(resolve => {
    scanSignal = signal;
    signal.addEventListener('abort', () => resolve({ messages: [{ text: 'kept' }], reason: 'stopped', warning: 'stopped early' }));
  });
  let packaged = null;
  c.chrome.runtime.sendMessage = packageRecorder(payload => { packaged = payload; return { success: true, filename: 'x.txt' }; });
  const run = c.runExport({ format: 'txt' });
  for (let i = 0; i < 30 && !scanSignal; i++) await Promise.resolve();
  vm.runInContext('historyScanStop.abort()', c);
  assert.equal(await run, 'done');
  assert.deepEqual(Array.from(packaged.messages, m => m.text), ['kept']);
  assert.equal(packaged.history.reason, 'stopped');
  assert.equal(packaged.checkpoint, null);
});

test('collected history far below the viewport is detached by outermost wrapper and restored in place', async () => {
  const c = loadContent();
  const sel = await c.loadSelectors();
  sel.dateSeparator = '.sep';
  sel.messageGroups = '.group';
  // Minimal DOM: container > list > (row > group | separator); enough for the pruner's node operations.
  const container = { clientHeight: 400, getBoundingClientRect: () => ({ bottom: 400 }) };
  const node = (name, top = 0, parent = null) => {
    const n = {
      name, top, parent, children: [], textContent: name === 'sep' ? 'Monday' : '',
      get parentElement() { return this.parent; },
      matches: sel => sel === '.sep' && name === 'sep',
      getBoundingClientRect: () => ({ top }),
      get isConnected() { return !!this.parent && (this.parent === container || this.parent.isConnected); },
      get nextSibling() { return this.parent?.children ? this.parent.children[this.parent.children.indexOf(this) + 1] || null : null; },
      remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; },
      appendChild(child) { child.remove(); child.parent = this; this.children.push(child); },
      replaceWith(other) {
        const list = this.parent.children;
        const incoming = other.name === '#fragment' ? other.children.splice(0) : (other.remove(), [other]);
        incoming.forEach(x => { x.parent = this.parent; });
        list.splice(list.indexOf(this), 1, ...incoming);
        this.parent = null;
      }
    };
    if (parent) parent.children.push(n);
    return n;
  };
  const list = node('list', 0, null);
  list.parent = container;
  const row = (name, top) => { const r = node(`row-${name}`, top, list); node(name, top, r); return r; };
  row('g0', 100); row('g1', 500); row('g2', 2500); node('sep', 2900, list); row('g3', 3000); row('g4', 4000);
  const original = list.children.map(n => n.name);
  container.querySelectorAll = () => list.children.filter(n => n.name !== '#comment')
    .map(n => n.name === 'sep' ? n : n.children[0]);
  c.document.createComment = () => node('#comment');
  c.document.createDocumentFragment = () => node('#fragment');
  const pruner = c.createHistoryPruner(container);
  assert.equal(pruner.prune(), 3, 'counts message groups only');
  assert.deepEqual(list.children.map(n => n.name), ['row-g0', 'row-g1', '#comment'],
    'wrappers and separators below the buffer go behind one marker');
  assert.equal(pruner.leadingDate, 'Monday');
  assert.equal(pruner.prune(), 0, 'buffer content stays attached');
  assert.equal(pruner.count, 3);
  assert.equal(pruner.restore(), 0);
  assert.deepEqual(list.children.map(n => n.name), original);
  assert.equal(pruner.count, 0);
});

test('anchor restoration handles prepended content and changed layout', async () => {
  const c = loadContent();
  await c.loadSelectors();
  const container = { scrollTop: 100, scrollHeight: 3000, clientHeight: 400,
    getBoundingClientRect: () => ({ top: 20 }),
    querySelectorAll: () => [{ getAttribute: () => 'message-1', getBoundingClientRect: () => ({ top: 170 }) }] };
  c.restoreScrollPosition(container, 0, { id: 'message-1', offset: 30 });
  assert.equal(container.scrollTop, 220, 'uses anchor offset instead of jumping to bottom');
});

test('FileReader conversion is aborted and rejects with AbortError', async () => {
  const c = loadContent();
  let reader;
  c.FileReader = class { constructor() { reader = this; } readAsDataURL() {} abort() { this.aborted = true; } };
  const controller = new AbortController();
  const pending = c.blobToBase64({ headers: { get: () => 'image/png' }, blob: async () => ({}) }, controller.signal);
  for (let i = 0; i < 10 && !reader; i++) await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.ok(reader.aborted);
});

test('full export waits for cancelled background workers, blocks duplicates, and restarts', async () => {
  const c = loadContent();
  await c.loadSelectors();
  c.isInChatFrame = () => true;
  c.getConversationName = () => 'Fixture';
  c.extractMessages = () => [{ text: 'hello', media: Array.from({ length: 6 }, (_, i) => ({ url: `https://example.com/${i}`, name: `${i}.png` })) }];
  c.sleep = async (_ms, signal) => c.throwIfAborted(signal);
  c.setTimeout = () => 0; // terminal HUD dismissal is irrelevant to lifecycle
  c.fetch = async () => ({ ok: false });
  const pending = new Map();
  const cancelled = [];
  const packaged = [];
  const progress = [];
  c.showProgress = text => progress.push(text);
  c.chrome.runtime.sendMessage = async msg => {
    if (msg.action === 'downloadMediaBg') return new Promise(resolve => pending.set(msg.requestId, resolve));
    if (msg.action === 'cancelMediaBg') { cancelled.push(msg.requestId); return {}; }
    if (msg.action === 'packageAndDownload') { packaged.push(msg); return { success: true, filename: 'fixture.txt' }; }
  };
  const run = c.runExport({ format: 'html', loadAll: false });
  for (let i = 0; i < 30 && pending.size < 4; i++) await Promise.resolve();
  assert.equal(pending.size, 4);
  vm.runInContext('exportController.abort()', c);
  assert.equal(cancelled.length, 4);
  await c.runExport({ loadAll: false });
  assert.equal(packaged.length, 0, 'restart blocked while workers drain');
  for (const resolve of pending.values()) resolve({ success: false });
  await run;
  assert.equal(packaged.length, 0, 'cancelled export never packages');
  assert.equal(progress.at(-1), 'Export cancelled.');
  assert.equal(vm.runInContext('exportInProgress', c), false);
  await c.runExport({ format: 'txt', loadAll: false });
  assert.equal(packaged.length, 1);
  assert.equal(packaged[0].payload.history.reason, 'visible-only');
});

test('full export propagates history warning into the saved payload', async () => {
  const c = loadContent();
  await c.loadSelectors();
  c.isInChatFrame = () => true;
  c.showProgress = () => {};
  c.getConversationName = () => 'Fixture';
  c.sleep = async () => {};
  c.scrollToLoadAll = async () => ({ messages: [{ text: 'hello' }], reason: 'limit', warning: 'May be incomplete' });
  let payload;
  c.chrome.runtime.sendMessage = async msg => { payload = msg.payload; return { success: true, filename: 'fixture.txt' }; };
  await c.runExport({});
  assert.equal(payload.history.warning, 'May be incomplete');
  assert.equal(vm.runInContext('exportInProgress', c), false);
});

test('history observer accepts delayed history and ignores unrelated mutations', async () => {
  const c = loadContent();
  let mutation;
  let disconnected = false;
  c.MutationObserver = class { constructor(fn) { mutation = fn; } observe() {} disconnect() { disconnected = true; } };
  c.getOldestTimestamp = () => 10;
  const container = { scrollHeight: 500 };
  let finished = false;
  const pending = c.waitForHistoryMutation(container, 500, 10, 1000).then(() => { finished = true; });
  mutation();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(finished, false);
  container.scrollHeight = 800;
  mutation();
  await pending;
  assert.ok(disconnected);
});

test('loaded viewport proceeds after two frames; boundary still waits for history', async () => {
  const c = loadContent();
  const frames = [];
  c.requestAnimationFrame = fn => { frames.push(fn); return frames.length; };
  c.cancelAnimationFrame = () => {};
  c.getOldestTimestamp = () => 10;
  const container = { scrollHeight: 1000 };
  const controller = new AbortController();
  const fast = c.waitForHistoryMutation(container, 1000, 10, 10000, controller.signal, true);
  assert.equal(frames.length, 1);
  frames.shift()();
  frames.shift()();
  await fast;
  const slow = c.waitForHistoryMutation(container, 1000, 10, 10000, controller.signal, false);
  assert.equal(frames.length, 0, 'no frame shortcut at history boundary');
  controller.abort();
  await assert.rejects(slow, { name: 'AbortError' });
});

test('extraction cache reuses unchanged groups and reparses edited or recycled content', async () => {
  const c = loadContent();
  await c.loadSelectors();
  let records = [];
  let disconnected = false;
  c.MutationObserver = class {
    observe() {}
    takeRecords() { const batch = records; records = []; return batch; }
    disconnect() { disconnected = true; }
  };
  const cache = c.createExtractionCache({});
  const group = { nodeType: 1, closest() { return this; } };
  let parses = 0;
  let text = 'original';
  const parse = () => { parses++; return [{ text }]; };
  for (let i = 0; i < 100; i++) assert.equal(cache.read(group, 'Today', parse)[0].text, 'original');
  assert.equal(parses, 1, '100 overlapping collections parse once');
  text = 'edited';
  records = [{ target: group }];
  assert.equal(cache.read(group, 'Today', parse)[0].text, 'edited');
  assert.equal(parses, 2);
  cache.read(group, 'Yesterday', parse);
  assert.equal(parses, 3, 'date reassociation invalidates cached extraction');
  records = [{ target: { nodeType: 1, closest: () => null } }];
  cache.read(group, 'Yesterday', parse);
  assert.equal(parses, 3, 'adding another group does not reparse unchanged groups');
  cache.disconnect();
  assert.ok(disconnected);
});

test('checkpoint scope separates conversations, accounts and export modes', () => {
  const c = loadContent();
  const url = 'https://chat.google.com/u/0/app/chat/ABC123';
  const txt = c.checkpointScope(url, 'txt', true);
  assert.ok(txt);
  assert.notEqual(txt, c.checkpointScope(url.replace('ABC123', 'XYZ'), 'txt', true));
  assert.notEqual(txt, c.checkpointScope(url.replace('/u/0/', '/u/1/'), 'txt', true));
  assert.notEqual(txt, c.checkpointScope(url, 'html', false));
  assert.notEqual(c.checkpointScope(url, 'html', true), c.checkpointScope(url, 'html', false));
  assert.ok(c.checkpointScope('https://mail.google.com/mail/u/0/#chat/space/AAA123', 'txt', false));
  assert.ok(c.checkpointScope('https://chat.google.com/u/0/room/AAA123', 'txt', false));
  assert.ok(c.checkpointScope('https://chat.google.com/u/0/dm/AAA123', 'txt', false));
  assert.equal(c.checkpointScope('https://chat.google.com/u/0/', 'txt', false), '');
});

test('web-app checkpoint scope uses the selected conversation link', () => {
  const c = loadContent();
  c.location = { href: 'https://chat.google.com/u/0/' };
  c.document.querySelectorAll = selector => selector.includes('aria-current') ? [{
    href: 'https://chat.google.com/u/0/room/PWA123',
    getAttribute() { return this.href; }
  }] : [];
  const scope = c.checkpointScopeFromPage('txt', false, 'https://chat.google.com/u/0/');
  assert.equal(scope, 'chat.google.com|0|room|PWA123|txt');
});

test('web-app checkpoint scope inspects the outer application document', () => {
  const c = loadContent();
  c.location = { href: 'https://chat.google.com/u/0/frame' };
  const selected = {
    href: 'https://chat.google.com/u/0/app/chat/OUTER123',
    getAttribute() { return this.href; }
  };
  const outerDocument = { querySelectorAll: selector => selector.includes('aria-current') ? [selected] : [] };
  const outer = { location: { href: 'https://chat.google.com/u/0/' }, document: outerDocument };
  outer.parent = outer;
  c.window.parent = outer;
  assert.equal(c.checkpointScopeFromPage('html', true, 'https://chat.google.com/u/0/'),
    'chat.google.com|0|chat|OUTER123|html-media');
});

test('web-app title fallback requires exactly one matching conversation link', () => {
  const c = loadContent();
  c.location = { href: 'https://chat.google.com/u/0/' };
  c.getConversationName = () => 'Project Room';
  const link = id => ({
    href: `https://chat.google.com/u/0/room/${id}`,
    textContent: 'Project Room',
    getAttribute(name) { return name === 'aria-label' ? '' : this.href; }
  });
  c.document.querySelectorAll = selector => selector === 'a[href]' ? [link('ONE')] : [];
  assert.equal(c.checkpointScopeFromPage('txt', false), 'chat.google.com|0|room|ONE|txt');
  c.document.querySelectorAll = selector => selector === 'a[href]' ? [link('ONE'), link('TWO')] : [];
  assert.equal(c.checkpointScopeFromPage('txt', false), '', 'ambiguous titles fail closed');
});

test('incremental selection preserves equal-time new messages and unknown timestamps', async () => {
  const c = loadContent();
  const old = { _dedupKey: 'a', absoluteTimestamp: 100, text: 'old' };
  const checkpoint = await c.buildCheckpoint([old]);
  const equalTime = { _dedupKey: 'b', absoluteTimestamp: 100, text: 'new at same time' };
  const unknown = { text: 'unknown' };
  const selected = await c.selectNewMessages([{ absoluteTimestamp: 99 }, old, equalTime, unknown], checkpoint);
  assert.deepEqual(Array.from(selected), [equalTime, unknown]);
  assert.equal(await c.buildCheckpoint([unknown]), null);
  assert.equal(JSON.stringify(checkpoint).includes('old'), false, 'checkpoint stores hashes rather than text');
});

test('content-derived checkpoint scope is stable and separates conversations and modes', async () => {
  const c = loadContent();
  const history = [
    { _dedupKey: 'first', sender: 'A', absoluteTimestamp: 10, text: 'one', media: [] },
    { _dedupKey: 'second', sender: 'B', absoluteTimestamp: 20, text: 'two', media: [] }
  ];
  const scope = await c.contentCheckpointScope(history, 'Room', 'txt', false, 'https://chat.google.com/u/2/');
  assert.equal(scope, await c.contentCheckpointScope(history, 'Room', 'txt', false, 'https://chat.google.com/u/2/'));
  assert.notEqual(scope, await c.contentCheckpointScope([{ ...history[0], text: 'different' }], 'Room', 'txt', false, 'https://chat.google.com/u/2/'));
  assert.notEqual(scope, await c.contentCheckpointScope(history, 'Room', 'html', true, 'https://chat.google.com/u/2/'));
  assert.match(scope, /^chat\.google\.com\|2\|content\|/);
  assert.equal(scope.includes('Room'), false, 'scope hashes the title');
});

test('incremental web-app export falls back to a content-derived checkpoint', async () => {
  const c = loadContent();
  await c.loadSelectors();
  c.isInChatFrame = () => true;
  c.findScrollContainer = () => null;
  c.getConversationName = () => 'PWA Fixture';
  c.checkpointScopeFromPage = () => '';
  c.sleep = async () => {};
  c.setTimeout = () => 0;
  c.showProgress = () => {};
  const messages = [{ _dedupKey: 'oldest', sender: 'A', absoluteTimestamp: 100, text: 'first', media: [] }];
  const cutoffs = [];
  c.scrollToLoadAll = async (_progress, cutoff) => { cutoffs.push(cutoff); return { messages, reason: 'idle', warning: '' }; };
  const stored = {};
  c.chrome.storage.local.get = async key => ({ [key]: stored[key] });
  let downloads = 0;
  c.chrome.runtime.sendMessage = packageRecorder(payload => {
    downloads++;
    stored[payload.checkpoint.key] = payload.checkpoint.value;
    return { success: true, filename: 'pwa.txt' };
  });
  const options = { format: 'txt', incremental: true, sourceUrl: 'https://chat.google.com/u/0/' };
  await c.runExport(options);
  await c.runExport(options);
  assert.equal(downloads, 1, 'the second identical export finds its content-derived checkpoint');
  assert.deepEqual(cutoffs, [0, 0], 'route-less PWA mode safely scans full history before identifying the conversation');
});

test('incremental export establishes baseline, exports new files, then reports no new messages', async () => {
  const c = loadContent();
  await c.loadSelectors();
  c.isInChatFrame = () => true;
  c.findScrollContainer = () => null;
  c.getConversationName = () => 'Fixture';
  c.sleep = async () => {};
  c.setTimeout = () => 0;
  const progress = [];
  c.showProgress = text => progress.push(text);
  let messages = [{ _dedupKey: 'a', absoluteTimestamp: 100, text: 'first', media: [] }];
  const cutoffs = [];
  c.scrollToLoadAll = async (_progress, cutoff) => { cutoffs.push(cutoff); return { messages, reason: cutoff ? 'date-boundary' : 'idle', warning: '' }; };
  const stored = {};
  c.chrome.storage.local.get = async key => ({ [key]: stored[key] });
  const packages = [];
  c.chrome.runtime.sendMessage = packageRecorder(payload => {
    packages.push(payload);
    if (payload.checkpoint) stored[payload.checkpoint.key] = payload.checkpoint.value;
    return { success: true, filename: 'fixture.zip' };
  });
  c.downloadMedia = async () => ({ success: true, base64: 'eA==', mimeType: 'text/plain' });
  const options = { format: 'html', includeMedia: true, incremental: true, sourceUrl: 'https://chat.google.com/u/0/app/chat/ABC' };
  await c.runExport(options);
  messages = [...messages, { _dedupKey: 'b', absoluteTimestamp: 200, text: 'second', media: [{ url: 'https://example.com/a.txt', name: 'a.txt', type: 'file' }] }];
  await c.runExport(options);
  assert.equal(packages[1].messages.length, 1);
  assert.equal(packages[1].messages[0].text, 'second');
  assert.equal(packages[1].mediaFiles.length, 1);
  await c.runExport(options);
  assert.equal(packages.length, 2, 'nothing new produces no empty archive');
  assert.match(progress.at(-1), /No new messages/);
  assert.deepEqual(cutoffs, [0, 100, 200]);
  // Failed attachments must remain eligible on the next attempt.
  messages = [...messages, { _dedupKey: 'c', absoluteTimestamp: 300, text: 'third', media: [{ url: 'https://example.com/b.txt' }] }];
  c.downloadMedia = async () => ({ success: false });
  await c.runExport(options);
  assert.equal(packages[2].checkpoint, null);
  assert.match(packages[2].history.warning, /attachments failed/);
  assert.equal(Object.values(stored)[0].timestamp, 200);
  await c.runExport({ ...options, format: 'txt' });
  assert.equal(packages[3].messages.length, 3, 'TXT starts its own baseline rather than inheriting the media checkpoint');
  assert.equal(Object.keys(stored).length, 2);
});

test('a failed export keeps its scan so the retry skips rescanning', async () => {
  const c = loadContent();
  await c.loadSelectors();
  c.isInChatFrame = () => true;
  c.getConversationName = () => 'Fixture';
  c.showProgress = () => {};
  c.sleep = async () => {};
  let scans = 0;
  c.scrollToLoadAll = async () => { scans++; return { messages: [{ text: 'kept' }], reason: 'idle', warning: '' }; };
  let fail = true;
  c.chrome.runtime.sendMessage = packageRecorder(() => fail ? { success: false, error: 'boom' } : { success: true, filename: 'x.txt' });
  assert.equal(await c.runExport({ format: 'txt' }), 'error');
  fail = false;
  assert.equal(await c.runExport({ format: 'txt' }), 'done');
  assert.equal(scans, 1, 'retry reused the retained scan');
  await c.runExport({ format: 'txt' });
  assert.equal(scans, 2, 'a successful export clears the retained scan');
});

test('a failed HTML export keeps downloaded media for the retry', async () => {
  const c = loadContent();
  await c.loadSelectors();
  c.isInChatFrame = () => true;
  c.getConversationName = () => 'Fixture';
  c.showProgress = () => {};
  c.sleep = async () => {};
  c.scrollToLoadAll = async () => ({ messages: [{ text: 'pic', media: [{ url: 'https://example.com/p.png', name: 'p.png' }] }], reason: 'idle', warning: '' });
  let downloads = 0;
  c.downloadMedia = async () => { downloads++; return { success: true, base64: 'eA==', mimeType: 'image/png' }; };
  let fail = true;
  let packaged = null;
  c.chrome.runtime.sendMessage = packageRecorder(payload => { packaged = payload; return fail ? { success: false, error: 'Invalid string length' } : { success: true, filename: 'x.zip' }; });
  assert.equal(await c.runExport({ format: 'html' }), 'error');
  fail = false;
  assert.equal(await c.runExport({ format: 'html' }), 'done');
  assert.equal(downloads, 1, 'media is not downloaded again');
  assert.equal(packaged.mediaFiles.length, 1);
  assert.equal(packaged.messages[0].media[0]._localPath, packaged.mediaFiles[0].path);
});

test('HTML media is packaged one part per request and a failed part resumes without repeating earlier ones', async () => {
  const c = loadContent();
  await c.loadSelectors();
  c.isInChatFrame = () => true;
  c.getConversationName = () => 'Fixture';
  c.showProgress = () => {};
  c.sleep = async () => {};
  vm.runInContext('ZIP_PART_BASE64_BUDGET = 10', c);
  c.scrollToLoadAll = async () => ({ messages: ['a', 'b', 'c'].map(n => ({ text: n, media: [{ url: `https://example.com/${n}`, name: n }] })), reason: 'idle', warning: '' });
  c.downloadMedia = async () => ({ success: true, base64: 'x'.repeat(6), mimeType: 'image/png' });
  const parts = [];
  let failAt = 1;
  c.chrome.runtime.sendMessage = packageRecorder(payload => {
    if (payload.part.index === failAt) return { success: false, error: 'killed' };
    parts.push({ index: payload.part.index, count: payload.part.count, messages: payload.messages.length, media: payload.mediaFiles.length });
    return { success: true, filename: `p${payload.part.index + 1}.zip` };
  });
  assert.equal(await c.runExport({ format: 'html' }), 'error');
  failAt = -1;
  assert.equal(await c.runExport({ format: 'html' }), 'done');
  assert.deepEqual(parts, [
    { index: 0, count: 3, messages: 3, media: 1 },
    { index: 1, count: 3, messages: 0, media: 1 },
    { index: 2, count: 3, messages: 0, media: 1 }
  ], 'index.html travels only with part 1, and part 1 is not repeated on retry');
});

test('the checkpoint waits for every ZIP part, and the console export resumes at the failed part', async () => {
  const c = loadContent();
  await c.loadSelectors();
  c.isInChatFrame = () => true;
  c.getConversationName = () => 'Fixture';
  c.showProgress = () => {};
  c.sleep = async () => {};
  c.location = { href: 'https://chat.google.com/app/chat/SPACE' };
  vm.runInContext('ZIP_PART_BASE64_BUDGET = 10', c);
  c.scrollToLoadAll = async () => ({ messages: ['a', 'b', 'c'].map((n, i) => ({ text: n, absoluteTimestamp: i + 1, media: [{ url: `https://example.com/${n}`, name: n }] })), reason: 'idle', warning: '' });
  c.downloadMedia = async () => ({ success: true, base64: 'x'.repeat(6), mimeType: 'image/png' });
  const parts = [];
  let failAt = 1;
  let lastPayload;
  c.chrome.runtime.sendMessage = packageRecorder(payload => {
    if (payload.part.index === failAt) return { success: false, error: 'killed' };
    parts.push(payload.part.index);
    lastPayload = payload;
    return { success: true, filename: `p${payload.part.index + 1}.zip`, downloadIds: [100 + payload.part.index] };
  });
  assert.equal(await c.runExport({ format: 'html' }), 'error');
  failAt = -1;
  assert.equal(await c.gceExportFromMemory(), 'done');
  assert.deepEqual(parts, [0, 1, 2], 'parts saved before the failure are not repeated');
  assert.deepEqual(Array.from(lastPayload.partDownloads), [100, 101], 'the last part carries the earlier parts\' downloads');
});

test('a retry packages an earlier ZIP part again when its download did not complete', async () => {
  const c = loadContent();
  await c.loadSelectors();
  c.isInChatFrame = () => true;
  c.getConversationName = () => 'Fixture';
  c.showProgress = () => {};
  c.sleep = async () => {};
  vm.runInContext('ZIP_PART_BASE64_BUDGET = 10', c);
  c.scrollToLoadAll = async () => ({ messages: ['a', 'b', 'c'].map(n => ({ text: n, media: [{ url: `https://example.com/${n}`, name: n }] })), reason: 'idle', warning: '' });
  c.downloadMedia = async () => ({ success: true, base64: 'x'.repeat(6), mimeType: 'image/png' });
  const parts = [];
  let failAt = 2;
  let nextId = 100;
  c.chrome.runtime.sendMessage = packageRecorder(payload => {
    if (payload.part.index === failAt) return { success: false, error: 'killed' };
    parts.push(payload.part.index);
    return { success: true, filename: `p${payload.part.index + 1}.zip`, downloadIds: [nextId++] };
  }, 1, id => id === 100 ? 'interrupted' : 'complete');
  assert.equal(await c.runExport({ format: 'html' }), 'error');
  failAt = -1;
  assert.equal(await c.runExport({ format: 'html' }), 'done');
  assert.deepEqual(parts, [0, 1, 0, 2], 'the interrupted part 1 is rebuilt, the completed part 2 is not');
});

test('a text retry after a failed HTML export keeps the kept messages linked to the kept media', async () => {
  const c = loadContent();
  await c.loadSelectors();
  c.isInChatFrame = () => true;
  c.getConversationName = () => 'Fixture';
  c.showProgress = () => {};
  c.sleep = async () => {};
  c.scrollToLoadAll = async () => ({ messages: [{ text: 'pic', media: [{ url: 'https://example.com/p.png', name: 'p.png' }] }], reason: 'idle', warning: '' });
  c.downloadMedia = async () => ({ success: true, base64: 'eA==', mimeType: 'image/png' });
  let fail = true;
  let packaged = null;
  c.chrome.runtime.sendMessage = packageRecorder(payload => { packaged = payload; return fail ? { success: false, error: 'boom' } : { success: true, filename: 'x' }; });
  assert.equal(await c.runExport({ format: 'html' }), 'error');
  assert.equal(await c.runExport({ format: 'txt' }), 'error');
  assert.equal(packaged.messages[0].media[0]._localPath, undefined, 'the text export has no packaged paths');
  fail = false;
  assert.equal(await c.runExport({ format: 'html' }), 'done');
  assert.equal(packaged.messages[0].media[0]._localPath, packaged.mediaFiles[0].path);
});

test('a kept scan is not reused once another conversation is open at the same address', async () => {
  const c = loadContent();
  await c.loadSelectors();
  c.isInChatFrame = () => true;
  let name = 'Alpha';
  c.getConversationName = () => name;
  c.showProgress = () => {};
  c.sleep = async () => {};
  let scans = 0;
  c.scrollToLoadAll = async () => { scans++; return { messages: [{ text: name }], reason: 'idle', warning: '' }; };
  let fail = true;
  let packaged;
  c.chrome.runtime.sendMessage = packageRecorder(payload => { packaged = payload; return fail ? { success: false, error: 'boom' } : { success: true, filename: 'x.txt' }; });
  assert.equal(await c.runExport({ format: 'txt' }), 'error');
  fail = false;
  name = 'Beta';
  assert.equal(await c.runExport({ format: 'txt' }), 'done');
  assert.equal(scans, 2, 'the other conversation is scanned');
  assert.equal(packaged.messages[0].text, 'Beta');
});

test('long scans hop to a fresh page at the oldest message and the resumed page exports all segments', async () => {
  const store = {};
  const storage = {
    async get(keys) {
      if (keys == null) return { ...store };
      return Object.fromEntries([].concat(keys).filter(k => k in store).map(k => [k, store[k]]));
    },
    async set(values) { Object.assign(store, JSON.parse(JSON.stringify(values))); },
    async remove(keys) { [].concat(keys).forEach(k => delete store[k]); }
  };
  const page = async (scan) => {
    const c = loadContent();
    await c.loadSelectors();
    await settle();
    c.chrome.storage.local = storage;
    c.isInChatFrame = () => true;
    c.getConversationName = () => 'Fixture';
    c.showProgress = () => {};
    const backups = [];
    c.saveScanBackup = messages => backups.push(Array.from(messages, m => m.text));
    vm.runInContext('SCAN_BACKUP_MIN_MESSAGES = 1; SEGMENT_STALL_MESSAGES = 0', c);
    c.sleep = async () => {};
    c.location = { href: 'https://chat.google.com/app/chat/SPACE/topic/t1/message/t1' };
    c.document.querySelector = () => ({});
    c.oldestMessageLink = () => ({ link: 'https://chat.google.com/app/chat/SPACE/topic/t1/message/t1', conversation: 'SPACE' });
    c.scrollToLoadAll = async () => scan;
    const sent = { navigations: [], packaged: null, backups };
    const pack = packageRecorder(payload => { sent.packaged = payload; return { success: true, filename: 'x.txt' }; });
    c.chrome.runtime.sendMessage = async msg => {
      if (msg.action === 'navigateTab') { sent.navigations.push(msg.url); return { success: true }; }
      return pack(msg);
    };
    return { c, sent };
  };
  const msg = (key, ts) => ({ _dedupKey: key, text: key, absoluteTimestamp: ts });

  const first = await page({ messages: [msg('b', 2), msg('c', 3)], reason: 'segment', warning: '' });
  assert.equal(await first.c.runExport({ format: 'txt' }), 'segment');
  assert.deepEqual(first.sent.navigations, ['https://chat.google.com/app/chat/SPACE/topic/t1/message/t1']);
  assert.equal(store['gceSegmentJob:1'].state, 'hop');
  assert.equal(first.sent.packaged, null, 'nothing is packaged before the last segment');
  assert.deepEqual(first.sent.backups, [], 'no backup download while hopping between segments');

  const second = await page({ messages: [msg('a', 1), msg('b', 2)], reason: 'idle', warning: '' });
  assert.equal(await second.c.resumeSegmentJob(), 'done');
  assert.deepEqual(Array.from(second.sent.packaged.messages, m => m.text), ['a', 'b', 'c'], 'segments merged without the overlap');
  assert.deepEqual(second.sent.backups, [['a', 'b', 'c']], 'one backup with every segment when the run ends');
  assert.deepEqual(Object.keys(store), [], 'stored segments are cleared after a successful export');
});

test('a resumed page finds the linked message by either ID, backs up stored segments, and a retry clears the job', async () => {
  const store = {};
  const storage = {
    async get(keys) {
      if (keys == null) return { ...store };
      return Object.fromEntries([].concat(keys).filter(k => k in store).map(k => [k, store[k]]));
    },
    async set(values) { Object.assign(store, JSON.parse(JSON.stringify(values))); },
    async remove(keys) { [].concat(keys).forEach(k => delete store[k]); }
  };
  const page = async ({ scan, onPage = () => true, fail = () => false }) => {
    const c = loadContent();
    await c.loadSelectors();
    await settle();
    c.chrome.storage.local = storage;
    c.isInChatFrame = () => true;
    c.getConversationName = () => 'Fixture';
    c.showProgress = () => {};
    const sent = { backups: [], scans: 0, packaged: null };
    c.saveScanBackup = messages => sent.backups.push(Array.from(messages, m => m.text));
    vm.runInContext('SCAN_BACKUP_MIN_MESSAGES = 1; SEGMENT_STALL_MESSAGES = 0', c);
    c.sleep = async () => {};
    c.location = { href: 'https://chat.google.com/app/chat/SPACE/topic/m1/message/m1' };
    c.document.querySelector = selector => (/="m1"/.test(selector) ? onPage(selector) : true) ? {} : null;
    c.oldestMessageLink = () => ({ link: 'https://chat.google.com/app/chat/SPACE/topic/m1/message/m1', conversation: 'SPACE', message: 'm1' });
    c.scrollToLoadAll = async () => { sent.scans++; return scan; };
    const pack = packageRecorder(payload => { sent.packaged = payload; return fail() ? { success: false, error: 'boom' } : { success: true, filename: 'x.txt' }; });
    c.chrome.runtime.sendMessage = async msg => msg.action === 'navigateTab' ? { success: true } : pack(msg);
    return { c, sent };
  };
  const msg = (key, ts) => ({ _dedupKey: key, text: key, absoluteTimestamp: ts });
  const hop = async () => assert.equal(await (await page({ scan: { messages: [msg('b', 2)], reason: 'segment', warning: '' } })).c.runExport({ format: 'txt' }), 'segment');

  // The message is only found through data-message-id: the scan continues.
  await hop();
  const byMessageId = await page({ scan: { messages: [msg('a', 1)], reason: 'idle', warning: '' }, onPage: s => /data-message-id/.test(s) });
  assert.equal(await byMessageId.c.resumeSegmentJob(), 'done');
  assert.equal(byMessageId.sent.scans, 1);

  // Chat did not open the link: the stored segments are exported and still backed up.
  await hop();
  const notOpened = await page({ scan: null, onPage: () => false });
  assert.equal(await notOpened.c.resumeSegmentJob(), 'done');
  assert.deepEqual(notOpened.sent.backups, [['b']]);
  assert.deepEqual(Object.keys(store), []);

  // Packaging fails on the last page; a plain retry clears the finished job and its segments.
  await hop();
  let failing = true;
  const retry = await page({ scan: { messages: [msg('a', 1)], reason: 'idle', warning: '' }, fail: () => failing });
  assert.equal(await retry.c.resumeSegmentJob(), 'error');
  assert.ok(Object.keys(store).length, 'the segments survive the failure');
  failing = false;
  assert.equal(await retry.c.runExport({ format: 'txt' }), 'done');
  assert.equal(retry.sent.scans, 1, 'the retry reused the kept scan');
  assert.deepEqual(Object.keys(store), [], 'the retry cleared the job');

  // Chat did not open the link and packaging failed: a plain retry still clears that job.
  await hop();
  failing = true;
  const unopened = await page({ scan: null, onPage: () => false, fail: () => failing });
  assert.equal(await unopened.c.resumeSegmentJob(), 'error');
  failing = false;
  assert.equal(await unopened.c.runExport({ format: 'txt' }), 'done');
  assert.deepEqual(Object.keys(store), [], 'the retry cleared the job');

  // A fresh export of another conversation leaves the failed run's segments for recovery.
  await hop();
  failing = true;
  const other = await page({ scan: { messages: [msg('a', 1)], reason: 'idle', warning: '' }, fail: () => failing });
  assert.equal(await other.c.resumeSegmentJob(), 'error');
  failing = false;
  other.c.location = { href: 'https://chat.google.com/app/chat/OTHER' };
  assert.equal(await other.c.runExport({ format: 'txt' }), 'done');
  assert.equal(other.sent.scans, 2, 'the other conversation was scanned');
  assert.ok(Object.keys(store).length, 'the failed run\'s segments are kept');
});

test('segmented scans in two tabs keep separate jobs and segments', async () => {
  const store = {};
  const tab = async tabId => {
    const c = loadContent();
    await c.loadSelectors();
    await settle();
    c.chrome.storage.local = {
      async get(keys) {
        if (keys == null) return { ...store };
        return Object.fromEntries([].concat(keys).filter(k => k in store).map(k => [k, store[k]]));
      },
      async set(values) { Object.assign(store, JSON.parse(JSON.stringify(values))); },
      async remove(keys) { [].concat(keys).forEach(k => delete store[k]); }
    };
    c.isInChatFrame = () => true;
    c.getConversationName = () => `Tab ${tabId}`;
    c.showProgress = () => {};
    c.sleep = async () => {};
    c.oldestMessageLink = () => ({ link: 'https://chat.google.com/app/chat/X/topic/m/message/m', conversation: 'X', message: 'm' });
    c.scrollToLoadAll = async () => ({ messages: [{ _dedupKey: `t${tabId}`, text: `t${tabId}`, absoluteTimestamp: tabId }], reason: 'segment', warning: '' });
    const pack = packageRecorder(() => ({ success: true }), tabId);
    c.chrome.runtime.sendMessage = async msg => msg.action === 'navigateTab' ? { success: true } : pack(msg);
    return c;
  };
  assert.equal(await (await tab(1)).runExport({ format: 'txt' }), 'segment');
  assert.equal(await (await tab(2)).runExport({ format: 'txt' }), 'segment');
  const one = store['gceSegmentJob:1'];
  assert.ok(one && store['gceSegmentJob:2'], 'both jobs are kept');
  assert.deepEqual(Array.from(store[`gceSegment:${one.id}:0`], m => m.text), ['t1'], 'tab 1 keeps its segment');
});

test('oldest-message link follows the app URL, falling back to the copied-link format', async () => {
  const c = loadContent();
  const sel = await c.loadSelectors();
  sel.attrs.groupId = 'data-id';
  const attrs = { 'data-id': 'dV5wI_76Cgs', 'data-topic-id': 'dV5wI_76Cgs', 'data-group-synthetic-id': 'space/AAAAtnkdPQo' };
  const inner = { getAttribute: name => attrs[name] ?? null };
  const group = { getAttribute: name => name === 'data-id' ? attrs['data-id'] : null, closest: () => null,
    querySelector: sel => (sel.slice(1, -1) in attrs ? inner : null) };
  c.document.querySelector = () => group;
  c.location = { href: 'https://chat.google.com/app/chat/AAAAtnkdPQo' };
  assert.deepEqual({ ...c.oldestMessageLink() }, {
    link: 'https://chat.google.com/app/chat/AAAAtnkdPQo/topic/dV5wI_76Cgs/message/dV5wI_76Cgs', conversation: 'AAAAtnkdPQo', message: 'dV5wI_76Cgs' });
  c.location = { href: 'https://mail.google.com/chat/u/0/#chat/space/AAAAtnkdPQo' };
  assert.deepEqual({ ...c.oldestMessageLink() }, {
    link: 'https://chat.google.com/u/0/room/AAAAtnkdPQo/dV5wI_76Cgs/dV5wI_76Cgs', conversation: 'AAAAtnkdPQo', message: 'dV5wI_76Cgs' });
  c.location = { href: 'https://mail.google.com/chat/#chat/space/AAAAtnkdPQo' };
  assert.equal(c.oldestMessageLink().link, 'https://chat.google.com/room/AAAAtnkdPQo/dV5wI_76Cgs/dV5wI_76Cgs');
  c.location = { href: 'https://chat.google.com/app/chat/AAAAtnkdPQo?authuser=2' };
  assert.equal(c.oldestMessageLink().link, 'https://chat.google.com/app/chat/AAAAtnkdPQo/topic/dV5wI_76Cgs/message/dV5wI_76Cgs?authuser=2', 'the account survives the reopen');
  c.location = { href: 'https://chat.google.com/u/1/app/chat/AAAAtnkdPQo' };
  assert.equal(c.oldestMessageLink().link, 'https://chat.google.com/u/1/app/chat/AAAAtnkdPQo/topic/dV5wI_76Cgs/message/dV5wI_76Cgs');
});

test('console backup saves the kept scan and a picked backup file is exported', async () => {
  const c = loadContent();
  await c.loadSelectors();
  c.getConversationName = () => 'Fixture';
  const saved = [];
  c.saveScanBackup = (messages, name) => saved.push({ count: messages.length, name });
  vm.runInContext("retainedScan = { url: '', dateFromTs: 0, at: 0, history: { messages: [{ text: 'a' }, { text: 'b' }] } }", c);
  assert.equal(await c.gceSaveBackup(), '2 messages from retained scan');
  assert.deepEqual(saved, [{ count: 2, name: 'Fixture' }]);

  let input;
  c.document.createElement = () => (input = { click() {}, files: [{ text: async () => JSON.stringify([{ text: 'x' }]) }] });
  const exported = [];
  c.gceExportFromMemory = async (messages, options) => { exported.push({ messages, options }); return 'done'; };
  const pending = c.gceExportBackupFile({ format: 'txt' });
  await input.onchange();
  assert.equal(await pending, 'done');
  assert.deepEqual(Array.from(exported[0].messages, m => m.text), ['x']);
  assert.equal(exported[0].options.format, 'txt');
});

test('scan backups are zipped when JSZip is loaded, and zipped backups can be exported', async () => {
  const c = loadContent();
  await c.loadSelectors();
  const zipped = [];
  c.JSZip = class {
    file(name, data) { zipped.push({ name, data }); return this; }
    async generateAsync() { return 'ZIP'; }
    static async loadAsync() {
      return { files: { 'dir/': { dir: true, name: 'dir/' }, 'b.json': { dir: false, name: 'b.json', async: async () => '[{"text":"z"}]' } } };
    }
  };
  c.URL = { createObjectURL: blob => `blob:${blob}`, revokeObjectURL() {} };
  const anchors = [];
  c.document.documentElement = { appendChild() {} };
  c.document.createElement = () => { const a = { click() {}, remove() {} }; anchors.push(a); return a; };
  await c.saveScanBackup([{ text: 'a' }], 'My Chat');
  assert.match(anchors[0].download, /^My_Chat_scan-backup_.*\.zip$/);
  assert.equal(anchors[0].href, 'blob:ZIP');
  assert.match(zipped[0].name, /\.json$/);
  assert.equal(zipped[0].data, '[{"text":"a"}]');

  let input;
  c.document.createElement = () => (input = { click() {}, files: [{ name: 'backup.zip' }] });
  let exported;
  c.gceExportFromMemory = async messages => { exported = messages; return 'done'; };
  const pending = c.gceExportBackupFile();
  await input.onchange();
  assert.equal(await pending, 'done');
  assert.deepEqual(Array.from(exported, m => m.text), ['z']);
});

test('a reopened segment that stalls is reopened elsewhere, then exported with a warning once retries run out', async () => {
  const store = {};
  const c = loadContent();
  await c.loadSelectors();
  c.chrome.storage.local = {
    async get(keys) { return Object.fromEntries([].concat(keys).filter(k => k in store).map(k => [k, store[k]])); },
    async set(values) { Object.assign(store, JSON.parse(JSON.stringify(values))); },
    async remove(keys) { [].concat(keys).forEach(k => delete store[k]); }
  };
  c.isInChatFrame = () => true;
  c.getConversationName = () => 'Fixture';
  c.showProgress = () => {};
  c.saveScanBackup = () => {};
  c.sleep = async () => {};
  c.location = { href: 'https://chat.google.com/app/chat/DM/topic/m1/message/m1' };
  c.oldestMessageLink = () => ({ link: 'https://chat.google.com/app/chat/DM/topic/m0/message/m0', conversation: 'DM', message: 'm0' });
  const stalled = { messages: [{ _dedupKey: 'x', text: 'x', absoluteTimestamp: Date.UTC(2024, 0, 2) }], startCount: 1, reason: 'idle', warning: '' };
  c.scrollToLoadAll = async () => ({ ...stalled });
  const navigations = [];
  let packaged = null;
  const pack = packageRecorder(payload => { packaged = payload; return { success: true, filename: 'x.txt' }; });
  c.chrome.runtime.sendMessage = async msg => msg.action === 'navigateTab' ? (navigations.push(msg.url), { success: true }) : pack(msg);
  const job = { id: 'j', segments: 1, collected: 3000, options: { format: 'txt' }, retries: 0, startedAt: Date.now() - 60000 };
  store[`gceSegment:j:0`] = [{ _dedupKey: 'y', text: 'y', absoluteTimestamp: Date.UTC(2024, 5, 1) }];

  assert.equal(await c.runExport({ format: 'txt', segmentJob: job }), 'segment');
  assert.equal(navigations.length, 1);
  assert.equal(store['gceSegmentJob:1'].retries, 1);

  assert.equal(await c.runExport({ format: 'txt', segmentJob: { ...store['gceSegmentJob:1'], retries: 10 } }), 'done');
  assert.equal(navigations.length, 1, 'no further reopen once retries run out');
  assert.match(packaged.history.warning, /may be incomplete.*after 10 reopen attempts/);
  assert.equal(packaged.history.reason, 'stalled');
  assert.deepEqual(Array.from(packaged.messages, m => m.text), ['x', 'y']);

  // The visible "created this chat" line means the real start was reached: no reopen, no warning.
  c.conversationStartVisible = () => true;
  store['gceSegmentJob:1'] = job;
  assert.equal(await c.runExport({ format: 'txt', segmentJob: job }), 'done');
  assert.equal(navigations.length, 1);
  assert.equal(packaged.history.reason, 'idle');
  assert.equal(packaged.history.warning, '');
  assert.ok(packaged.stats.exportSeconds >= packaged.stats.scan.seconds, 'total time covers every segment');
});

test('a reopened page that barely loads anything gives up after fewer idle checks', async () => {
  const run = async quickStall => {
    const c = loadContent();
    await c.loadSelectors();
    const container = { scrollHeight: 1200, clientHeight: 400, scrollTop: 0,
      getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: () => [] };
    c.findScrollContainer = () => container;
    c.extractMessages = () => [{ _dedupKey: 'a', text: 'a', absoluteTimestamp: 1 }];
    c.getOldestTimestamp = () => 1;
    c.sleep = async () => {};
    c.provokeHistoryLoad = async () => false;
    let waits = 0;
    c.waitForHistoryMutation = async () => { waits++; };
    const result = await c.scrollToLoadAll(null, 0, null, 0, quickStall);
    assert.equal(result.reason, 'idle');
    return waits;
  };
  assert.ok(await run(true) < await run(false));
});

test('walking up through already-loaded history keeps the scan alive; a scroll that stops moving ends incomplete', async () => {
  const run = async ({ stuck }) => {
    const c = loadContent();
    await c.loadSelectors();
    let now = 0;
    c.Date = class extends Date { static now() { return now; } };
    let top = 100000;
    let minTop = top;
    const container = { scrollHeight: 100400, clientHeight: 400,
      get scrollTop() { return top; },
      set scrollTop(value) { if (!stuck || value > top) top = value; minTop = Math.min(minTop, top); },
      getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: () => [] };
    if (stuck) top = minTop = 50000;
    c.findScrollContainer = () => container;
    c.extractMessages = () => [{ _dedupKey: 'a', text: 'a', absoluteTimestamp: 1 }];
    c.getOldestTimestamp = () => 1;
    c.sleep = async () => {};
    c.provokeHistoryLoad = async () => false;
    c.waitForHistoryMutation = async () => { now += 5000; };
    return { result: await c.scrollToLoadAll(null, 0, null, 0, false), minTop };
  };
  const walked = await run({ stuck: false });
  assert.equal(walked.result.reason, 'idle');
  assert.ok(walked.minTop <= 1, 'the scan reached the top');
  const stuck = await run({ stuck: true });
  assert.equal(stuck.result.reason, 'stuck');
  assert.match(stuck.result.warning, /may be missing/);
});

test('an HTML export that downloads media again drops packaged paths left from earlier attempts', async () => {
  const c = loadContent();
  await c.loadSelectors();
  c.isInChatFrame = () => true;
  c.getConversationName = () => 'Fixture';
  c.showProgress = () => {};
  c.sleep = async () => {};
  c.location = { href: 'https://chat.google.com/app/chat/SPACE' };
  c.downloadMedia = async () => ({ success: false });
  let packaged;
  c.chrome.runtime.sendMessage = packageRecorder(payload => { packaged = payload; return { success: true, filename: 'x.zip' }; });
  const imported = [{ text: 'pic', media: [{ url: 'https://example.com/p.png', name: 'p.png', _localPath: 'media/1_p.png' }] }];
  assert.equal(await c.gceExportFromMemory(imported), 'done');
  assert.equal(packaged.messages[0].media[0]._localPath, undefined, 'the failed attachment links to its original URL');
});

test('exports carry stats about the version, message range and scan', async () => {
  const c = loadContent();
  await c.loadSelectors();
  c.isInChatFrame = () => true;
  c.getConversationName = () => 'Fixture';
  c.showProgress = () => {};
  c.sleep = async () => {};
  c.chrome.runtime.getManifest = () => ({ version: '3.0.0' });
  c.scrollToLoadAll = async () => ({ messages: [
    { text: 'a', absoluteTimestamp: Date.UTC(2022, 7, 30) }, { text: 'b', absoluteTimestamp: Date.UTC(2026, 9, 24) }
  ], reason: 'idle', warning: '' });
  let packaged;
  c.chrome.runtime.sendMessage = packageRecorder(payload => { packaged = payload; return { success: true, filename: 'x.txt' }; });
  assert.equal(await c.runExport({ format: 'txt' }), 'done');
  const { stats } = packaged;
  assert.equal(stats.extensionVersion, '3.0.0');
  assert.equal(stats.messages, 2);
  assert.equal(stats.firstMessageAt, '2022-08-30T00:00:00.000Z');
  assert.equal(stats.lastMessageAt, '2026-10-24T00:00:00.000Z');
  assert.equal(stats.scan.reason, 'idle');
  assert.equal(stats.scan.segments, 1);
  assert.equal(typeof stats.scan.seconds, 'number');
  assert.equal(stats.format, 'txt');
});

test('console export packages on-page messages with media as a complete export, without scrolling', async () => {
  const c = loadContent();
  await c.loadSelectors();
  c.isInChatFrame = () => true;
  c.getConversationName = () => 'Fixture';
  c.showProgress = () => {};
  c.sleep = async () => {};
  c.location = { href: 'https://chat.google.com/u/0/frame' };
  c.scrollToLoadAll = async () => { throw new Error('must not scroll'); };
  c.extractMessages = () => [{ text: 'pic', media: [{ url: 'https://example.com/p.png', name: 'p.png' }] }];
  c.downloadMedia = async () => ({ success: true, base64: 'eA==', mimeType: 'image/png' });
  let packaged = null;
  c.chrome.runtime.sendMessage = packageRecorder(payload => { packaged = payload; return { success: true, filename: 'x.zip' }; });
  assert.equal(await c.gceExportFromMemory(), 'done');
  assert.equal(packaged.messages.length, 1);
  assert.equal(packaged.mediaFiles.length, 1);
  assert.equal(packaged.history.reason, 'recovery');
  assert.equal(packaged.history.warning, '');
  assert.equal(packaged.checkpoint, null, 'recovered messages never advance the checkpoint');
});

test('a console export keeps the kept scan\'s incomplete-history warning', async () => {
  const c = loadContent();
  await c.loadSelectors();
  c.isInChatFrame = () => true;
  c.getConversationName = () => 'Fixture';
  c.showProgress = () => {};
  c.sleep = async () => {};
  c.location = { href: 'https://chat.google.com/app/chat/SPACE' };
  vm.runInContext("retainedScan = { url: '', dateFromTs: 0, at: 0, history: { messages: [{ text: 'a', absoluteTimestamp: 5 }], reason: 'stalled', warning: 'may be incomplete' } }", c);
  let packaged = null;
  c.chrome.runtime.sendMessage = packageRecorder(payload => { packaged = payload; return { success: true, filename: 'x.txt' }; });
  assert.equal(await c.gceExportFromMemory(null, { format: 'txt' }), 'done');
  assert.equal(packaged.history.reason, 'stalled');
  assert.equal(packaged.history.warning, 'may be incomplete');
  assert.equal(packaged.checkpoint, null);
});

test('a cancel during preparation stops the export before the history scan starts', async () => {
  const c = loadContent();
  await c.loadSelectors();
  c.isInChatFrame = () => true;
  c.getConversationName = () => 'Fixture';
  c.showProgress = () => {};
  c.sleep = async () => {};
  c.checkpointScopeFromPage = () => { vm.runInContext('exportController.abort()', c); return ''; };
  let scanned = false;
  c.scrollToLoadAll = async () => { scanned = true; return { messages: [], reason: 'idle', warning: '' }; };
  assert.equal(await c.runExport({ format: 'txt' }), 'cancelled');
  assert.equal(scanned, false);
});

test('an attachment larger than one message is staged in pieces and joined in order', async () => {
  const c = loadContent();
  vm.runInContext('MEDIA_CHUNK_CHARS = 4', c);
  const sent = [];
  c.chrome.runtime.sendMessage = async msg => { sent.push(msg); return { success: true }; };
  await c.sendPackage('html', { messages: [], mediaFiles: [{ path: 'media/a', base64: 'aa' }, { path: 'media/big', mimeType: 'video/mp4', base64: '0123456789' }] });
  const pieces = sent.filter(m => m.mediaPiece).map(m => [m.mediaPiece.index, m.mediaPiece.count, m.mediaPiece.base64]);
  assert.deepEqual(pieces, [[0, 3, '0123'], [1, 3, '4567'], [2, 3, '89']]);
  assert.deepEqual(Array.from(sent.find(m => m.mediaFiles).mediaFiles, f => f.path), ['media/a']);
  assert.deepEqual({ ...sent.at(-1).expected }, { messages: 0, mediaFiles: 2 });
});

test('advanced scan options turn off segmentation, retry reuse and backups; stopping always keeps messages', async () => {
  const c = loadContent();
  await c.loadSelectors();
  c.chrome.storage.local.get = async () => ({ gceSettings: { segmentedScan: false, retryReuse: false, scanBackup: false, stopKeepsMessages: false } });
  c.isInChatFrame = () => true;
  c.getConversationName = () => 'Fixture';
  c.showProgress = () => {};
  c.sleep = async () => {};
  let backups = 0;
  c.saveScanBackup = () => { backups++; };
  const limits = [];
  let stopDuringScan;
  c.scrollToLoadAll = async (_progress, _cutoff, _signal, segmentLimit) => {
    limits.push(segmentLimit);
    stopDuringScan = vm.runInContext('historyScanStop', c);
    return { messages: Array.from({ length: 1200 }, (_, i) => ({ text: String(i) })), reason: 'idle', warning: '' };
  };
  let fail = true;
  c.chrome.runtime.sendMessage = packageRecorder(() => fail ? { success: false, error: 'boom' } : { success: true, filename: 'x.txt' });
  assert.equal(await c.runExport({ format: 'txt' }), 'error');
  fail = false;
  assert.equal(await c.runExport({ format: 'txt' }), 'done');
  assert.deepEqual(limits, [0, 0], 'no segmentation, and the retry rescans');
  assert.ok(stopDuringScan, 'the first click always stops the scan and keeps messages, even with an outdated setting stored');
  assert.equal(backups, 0);
});

test('segment size comes from the settings and falls back to 4000 for unsupported values', async () => {
  const c = loadContent();
  await c.loadSelectors();
  let stored = { segmentSize: 2000 };
  c.chrome.storage.local.get = async () => ({ gceSettings: stored });
  assert.equal((await c.readScanOptions()).segmentSize, 2000);
  stored = { segmentSize: 1000 };
  assert.equal((await c.readScanOptions()).segmentSize, 4000);
  stored = { segmentSize: '3000' };
  c.isInChatFrame = () => true;
  c.getConversationName = () => 'Fixture';
  c.showProgress = () => {};
  c.sleep = async () => {};
  let limit;
  c.scrollToLoadAll = async (_p, _c, _s, segmentLimit) => { limit = segmentLimit; return { messages: [{ text: 'a' }], reason: 'idle', warning: '' }; };
  c.chrome.runtime.sendMessage = packageRecorder(() => ({ success: true, filename: 'x.txt' }));
  await c.runExport({ format: 'txt' });
  assert.equal(limit, 3000);
});

test('segmented progress shows messages in this segment and the running total', async () => {
  const c = loadContent();
  await c.loadSelectors();
  c.isInChatFrame = () => true;
  c.getConversationName = () => 'Fixture';
  c.sleep = async () => {};
  c.chrome.storage.local.set = async () => {};
  c.loadSegments = async () => [[]];
  const shown = [];
  c.showProgress = text => shown.push(text);
  c.scrollToLoadAll = async onProgress => {
    onProgress('Loading history... 1500 messages collected', 1500);
    onProgress('Reached date range boundary — stopping scroll.');
    return { messages: [], reason: 'idle', warning: '' };
  };
  await c.runExport({ format: 'txt', segmentJob: { id: 'j', segments: 2, collected: 8000 } });
  assert.ok(shown.includes('Segment 3: loading history... 1,500 messages in this segment, ~9,500 total'));
  assert.ok(shown.includes('Segment 3: Reached date range boundary — stopping scroll.'));
});

test('turning off DOM pruning scans without detaching anything', async () => {
  const c = loadContent();
  await c.loadSelectors();
  vm.runInContext('scanOptions = { ...scanOptions, pruneDom: false }', c);
  c.createHistoryPruner = () => { throw new Error('pruner must not be created'); };
  const container = { scrollHeight: 1200, clientHeight: 400, scrollTop: 800,
    getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: () => [] };
  c.findScrollContainer = () => container;
  c.extractMessages = () => [{ _dedupKey: 'a', text: 'a', absoluteTimestamp: 1 }];
  c.getOldestTimestamp = () => 1;
  const controller = new AbortController();
  const pending = c.scrollToLoadAll(null, 0, controller.signal);
  controller.abort();
  assert.equal((await pending).reason, 'stopped');
});

test('conversation identity comes from the chat address', () => {
  const c = loadContent();
  c.location = { href: 'https://chat.google.com/u/1/app/space/AAA123' };
  assert.equal(c.currentConversation().key, 'chat.google.com|1|space|AAA123');
});

test('export mode waits for a settled conversation and cancels on switch', async () => {
  const c = loadContent();
  await c.loadSelectors();
  vm.runInContext('exportModeEnabled = true; exportModeLastSync = Date.now();', c);
  let key = 'a';
  const started = [];
  c.isInChatFrame = () => true;
  c.currentConversation = () => ({ key });
  c.startAutoExport = async value => { started.push(value); };
  let rendered = false;
  c.document.querySelector = () => (rendered ? {} : null);

  for (let i = 0; i < 4; i++) c.exportModeTick();
  assert.deepEqual(started, [], 'no export before messages render');
  rendered = true;
  c.exportModeTick();
  c.exportModeTick();
  assert.deepEqual(started, ['a']);

  const controller = new AbortController();
  c.exportController = controller;
  vm.runInContext('exportInProgress = true; autoExportKey = "a";', c);
  vm.runInContext('exportController = this.exportController;', c);
  key = 'b';
  c.exportModeTick();
  assert.equal(controller.signal.aborted, true);
});

test('auto-export marks a channel only after it saved', async () => {
  const c = loadContent();
  await c.loadSelectors();
  const sent = [];
  c.chrome.runtime.sendMessage = async msg => {
    sent.push(msg.action);
    return msg.action === 'autoExportCandidate' ? { run: true, settings: { format: 'html', incremental: true } } : {};
  };
  let options;
  let outcome = 'done';
  c.runExport = async value => { options = value; return outcome; };
  vm.runInContext('exportModeWatch = { key: "a", stableTicks: 2, handled: true };', c);

  await c.startAutoExport('a');
  assert.equal(options.format, 'html');
  assert.equal(options.incremental, true);
  assert.equal(options.auto, true);
  assert.ok(sent.includes('autoExportDone'));

  sent.length = 0;
  outcome = 'cancelled';
  await c.startAutoExport('a');
  assert.ok(!sent.includes('autoExportDone'));
  assert.equal(vm.runInContext('exportModeWatch.handled', c), true, 'manual cancel stays suppressed while on channel');

  // Revisiting the channel clears handled and allows retry
  vm.runInContext('exportModeWatch = { key: "b", stableTicks: 0, handled: false }; exportModeEnabled = true;', c);
  c.currentConversation = () => ({ key: 'a' });
  c.exportModeTick();
  assert.equal(vm.runInContext('exportModeWatch.handled', c), false, 'cancelled channel retries on revisit');

  vm.runInContext('exportModeWatch.handled = true;', c);
  outcome = 'error';
  await c.startAutoExport('a');
  assert.equal(vm.runInContext('exportModeWatch.handled', c), true, 'failures do not retry in a loop');
});

test('export mode tick does not poll background when disabled', async () => {
  const c = loadContent();
  await c.loadSelectors();
  let polled = false;
  c.chrome.runtime.sendMessage = async () => { polled = true; return {}; };
  c.isInChatFrame = () => true;
  vm.runInContext('exportModeEnabled = false; exportModeLastSync = 0;', c);
  c.exportModeTick();
  assert.equal(polled, false, 'must not poll background when export mode is disabled');
});

