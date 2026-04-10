import AgentCard from "./AgentCard.jsx";
import AttachmentList from "./AttachmentList.jsx";
import {
  CLIENT_LIMITS,
  DOCUMENT_ACCEPT,
  MODEL_OPTIONS,
  TOPIC_ACCEPT,
} from "../utils/debateHelpers.js";

export default function DebateSetupPanel({
  agentFiles,
  agents,
  debatePromptFiles,
  error,
  form,
  isRunning,
  status,
  topicFiles,
  onAddAgent,
  onAgentFilesSelected,
  onAgentRemoveFile,
  onAgentUpdate,
  onClearTranscript,
  onDebatePromptFilesSelected,
  onFormChange,
  onRemoveAgent,
  onRemoveDebatePromptFile,
  onRemoveTopicFile,
  onStartDebate,
  onTopicFilesSelected,
}) {
  return (
    <section className="panel control-panel">
      <div className="panel-heading">
        <div>
          <p className="panel-kicker">Setup</p>
          <h2>Debate configuration</h2>
        </div>
        <button
          type="button"
          className="ghost-button"
          onClick={onClearTranscript}
          disabled={isRunning}
        >
          Clear transcript
        </button>
      </div>

      <form className="debate-form" onSubmit={onStartDebate}>
        <label className="field">
          <span>Debate topic</span>
          <textarea
            rows="3"
            maxLength={CLIENT_LIMITS.maxTopicLength}
            placeholder="Example: Should a mid-sized SaaS company adopt AI agents for internal support operations in 2026?"
            value={form.topic}
            onChange={(event) => onFormChange("topic", event.target.value)}
          />
          <small className="helper-copy">
            Up to {CLIENT_LIMITS.maxTopicLength} characters.
          </small>
        </label>

        <label className="field">
          <span>Topic files and images</span>
          <input
            type="file"
            multiple
            accept={TOPIC_ACCEPT}
            onChange={onTopicFilesSelected}
            disabled={isRunning}
          />
          <small className="helper-copy">
            Allowed: .docx, .md, .doc, .pdf, .rtf, .txt, .odt, .png, .jpg,
            .jpeg, .webp, .gif. Up to {CLIENT_LIMITS.maxFiles} files, {Math.round(CLIENT_LIMITS.maxFileSizeBytes / (1024 * 1024))} MB each.
          </small>
        </label>
        <AttachmentList files={topicFiles} onRemove={onRemoveTopicFile} />

        <label className="field">
          <span>Debate prompt</span>
          <textarea
            rows="4"
            maxLength={CLIENT_LIMITS.maxDebatePromptLength}
            placeholder="Set the objective, desired tone, constraints, or success criteria for the debate."
            value={form.debatePrompt}
            onChange={(event) => onFormChange("debatePrompt", event.target.value)}
          />
          <small className="helper-copy">
            Up to {CLIENT_LIMITS.maxDebatePromptLength} characters.
          </small>
        </label>

        <label className="field">
          <span>Debate prompt files</span>
          <input
            type="file"
            multiple
            accept={DOCUMENT_ACCEPT}
            onChange={onDebatePromptFilesSelected}
            disabled={isRunning}
          />
          <small className="helper-copy">
            Allowed: .docx, .md, .doc, .pdf, .rtf, .txt, .odt. Up to {CLIENT_LIMITS.maxFiles} files, {Math.round(CLIENT_LIMITS.maxFileSizeBytes / (1024 * 1024))} MB each.
          </small>
        </label>
        <AttachmentList files={debatePromptFiles} onRemove={onRemoveDebatePromptFile} />

        <label className="field compact-field">
          <span>Rounds per agent</span>
          <input
            type="number"
            min="1"
            max="5"
            value={form.rounds}
            onChange={(event) => onFormChange("rounds", event.target.value)}
          />
        </label>

        <div className="agents-header">
          <div>
            <p className="panel-kicker">Agents</p>
            <h3>System prompts</h3>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={onAddAgent}
            disabled={isRunning || agents.length >= CLIENT_LIMITS.maxAgents}
          >
            Add agent
          </button>
        </div>

        <div className="agents-grid">
          {agents.map((agent, index) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              index={index}
              files={agentFiles[agent.id] ?? []}
              isRunning={isRunning}
              canRemove={agents.length > 2}
              onUpdate={onAgentUpdate}
              onRemove={onRemoveAgent}
              onFilesSelected={onAgentFilesSelected}
              onRemoveFile={onAgentRemoveFile}
            />
          ))}
        </div>

        {error ? <p className="error-banner">{error}</p> : null}

        <div className="action-row">
          <div className="model-picker field compact-field">
            <span>AI model</span>
            <select
              className="model-select"
              value={form.model}
              onChange={(event) => onFormChange("model", event.target.value)}
              disabled={isRunning}
            >
              {MODEL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="primary-button" disabled={isRunning}>
            {isRunning ? "Debate in progress..." : "Start debate"}
          </button>
          <p className="status-copy">{status}</p>
        </div>
      </form>
    </section>
  );
}
