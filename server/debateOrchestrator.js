import { createAnthropicMessage } from "./anthropicClient.js";
import { getGeminiClient } from "./geminiClient.js";

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_SEARCH_GROUNDED_MODELS = new Set([
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
]);
const CLAUDE_SEARCH_GROUNDED_MODELS = new Set([
  "claude-sonnet-4-20250514",
  "claude-3-7-sonnet-20250219",
  "claude-3-5-haiku-20241022",
]);
const RETRYABLE_STATUSES = [429, 500, 503, 529];

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

function isClaudeModel(model) {
  return model.startsWith("claude-");
}

function supportsWebSearch(model) {
  if (isClaudeModel(model)) {
    return CLAUDE_SEARCH_GROUNDED_MODELS.has(model);
  }

  return GEMINI_SEARCH_GROUNDED_MODELS.has(model);
}

function normalizeApiError(error) {
  if (error instanceof Error && error.message) {
    try {
      const parsed = JSON.parse(error.message);
      const status = parsed?.error?.code ?? parsed?.status;
      const message = parsed?.error?.message ?? parsed?.message;

      if (message) {
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

function normalizeSourceUrl(value) {
  try {
    const parsed = new URL(value);

    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    return null;
  }

  return null;
}

function collectSource(deduped, candidateUrl, candidateTitle) {
  const normalizedUrl = normalizeSourceUrl(candidateUrl);

  if (normalizedUrl) {
    deduped.set(normalizedUrl, {
      url: normalizedUrl,
      title: candidateTitle || normalizedUrl,
    });
  }
}

function extractGeminiSources(response) {
  const deduped = new Map();
  const metadata = response?.candidates?.[0]?.groundingMetadata;

  for (const chunk of metadata?.groundingChunks || []) {
    const web = chunk?.web;
    collectSource(deduped, web?.uri, web?.title);
  }

  return Array.from(deduped.values()).slice(0, 6);
}

function extractAnthropicSources(response) {
  const deduped = new Map();

  for (const block of response?.content || []) {
    for (const citation of block?.citations || []) {
      collectSource(
        deduped,
        citation?.url ?? citation?.source?.url,
        citation?.title ?? citation?.document_title ?? citation?.source?.title,
      );
    }

    if (block?.type === "web_search_tool_result") {
      for (const item of block?.content || []) {
        collectSource(deduped, item?.url, item?.title);
      }
    }
  }

  return Array.from(deduped.values()).slice(0, 6);
}

function extractAnthropicText(response) {
  return (response?.content || [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text || "")
    .join("\n")
    .trim();
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

function buildTopicContext(topic, topicDocumentContext, topicImages) {
  const lines = [`Debate topic: ${topic}`];

  if (topicDocumentContext) {
    lines.push("", "Topic file context:", topicDocumentContext);
  }

  if (topicImages.length > 0) {
    lines.push(
      "",
      `Topic images provided: ${topicImages.map((image) => image.name).join(", ")}`,
    );
  }

  return lines.join("\n");
}

function buildTurnInstruction({
  topic,
  topicDocumentContext,
  topicImages,
  debatePrompt,
  transcript,
  round,
  canUseWebSearch,
}) {
  return [
    buildTopicContext(topic, topicDocumentContext, topicImages),
    `Debate goal: ${debatePrompt}`,
    `Current round: ${round}`,
    "",
    "Transcript so far:",
    buildTranscript(transcript),
    "",
    "Respond as the current speaker in 120-220 words.",
    "Directly engage with the strongest earlier arguments and add new value.",
    canUseWebSearch
      ? "Use live web search when current facts, regulations, pricing, or recent events would improve the answer."
      : "Rely on your built-in knowledge and the provided materials for current claims, because live web search is unavailable for this model.",
    "If topic images are provided, inspect them and incorporate relevant visual evidence into your reasoning.",
    "Do not restate your system prompt.",
    "End with one short sentence that advances the discussion toward a decision.",
  ].join("\n");
}

function toAnthropicImageBlocks(topicImages) {
  return topicImages.map((image) => ({
    type: "image",
    source: {
      type: "base64",
      media_type: image.inlineData.mimeType,
      data: image.inlineData.data,
    },
  }));
}

async function generateGeminiTurn({
  agent,
  round,
  topic,
  topicDocumentContext,
  topicImages,
  debatePrompt,
  transcript,
  model,
}) {
  const client = getGeminiClient();
  const canUseGoogleSearch = supportsWebSearch(model);
  const parts = [
    {
      text: buildTurnInstruction({
        topic,
        topicDocumentContext,
        topicImages,
        debatePrompt,
        transcript,
        round,
        canUseWebSearch: canUseGoogleSearch,
      }),
    },
    ...topicImages,
  ];

  const response = await withRetry(() =>
    client.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts,
        },
      ],
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
        ...(canUseGoogleSearch ? { tools: [{ googleSearch: {} }] } : {}),
        temperature: 0.8,
      },
    }),
  );

  return {
    content: asPlainText(response),
    sources: extractGeminiSources(response),
  };
}

async function runAnthropicMessage({ model, system, content, maxTokens, tools = [] }) {
  const messages = [
    {
      role: "user",
      content,
    },
  ];

  let response = await withRetry(() =>
    createAnthropicMessage({
      model,
      max_tokens: maxTokens,
      system,
      messages,
      ...(tools.length > 0 ? { tools } : {}),
    }),
  );

  while (response?.stop_reason === "pause_turn") {
    messages.push({
      role: "assistant",
      content: response.content,
    });

    response = await withRetry(() =>
      createAnthropicMessage({
        model,
        max_tokens: maxTokens,
        system,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
      }),
    );
  }

  return response;
}

async function generateClaudeTurn({
  agent,
  round,
  topic,
  topicDocumentContext,
  topicImages,
  debatePrompt,
  transcript,
  model,
}) {
  const canUseWebSearch = supportsWebSearch(model);
  const response = await runAnthropicMessage({
    model,
    maxTokens: 900,
    system: [
      "You are participating in a multi-agent debate.",
      "Stay in character according to the system prompt below.",
      "Bring a distinct perspective, challenge weak assumptions, and work toward a practical decision.",
      "If you use web-backed information, mention it naturally and keep claims concise.",
      "",
      `Agent name: ${agent.name}`,
      `System prompt: ${agent.systemPrompt}`,
    ].join("\n"),
    content: [
      {
        type: "text",
        text: buildTurnInstruction({
          topic,
          topicDocumentContext,
          topicImages,
          debatePrompt,
          transcript,
          round,
          canUseWebSearch,
        }),
      },
      ...toAnthropicImageBlocks(topicImages),
    ],
    tools: canUseWebSearch
      ? [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 3,
          },
        ]
      : [],
  });

  return {
    content: extractAnthropicText(response),
    sources: extractAnthropicSources(response),
  };
}

