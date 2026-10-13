/**
 * Proxy-aware upstream connection for the admission relay.
 *
 * The relay, not the native child, opens the upstream connection, and
 * `node:https` ignores proxy environment variables. On hosts where
 * api.anthropic.com is reachable only through a proxy (a region-blocked
 * egress answers `403 Request not allowed`), the relay must tunnel itself.
 *
 * Resolution follows the usual conventions: `https_proxy`/`HTTPS_PROXY`
 * (HTTP CONNECT), then `all_proxy`/`ALL_PROXY` (HTTP CONNECT or SOCKS5),
 * with `no_proxy`/`NO_PROXY` exclusions. Loopback targets never use a proxy.
 */
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

export interface ProxySpec {
  kind: "http" | "socks5";
  host: string;
  port: number;
  username?: string;
  password?: string;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name.toLowerCase()] ?? env[name.toUpperCase()];
  return value && value.trim() ? value.trim() : undefined;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);
}

/** True when `no_proxy` excludes `host` (exact, suffix, `.suffix`, or `*`). */
function excluded(host: string, env: NodeJS.ProcessEnv): boolean {
  const list = envValue(env, "no_proxy");
  if (!list) return false;
  const name = host.toLowerCase();
  return list.split(",").map((entry) => entry.trim().toLowerCase().replace(/:\d+$/, "")).some((entry) => {
    if (!entry) return false;
    if (entry === "*") return true;
    const suffix = entry.startsWith(".") ? entry : `.${entry}`;
    return name === entry.replace(/^\./, "") || name.endsWith(suffix);
  });
}

function parseProxy(value: string): ProxySpec | undefined {
  let url: URL;
  try {
    url = new URL(value.includes("://") ? value : `http://${value}`);
  } catch {
    return undefined;
  }
  const kind = url.protocol === "http:" ? "http" : /^socks5h?:$/.test(url.protocol) ? "socks5" : undefined;
  if (!kind || !url.hostname) return undefined;
  const port = Number(url.port || (kind === "http" ? 80 : 1080));
  return {
    kind,
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}

/** Proxy to use for an HTTPS upstream `host`, or undefined for a direct connection. */
export function resolveUpstreamProxy(host: string, env: NodeJS.ProcessEnv): ProxySpec | undefined {
  if (isLoopback(host) || excluded(host, env)) return undefined;
  for (const name of ["https_proxy", "all_proxy"]) {
    const value = envValue(env, name);
    if (value) return parseProxy(value);
  }
  return undefined;
}

function once(socket: Socket, timeoutMs: number, minBytes: number, until?: (data: Buffer) => boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error("Proxy handshake timed out")), timeoutMs);
    const onData = (chunk: Buffer): void => {
      data = Buffer.concat([data, chunk]);
      if (data.length >= minBytes && (!until || until(data))) finish();
    };
    const onError = (error: Error): void => finish(error);
    const onClose = (): void => finish(new Error("Proxy closed the connection during handshake"));
    function finish(error?: Error): void {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve(data);
    }
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function openSocket(proxy: ProxySpec, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: proxy.host, port: proxy.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Proxy ${proxy.host}:${proxy.port} connect timed out`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function httpConnect(socket: Socket, proxy: ProxySpec, host: string, port: number, timeoutMs: number): Promise<void> {
  const auth = proxy.username !== undefined
    ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ""}`).toString("base64")}\r\n`
    : "";
  const reply = once(socket, timeoutMs, 12, (data) => data.includes("\r\n\r\n"));
  socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
  const head = (await reply).toString("latin1");
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1];
  if (status !== "200") {
    throw new Error(`Proxy CONNECT to ${host}:${port} failed: ${head.split("\r\n")[0] ?? "no response"}`);
  }
}

async function socks5Connect(socket: Socket, proxy: ProxySpec, host: string, port: number, timeoutMs: number): Promise<void> {
  const useAuth = proxy.username !== undefined;
  let reply = once(socket, timeoutMs, 2);
  socket.write(Buffer.from(useAuth ? [5, 2, 0, 2] : [5, 1, 0]));
  const method = (await reply)[1];
  if (method === 2 && useAuth) {
    const user = Buffer.from(proxy.username ?? "");
    const pass = Buffer.from(proxy.password ?? "");
    reply = once(socket, timeoutMs, 2);
    socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
    if ((await reply)[1] !== 0) throw new Error("SOCKS5 proxy rejected the credentials");
  } else if (method !== 0) {
    throw new Error("SOCKS5 proxy offered no supported authentication method");
  }
  const name = Buffer.from(host);
  reply = once(socket, timeoutMs, 5, (data) => {
    const type = data[3];
    const addr = type === 1 ? 4 : type === 4 ? 16 : type === 3 ? 1 + (data[4] ?? 0) : 0;
    return data.length >= 6 + addr;
  });
  socket.write(Buffer.concat([
    Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([(port >> 8) & 0xff, port & 0xff]),
  ]));
  const code = (await reply)[1];
  if (code !== 0) throw new Error(`SOCKS5 connect to ${host}:${port} failed with code ${code}`);
}

/** Open a TLS connection to `host:port` through `proxy`. */
export async function openProxiedTls(proxy: ProxySpec, host: string, port: number, timeoutMs: number): Promise<TLSSocket> {
  const socket = await openSocket(proxy, timeoutMs);
  try {
    if (proxy.kind === "http") await httpConnect(socket, proxy, host, port, timeoutMs);
    else await socks5Connect(socket, proxy, host, port, timeoutMs);
  } catch (error) {
    socket.destroy();
    throw error;
  }
  return await new Promise<TLSSocket>((resolve, reject) => {
    const tls = tlsConnect({ socket, servername: host, ALPNProtocols: ["http/1.1"] }, () => resolve(tls));
    tls.once("error", reject);
  });
}

/** Proxy endpoint for logs and errors; never includes credentials. */
export function describeProxy(proxy: ProxySpec): string {
  return `${proxy.kind}://${proxy.host}:${proxy.port}`;
}
