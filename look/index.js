export const config = { runtime: "edge" };

const TARGET_BASE = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");

const STRIP_REQ_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "cf-connecting-ip",
  "cf-ray",
  "cf-visitor",
  "cdn-loop",
]);

const STRIP_RES_HEADERS = new Set([
  "x-vercel-id",
  "x-vercel-cache",
  "x-vercel-execution-region",
  "x-vercel-proxy-signature",
  "x-vercel-proxy-signature-ts",
  "x-powered-by",
  "server",
  "via",
  "alt-svc",
]);

export default async function handler(req) {
  if (!TARGET_BASE) {
    return new Response("Internal Server Error", { status: 500 });
  }

  try {
    const url = new URL(req.url);
    const targetUrl = TARGET_BASE + url.pathname + url.search;

    // --- build upstream request headers ---
    const reqHeaders = new Headers();
    let clientIp = null;

    for (const [k, v] of req.headers) {
      const lower = k.toLowerCase();
      if (STRIP_REQ_HEADERS.has(lower)) continue;
      if (lower.startsWith("x-vercel-")) continue;
      if (lower === "x-real-ip") { clientIp = v; continue; }
      if (lower === "x-forwarded-for") { if (!clientIp) clientIp = v; continue; }
      reqHeaders.set(k, v);
    }

    if (clientIp) reqHeaders.set("x-forwarded-for", clientIp);

    // set host to target so upstream sees correct Host header
    const targetHost = new URL(TARGET_BASE).host;
    reqHeaders.set("host", targetHost);

    // fix origin / referer to point at target
    const myOrigin = url.origin;
    for (const h of ["origin", "referer"]) {
      const val = reqHeaders.get(h);
      if (val) reqHeaders.set(h, val.replace(myOrigin, TARGET_BASE));
    }

    const method = req.method;
    const hasBody = method !== "GET" && method !== "HEAD";

    // --- fetch from upstream ---
    const upstream = await fetch(targetUrl, {
      method,
      headers: reqHeaders,
      body: hasBody ? req.body : undefined,
      duplex: "half",
      redirect: "manual",
    });

    // --- build downstream response headers ---
    const resHeaders = new Headers();
    for (const [k, v] of upstream.headers) {
      const lower = k.toLowerCase();
      if (STRIP_RES_HEADERS.has(lower)) continue;

      // rewrite location headers on redirects
      if (lower === "location") {
        resHeaders.set(k, v.replace(TARGET_BASE, myOrigin));
        continue;
      }

      // rewrite set-cookie domains
      if (lower === "set-cookie") {
        resHeaders.append(
          k,
          v.replace(
            new RegExp(`domain=${targetHost.replace(".", "\\.")}`, "gi"),
            `domain=${url.hostname}`
          )
        );
        continue;
      }

      resHeaders.append(k, v);
    }

    // mimic a normal origin server
    resHeaders.set("server", "nginx");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: resHeaders,
    });
  } catch {
    return new Response("Bad Gateway", { status: 502 });
  }
}