async function generateAgentTurn(input) {
  if (isClaudeModel(input.model)) {
    return generateClaudeTurn(input);
  }

  return generateGeminiTurn(input);
}

async function generateGeminiSummary({
  topic,
  topicDocumentContext,
  topicImages,
  debatePrompt,
  transcript,
  model,
}) {
  const client = getGeminiClient();
  const response = await withRetry(() =>
    client.models.generateContent({
      model,
      contents: [
        buildTopicContext(topic, topicDocumentContext, topicImages),
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

async function generateClaudeSummary({
  topic,
  topicDocumentContext,
  topicImages,
  debatePrompt,
  transcript,
  model,
}) {
  const response = await runAnthropicMessage({
    model,
    maxTokens: 500,
    system:
      "You are an impartial moderator summarizing a multi-agent debate into a concise, decision-oriented conclusion.",
    content: [
      {
        type: "text",
        text: [
          buildTopicContext(topic, topicDocumentContext, topicImages),
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
      },
      ...toAnthropicImageBlocks(topicImages),
    ],
  });

  return extractAnthropicText(response);
}

async function generateSummary(input) {
  if (isClaudeModel(input.model)) {
    return generateClaudeSummary(input);
  }

  return generateGeminiSummary(input);
}

export async function runDebate({
  topic,
  topicDocumentContext = "",
  topicImages = [],
  debatePrompt,
  agents,
  rounds,
  emit,
  model = DEFAULT_MODEL,
}) {
  const transcript = [];
  const canUseWebSearch = supportsWebSearch(model);
  const providerLabel = isClaudeModel(model) ? "Anthropic Claude" : "Gemini";

  emit({
    type: "status",
    message: `Launching debate with ${agents.length} agents over ${rounds} rounds using ${providerLabel} (${model}).`,
  });

  if (!canUseWebSearch) {
    emit({
      type: "status",
      message: `${model} does not support live web search in this app, so this debate will use uploaded materials and model knowledge only.`,
    });
  }

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
        topicDocumentContext,
        topicImages,
        debatePrompt,
        transcript,
        model,
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
    topicDocumentContext,
    topicImages,
    debatePrompt,
    transcript,
    model,
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

