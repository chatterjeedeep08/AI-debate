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

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3001);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, "../dist");

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    providers: {
      gemini: Boolean(process.env.GEMINI_API_KEY),
      anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    },
    uploads: true,
  });
});

function handleDebateUploads(request, response, next) {
  if (!request.is("multipart/form-data")) {
    next();
    return;
  }

  upload.any()(request, response, (error) => {
    if (error) {
      response.status(400).json({
        error: formatUploadError(error),
      });
      return;
    }

    next();
  });
}

app.post("/api/debates", handleDebateUploads, async (request, response) => {
  let debateInput;

  try {
    const payload = parseDebatePayload(request);
    const validatedPayload = validateDebatePayload(payload);
    debateInput = await hydrateDebatePayload(validatedPayload, request.files ?? []);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Invalid debate request.",
    });
    return;
  }

  response.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
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
});

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

  response.status(500).json({
    error: "Internal server error.",
  });
});

app.listen(port, () => {
  console.log(`AI Debate Studio server listening on http://localhost:${port}`);
});
