export const config = { runtime: "edge" };

const TARGET_BASE = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");

const STRIP_HEADERS = new Set([
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
]);

function rewriteSetCookie(headers) {
  const cookies = headers.getSetCookie?.() || [];
  if (!cookies.length) return;
  headers.delete("set-cookie");
  for (const c of cookies) {
    headers.append(
      "set-cookie",
      c
        .replace(/;\s*Domain=[^;]+/gi, "")
        .replace(/;\s*SameSite=None/gi, "; SameSite=Lax")
    );
  }
}

function rewriteLocation(headers, targetBase) {
  const location = headers.get("location");
  if (!location) return;
  // اگه Location با آدرس upstream شروع میشه، تبدیلش کن به path نسبی
  if (location.startsWith(targetBase)) {
    headers.set("location", location.slice(targetBase.length) || "/");
  }
}

export default async function handler(req) {
  if (!TARGET_BASE) {
    return new Response("Misconfigured: TARGET_DOMAIN is not set", { status: 500 });
  }

  try {
    const incoming = new URL(req.url);
    const targetUrl = TARGET_BASE + incoming.pathname + incoming.search;

    const out = new Headers();
    let clientIp = null;

    for (const [k, v] of req.headers) {
      if (STRIP_HEADERS.has(k)) continue;
      if (k.startsWith("x-vercel-")) continue;
      if (k === "x-real-ip") {
        clientIp = v;
        continue;
      }
      if (k === "x-forwarded-for") {
        if (!clientIp) clientIp = v;
        continue;
      }
      out.set(k, v);
    }

    // ست کردن host درست برای upstream
    out.set("host", new URL(TARGET_BASE).host);

    if (clientIp) out.set("x-forwarded-for", clientIp);

    const method = req.method;
    const hasBody = method !== "GET" && method !== "HEAD";

    // fetchOptions بدون duplex اول امتحان میشه، اگه لازم بود اضافه میشه
    const fetchOptions = {
      method,
      headers: out,
      body: hasBody ? req.body : undefined,
      redirect: "manual",
    };

    // duplex فقط وقتی body داریم لازمه
    if (hasBody) fetchOptions.duplex = "half";

    const upstream = await fetch(targetUrl, fetchOptions);

    const resHeaders = new Headers(upstream.headers);
    rewriteSetCookie(resHeaders);
    rewriteLocation(resHeaders, TARGET_BASE);

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: resHeaders,
    });
  } catch (err) {
    console.error("relay error:", err);
    return new Response("NoGoTrue!!!", { status: 502 });
  }
}