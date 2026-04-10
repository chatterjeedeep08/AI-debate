import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import mammoth from "mammoth";
import multer from "multer";
import pdf from "pdf-parse";
import WordExtractor from "word-extractor";

const DOCUMENT_EXTENSIONS = new Set([".doc", ".docx", ".md", ".odt", ".pdf", ".rtf", ".txt"]);
const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const GENERIC_BINARY_TYPES = new Set(["", "application/octet-stream"]);
const ALLOWED_MODELS = new Set([
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "claude-sonnet-4-20250514",
  "claude-3-7-sonnet-20250219",
  "claude-3-5-haiku-20241022",
]);
const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const EXTENSION_MIME_TYPES = {
  ".doc": new Set(["application/msword"]),
  ".docx": new Set([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ]),
  ".md": new Set(["text/markdown", "text/plain"]),
  ".odt": new Set(["application/vnd.oasis.opendocument.text"]),
  ".pdf": new Set(["application/pdf"]),
  ".rtf": new Set(["application/rtf", "text/rtf"]),
  ".txt": new Set(["text/plain"]),
  ".gif": new Set(["image/gif"]),
  ".jpeg": new Set(["image/jpeg"]),
  ".jpg": new Set(["image/jpeg"]),
  ".png": new Set(["image/png"]),
  ".webp": new Set(["image/webp"]),
};

function getPreferredMimeType(file) {
  const extension = getExtension(file.originalname);
  const defaultMimeType = Array.from(EXTENSION_MIME_TYPES[extension] ?? [])[0];
  const incomingMimeType = (file.mimetype || "").toLowerCase();

  if (GENERIC_BINARY_TYPES.has(incomingMimeType)) {
    return defaultMimeType;
  }

  return incomingMimeType || defaultMimeType;
}

const MAX_FILES = 20;
const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_PER_FILE = 12000;
const MAX_TOPIC_DOCUMENT_TEXT = 20000;
const MAX_PROMPT_ATTACHMENT_TEXT = 18000;

function getExtension(fileName) {
  return path.extname(fileName || "").toLowerCase();
}

function decodeXmlEntities(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function normalizeExtractedText(value) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_EXTRACTED_TEXT_PER_FILE);
}

function extractRtfText(value) {
  return value
    .replace(/\\par[d]?/gi, "\n")
    .replace(/\\'[0-9a-f]{2}/gi, " ")
    .replace(/\\[a-z]+-?\d* ?/gi, " ")
    .replace(/[{}]/g, " ")
    .replace(/\s+\n/g, "\n");
}

function ensureAllowedMime(extension, mimeType) {
  const allowedTypes = EXTENSION_MIME_TYPES[extension];

  if (!allowedTypes) {
    throw new Error(`Unsupported file type: ${extension}`);
  }

  if (allowedTypes.has(mimeType) || GENERIC_BINARY_TYPES.has(mimeType)) {
    return;
  }

  throw new Error(`File MIME type ${mimeType} does not match ${extension}.`);
}

function summarizeExtractedFiles(files, maxCharacters) {
  if (files.length === 0) {
    return "";
  }

  const combined = files
    .map((file) => `File: ${file.originalname}\n${file.extractedText}`)
    .join("\n\n")
    .slice(0, maxCharacters);

  return combined.trim();
}

async function withTempFile(buffer, extension, callback) {
  const tempPath = path.join(os.tmpdir(), `${crypto.randomUUID()}${extension}`);
  await fs.writeFile(tempPath, buffer);

  try {
    return await callback(tempPath);
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

async function extractDocumentText(file) {
  const extension = getExtension(file.originalname);

  switch (extension) {
    case ".docx": {
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      return normalizeExtractedText(result.value);
    }
    case ".doc": {
      const extractor = new WordExtractor();
      const text = await withTempFile(file.buffer, extension, async (tempPath) => {
        const document = await extractor.extract(tempPath);
        return document.getBody();
      });
      return normalizeExtractedText(text);
    }
    case ".pdf": {
      const result = await pdf(file.buffer);
      return normalizeExtractedText(result.text);
    }
    case ".odt": {
      const archive = await JSZip.loadAsync(file.buffer);
      const content = await archive.file("content.xml")?.async("string");

      if (!content) {
        return "";
      }

      return normalizeExtractedText(
        decodeXmlEntities(content.replace(/<[^>]+>/g, " ")),
      );
    }
    case ".rtf":
      return normalizeExtractedText(extractRtfText(file.buffer.toString("utf8")));
    case ".md":
    case ".txt":
      return normalizeExtractedText(file.buffer.toString("utf8"));
    default:
      return "";
  }
}

function classifyField(fieldName) {
  if (fieldName === "topicFiles") {
    return "topic";
  }

  if (fieldName === "debatePromptFiles") {
    return "debatePrompt";
  }

  if (fieldName.startsWith("agentFiles:")) {
    return "agent";
  }

  throw new Error(`Unexpected upload field: ${fieldName}`);
}

function ensureFileAllowedForField(file) {
  const extension = getExtension(file.originalname);
  const mimeType = (file.mimetype || "").toLowerCase();
  const fieldType = classifyField(file.fieldname);
  const isDocument = DOCUMENT_EXTENSIONS.has(extension);
  const isImage = IMAGE_EXTENSIONS.has(extension);

  ensureAllowedMime(extension, mimeType);

  if (fieldType === "topic" && (isDocument || isImage)) {
    return;
  }

  if ((fieldType === "debatePrompt" || fieldType === "agent") && isDocument) {
    return;
  }

  throw new Error(`File ${file.originalname} is not allowed in ${file.fieldname}.`);
}

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: MAX_FILES,
  },
  fileFilter(_request, file, callback) {
    try {
      ensureFileAllowedForField(file);
      callback(null, true);
    } catch (error) {
      callback(error);
    }
  },
});

