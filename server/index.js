import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import { runDebate } from "./debateOrchestrator.js";
import {
  formatUploadError,
  hydrateDebatePayload,
  parseDebatePayload,
  upload,
  validateDebatePayload,
} from "./fileIngestion.js";
import {
  HttpError,
  applySecurityHeaders,
  buildCorsOptions,
  buildSecurityConfig,
  createInFlightLimiter,
  createRateLimiter,
  enforceApiRequestShape,
  getAuthenticatedPrincipal,
  getClientAddress,
} from "./security.js";

dotenv.config();

const app = express();
const securityConfig = buildSecurityConfig();
const port = Number(process.env.PORT || 3001);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, "../dist");
const corsOptions = buildCorsOptions();
const skipAnonymousUsers = (request) => !getAuthenticatedPrincipal(request);

const apiIpLimiter = createRateLimiter({
  windowMs: securityConfig.globalRateLimitWindowMs,
  max: securityConfig.globalRateLimitIpMax,
  keyGenerator: getClientAddress,
  message: "Too many API requests from this IP address. Please retry shortly.",
});

const apiUserLimiter = createRateLimiter({
  windowMs: securityConfig.globalRateLimitWindowMs,
  max: securityConfig.globalRateLimitUserMax,
  keyGenerator: getAuthenticatedPrincipal,
  skip: skipAnonymousUsers,
  message: "Too many API requests for this user. Please retry shortly.",
});

const healthIpLimiter = createRateLimiter({
  windowMs: securityConfig.globalRateLimitWindowMs,
  max: securityConfig.healthRateLimitIpMax,
  keyGenerator: getClientAddress,
  message: "Health checks are being called too frequently. Please retry shortly.",
});

const debateIpLimiter = createRateLimiter({
  windowMs: securityConfig.debateRateLimitWindowMs,
  max: securityConfig.debateRateLimitIpMax,
  keyGenerator: getClientAddress,
  message: "Too many debate runs requested from this IP address. Please wait before starting another debate.",
});

const debateUserLimiter = createRateLimiter({
  windowMs: securityConfig.debateRateLimitWindowMs,
  max: securityConfig.debateRateLimitUserMax,
  keyGenerator: getAuthenticatedPrincipal,
  skip: skipAnonymousUsers,
  message: "Too many debate runs requested for this user. Please wait before starting another debate.",
});

const debateInFlightLimiter = createInFlightLimiter({
  max: securityConfig.debateRateLimitMaxInFlightIp,
  keyGenerator: getClientAddress,
  message: "Too many debate runs are already in progress for this IP address. Wait for an active request to finish.",
});

app.disable("x-powered-by");

if (securityConfig.trustProxy) {
  app.set("trust proxy", 1);
}

app.use(applySecurityHeaders);
app.use("/api", cors(corsOptions));
app.options("/api/*", cors(corsOptions));
app.use(enforceApiRequestShape);
app.use(
  "/api",
  express.json({
    limit: `${securityConfig.maxJsonBodyBytes}b`,
    strict: true,
    type: ["application/json", "application/*+json"],
  }),
);
app.use("/api", apiIpLimiter, apiUserLimiter);

app.get("/api/health", healthIpLimiter, (_request, response) => {
  response.json({
    ok: true,
  });
});

function handleDebateUploads(request, response, next) {
  if (!request.is("multipart/form-data")) {
    next();
    return;
  }

  upload.any()(request, response, (error) => {
    if (error) {
      const formatted = formatUploadError(error);
      response.status(formatted.status).json({
        error: formatted.message,
      });
      return;
    }

    next();
  });
}

app.post(
  "/api/debates",
  debateIpLimiter,
  debateUserLimiter,
  debateInFlightLimiter,
  handleDebateUploads,
  async (request, response) => {
    let debateInput;

    try {
      const payload = parseDebatePayload(request);
      const validatedPayload = validateDebatePayload(payload);
      debateInput = await hydrateDebatePayload(validatedPayload, request.files ?? []);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 400;
      response.status(status).json({
        error: error instanceof Error ? error.message : "Invalid debate request.",
      });
      return;
    }

    response.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const emit = (event) => {
      response.write(`${JSON.stringify(event)}\n`);
    };

    try {
      await runDebate({
        ...debateInput,
        emit,
      });
    } catch (error) {
      emit({
        type: "error",
        message:
          error instanceof Error ? error.message : "Unexpected debate failure.",
      });
    } finally {
      response.end();
    }
  },
);

app.use(express.static(distPath));

app.get("*", (request, response, next) => {
  if (!request.path.startsWith("/api")) {
    response.sendFile(path.join(distPath, "index.html"));
    return;
  }

  next();
});

app.use((error, _request, response, _next) => {
  if (error instanceof SyntaxError && "body" in error) {
    response.status(400).json({
      error: "Malformed JSON request body.",
    });
    return;
  }

  if (error instanceof HttpError) {
    for (const [header, value] of Object.entries(error.headers)) {
      response.setHeader(header, value);
    }

    response.status(error.status).json({
      error: error.message,
    });
    return;
  }

  response.status(500).json({
    error: "Internal server error.",
  });
});

app.listen(port, () => {
  console.log(`AI Debate Studio server listening on http://localhost:${port}`);
});
