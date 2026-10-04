// Support board. No installs needed beyond Node 18+.
// Run:  node server.js     Then open http://localhost:3000
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = Number(process.env.PORT || 3000);
const SESSION_MS = 12 * 60 * 60 * 1000;

const FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
let db = { tasks: [], team: [], owners: {}, users: [] };
if (fs.existsSync(FILE)) {
  db = Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8')));
  if (!Array.isArray(db.tasks)) throw new Error('data.json must contain a tasks array');
}
if (!Array.isArray(db.users)) db.users = [];
db.users.forEach(user => { if (user.role === 'member') user.role = 'user'; });
// Old category names -> the new team names
const MAP = { 'Account': 'Accounts & Verification', 'Live stream & selling': 'Live Stream & Seller Support', 'Buying & checkout': 'Orders & Delivery', 'Orders & delivery': 'Orders & Delivery', 'Refunds & returns': 'Payments & Refunds', 'Payments & payouts': 'Payments & Refunds', 'App bug / technical': 'Technical Support', 'Other': 'General / Other' };
db.tasks.forEach(t => { if (MAP[t.category]) t.category = MAP[t.category]; });
db.tasks.forEach(t => { delete t.chat; delete t.source; delete t.newMsg; });
delete db.offset;
db.owners = Object.fromEntries(Object.entries(db.owners || {}).map(([k, v]) => [MAP[k] || k, v]));
const save = () => fs.writeFileSync(FILE, JSON.stringify(db, null, 1));
save();

