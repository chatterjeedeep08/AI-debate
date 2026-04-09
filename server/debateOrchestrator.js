import { getGeminiClient } from "./geminiClient.js";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const RETRYABLE_STATUSES = [429, 500, 503];

function createTimestamp() {
  return new Intl.DateTimeFormat("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeApiError(error) {
  if (error instanceof Error && error.message) {
    try {
      const parsed = JSON.parse(error.message);
      const status = parsed?.error?.code;
      const message = parsed?.error?.message;

      if (status && message) {
        return { status, message };
      }
    } catch {
      return {
        status: undefined,
        message: error.message,
      };
    }

    return {
      status: undefined,
      message: error.message,
    };
  }

  return {
    status: undefined,
    message: String(error),
  };
}

async function withRetry(task) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const normalized = normalizeApiError(error);
      const shouldRetry =
        attempt < 3 && normalized.status && RETRYABLE_STATUSES.includes(normalized.status);

      if (!shouldRetry) {
        throw new Error(normalized.message);
      }

      await sleep(1200 * attempt);
    }
  }

  throw lastError;
}

function asPlainText(response) {
  if (typeof response?.text === "string" && response.text.trim()) {
    return response.text.trim();
  }

  const parts = response?.candidates?.flatMap((candidate) =>
    candidate?.content?.parts?.map((part) => part?.text || "") || [],
  );

  return (parts || []).join("\n").trim();
}

function extractSources(response) {
  const deduped = new Map();
  const metadata = response?.candidates?.[0]?.groundingMetadata;

  for (const chunk of metadata?.groundingChunks || []) {
    const web = chunk?.web;

    if (web?.uri) {
      deduped.set(web.uri, {
        url: web.uri,
        title: web.title || web.uri,
      });
    }
  }

  return Array.from(deduped.values()).slice(0, 6);
}

function buildTranscript(transcript) {
  if (!transcript.length) {
    return "No prior messages yet.";
  }

  return transcript
    .map(
      (message) =>
        `Round ${message.round} | ${message.agentName}: ${message.content}`,
    )
    .join("\n\n");
}

async function generateAgentTurn({ agent, round, topic, debatePrompt, transcript }) {
  const client = getGeminiClient();

  const response = await withRetry(() =>
    client.models.generateContent({
      model: MODEL,
      contents: [
        `Debate topic: ${topic}`,
        `Debate goal: ${debatePrompt}`,
        `Current round: ${round}`,
        "",
        "Transcript so far:",
        buildTranscript(transcript),
        "",
        "Respond as the current speaker in 120-220 words.",
        "Directly engage with the strongest earlier arguments and add new value.",
        "Use Google Search grounding when current facts, regulations, pricing, or recent events would improve the answer.",
        "Do not restate your system prompt.",
        "End with one short sentence that advances the discussion toward a decision.",
      ].join("\n"),
      config: {
        systemInstruction: [
          "You are participating in a multi-agent debate.",
          "Stay in character according to the system prompt below.",
          "Bring a distinct perspective, challenge weak assumptions, and work toward a practical decision.",
          "If you use grounded web information, mention it naturally and keep claims concise.",
          "",
          `Agent name: ${agent.name}`,
          `System prompt: ${agent.systemPrompt}`,
        ].join("\n"),
        tools: [{ googleSearch: {} }],
        temperature: 0.8,
      },
    }),
  );

  return {
    content: asPlainText(response),
    sources: extractSources(response),
  };
}

async function generateSummary({ topic, debatePrompt, transcript }) {
  const client = getGeminiClient();

  const response = await withRetry(() =>
    client.models.generateContent({
      model: MODEL,
      contents: [
        `Debate topic: ${topic}`,
        `Debate goal: ${debatePrompt}`,
        "",
        "Transcript:",
        buildTranscript(transcript),
        "",
        "Produce a 3-5 sentence decision-oriented summary covering:",
        "1. The emerging consensus or best decision.",
        "2. The main disagreement that remains.",
        "3. The most practical next step.",
      ].join("\n"),
      config: {
        systemInstruction:
          "You are an impartial moderator summarizing a multi-agent debate into a concise, decision-oriented conclusion.",
        temperature: 0.4,
      },
    }),
  );

  return asPlainText(response);
}

export async function runDebate({ topic, debatePrompt, agents, rounds, emit }) {
  const transcript = [];

  emit({
    type: "status",
    message: `Launching debate with ${agents.length} agents over ${rounds} rounds.`,
  });

  for (let round = 1; round <= rounds; round += 1) {
    emit({
      type: "status",
      message: `Round ${round} is underway.`,
    });

    for (const agent of agents) {
      emit({
        type: "status",
        message: `${agent.name} is preparing a response for round ${round}.`,
      });

      const turn = await generateAgentTurn({
        agent,
        round,
        topic,
        debatePrompt,
        transcript,
      });

      const message = {
        id: `${round}-${agent.id}-${Date.now()}`,
        type: "message",
        round,
        agentId: agent.id,
        agentName: agent.name,
        content: turn.content,
        sources: turn.sources,
        timestamp: createTimestamp(),
      };

      transcript.push(message);
      emit(message);
    }
  }

  emit({
    type: "status",
    message: "Drafting the moderator summary.",
  });

  const summary = await generateSummary({
    topic,
    debatePrompt,
    transcript,
  });

  emit({
    id: `summary-${Date.now()}`,
    type: "summary",
    content: summary,
  });

  emit({
    type: "status",
    message: "Debate finished successfully.",
  });
}
