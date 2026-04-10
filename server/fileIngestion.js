import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import mammoth from "mammoth";
import multer from "multer";
import pdf from "pdf-parse";
import WordExtractor from "word-extractor";
import { HttpError } from "./security.js";

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
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const INVALID_CONTROL_CHAR_PATTERN = /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

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

const MAX_FILES = 20;
const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_UPLOAD_BYTES = 24 * 1024 * 1024;
const MAX_FILE_NAME_LENGTH = 120;
const MAX_EXTRACTED_TEXT_PER_FILE = 12000;
const MAX_TOPIC_DOCUMENT_TEXT = 20000;
const MAX_PROMPT_ATTACHMENT_TEXT = 18000;
const MAX_TOPIC_LENGTH = 3000;
const MAX_DEBATE_PROMPT_LENGTH = 6000;
const MAX_AGENT_NAME_LENGTH = 80;
const MAX_AGENT_PROMPT_LENGTH = 6000;
const MAX_AGENTS = 6;

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

function getPreferredMimeType(file) {
  const extension = getExtension(file.originalname);
  const defaultMimeType = Array.from(EXTENSION_MIME_TYPES[extension] ?? [])[0];
  const incomingMimeType = (file.mimetype || "").toLowerCase();

  if (GENERIC_BINARY_TYPES.has(incomingMimeType)) {
    return defaultMimeType;
  }

  return incomingMimeType || defaultMimeType;
}

function ensureAllowedMime(extension, mimeType) {
  const allowedTypes = EXTENSION_MIME_TYPES[extension];

  if (!allowedTypes) {
    throw new HttpError(400, `Unsupported file type: ${extension}`);
  }

  if (allowedTypes.has(mimeType) || GENERIC_BINARY_TYPES.has(mimeType)) {
    return;
  }

  throw new HttpError(400, `File MIME type ${mimeType} does not match ${extension}.`);
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

function ensureSafeText(value, fieldName, maxLength) {
  if (typeof value !== "string") {
    throw new HttpError(400, `${fieldName} must be a string.`);
  }

  const normalized = value
    .normalize("NFKC")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();

  if (!normalized) {
    throw new HttpError(400, `${fieldName} is required.`);
  }

  if (normalized.length > maxLength) {
    throw new HttpError(413, `${fieldName} must be ${maxLength} characters or fewer.`);
  }

  if (INVALID_CONTROL_CHAR_PATTERN.test(normalized)) {
    throw new HttpError(400, `${fieldName} contains unsupported control characters.`);
  }

  return normalized;
}

function ensureSafeIdentifier(value, fieldName) {
  if (typeof value !== "string") {
    throw new HttpError(400, `${fieldName} must be a string.`);
  }

  const normalized = value.trim();

  if (!SAFE_ID_PATTERN.test(normalized)) {
    throw new HttpError(400, `${fieldName} contains unsupported characters.`);
  }

  return normalized;
}

function ensureOnlyKnownKeys(object, allowedKeys, fieldName) {
  const unknownKeys = Object.keys(object).filter((key) => !allowedKeys.has(key));

  if (unknownKeys.length > 0) {
    throw new HttpError(400, `${fieldName} contains unsupported fields: ${unknownKeys.join(", ")}.`);
  }
}

function ensureSafeFilename(fileName) {
  if (typeof fileName !== "string") {
    throw new HttpError(400, "Uploaded files must include a filename.");
  }

  const normalized = fileName.normalize("NFKC").trim();

  if (!normalized) {
    throw new HttpError(400, "Uploaded files must include a filename.");
  }

  if (normalized.length > MAX_FILE_NAME_LENGTH) {
    throw new HttpError(400, `Filenames must be ${MAX_FILE_NAME_LENGTH} characters or fewer.`);
  }

  if (path.basename(normalized) !== normalized || /[\\/]/.test(normalized)) {
    throw new HttpError(400, `Filename ${fileName} contains an invalid path.`);
  }

  if (INVALID_CONTROL_CHAR_PATTERN.test(normalized)) {
    throw new HttpError(400, `Filename ${fileName} contains unsupported control characters.`);
  }

  return normalized;
}

function startsWithBytes(buffer, signature) {
  return signature.every((byte, index) => buffer[index] === byte);
}

function ensureFileSignatureMatches(file) {
  const extension = getExtension(file.originalname);
  const buffer = file.buffer;

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new HttpError(400, `File ${file.originalname} is empty or unreadable.`);
  }

  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    throw new HttpError(413, `File ${file.originalname} exceeds the ${Math.round(MAX_FILE_SIZE_BYTES / (1024 * 1024))} MB upload limit.`);
  }

  switch (extension) {
    case ".pdf":
      if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
        throw new HttpError(400, `File ${file.originalname} does not look like a valid PDF.`);
      }
      return;
    case ".png":
      if (!startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
        throw new HttpError(400, `File ${file.originalname} does not look like a valid PNG.`);
      }
      return;
    case ".jpg":
    case ".jpeg":
      if (!startsWithBytes(buffer, [0xff, 0xd8, 0xff])) {
        throw new HttpError(400, `File ${file.originalname} does not look like a valid JPEG.`);
      }
      return;
    case ".gif": {
      const header = buffer.subarray(0, 6).toString("ascii");
      if (header !== "GIF87a" && header !== "GIF89a") {
        throw new HttpError(400, `File ${file.originalname} does not look like a valid GIF.`);
      }
      return;
    }
    case ".webp":
      if (
        buffer.subarray(0, 4).toString("ascii") !== "RIFF" ||
        buffer.subarray(8, 12).toString("ascii") !== "WEBP"
      ) {
        throw new HttpError(400, `File ${file.originalname} does not look like a valid WEBP image.`);
      }
      return;
    case ".docx":
    case ".odt":
      if (!startsWithBytes(buffer, [0x50, 0x4b, 0x03, 0x04])) {
        throw new HttpError(400, `File ${file.originalname} does not look like a valid ${extension.slice(1).toUpperCase()} file.`);
      }
      return;
    case ".doc":
      if (!startsWithBytes(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
        throw new HttpError(400, `File ${file.originalname} does not look like a valid DOC file.`);
      }
      return;
    case ".rtf":
      if (buffer.subarray(0, 5).toString("ascii") !== "{\\rtf") {
        throw new HttpError(400, `File ${file.originalname} does not look like a valid RTF file.`);
      }
      return;
    default:
      return;
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

  throw new HttpError(400, `Unexpected upload field: ${fieldName}`);
}

