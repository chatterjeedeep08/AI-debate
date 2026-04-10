const DOCUMENT_ACCEPT = ".docx,.md,.doc,.pdf,.rtf,.txt,.odt";
const TOPIC_ACCEPT = `${DOCUMENT_ACCEPT},.png,.jpg,.jpeg,.webp,.gif`;
const MODEL_OPTIONS = [
  {
    value: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
  },
  {
    value: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
  },
  {
    value: "gemini-2.0-flash",
    label: "Gemini 2.0 Flash",
  },
  {
    value: "gemini-2.0-flash-lite",
    label: "Gemini 2.0 Flash-Lite",
  },
  {
    value: "claude-sonnet-4-20250514",
    label: "Claude Sonnet 4",
  },
  {
    value: "claude-3-7-sonnet-20250219",
    label: "Claude Sonnet 3.7",
  },
  {
    value: "claude-3-5-haiku-20241022",
    label: "Claude Haiku 3.5",
  },
];

const CLIENT_LIMITS = {
  maxAgents: 6,
  maxAgentNameLength: 80,
  maxDebatePromptLength: 6000,
  maxFileSizeBytes: 8 * 1024 * 1024,
  maxFiles: 20,
  maxPromptLength: 6000,
  maxTopicLength: 3000,
};

const DEFAULT_SYSTEM_PROMPTS = [
  "You are a pragmatic strategist. Focus on tradeoffs, feasibility, and practical next steps.",
  "You are a critical thinker. Challenge weak assumptions, surface risks, and push for evidence-backed claims.",
];

function createAgent(index) {
  return {
    id: crypto.randomUUID(),
    name: `Agent ${index + 1}`,
    systemPrompt:
      DEFAULT_SYSTEM_PROMPTS[index] ??
      "You are a constructive debate participant. Bring a distinct viewpoint, use evidence, and work toward a decision.",
  };
}

function fileId(file) {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

function formatBytes(size) {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function hasAllowedExtension(file, acceptString) {
  const allowedExtensions = acceptString
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const normalizedName = file.name.toLowerCase();
  return allowedExtensions.some((extension) => normalizedName.endsWith(extension));
}

function mergeFiles(currentFiles, incomingFiles, acceptString, options = {}) {
  const maxFiles = options.maxFiles ?? CLIENT_LIMITS.maxFiles;
  const maxFileSizeBytes = options.maxFileSizeBytes ?? CLIENT_LIMITS.maxFileSizeBytes;
  const nextFiles = [...currentFiles];
  const seen = new Set(currentFiles.map(fileId));
  const rejected = [];

  for (const file of incomingFiles) {
    if (!hasAllowedExtension(file, acceptString)) {
      rejected.push(`${file.name} (unsupported type)`);
      continue;
    }

    if (file.size > maxFileSizeBytes) {
      rejected.push(`${file.name} (larger than ${formatBytes(maxFileSizeBytes)})`);
      continue;
    }

    const signature = fileId(file);

    if (seen.has(signature)) {
      continue;
    }

    if (nextFiles.length >= maxFiles) {
      rejected.push(`${file.name} (file limit reached)`);
      continue;
    }

    seen.add(signature);
    nextFiles.push(file);
  }

  return {
    files: nextFiles,
    rejected,
  };
}

function removeFile(files, targetId) {
  return files.filter((file) => fileId(file) !== targetId);
}

function buildRateLimitMessage(retryAfterSeconds) {
  if (!retryAfterSeconds || Number.isNaN(Number(retryAfterSeconds))) {
    return "The app is being rate limited. Please wait a moment and try again.";
  }

  const seconds = Math.max(1, Number(retryAfterSeconds));
  return `The app is being rate limited. Please wait about ${seconds} second${seconds === 1 ? "" : "s"} and try again.`;
}

function getFriendlyErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);

  if (message === "Failed to fetch") {
    return "The app could not reach the backend. Make sure the server is running and open the app through http://localhost:5173 or http://localhost:3001 instead of opening the HTML file directly.";
  }

  return message;
}

function checkFileCollection(files, label) {
  if (files.length > CLIENT_LIMITS.maxFiles) {
    return `${label} can include at most ${CLIENT_LIMITS.maxFiles} files.`;
  }

  const oversized = files.find((file) => file.size > CLIENT_LIMITS.maxFileSizeBytes);

  if (oversized) {
    return `${oversized.name} is larger than ${formatBytes(CLIENT_LIMITS.maxFileSizeBytes)}.`;
  }

  return null;
}

function validateDebateBeforeSubmit({ form, agents, topicFiles, debatePromptFiles, agentFiles }) {
  const trimmedTopic = form.topic.trim();
  const trimmedDebatePrompt = form.debatePrompt.trim();

  if (!trimmedTopic) {
    return "Add a debate topic before starting.";
  }

  if (trimmedTopic.length > CLIENT_LIMITS.maxTopicLength) {
    return `The debate topic must be ${CLIENT_LIMITS.maxTopicLength} characters or fewer.`;
  }

  if (!trimmedDebatePrompt) {
    return "Add a debate prompt before starting.";
  }

  if (trimmedDebatePrompt.length > CLIENT_LIMITS.maxDebatePromptLength) {
    return `The debate prompt must be ${CLIENT_LIMITS.maxDebatePromptLength} characters or fewer.`;
  }

  if (agents.length < 2) {
    return "At least two agents are required.";
  }

  if (agents.length > CLIENT_LIMITS.maxAgents) {
    return `At most ${CLIENT_LIMITS.maxAgents} agents are allowed per debate.`;
  }

  const topicFileError = checkFileCollection(topicFiles, "Topic uploads");

  if (topicFileError) {
    return topicFileError;
  }

  const debatePromptFileError = checkFileCollection(debatePromptFiles, "Debate prompt uploads");

  if (debatePromptFileError) {
    return debatePromptFileError;
  }

  for (const agent of agents) {
    if (!agent.name.trim()) {
      return "Each agent needs a name.";
    }

    if (agent.name.trim().length > CLIENT_LIMITS.maxAgentNameLength) {
      return `Agent names must be ${CLIENT_LIMITS.maxAgentNameLength} characters or fewer.`;
    }

    if (!agent.systemPrompt.trim()) {
      return "Each agent needs a system prompt.";
    }

    if (agent.systemPrompt.trim().length > CLIENT_LIMITS.maxPromptLength) {
      return `System prompts must be ${CLIENT_LIMITS.maxPromptLength} characters or fewer.`;
    }

    const agentFileError = checkFileCollection(agentFiles[agent.id] ?? [], `${agent.name} uploads`);

    if (agentFileError) {
      return agentFileError;
    }
  }

  return null;
}

async function checkBackendAvailability() {
  try {
    await fetch("/api/health");
    return true;
  } catch {
    return false;
  }
}

const INITIAL_AGENTS = [createAgent(0), createAgent(1)];
const INITIAL_FORM = {
  topic: "",
  debatePrompt:
    "Debate the topic rigorously, use current web information when helpful, and work toward a clear recommendation.",
  model: MODEL_OPTIONS[0].value,
  rounds: 2,
};

export {
  CLIENT_LIMITS,
  DOCUMENT_ACCEPT,
  MODEL_OPTIONS,
  TOPIC_ACCEPT,
  buildRateLimitMessage,
  createAgent,
  fileId,
  formatBytes,
  mergeFiles,
  removeFile,
  getFriendlyErrorMessage,
  checkBackendAvailability,
  validateDebateBeforeSubmit,
  INITIAL_AGENTS,
  INITIAL_FORM,
};