export function parseDebatePayload(request) {
  if (request.is("multipart/form-data")) {
    if (typeof request.body.payload !== "string") {
      throw new Error("Multipart requests must include a payload field.");
    }

    return JSON.parse(request.body.payload);
  }

  return request.body ?? {};
}

export function validateDebatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Debate payload must be a JSON object.");
  }

  const topic = typeof payload.topic === "string" ? payload.topic.trim() : "";
  const debatePrompt =
    typeof payload.debatePrompt === "string" ? payload.debatePrompt.trim() : "";
  const model = typeof payload.model === "string" ? payload.model.trim() : DEFAULT_MODEL;
  const rounds = Number(payload.rounds);
  const incomingAgents = Array.isArray(payload.agents) ? payload.agents : [];

  if (!topic) {
    throw new Error("Provide a debate topic.");
  }

  if (!debatePrompt) {
    throw new Error("Provide a debate prompt.");
  }

  if (!ALLOWED_MODELS.has(model)) {
    throw new Error("Choose a supported AI model.");
  }

  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) {
    throw new Error("Rounds must be an integer between 1 and 5.");
  }

  if (incomingAgents.length < 2) {
    throw new Error("At least two agents are required.");
  }

  const seenIds = new Set();
  const agents = incomingAgents.map((agent) => {
    const id = typeof agent?.id === "string" ? agent.id.trim() : "";
    const name = typeof agent?.name === "string" ? agent.name.trim() : "";
    const systemPrompt =
      typeof agent?.systemPrompt === "string" ? agent.systemPrompt.trim() : "";

    if (!id) {
      throw new Error("Each agent must include an id.");
    }

    if (seenIds.has(id)) {
      throw new Error("Agent ids must be unique.");
    }

    if (!name) {
      throw new Error("Each agent must include a name.");
    }

    if (!systemPrompt) {
      throw new Error("Each agent must include a system prompt.");
    }

    seenIds.add(id);

    return {
      id,
      name,
      systemPrompt,
    };
  });

  return {
    agents,
    debatePrompt,
    model,
    rounds,
    topic,
  };
}

export async function hydrateDebatePayload(payload, files) {
  const topicDocumentFiles = [];
  const topicImages = [];
  const debatePromptFiles = [];
  const agentFilesById = new Map(payload.agents.map((agent) => [agent.id, []]));

  for (const file of files) {
    if (file.fieldname === "topicFiles") {
      if (IMAGE_EXTENSIONS.has(getExtension(file.originalname))) {
        topicImages.push({
          inlineData: {
            data: file.buffer.toString("base64"),
            mimeType: getPreferredMimeType(file),
          },
          name: file.originalname,
        });
      } else {
        topicDocumentFiles.push(file);
      }

      continue;
    }

    if (file.fieldname === "debatePromptFiles") {
      debatePromptFiles.push(file);
      continue;
    }

    if (file.fieldname.startsWith("agentFiles:")) {
      const agentId = file.fieldname.slice("agentFiles:".length);
      const target = agentFilesById.get(agentId);

      if (!target) {
        throw new Error(`Received files for unknown agent ${agentId}.`);
      }

      target.push(file);
    }
  }

  for (const file of [...topicDocumentFiles, ...debatePromptFiles, ...agentFilesById.values()].flat()) {
    file.extractedText = await extractDocumentText(file);
  }

  const topicDocumentContext = summarizeExtractedFiles(
    topicDocumentFiles,
    MAX_TOPIC_DOCUMENT_TEXT,
  );

  const debatePromptContext = summarizeExtractedFiles(
    debatePromptFiles,
    MAX_PROMPT_ATTACHMENT_TEXT,
  );

  return {
    ...payload,
    agents: payload.agents.map((agent) => {
      const agentContext = summarizeExtractedFiles(
        agentFilesById.get(agent.id) ?? [],
        MAX_PROMPT_ATTACHMENT_TEXT,
      );

      return {
        ...agent,
        systemPrompt: agentContext
          ? `${agent.systemPrompt}\n\nAttached file context:\n${agentContext}`
          : agent.systemPrompt,
      };
    }),
    debatePrompt: debatePromptContext
      ? `${payload.debatePrompt}\n\nAttached file context:\n${debatePromptContext}`
      : payload.debatePrompt,
    topicDocumentContext,
    topicImages,
  };
}

export function formatUploadError(error) {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return `File too large. Each file must be ${Math.round(
        MAX_FILE_SIZE_BYTES / (1024 * 1024),
      )} MB or smaller.`;
    }

    if (error.code === "LIMIT_FILE_COUNT") {
      return `Too many files uploaded. Upload at most ${MAX_FILES} files per debate.`;
    }

    return error.message;
  }

  return error instanceof Error ? error.message : "Unable to process uploaded files.";
}

export const TOPIC_FILE_ACCEPT =
  ".docx,.md,.doc,.pdf,.rtf,.txt,.odt,.png,.jpg,.jpeg,.webp,.gif";
export const PROMPT_FILE_ACCEPT = ".docx,.md,.doc,.pdf,.rtf,.txt,.odt";
