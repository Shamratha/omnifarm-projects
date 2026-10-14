import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import * as analytics from '../public/analytics.mjs';
import { StreamParser, StreamProtocolError, buildReconnectUrl } from '../public/stream-parser.mjs';

const [html, app, recording] = await Promise.all([
  readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('./recordings/stream-reconnect.json', import.meta.url), 'utf8').then(JSON.parse),
]);

// Exercise the real app and protocol with a small DOM/transport double. Browser
// layout and native key defaults are verified separately in a browser smoke check.
function dashboard({ connected = true, frames = true } = {}) {
  const document = { listeners: new Map(), downloads: [] };
  class Element {
    constructor(tagName = 'div', attributes = '') {
      this.tagName = tagName;
      this.attributes = Object.fromEntries([...attributes.matchAll(/([\w-]+)="([^"]*)"/g)]
        .map((match) => [match[1], match[2]]));
      this.id = this.attributes.id;
      this.dataset = this.attributes['data-index'] === undefined ? {} : { index: this.attributes['data-index'] };
      this.disabled = /\sdisabled(?:\s|$)/.test(attributes);
      this.hidden = /\shidden(?:\s|$)/.test(attributes);
      this.style = {};
      this.previousElementSibling = { style: {} };
      this.listeners = new Map();
      this.rows = [];
      this.textContent = '';
      this.clientWidth = 500;
      this.clientHeight = 300;
    }
    set innerHTML(markup) {
      if (this.rows.includes(document.activeElement)) document.activeElement = document.body;
      this.rows = [...markup.matchAll(/<tr\b([^>]*)>/g)]
        .filter((match) => /data-index=/.test(match[1]))
        .map((match) => Object.assign(new Element('tr', match[1]), { parentElement: this }));
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }
    querySelector(selector) {
      const index = selector.match(/data-index="(\d+)"/);
      if (index) return this.rows.find((row) => row.dataset.index === index[1]) || null;
      return selector.includes(':last-child') ? this.rows.at(-1) : this.rows[0];
    }
    closest(selector) {
      if (selector.includes('tr[data-index]')) return this.dataset.index === undefined ? null : this;
      if (selector.includes('input, select, textarea, button')) {
        return ['input', 'select', 'textarea', 'button', 'a', 'summary'].includes(this.tagName) ? this
          : this.parentElement?.closest(selector) || null;
      }
      return null;
    }
    focus() { document.activeElement = this; }
    click() { if (!this.disabled && !this.hidden) dispatch(this, 'click'); }
    appendChild() {}
    remove() {}
    getContext() {
      return new Proxy({}, { get: (_, key) => key === 'createRadialGradient'
        ? () => ({ addColorStop() {} }) : () => {} });
    }
  }

  const elements = new Map([...html.matchAll(/<(\w+)\b([^>]*\bid="[^"]+"[^>]*)>/g)]
    .map((match) => new Element(match[1], match[2])).map((element) => [element.id, element]));
  document.body = new Element('body');
  document.activeElement = document.body;
  document.querySelector = (selector) => elements.get(selector.slice(1));
  document.createElement = (tag) => new Element(tag);
  document.addEventListener = Element.prototype.addEventListener;
  function dispatch(target, type, properties = {}) {
    const event = { target, key: '', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...properties };
    let current = target;
    while (current) {
      (current.listeners.get(type) || []).forEach((listener) => listener(event));
      current = current === document ? null : current.parentElement || document;
    }
    return event;
  }
  let socket;
  class Socket extends Element {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() { super(); socket = this; this.readyState = Socket.CONNECTING; this.sent = []; }
    send(message) { this.sent.push(JSON.parse(message).action); }
    emit(type, data) {
      if (type === 'open') this.readyState = Socket.OPEN;
      if (type === 'close') this.readyState = 3;
      (this.listeners.get(type) || []).forEach((listener) => listener({ data }));
    }
  }
  const window = {
    location: { protocol: 'http:', host: 'localhost:8765' },
    setTimeout() { return 1; }, addEventListener() {},
  };
  runInNewContext(app.replace(/^import .*;\n/gm, ''), {
    ...analytics, StreamParser, StreamProtocolError, buildReconnectUrl,
    document, window, Element, WebSocket: Socket, Blob,
    URL: { createObjectURL(blob) { document.downloads.push(blob); return 'blob:csv'; }, revokeObjectURL() {} },
    console: { warn() {} },
  }, { filename: 'public/app.js' });
  const receive = (message) => socket.emit('message', JSON.stringify(message));
  if (connected) {
    socket.emit('open');
    receive(recording.metadata);
    if (frames) receive(recording.initial_snapshot);
    receive(recording.status);
  }
  return {
    document, socket, receive, elements,
    get: (id) => elements.get(id),
    row: (index) => elements.get('frames-body').querySelector(`tr[data-index="${index}"]`),
    key: (key, target = document.activeElement, options = {}) => dispatch(target, 'keydown', { key, ...options }),
    element: (tag) => new Element(tag),
  };
}

test('controls are named, shortcut help is visible, and status regions are live', () => {
  const controls = [...html.matchAll(/<(button|select)\b([^>]*)>/g)];
  assert.ok(controls.length > 0);
  for (const [, tag, attributes] of controls) {
    assert.ok(/aria-label="[^"]+"/.test(attributes), `unnamed ${tag}: ${attributes}`);
  }
  for (const id of ['connection-label', 'producer-status', 'diagnostics-status', 'status-announcer']) {
    assert.equal(dashboard({ connected: false }).get(id).getAttribute('aria-live'), 'polite', id);
  }
  assert.match(html, /<kbd>Space<\/kbd> pause\/resume/);
  for (const key of ['R', 'L', 'E']) assert.ok(html.includes(`<kbd>${key}</kbd>`));
});

test('frame Enter/Space selects one row without pausing and preserves focus during streaming', () => {
  const ui = dashboard();
  ui.row(0).focus();
  assert.equal(ui.key('Enter').defaultPrevented, true);
  assert.equal(ui.row(0).getAttribute('aria-selected'), 'true');
  assert.equal(ui.row(0).getAttribute('tabindex'), '0');
  assert.equal(ui.row(0).getAttribute('role'), null, 'keep native row semantics');
  assert.equal(ui.row(1).getAttribute('aria-selected'), 'false');
  assert.equal(ui.document.activeElement, ui.row(0));
  ui.receive(recording.frame_2);
  assert.equal(ui.document.activeElement, ui.row(0), 'incoming frames must not lose focus');
  ui.row(1).focus();
  ui.key(' ');
  assert.equal(ui.row(0).getAttribute('aria-selected'), 'false');
  assert.equal(ui.row(1).getAttribute('aria-selected'), 'true');
  assert.deepEqual(ui.socket.sent, [], 'Space on a row must not trigger pause');
  assert.match(ui.get('status-announcer').textContent, /Inspecting frame 1/);
});

test('Space toggles playback and native pause/resume controls keep useful focus', () => {
  const ui = dashboard();
  ui.key(' ');
  assert.deepEqual(ui.socket.sent, ['pause']);
  ui.get('pause-button').focus();
  ui.receive({ ...recording.status, status: 'paused', paused: true });
  assert.equal(ui.document.activeElement, ui.get('resume-button'));
  ui.document.body.focus();
  ui.key(' ');
  assert.deepEqual(ui.socket.sent, ['pause', 'resume']);
});

test('shortcuts leave text entry, native controls, modifiers, IME, and repeats alone', () => {
  const ui = dashboard();
  const targets = ['input', 'textarea', 'select', 'button', 'a', 'summary'].map((tag) => ui.element(tag));
  targets.push(Object.assign(ui.element('span'), { isContentEditable: true }));
  targets.push(Object.assign(ui.element('span'), { parentElement: ui.get('restart-button') }));
  for (const target of targets) {
    for (const key of [' ', 'r', 'l', 'e']) assert.equal(ui.key(key, target).defaultPrevented, false);
  }
  for (const option of ['ctrlKey', 'metaKey', 'altKey', 'repeat', 'isComposing', 'defaultPrevented']) {
    for (const key of [' ', 'r', 'l', 'e']) ui.key(key, ui.document.body, { [option]: true });
  }
  assert.deepEqual(ui.socket.sent, []);
  assert.equal(ui.document.downloads.length, 0);
});

test('R replays, L clears selection, and E exports all retained frames', async () => {
  const ui = dashboard();
  ui.key('Enter', ui.row(0));
  ui.key('L', ui.row(0));
  assert.equal(ui.row(0).getAttribute('aria-selected'), 'false');
  assert.equal(ui.get('return-live').hidden, true);
  ui.key('R', ui.document.body);
  assert.deepEqual(ui.socket.sent, ['restart']);
  ui.key('E', ui.document.body);
  assert.equal(ui.document.downloads.length, 1);
  const csv = await ui.document.downloads[0].text();
  assert.equal(csv.trim().split('\r\n').length, recording.initial_snapshot.frames.length + 1);
  assert.match(csv, /^schema_version,run_id,sequence,index,step,timestamp,time_fs,temperature_K,potential_energy_kj_mol,rmsd_angstrom,/);
  assert.match(csv, /,0,0,none,angstrom,femtosecond,kelvin,kilojoule_per_mole,/);
});

test('return-live activation restores row focus and unavailable actions stay disabled', () => {
  const ui = dashboard();
  ui.key('Enter', ui.row(0));
  ui.get('return-live').focus();
  ui.get('return-live').click();
  assert.equal(ui.document.activeElement, ui.row(0));
  assert.equal(ui.row(0).getAttribute('aria-selected'), 'false');
  const offline = dashboard({ connected: false });
  for (const key of [' ', 'r', 'e']) offline.key(key);
  assert.deepEqual(offline.socket.sent, []);
  assert.equal(offline.document.downloads.length, 0);
  const empty = dashboard({ frames: false });
  empty.key('e');
  assert.equal(empty.document.downloads.length, 0);
});

test('connection failures and rejected messages surface through live status regions', () => {
  const ui = dashboard();
  ui.receive({ type: 'invalid' });
  assert.equal(ui.get('connection-label').textContent, 'Invalid stream');
  assert.match(ui.get('status-announcer').textContent, /Diagnostic: invalid stream message/);
  ui.socket.emit('close');
  assert.equal(ui.get('connection-label').textContent, 'Disconnected');
  assert.equal(ui.get('producer-status').textContent, 'OFFLINE');
});
