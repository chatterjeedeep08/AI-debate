const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:3001",
  "http://localhost:4173",
  "http://localhost:5173",
  "http://127.0.0.1:3001",
  "http://127.0.0.1:4173",
  "http://127.0.0.1:5173",
];

const DEFAULT_GLOBAL_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const DEFAULT_DEBATE_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_GLOBAL_RATE_LIMIT_IP_MAX = 60;
const DEFAULT_GLOBAL_RATE_LIMIT_USER_MAX = 180;
const DEFAULT_HEALTH_RATE_LIMIT_IP_MAX = 30;
const DEFAULT_DEBATE_RATE_LIMIT_IP_MAX = 4;
const DEFAULT_DEBATE_RATE_LIMIT_USER_MAX = 8;
const DEFAULT_DEBATE_MAX_IN_FLIGHT_IP = 2;
const DEFAULT_MAX_JSON_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_MULTIPART_BODY_BYTES = 24 * 1024 * 1024;

const RATE_LIMIT_RESPONSE = {
  error: "Too many requests. Please retry later.",
};

export class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.headers = headers;
  }
}

function parseBoolean(value, fallback = false) {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parsePositiveInteger(value, fallback) {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanOrigin(value) {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = new URL(value.trim());

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    return parsed.origin;
  } catch {
    return null;
  }
}

function parseAllowedOrigins(value) {
  const configured = typeof value === "string"
    ? value
        .split(",")
        .map((entry) => cleanOrigin(entry))
        .filter(Boolean)
    : [];

  return new Set(configured.length > 0 ? configured : DEFAULT_ALLOWED_ORIGINS);
}

function getCurrentWindow(now, windowMs) {
  return now - (now % windowMs);
}

function createFixedWindowStore(windowMs) {
  const entries = new Map();
  const cleanupInterval = setInterval(() => {
    const now = Date.now();

    for (const [key, entry] of entries.entries()) {
      if (entry.resetAt <= now) {
        entries.delete(key);
      }
    }
  }, Math.max(30_000, Math.min(windowMs, 5 * 60 * 1000)));

  cleanupInterval.unref?.();

  return {
    increment(key) {
      const now = Date.now();
      const resetAt = getCurrentWindow(now, windowMs) + windowMs;
      const current = entries.get(key);

      if (!current || current.resetAt <= now) {
        const next = {
          count: 1,
          resetAt,
        };

        entries.set(key, next);
        return next;
      }

      current.count += 1;
      return current;
    },
  };
}

function getForwardedIp(request) {
  const forwarded = request.headers["x-forwarded-for"];

  if (typeof forwarded !== "string") {
    return null;
  }

  const [candidate] = forwarded.split(",");
  return candidate?.trim() || null;
}

export function getAuthenticatedPrincipal(request) {
  const principal =
    request.auth?.userId ??
    request.user?.id ??
    request.user?.userId ??
    null;

  return typeof principal === "string" && principal.trim() ? principal.trim() : null;
}

export function getClientAddress(request) {
  const candidate =
    (typeof request.ip === "string" && request.ip.trim()) ||
    getForwardedIp(request) ||
    request.socket?.remoteAddress ||
    "unknown";

  return candidate.trim().toLowerCase();
}

function setRateLimitHeaders(response, { limit, remaining, resetAt }) {
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));

  response.setHeader("Retry-After", String(retryAfterSeconds));
  response.setHeader("RateLimit-Limit", String(limit));
  response.setHeader("RateLimit-Remaining", String(Math.max(0, remaining)));
  response.setHeader("RateLimit-Reset", String(Math.max(1, Math.ceil(resetAt / 1000))));

  return retryAfterSeconds;
}

export function createRateLimiter({
  windowMs,
  max,
  keyGenerator,
  skip,
  message = RATE_LIMIT_RESPONSE.error,
}) {
  const store = createFixedWindowStore(windowMs);

  return function rateLimiter(request, response, next) {
    if (skip?.(request)) {
      next();
      return;
    }

    const key = keyGenerator(request);

    if (!key) {
      next();
      return;
    }

    const entry = store.increment(key);
    const remaining = max - entry.count;

    if (entry.count > max) {
      const retryAfterSeconds = setRateLimitHeaders(response, {
        limit: max,
        remaining: 0,
        resetAt: entry.resetAt,
      });

      response.status(429).json({
        error: message,
        retryAfterSeconds,
      });
      return;
    }

    response.setHeader("RateLimit-Limit", String(max));
    response.setHeader("RateLimit-Remaining", String(Math.max(0, remaining)));
    response.setHeader("RateLimit-Reset", String(Math.max(1, Math.ceil(entry.resetAt / 1000))));
    next();
  };
}

