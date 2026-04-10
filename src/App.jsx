import { useMemo, useState } from "react";
import DebateSetupPanel from "./components/DebateSetupPanel.jsx";
import HeroSection from "./components/HeroSection.jsx";
import TranscriptPanel from "./components/TranscriptPanel.jsx";
import {
  CLIENT_LIMITS,
  INITIAL_AGENTS,
  INITIAL_FORM,
  buildRateLimitMessage,
  checkBackendAvailability,
  createAgent,
  getFriendlyErrorMessage,
  mergeFiles,
  removeFile,
  validateDebateBeforeSubmit,
  DOCUMENT_ACCEPT,
  TOPIC_ACCEPT,
} from "./utils/debateHelpers.js";

export default function App() {
  const [agents, setAgents] = useState(INITIAL_AGENTS);
  const [form, setForm] = useState(INITIAL_FORM);
  const [events, setEvents] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState("Ready to start a new debate.");
  const [error, setError] = useState("");
  const [topicFiles, setTopicFiles] = useState([]);
  const [debatePromptFiles, setDebatePromptFiles] = useState([]);
  const [agentFiles, setAgentFiles] = useState(
    Object.fromEntries(INITIAL_AGENTS.map((agent) => [agent.id, []])),
  );

  const transcriptMessages = useMemo(
    () => events.filter((event) => event.type === "message"),
    [events],
  );

  const summary = useMemo(
    () => events.findLast((event) => event.type === "summary") ?? null,
    [events],
  );

  function pushRejectedFiles(rejected, scopeLabel) {
    if (rejected.length > 0) {
      setError(`Unsupported files for ${scopeLabel}: ${rejected.join(", ")}.`);
    }
  }

  function updateAgent(id, field, value) {
    setAgents((current) =>
      current.map((agent) =>
        agent.id === id ? { ...agent, [field]: value } : agent,
      ),
    );
  }

  function updateForm(field, value) {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function addAgent() {
    if (agents.length >= CLIENT_LIMITS.maxAgents) {
      setError(`At most ${CLIENT_LIMITS.maxAgents} agents are allowed per debate.`);
      return;
    }

    const nextAgent = createAgent(agents.length);
    setAgents((current) => [...current, nextAgent]);
    setAgentFiles((current) => ({
      ...current,
      [nextAgent.id]: [],
    }));
    setError("");
  }

  function removeAgent(id) {
    setAgents((current) => {
      if (current.length <= 2) {
        return current;
      }

      return current.filter((agent) => agent.id !== id);
    });

    setAgentFiles((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  function handleTopicFilesSelected(event) {
    const selection = Array.from(event.target.files || []);
    const merged = mergeFiles(topicFiles, selection, TOPIC_ACCEPT);
    setTopicFiles(merged.files);
    pushRejectedFiles(merged.rejected, "the debate topic");
    event.target.value = "";
  }

  function handleDebatePromptFilesSelected(event) {
    const selection = Array.from(event.target.files || []);
    const merged = mergeFiles(debatePromptFiles, selection, DOCUMENT_ACCEPT);
    setDebatePromptFiles(merged.files);
    pushRejectedFiles(merged.rejected, "the debate prompt");
    event.target.value = "";
  }

  function handleAgentFilesSelected(agentId, event) {
    const selection = Array.from(event.target.files || []);
    const existingFiles = agentFiles[agentId] ?? [];
    const merged = mergeFiles(existingFiles, selection, DOCUMENT_ACCEPT);
    setAgentFiles((current) => ({
      ...current,
      [agentId]: merged.files,
    }));
    pushRejectedFiles(merged.rejected, "the system prompt");
    event.target.value = "";
  }

  async function startDebate(event) {
    event.preventDefault();
    setError("");

    const validationError = validateDebateBeforeSubmit({
      form,
      agents,
      topicFiles,
      debatePromptFiles,
      agentFiles,
    });

    if (validationError) {
      setError(validationError);
      return;
    }

    const trimmedAgents = agents.map((agent) => ({
      ...agent,
      name: agent.name.trim(),
      systemPrompt: agent.systemPrompt.trim(),
    }));

    setIsRunning(true);
    setEvents([]);
    setStatus("Starting debate...");

    try {
      const formData = new FormData();
      formData.append(
        "payload",
        JSON.stringify({
          topic: form.topic.trim(),
          debatePrompt: form.debatePrompt.trim(),
          model: form.model,
          rounds: Number(form.rounds),
          agents: trimmedAgents,
        }),
      );

      for (const file of topicFiles) {
        formData.append("topicFiles", file);
      }

      for (const file of debatePromptFiles) {
        formData.append("debatePromptFiles", file);
      }

      for (const agent of trimmedAgents) {
        for (const file of agentFiles[agent.id] ?? []) {
          formData.append(`agentFiles:${agent.id}`, file);
        }
      }

      const response = await fetch("/api/debates", {
        method: "POST",
        body: formData,
      });

      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null);

        if (response.status === 429) {
          throw new Error(
            payload?.error ?? buildRateLimitMessage(response.headers.get("Retry-After")),
          );
        }

        throw new Error(payload?.error ?? "Unable to start the debate.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          if (!part.trim()) {
            continue;
          }

          const parsed = JSON.parse(part);
          setEvents((current) => [...current, parsed]);

          if (parsed.type === "status") {
            setStatus(parsed.message);
          }

          if (parsed.type === "error") {
            throw new Error(parsed.message);
          }
        }
      }

      setStatus("Debate complete.");
    } catch (debateError) {
      const backendIsReachable = await checkBackendAvailability();

      if (!backendIsReachable) {
        setError(
          "The frontend cannot reach the backend API. Start the app with npm run dev or npm start, then open the app at the served localhost URL.",
        );
      } else {
        setError(getFriendlyErrorMessage(debateError));
      }

      setStatus("Debate stopped.");
    } finally {
      setIsRunning(false);
    }
  }

  function resetWorkspace() {
    setEvents([]);
    setStatus("Ready to start a new debate.");
    setError("");
  }

  function removeTopicFile(targetId) {
    setTopicFiles((current) => removeFile(current, targetId));
  }

  function removeDebatePromptFile(targetId) {
    setDebatePromptFiles((current) => removeFile(current, targetId));
  }

  function removeAgentFile(agentId, targetId) {
    setAgentFiles((current) => ({
      ...current,
      [agentId]: removeFile(current[agentId] ?? [], targetId),
    }));
  }

  return (
    <div className="page-shell">
      <HeroSection />

      <main className="workspace">
        <DebateSetupPanel
          agentFiles={agentFiles}
          agents={agents}
          debatePromptFiles={debatePromptFiles}
          error={error}
          form={form}
          isRunning={isRunning}
          status={status}
          topicFiles={topicFiles}
          onAddAgent={addAgent}
          onAgentFilesSelected={handleAgentFilesSelected}
          onAgentRemoveFile={removeAgentFile}
          onAgentUpdate={updateAgent}
          onClearTranscript={resetWorkspace}
          onDebatePromptFilesSelected={handleDebatePromptFilesSelected}
          onFormChange={updateForm}
          onRemoveAgent={removeAgent}
          onRemoveDebatePromptFile={removeDebatePromptFile}
          onRemoveTopicFile={removeTopicFile}
          onStartDebate={startDebate}
          onTopicFilesSelected={handleTopicFilesSelected}
        />

        <TranscriptPanel
          transcriptMessages={transcriptMessages}
          summary={summary}
        />
      </main>
    </div>
  );
}
