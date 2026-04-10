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

function mergeFiles(currentFiles, incomingFiles, acceptString) {
  const nextFiles = [...currentFiles];
  const seen = new Set(currentFiles.map(fileId));
  const rejected = [];

  for (const file of incomingFiles) {
    if (!hasAllowedExtension(file, acceptString)) {
      rejected.push(file.name);
      continue;
    }

    const signature = fileId(file);

    if (!seen.has(signature)) {
      seen.add(signature);
      nextFiles.push(file);
    }
  }

  return {
    files: nextFiles,
    rejected,
  };
}

function removeFile(files, targetId) {
  return files.filter((file) => fileId(file) !== targetId);
}

function getFriendlyErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);

  if (message === "Failed to fetch") {
    return "The app could not reach the backend. Make sure the server is running and open the app through http://localhost:5173 or http://localhost:3001 instead of opening the HTML file directly.";
  }

  return message;
}

async function checkBackendAvailability() {
  try {
    const response = await fetch("/api/health");
    return response.ok;
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
  DOCUMENT_ACCEPT,
  MODEL_OPTIONS,
  TOPIC_ACCEPT,
  createAgent,
  fileId,
  formatBytes,
  mergeFiles,
  removeFile,
  getFriendlyErrorMessage,
  checkBackendAvailability,
  INITIAL_AGENTS,
  INITIAL_FORM,
};