function ensureFileAllowedForField(file) {
  const sanitizedName = ensureSafeFilename(file.originalname);
  const extension = getExtension(sanitizedName);
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

  throw new HttpError(400, `File ${sanitizedName} is not allowed in ${file.fieldname}.`);
}

function ensureFilesWithinTotalLimit(files) {
  const totalBytes = files.reduce((sum, file) => sum + (file.size || file.buffer?.length || 0), 0);

  if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
    throw new HttpError(
      413,
      `Combined upload size must be ${Math.round(MAX_TOTAL_UPLOAD_BYTES / (1024 * 1024))} MB or smaller.`,
    );
  }
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
      throw new HttpError(400, "Multipart requests must include a payload field.");
    }

    try {
      return JSON.parse(request.body.payload);
    } catch {
      throw new HttpError(400, "Multipart payload must contain valid JSON.");
    }
  }

  return request.body ?? {};
}

export function validateDebatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HttpError(400, "Debate payload must be a JSON object.");
  }

  ensureOnlyKnownKeys(
    payload,
    new Set(["agents", "debatePrompt", "model", "rounds", "topic"]),
    "Debate payload",
  );

  const topic = ensureSafeText(payload.topic, "Topic", MAX_TOPIC_LENGTH);
  const debatePrompt = ensureSafeText(
    payload.debatePrompt,
    "Debate prompt",
    MAX_DEBATE_PROMPT_LENGTH,
  );
  const model = typeof payload.model === "string" ? payload.model.trim() : DEFAULT_MODEL;
  const rounds = Number(payload.rounds);
  const incomingAgents = Array.isArray(payload.agents) ? payload.agents : [];

  if (!ALLOWED_MODELS.has(model)) {
    throw new HttpError(400, "Choose a supported AI model.");
  }

  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) {
    throw new HttpError(400, "Rounds must be an integer between 1 and 5.");
  }

  if (incomingAgents.length < 2) {
    throw new HttpError(400, "At least two agents are required.");
  }

  if (incomingAgents.length > MAX_AGENTS) {
    throw new HttpError(413, `At most ${MAX_AGENTS} agents are allowed per debate.`);
  }

  const seenIds = new Set();
  const agents = incomingAgents.map((agent) => {
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
      throw new HttpError(400, "Each agent must be a JSON object.");
    }

    ensureOnlyKnownKeys(agent, new Set(["id", "name", "systemPrompt"]), "Agent");

    const id = ensureSafeIdentifier(agent.id, "Agent id");
    const name = ensureSafeText(agent.name, "Agent name", MAX_AGENT_NAME_LENGTH);
    const systemPrompt = ensureSafeText(
      agent.systemPrompt,
      "System prompt",
      MAX_AGENT_PROMPT_LENGTH,
    );

    if (seenIds.has(id)) {
      throw new HttpError(400, "Agent ids must be unique.");
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
  ensureFilesWithinTotalLimit(files);
  const topicDocumentFiles = [];
  const topicImages = [];
  const debatePromptFiles = [];
  const agentFilesById = new Map(payload.agents.map((agent) => [agent.id, []]));

  for (const file of files) {
    ensureFileAllowedForField(file);
    ensureFileSignatureMatches(file);
    file.originalname = ensureSafeFilename(file.originalname);

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
        throw new HttpError(400, `Received files for unknown agent ${agentId}.`);
      }

      target.push(file);
    }
  }

  const extractedFileGroups = [
    ...topicDocumentFiles,
    ...debatePromptFiles,
    ...Array.from(agentFilesById.values()).flat(),
  ];

  for (const file of extractedFileGroups) {
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
      return {
        status: 413,
        message: `File too large. Each file must be ${Math.round(MAX_FILE_SIZE_BYTES / (1024 * 1024))} MB or smaller.`,
      };
    }

    if (error.code === "LIMIT_FILE_COUNT") {
      return {
        status: 413,
        message: `Too many files uploaded. Upload at most ${MAX_FILES} files per debate.`,
      };
    }

    return {
      status: 400,
      message: error.message,
    };
  }

  if (error instanceof HttpError) {
    return {
      status: error.status,
      message: error.message,
    };
  }

  return {
    status: 400,
    message: error instanceof Error ? error.message : "Unable to process uploaded files.",
  };
}

export const TOPIC_FILE_ACCEPT =
  ".docx,.md,.doc,.pdf,.rtf,.txt,.odt,.png,.jpg,.jpeg,.webp,.gif";
export const PROMPT_FILE_ACCEPT = ".docx,.md,.doc,.pdf,.rtf,.txt,.odt";
export const CLIENT_DEBATE_LIMITS = {
  maxAgents: MAX_AGENTS,
  maxAgentNameLength: MAX_AGENT_NAME_LENGTH,
  maxDebatePromptLength: MAX_DEBATE_PROMPT_LENGTH,
  maxFiles: MAX_FILES,
  maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
  maxPromptLength: MAX_AGENT_PROMPT_LENGTH,
  maxTopicLength: MAX_TOPIC_LENGTH,
};

