// A tiny multi-page "module" used to test recording and replay end to end:
// login -> dashboard -> new order form (text, select, checkbox) -> orders list.
import http from 'node:http';

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body><header><nav><a href="/dashboard">Dashboard</a> <a href="/orders">Orders</a></nav></header><main><h1>${title}</h1>${body}</main></body></html>`;

export function startFixtureSite(port = 0) {
  const orders = [];
  const customers = [];
  const bugs = { customerServerError: false };
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const customerForm = (msg = '', v = {}) => page('New customer', `${msg ? `<p role="alert" class="error">${esc(msg)}</p>` : ''}<form action="/customers/create" method="get">
        <label for="name">Full name</label><input id="name" name="name" value="${esc(v.name)}">
        <label for="cemail">Email</label><input id="cemail" name="email" type="email" value="${esc(v.email)}">
        <label for="phone">Mobile</label><input id="phone" name="phone" type="tel" value="${esc(v.phone)}">
        <label for="company">Company</label><input id="company" name="company" maxlength="40" value="${esc(v.company)}">
        <button type="submit">Save customer</button></form>`);
  const server = http.createServer((req, res) => {
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
    if (url.pathname === '/customers/new') return send(customerForm());
    if (url.pathname === '/customers/create') {
      const c = Object.fromEntries(['name', 'email', 'phone', 'company'].map((k) => [k, url.searchParams.get(k) || '']));
      if (bugs.customerServerError) return send(page('Server error', '<p>Something went wrong</p>'), 500);
      if (customers.some((x) => x.email.toLowerCase() === c.email.toLowerCase())) return send(customerForm('Email already registered', c));
      if (!/^\d{10}$/.test(c.phone.replace(/\D/g, '').slice(-10))) return send(customerForm('Enter a valid mobile number', c));
      customers.push(c);
      res.writeHead(302, { location: '/customers' }); return res.end();
    }
    if (url.pathname === '/customers') {
      return send(page('Customers', `<ul id="customers">${customers.map((c, i) => `<li><a href="/customers/${i}">${esc(c.name)}</a> · ${esc(c.email)} · ${esc(c.company)}</li>`).join('')}</ul>`));
    }
    if (url.pathname === '/orders') {
      return send(page('Orders', `<ul id="orders">${orders.map(o => `<li class="order">${o.customer} - ${o.plan}${o.rush ? ' - rush' : ''}</li>`).join('')}</ul>`));
    }
    send(page('Not found', ''), 404);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    resolve({ server, orders, customers, bugs, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) });
  }));
}

if (process.argv[1] && process.argv[1].endsWith('site.mjs')) {
  startFixtureSite(Number(process.argv[2] || 0)).then(s => console.log(s.url));
}
