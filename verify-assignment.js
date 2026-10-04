const fs = require('fs');
const html = fs.readFileSync('board.html', 'utf8');
const match = html.match(/<script>([\s\S]*)<\/script>/);
if (!match) throw new Error('No script found');

function makeElement(tag = 'div', id = '') {
  return {
    tagName: tag.toUpperCase(),
    id,
    value: '',
    checked: false,
    textContent: '',
    children: [],
    listeners: {},
    attributes: {},
    type: '',
    name: '',
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    setAttribute(k, v) {
      this.attributes[k] = v;
      if (k === 'type') this.type = v;
      if (k === 'name') this.name = v;
      if (k === 'value') this.value = String(v);
      if (k === 'class') this.className = v;
    },
    focus() { this.focused = true; },
    querySelector(sel) {
      const walk = (node) => {
        if (!node || !node.children) return null;
        for (const child of node.children) {
          if (child && child.name === 'newAssignee') {
            if (sel === 'input[name="newAssignee"]:checked' && child.checked) return child;
            if (sel === 'input[name="newAssignee"]') return child;
          }
          const sub = walk(child);
          if (sub) return sub;
        }
        return null;
      };
      return walk(this);
    }
  };
}

const elements = new Map();
const document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, makeElement('div', id));
    return elements.get(id);
  },
  createElement(tag) {
    return makeElement(tag);
  },
  createTextNode(text) { return { textContent: text }; }
};

global.document = document;
global.fetch = async (url, opts = {}) => {
  if (url === '/api/auth/status') {
    return { ok: true, json: async () => ({ setupRequired: false, user: { username: 'admin', role: 'admin', mustChangePassword: false } }) };
  }
  if (url === '/api/state') {
    return { ok: true, json: async () => ({ tasks: [], team: ['Accounts & Verification', 'Live Stream & Seller Support'] }) };
  }
  if (url === '/api/admin/users') {
    return { ok: true, json: async () => ({ users: [] }) };
  }
  global.lastPayload = JSON.parse(opts.body || '{}');
  return { ok: true, json: async () => ({}) };
};
global.setInterval = () => 0;

async function verify() {
  new Function(match[1])();
  await new Promise(resolve => setTimeout(resolve, 0));

  const choices = document.getElementById('assigneeChoices');
  const first = choices.querySelector('input[name="newAssignee"]');
  if (!first || !first.checked) throw new Error('No default assignee selected');

  document.getElementById('title').value = 'Test task';
  document.getElementById('customer').value = 'Jane';
  document.getElementById('details').value = 'Issue body';
  document.getElementById('add').listeners.click[0]();
  await new Promise(resolve => setTimeout(resolve, 0));

  if (!global.lastPayload || global.lastPayload.assignee !== 'Accounts & Verification') {
    throw new Error('Default assignee not applied: ' + JSON.stringify(global.lastPayload));
  }
  if ('chat' in global.lastPayload || 'source' in global.lastPayload) {
    throw new Error('Board-only task unexpectedly includes bot fields: ' + JSON.stringify(global.lastPayload));
  }

  console.log('default-assignee flow OK');
  console.log('payload assignee=', global.lastPayload.assignee);
}

verify().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