const sessions = new Map();
const body = req => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', chunk => {
    s += chunk;
    if (s.length > 1024 * 1024) {
      reject(new Error('Request body is too large'));
      req.destroy();
    }
  });
  req.on('end', () => {
    try { resolve(JSON.parse(s || '{}')); }
    catch (e) { reject(new Error('Request body must be valid JSON')); }
  });
  req.on('error', reject);
});
const send = (res, code, obj, headers = {}) => {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers));
  res.end(JSON.stringify(obj));
};
const normalizeUsername = value => String(value || '').trim().toLowerCase();
const publicUser = user => ({ username: user.username, role: user.role, mustChangePassword: user.mustChangePassword });
const passwordHash = (password, salt = crypto.randomBytes(16).toString('hex')) => ({
  salt,
  hash: crypto.scryptSync(password, salt, 64).toString('hex')
});
const passwordMatches = (password, user) => {
  const actual = crypto.scryptSync(password, user.salt, 64);
  const expected = Buffer.from(user.hash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};
const cookieValue = req => {
  const item = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('taskboard_session='));
  return item ? item.slice('taskboard_session='.length) : '';
};
const setSession = (res, user) => {
  const id = crypto.randomBytes(32).toString('hex');
  sessions.set(id, { userId: user.id, expiresAt: Date.now() + SESSION_MS });
  res.setHeader('Set-Cookie', `taskboard_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
};
const clearSession = (req, res) => {
  sessions.delete(cookieValue(req));
  res.setHeader('Set-Cookie', 'taskboard_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
};
const getSessionUser = req => {
  const id = cookieValue(req);
  const session = sessions.get(id);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  return db.users.find(user => user.id === session.userId) || null;
};
const validPassword = password => typeof password === 'string' && password.length >= 8 && password.length <= 256;
const validUsername = username => /^[a-z0-9._-]{3,32}$/.test(username);
const unauthorized = res => send(res, 401, { error: 'Sign in required' });

http.createServer(async (req, res) => {
  try {
    const url = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'board.html')));
    }

    if (req.method === 'GET' && url === '/api/auth/status') {
      const user = getSessionUser(req);
      return send(res, 200, { setupRequired: db.users.length === 0, user: user ? publicUser(user) : null });
    }
    if (req.method === 'POST' && url === '/api/auth/setup') {
      if (db.users.length !== 0) return send(res, 409, { error: 'Admin setup has already been completed' });
      const input = await body(req);
      if (db.users.length !== 0) return send(res, 409, { error: 'Admin setup has already been completed' });
      const username = normalizeUsername(input.username);
      if (!validUsername(username)) return send(res, 400, { error: 'Username must be 3-32 characters: letters, numbers, dot, underscore, or hyphen' });
      if (!validPassword(input.password)) return send(res, 400, { error: 'Password must be between 8 and 256 characters' });
      const credentials = passwordHash(input.password);
      const user = { id: crypto.randomUUID(), username, role: 'admin', mustChangePassword: false, ...credentials };
      db.users.push(user);
      save();
      return send(res, 201, { username: user.username });
    }
    if (req.method === 'POST' && url === '/api/auth/login') {
      const input = await body(req);
      const username = normalizeUsername(input.username);
      const user = db.users.find(item => item.username === username);
      if (!user || typeof input.password !== 'string' || input.password.length > 256 || !passwordMatches(input.password, user)) {
        return send(res, 401, { error: 'Invalid username or password' });
      }
      setSession(res, user);
      return send(res, 200, { user: publicUser(user) });
    }
    if (req.method === 'POST' && url === '/api/auth/register') {
      const input = await body(req);
      const username = normalizeUsername(input.username);
      if (!validUsername(username)) {
        return send(res, 400, { error: 'Username must be 3-32 characters: letters, numbers, dot, underscore, or hyphen' });
      }
      if (!validPassword(input.password)) {
        return send(res, 400, { error: 'Password must be between 8 and 256 characters' });
      }
      if (db.users.some(item => item.username === username)) {
        return send(res, 409, { error: 'That username is already in use' });
      }
      const credentials = passwordHash(input.password);
      const user = { id: crypto.randomUUID(), username, role: 'user', mustChangePassword: false, ...credentials };
      db.users.push(user);
      save();
      return send(res, 201, { username: user.username });
    }
    if (req.method === 'POST' && url === '/api/auth/logout') {
      clearSession(req, res);
      return send(res, 200, {});
    }

    const user = getSessionUser(req);
    if (!user) return unauthorized(res);

    if (req.method === 'POST' && url === '/api/auth/password') {
      const input = await body(req);
      if (!validPassword(input.newPassword)) return send(res, 400, { error: 'Password must be between 8 and 256 characters' });
      if (!user.mustChangePassword && (typeof input.currentPassword !== 'string' || input.currentPassword.length > 256 || !passwordMatches(input.currentPassword, user))) {
        return send(res, 401, { error: 'Current password is incorrect' });
      }
      Object.assign(user, passwordHash(input.newPassword), { mustChangePassword: false });
      const activeSession = cookieValue(req);
      for (const [id, session] of sessions) {
        if (session.userId === user.id && id !== activeSession) sessions.delete(id);
      }
      save();
      return send(res, 200, { user: publicUser(user) });
    }

    if (url.startsWith('/api/') && user.mustChangePassword && !(req.method === 'GET' && url === '/api/auth/status')) {
      return send(res, 403, { error: 'Change your temporary password before continuing' });
    }
    if (req.method === 'GET' && url === '/api/state') return send(res, 200, { tasks: db.tasks, team: db.team, owners: db.owners, user: publicUser(user) });
    if (req.method === 'POST' && url === '/api/tasks') {
      const t = await body(req); if (!t.id) return send(res, 400, { error: 'Task id is required' });
      const i = db.tasks.findIndex(x => x.id === t.id);
      if (i >= 0) ['title', 'customer', 'phone', 'email', 'userType', 'category', 'priority', 'assignee', 'status', 'newMsg', 'details'].forEach(k => { if (k in t) db.tasks[i][k] = t[k]; }); else db.tasks.push(t);
      save(); return send(res, 200, {});
    }
    if (req.method === 'POST' && url === '/api/delete') { const b = await body(req); db.tasks = db.tasks.filter(x => x.id !== b.id); save(); return send(res, 200, {}); }
    if (req.method === 'POST' && url === '/api/team') {
      if (user.role !== 'admin') return send(res, 403, { error: 'Admin access required' });
      const b = await body(req); db.team = Array.isArray(b.names) ? b.names : []; db.owners = b.owners || {}; save(); return send(res, 200, {});
    }
    send(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error('Request failed:', error);
    if (!res.headersSent) send(res, 400, { error: error.message || 'Request failed' });
    else res.destroy();
  }
}).listen(PORT, '0.0.0.0', () => console.log('Board running on port ' + PORT));