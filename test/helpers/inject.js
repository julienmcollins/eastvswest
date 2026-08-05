import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

/**
 * Drive an http handler without opening a socket.
 *
 * This is the PRIMARY test harness, not a convenience: `server.listen(0, '127.0.0.1')`
 * fails with EPERM in the sandbox this project is developed in, so any test that binds a
 * port cannot run here. Injecting straight into the `(req, res)` handler tests the same
 * code path with no network at all, and is faster besides.
 *
 * @param {(req:IncomingMessage,res:ServerResponse)=>any} handler
 * @param {{method?:string,url?:string,headers?:Record<string,string>,body?:any,cookies?:Record<string,string>}} opts
 * @returns {Promise<{status:number,headers:Record<string,string|string[]>,body:string,json:any,cookies:Record<string,string>,setCookie:string[]}>}
 */
export function injectRequest(handler, opts = {}) {
  const { method = 'GET', url = '/', body } = opts;
  const headers = { host: 'localhost:3000', ...lower(opts.headers ?? {}) };

  let payload;
  if (body !== undefined) {
    payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    if (!headers['content-type']) headers['content-type'] = 'application/json';
    // Deliberately NOT forced to match payload length: some tests send a lying
    // Content-Length on purpose, which is the actual attack the body cap defends against.
    if (!('content-length' in headers)) headers['content-length'] = String(Buffer.byteLength(payload));
  }

  if (opts.cookies && Object.keys(opts.cookies).length > 0) {
    headers.cookie = Object.entries(opts.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = method.toUpperCase();
  req.url = url;
  req.headers = headers;
  req.httpVersion = '1.1';
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;

  const res = new ServerResponse(req);
  const chunks = [];
  let finished = false;

  // ServerResponse writes a raw HTTP wire format through assignSocket; capturing the
  // stream writes directly and parsing off the status line is simpler and avoids needing
  // a real socket at all.
  res.assignSocket(
    Object.assign(new Socket(), {
      writable: true,
      write(chunk, _enc, cb) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        if (cb) cb();
        return true;
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        finished = true;
      },
      cork() {},
      uncork() {},
      destroy() {
        finished = true;
      },
    }),
  );

  return new Promise((resolve, reject) => {
    const settle = () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      resolve(parseWire(raw, res));
    };

    res.on('finish', () => setImmediate(settle));
    res.on('close', () => {
      if (!res.writableFinished) setImmediate(settle);
    });

    let ret;
    try {
      ret = handler(req, res);
    } catch (err) {
      reject(err);
      return;
    }
    Promise.resolve(ret).catch(reject);

    // Feed the body only after the handler has attached its listeners.
    setImmediate(() => {
      if (payload !== undefined) req.push(payload);
      req.push(null);
    });

    void finished;
  });
}

function parseWire(raw, res) {
  const split = raw.indexOf('\r\n\r\n');
  const head = split === -1 ? raw : raw.slice(0, split);
  let bodyText = split === -1 ? '' : raw.slice(split + 4);

  const lines = head.split('\r\n');
  const statusLine = lines.shift() ?? '';
  const status = Number(statusLine.split(' ')[1]) || res.statusCode;

  const headers = {};
  const setCookie = [];
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (k === 'set-cookie') setCookie.push(v);
    else if (k in headers) headers[k] = [].concat(headers[k], v);
    else headers[k] = v;
  }
  if (setCookie.length) headers['set-cookie'] = setCookie;

  // Strip chunked-transfer framing so assertions can look at the payload directly.
  if (String(headers['transfer-encoding'] ?? '').includes('chunked')) {
    bodyText = dechunk(bodyText);
  }

  let json;
  try {
    json = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    json = undefined;
  }

  const cookies = {};
  for (const c of setCookie) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }

  return { status, headers, body: bodyText, json, cookies, setCookie };
}

function dechunk(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const nl = s.indexOf('\r\n', i);
    if (nl === -1) break;
    const size = parseInt(s.slice(i, nl), 16);
    if (!Number.isFinite(size) || size === 0) break;
    out += s.slice(nl + 2, nl + 2 + size);
    i = nl + 2 + size + 2;
  }
  return out;
}

function lower(o) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), String(v)]));
}

/** Read one attribute off a Set-Cookie line, e.g. attrOf(line, 'Max-Age'). */
export function attrOf(setCookieLine, attr) {
  const m = new RegExp(`(?:^|;\\s*)${attr}(?:=([^;]*))?`, 'i').exec(setCookieLine);
  if (!m) return null;
  return m[1] === undefined ? true : m[1];
}
