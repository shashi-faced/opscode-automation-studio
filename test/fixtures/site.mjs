// A tiny multi-page "module" used to test recording and replay end to end:
// login -> dashboard -> new order form (text, select, checkbox) -> orders list.
import http from 'node:http';

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body><header><nav><a href="/dashboard">Dashboard</a> <a href="/orders">Orders</a> <a href="/customers">Customers</a> <a href="/notes">Notes</a></nav></header><main><h1>${title}</h1>${body}</main></body></html>`;

export function startFixtureSite(port = 0) {
  const orders = [];
  const customers = [];
  const bugs = { customerServerError: false, notesApiError: false, acceptsBadPhone: false, unescapedNames: false };
  const notes = [];
  const uploads = [];
  const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const customerForm = (msg = '', v = {}) => page('New customer', `${msg ? `<p role="alert" class="error">${esc(msg)}</p>` : ''}<form action="/customers/create" method="get">
        <label for="name">Full name</label><input id="name" name="name" value="${esc(v.name)}">
        <label for="cemail">Email</label><input id="cemail" name="email" type="email" value="${esc(v.email)}">
        <label for="phone">Mobile</label><input id="phone" name="phone" type="tel" value="${esc(v.phone)}">
        <label for="company">Company</label><input id="company" name="company" maxlength="40" value="${esc(v.company)}">
        <button type="submit">Save customer</button></form>`);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (html, code = 200) => { res.writeHead(code, { 'content-type': 'text/html' }); res.end(html); };
    if (url.pathname === '/' || url.pathname === '/login') {
      return send(page('Sign in', `<form action="/session" method="get">
        <label for="email">Email</label><input id="email" name="email" type="email">
        <label for="password">Password</label><input id="password" name="password" type="password">
        <button type="submit" data-testid="login-submit">Sign in</button></form>`));
    }
    if (url.pathname === '/session') {
      if (url.searchParams.get('password') !== 'secret') return send(page('Sign in failed', '<p id="error">Wrong password</p><a href="/login">Try again</a>'));
      res.writeHead(302, { location: '/dashboard' }); return res.end();
    }
    if (url.pathname === '/dashboard') {
      return send(page('Dashboard', `<p>Welcome back.</p><a href="/orders/new" role="button" aria-label="New order">+ New order</a>`));
    }
    if (url.pathname === '/orders/new') {
      return send(page('New order', `<form action="/orders/create" method="get">
        <label for="customer">Customer</label><input id="customer" name="customer">
        <label for="plan">Plan</label><select id="plan" name="plan"><option value="basic">Basic</option><option value="pro">Pro</option></select>
        <label><input type="checkbox" id="rush" name="rush"> Rush delivery</label>
        <button type="submit">Create order</button></form>`));
    }
    if (url.pathname === '/orders/create') {
      orders.push({ customer: url.searchParams.get('customer'), plan: url.searchParams.get('plan'), rush: !!url.searchParams.get('rush') });
      res.writeHead(302, { location: '/orders' }); return res.end();
    }
    // --- SPA notes: fetch POST / DELETE (server checks, extract, confirm dialog)
    if (url.pathname === '/notes') {
      return send(page('Notes', `<form id="nf"><label for="title">Title</label><input id="title" name="title" required>
        <label for="body">Text</label><textarea id="body" name="body"></textarea><button type="submit">Save note</button></form>
        <p id="status" role="status"></p><ul id="notes"></ul>
        <script>
          const list = document.getElementById('notes');
          const render = (n) => { const li = document.createElement('li'); li.id = 'note-' + n.id; li.textContent = n.title + ' '; const b = document.createElement('button'); b.textContent = 'Delete ' + n.title; b.onclick = async () => { if (!confirm('Delete note ' + n.title + '?')) return; const r = await fetch('/api/notes/' + n.id, { method: 'DELETE' }); if (r.ok) { li.remove(); document.getElementById('status').textContent = 'Deleted note #' + n.id; } }; li.appendChild(b); list.appendChild(li); };
          document.getElementById('nf').onsubmit = async (e) => { e.preventDefault(); const r = await fetch('/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: title.value, body: body.value }) });
            if (!r.ok) { document.getElementById('status').textContent = 'Could not save (' + r.status + ')'; return; } const n = await r.json(); render(n); document.getElementById('status').textContent = 'Saved note #' + n.id + ': ' + n.title; };
        </script>`));
    }
    if (url.pathname === '/api/notes' && req.method === 'POST') {
      const body = JSON.parse(String(await readBody(req)) || '{}');
      if (bugs.notesApiError) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":"db down"}'); }
      const n = { id: 100 + notes.length + 1, title: body.title || '', body: body.body || '' };
      notes.push(n);
      res.writeHead(201, { 'content-type': 'application/json' }); return res.end(JSON.stringify(n));
    }
    if (/^\/api\/notes\/\d+$/.test(url.pathname) && req.method === 'DELETE') {
      const id = Number(url.pathname.split('/').pop());
      const i = notes.findIndex((n) => n.id === id);
      if (i >= 0) notes.splice(i, 1);
      res.writeHead(i >= 0 ? 204 : 404); return res.end();
    }
    if (/^\/api\/notes\/\d+$/.test(url.pathname)) {
      const n = notes.find((x) => x.id === Number(url.pathname.split('/').pop()));
      return send(page(n ? 'Note' : 'No note', n ? `<h2 id="note-title">${esc(n.title)}</h2>` : '<p>Not found</p>'), n ? 200 : 404);
    }
    // --- upload, drag and drop, hover menu, iframe
    if (url.pathname === '/upload') {
      return send(page('Upload', `<label for="file">Attachment</label><input id="file" type="file" name="file"><button id="up">Upload</button><p id="result"></p>
        <script>document.getElementById('up').onclick = async () => { const f = document.getElementById('file').files[0]; if (!f) return; const r = await fetch('/api/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f }); const j = await r.json(); document.getElementById('result').textContent = 'Uploaded ' + j.name + ' (' + j.size + ' bytes)'; };</script>`));
    }
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      const buf = await readBody(req);
      uploads.push({ name: url.searchParams.get('name'), size: buf.length });
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(uploads[uploads.length - 1]));
    }
    if (url.pathname === '/board') {
      return send(page('Board', `<style>.col{display:inline-block;width:200px;min-height:120px;border:1px solid #999;margin:8px;vertical-align:top}.card{padding:6px;margin:6px;background:#eef}</style>
        <div class="col" id="todo"><h3>Todo</h3><div class="card" draggable="true" id="task-a">Task A</div></div>
        <div class="col" id="done"><h3>Done</h3></div><p id="moved"></p>
        <script>
          document.querySelectorAll('.card').forEach((c) => c.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', c.id)));
          const done = document.getElementById('done');
          done.addEventListener('dragover', (e) => e.preventDefault());
          done.addEventListener('drop', (e) => { e.preventDefault(); const c = document.getElementById(e.dataTransfer.getData('text/plain')); if (c) { done.appendChild(c); document.getElementById('moved').textContent = 'Done: ' + c.textContent; } });
        </script>`));
    }
    if (url.pathname === '/menu') {
      return send(page('Menu', `<style>.sub{display:none}.menu:hover .sub{display:block}</style><div class="menu"><span id="more">More ▾</span><div class="sub"><a href="/reports">Reports</a></div></div>`));
    }
    if (url.pathname === '/reports') return send(page('Reports', '<p>Monthly report</p>'));
    if (url.pathname === '/widget') {
      return send(page('Checkout', `<iframe id="pay" name="pay" src="/frame-form" style="width:420px;height:160px"></iframe>`));
    }
    if (url.pathname === '/frame-form') {
      return send(`<!doctype html><html><body><label for="card">Name on card</label><input id="card"><button id="paybtn">Pay</button><p id="paid"></p>
        <script>document.getElementById('paybtn').onclick = () => { document.getElementById('paid').textContent = 'Paid by ' + document.getElementById('card').value; };</script></body></html>`);
    }
    if (url.pathname === '/customers/new') return send(customerForm());
    if (url.pathname === '/customers/create') {
      const c = Object.fromEntries(['name', 'email', 'phone', 'company'].map((k) => [k, url.searchParams.get(k) || '']));
      if (bugs.customerServerError) return send(page('Server error', '<p>Something went wrong</p>'), 500);
      if (customers.some((x) => x.email.toLowerCase() === c.email.toLowerCase())) return send(customerForm('Email already registered', c));
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) return send(customerForm('Enter a valid email', c));
      if (!c.name.trim()) return send(customerForm('Name is required', c));
      if (!bugs.acceptsBadPhone && !/^\d{10}$/.test(c.phone.replace(/\D/g, ''))) return send(customerForm('Enter a valid mobile number', c));
      customers.push(c);
      res.writeHead(302, { location: '/customers' }); return res.end();
    }
    if (url.pathname === '/customers') {
      const show = (v) => (bugs.unescapedNames ? v : esc(v));
      return send(page('Customers', `<a href="/customers/new">New customer</a> <a href="/customers/remove">Remove a customer</a><ul id="customers">${customers.map((c, i) => `<li><a href="/customers/${i}">${show(c.name)}</a> · ${esc(c.email)} · ${esc(c.company)}</li>`).join('')}</ul>`));
    }
    if (url.pathname === '/customers/remove') {
      return send(page('Remove customer', `<form action="/customers/remove/do" method="get"><label for="remail">Email</label><input id="remail" name="email"><button type="submit">Remove</button></form>`));
    }
    if (url.pathname === '/customers/remove/do') {
      const i = customers.findIndex((c) => c.email === url.searchParams.get('email'));
      if (i >= 0) customers.splice(i, 1);
      res.writeHead(302, { location: '/customers' }); return res.end();
    }
    if (url.pathname === '/api/customers' && req.method === 'DELETE') {
      const i = customers.findIndex((c) => c.email === url.searchParams.get('email'));
      if (i >= 0) customers.splice(i, 1);
      res.writeHead(i >= 0 ? 204 : 404); return res.end();
    }
    if (url.pathname === '/orders') {
      return send(page('Orders', `<ul id="orders">${orders.map(o => `<li class="order">${o.customer} - ${o.plan}${o.rush ? ' - rush' : ''}</li>`).join('')}</ul>`));
    }
    send(page('Not found', ''), 404);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    resolve({ server, orders, customers, notes, uploads, bugs, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) });
  }));
}

if (process.argv[1] && process.argv[1].endsWith('site.mjs')) {
  startFixtureSite(Number(process.argv[2] || 0)).then(s => console.log(s.url));
}
