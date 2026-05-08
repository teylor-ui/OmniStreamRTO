import { PassThrough, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

// Enable Node.js Streaming instead of Edge runtime!
export const config = {
  api: { bodyParser: false },
  supportsResponseStreaming: true,
};

// ─── Configuration ────────────────────────────────────────────────────────
const TARGET_BASE = (process.env.OMNI_CLUSTER_NODE || "").replace(/\/$/, "");
const RELAY_KEY = (process.env.OMNI_ACCESS_TOKEN || "").trim(); // Optional Auth

// Settings based on user request (10 users, 5MB/s)
const UPSTREAM_TIMEOUT_MS = 55000;  // 55 seconds
const MAX_INFLIGHT = 512;           // Safe concurrency for ~10 active users
const MAX_BPS = 5242880;            // 5 MB/s Throttling

// ─── Headers Configuration ────────────────────────────────────────────────
const STRIP_HEADERS = new Set([
  "host", "connection", "keep-alive", "via", "forwarded",
  "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port",
  "x-forwarded-for", "x-real-ip", "transfer-encoding"
]);
const PLATFORM_PREFIX = `x-${String.fromCharCode(118, 101, 114, 99, 101, 108)}-`;

let inFlight = 0;
const globalLimiter = createGlobalLimiter(MAX_BPS);

// ─── Main Handler ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (!TARGET_BASE) {
    res.statusCode = 500;
    return res.end("Missing TARGET_DOMAIN env var.");
  }

  // Basic Authorization (Optional)
  if (RELAY_KEY && req.headers["x-omni-token"] !== RELAY_KEY) {
    res.statusCode = 403;
    return res.end("Forbidden");
  }

  // Concurrency Check
  if (inFlight >= MAX_INFLIGHT) {
    res.statusCode = 503;
    res.setHeader("retry-after", "2");
    return res.end("Server Busy");
  }

  inFlight++;
  let slotAcquired = true;

  try {
    const url = new URL(req.url || "/", `https://${req.headers.host || "localhost"}`);
    const targetUrl = `${TARGET_BASE}${url.pathname}${url.search || ""}`;

    // Clean headers
    const headers = {};
    for (const key of Object.keys(req.headers)) {
      const lower = key.toLowerCase();
      if (STRIP_HEADERS.has(lower)) continue;
      if (lower.startsWith(PLATFORM_PREFIX)) continue;
      if (lower === "x-omni-token") continue;
      if (req.headers[key]) headers[lower] = req.headers[key];
    }

    // Preserve real client IP for upstream logs if needed
    const clientIp = req.headers["x-real-ip"] || req.headers["x-forwarded-for"];
    if (clientIp) headers["x-forwarded-for"] = clientIp;

    const abortCtrl = new AbortController();
    const timeoutRef = setTimeout(() => abortCtrl.abort("timeout"), UPSTREAM_TIMEOUT_MS);

    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    
    let fetchOpts = {
      method: req.method,
      headers,
      redirect: "manual",
      signal: abortCtrl.signal,
    };

    if (hasBody) {
      // Throttle upload stream
      const uploadStream = globalLimiter ? req.pipe(createThrottleTransform(globalLimiter)) : req;
      fetchOpts.body = Readable.toWeb(uploadStream);
      fetchOpts.duplex = "half";
    }

    // Fetch upstream
    const upstream = await fetch(targetUrl, fetchOpts);
    clearTimeout(timeoutRef);

    res.statusCode = upstream.status;
    for (const [key, value] of upstream.headers) {
      const k = key.toLowerCase();
      if (k === "transfer-encoding" || k === "connection") continue;
      try { res.setHeader(key, value); } catch (e) {}
    }

    if (!upstream.body) {
      return res.end();
    }

    // Throttle download stream and pipe to client
    const downloadNodeStream = Readable.fromWeb(upstream.body);
    const throttledDownload = globalLimiter ? downloadNodeStream.pipe(createThrottleTransform(globalLimiter)) : downloadNodeStream;
    
    await pipeline(throttledDownload, res);

  } catch (err) {
    if (err === "timeout" || err.name === "AbortError") {
      if (!res.headersSent) {
        res.statusCode = 504;
        res.end("Gateway Timeout");
      }
    } else {
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end("Bad Gateway");
      }
    }
  } finally {
    if (slotAcquired) {
      inFlight = Math.max(0, inFlight - 1);
    }
  }
}

// ─── Throttling Utilities ─────────────────────────────────────────────────
function createGlobalLimiter(bytesPerSecond) {
  if (!bytesPerSecond || bytesPerSecond <= 0) return null;
  const burstCap = Math.max(bytesPerSecond, 524288); // 500KB burst
  let tokens = burstCap;
  let lastRefill = Date.now();
  const queue = [];
  let timer = null;

  function tryDrain() {
    const now = Date.now();
    const elapsed = now - lastRefill;
    if (elapsed > 0) {
      tokens = Math.min(burstCap, tokens + (elapsed * bytesPerSecond) / 1000);
      lastRefill = now;
    }

    while (queue.length > 0 && tokens >= 1) {
      const item = queue[0];
      const grant = Math.min(item.maxBytes, Math.max(1, Math.floor(tokens)));
      if (grant < 1) break;
      tokens -= grant;
      queue.shift().resolve(grant);
    }
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      tryDrain();
      if (queue.length > 0) schedule();
    }, 10);
  }

  return {
    acquire(maxBytes) {
      const reqBytes = Math.max(1, Math.trunc(maxBytes));
      return new Promise((resolve) => {
        queue.push({ maxBytes: reqBytes, resolve });
        tryDrain();
        if (queue.length > 0) schedule();
      });
    }
  };
}

function createThrottleTransform(limiter) {
  return new Transform({
    transform(chunk, encoding, callback) {
      if (!chunk || chunk.length === 0) return callback();
      (async () => {
        let offset = 0;
        while (offset < chunk.length) {
          const grant = await limiter.acquire(chunk.length - offset);
          this.push(chunk.subarray(offset, offset + grant));
          offset += grant;
        }
      })().then(() => callback()).catch(callback);
    }
  });
}
