import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import { runDebate } from "./debateOrchestrator.js";

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
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    provider: "gemini",
  });
});

app.post("/api/debates", async (request, response) => {
  const { topic, debatePrompt, agents, rounds } = request.body ?? {};

  if (!topic || !debatePrompt || !Array.isArray(agents) || agents.length < 2) {
    response.status(400).json({
      error: "Provide a topic, debate prompt, and at least two agents.",
    });
    return;
  }

  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) {
    response.status(400).json({
      error: "Rounds must be an integer between 1 and 5.",
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
      topic,
      debatePrompt,
      rounds,
      agents,
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

app.listen(port, () => {
  console.log(`AI Debate Studio server listening on http://localhost:${port}`);
});
