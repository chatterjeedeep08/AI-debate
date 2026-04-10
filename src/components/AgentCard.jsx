import AttachmentList from "./AttachmentList.jsx";
import { CLIENT_LIMITS, DOCUMENT_ACCEPT } from "../utils/debateHelpers.js";

export default function AgentCard({
  agent,
  index,
  files,
  isRunning,
  canRemove,
  onUpdate,
  onRemove,
  onFilesSelected,
  onRemoveFile,
}) {
  return (
    <article className="agent-card">
      <div className="agent-card-header">
        <input
          className="agent-name-input"
          value={agent.name}
          maxLength={CLIENT_LIMITS.maxAgentNameLength}
          onChange={(event) => onUpdate(agent.id, "name", event.target.value)}
          disabled={isRunning}
          aria-label={`Agent ${index + 1} name`}
        />
        <button
          type="button"
          className="icon-button"
          onClick={() => onRemove(agent.id)}
          disabled={isRunning || !canRemove}
          aria-label={`Remove ${agent.name}`}
        >
          x
        </button>
      </div>

      <textarea
        rows="6"
        maxLength={CLIENT_LIMITS.maxPromptLength}
        value={agent.systemPrompt}
        onChange={(event) => onUpdate(agent.id, "systemPrompt", event.target.value)}
        disabled={isRunning}
        placeholder="Define the agent's persona, priorities, and decision style."
      />

      <label className="field agent-file-field">
        <span>System prompt files</span>
        <input
          type="file"
          multiple
          accept={DOCUMENT_ACCEPT}
          onChange={(event) => onFilesSelected(agent.id, event)}
          disabled={isRunning}
        />
        <small className="helper-copy">
          Allowed: .docx, .md, .doc, .pdf, .rtf, .txt, .odt. Up to {CLIENT_LIMITS.maxFiles} files, {Math.round(CLIENT_LIMITS.maxFileSizeBytes / (1024 * 1024))} MB each.
        </small>
      </label>

      <AttachmentList
        files={files}
        onRemove={(targetId) => onRemoveFile(agent.id, targetId)}
      />
    </article>
  );
}