export function createInFlightLimiter({
  max,
  keyGenerator,
  message = "Too many concurrent requests. Wait for the current request to finish.",
}) {
  const activeRequests = new Map();

  return function inFlightLimiter(request, response, next) {
    const key = keyGenerator(request);

    if (!key) {
      next();
      return;
    }

    const current = activeRequests.get(key) ?? 0;

    if (current >= max) {
      response.setHeader("Retry-After", "30");
      response.status(429).json({
        error: message,
        retryAfterSeconds: 30,
      });
      return;
    }

    activeRequests.set(key, current + 1);

    let released = false;
    const release = () => {
      if (released) {
        return;
      }

      released = true;
      const nextCount = (activeRequests.get(key) ?? 1) - 1;

      if (nextCount <= 0) {
        activeRequests.delete(key);
      } else {
        activeRequests.set(key, nextCount);
      }
    };

    response.on("close", release);
    response.on("finish", release);
    next();
  };
}

function buildCspValue() {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self'",
    "font-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob: https:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
  ].join("; ");
}

export function applySecurityHeaders(request, response, next) {
  if (request.path.startsWith("/api")) {
    response.setHeader("Cache-Control", "no-store");
  }

  response.setHeader("Content-Security-Policy", buildCspValue());
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  next();
}

export function buildCorsOptions() {
  const allowedOrigins = parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS);

  return {
    credentials: false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Accept", "Content-Type"],
    maxAge: 600,
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      const normalizedOrigin = cleanOrigin(origin);

      if (normalizedOrigin && allowedOrigins.has(normalizedOrigin)) {
        callback(null, true);
        return;
      }

      callback(new HttpError(403, "Origin is not allowed by CORS policy."));
    },
  };
}

export function enforceApiRequestShape(request, _response, next) {
  if (request.method === "OPTIONS" || !request.path.startsWith("/api")) {
    next();
    return;
  }

  if (request.method === "POST" && request.path === "/api/debates") {
    const isJson = request.is("application/json");
    const isMultipart = request.is("multipart/form-data");

    if (!isJson && !isMultipart) {
      next(new HttpError(415, "Use application/json or multipart/form-data for debate requests."));
      return;
    }

    const maxBytes = isMultipart
      ? DEFAULT_MAX_MULTIPART_BODY_BYTES
      : DEFAULT_MAX_JSON_BODY_BYTES;
    const contentLength = Number(request.headers["content-length"]);

    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      next(new HttpError(413, "Request payload is too large."));
      return;
    }
  }

  next();
}

export function buildSecurityConfig() {
  return {
    trustProxy: parseBoolean(process.env.TRUST_PROXY, false),
    maxJsonBodyBytes: parsePositiveInteger(
      process.env.MAX_JSON_BODY_BYTES,
      DEFAULT_MAX_JSON_BODY_BYTES,
    ),
    globalRateLimitWindowMs: parsePositiveInteger(
      process.env.API_GLOBAL_RATE_LIMIT_WINDOW_MS,
      DEFAULT_GLOBAL_RATE_LIMIT_WINDOW_MS,
    ),
    debateRateLimitWindowMs: parsePositiveInteger(
      process.env.DEBATE_RATE_LIMIT_WINDOW_MS,
      DEFAULT_DEBATE_RATE_LIMIT_WINDOW_MS,
    ),
    globalRateLimitIpMax: parsePositiveInteger(
      process.env.API_GLOBAL_RATE_LIMIT_IP_MAX,
      DEFAULT_GLOBAL_RATE_LIMIT_IP_MAX,
    ),
    globalRateLimitUserMax: parsePositiveInteger(
      process.env.API_GLOBAL_RATE_LIMIT_USER_MAX,
      DEFAULT_GLOBAL_RATE_LIMIT_USER_MAX,
    ),
    healthRateLimitIpMax: parsePositiveInteger(
      process.env.API_HEALTH_RATE_LIMIT_IP_MAX,
      DEFAULT_HEALTH_RATE_LIMIT_IP_MAX,
    ),
    debateRateLimitIpMax: parsePositiveInteger(
      process.env.DEBATE_RATE_LIMIT_IP_MAX,
      DEFAULT_DEBATE_RATE_LIMIT_IP_MAX,
    ),
    debateRateLimitUserMax: parsePositiveInteger(
      process.env.DEBATE_RATE_LIMIT_USER_MAX,
      DEFAULT_DEBATE_RATE_LIMIT_USER_MAX,
    ),
    debateRateLimitMaxInFlightIp: parsePositiveInteger(
      process.env.DEBATE_MAX_IN_FLIGHT_IP,
      DEFAULT_DEBATE_MAX_IN_FLIGHT_IP,
    ),
  };
}
