import { useMemo, useState } from "react";

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
  rounds: 2,
};

export default function App() {
  const [agents, setAgents] = useState(INITIAL_AGENTS);
  const [form, setForm] = useState(INITIAL_FORM);
  const [events, setEvents] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState("Ready to start a new debate.");
  const [error, setError] = useState("");

  const transcriptMessages = useMemo(
    () => events.filter((event) => event.type === "message"),
    [events],
  );

  const summary = useMemo(
    () => events.findLast((event) => event.type === "summary") ?? null,
    [events],
  );

  function updateAgent(id, field, value) {
    setAgents((current) =>
      current.map((agent) =>
        agent.id === id ? { ...agent, [field]: value } : agent,
      ),
    );
  }

  function addAgent() {
    setAgents((current) => [...current, createAgent(current.length)]);
  }

  function removeAgent(id) {
    setAgents((current) => {
      if (current.length <= 2) {
        return current;
      }

      return current.filter((agent) => agent.id !== id);
    });
  }

  async function startDebate(event) {
    event.preventDefault();
    setError("");

    if (!form.topic.trim()) {
      setError("Add a debate topic before starting.");
      return;
    }

    if (agents.length < 2) {
      setError("At least two agents are required.");
      return;
    }

    const trimmedAgents = agents.map((agent) => ({
      ...agent,
      name: agent.name.trim() || "Unnamed Agent",
      systemPrompt: agent.systemPrompt.trim(),
    }));

    if (trimmedAgents.some((agent) => !agent.systemPrompt)) {
      setError("Each agent needs a system prompt.");
      return;
    }

    setIsRunning(true);
    setEvents([]);
    setStatus("Starting debate...");

    try {
      const response = await fetch("/api/debates", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          topic: form.topic.trim(),
          debatePrompt: form.debatePrompt.trim(),
          rounds: Number(form.rounds),
          agents: trimmedAgents,
        }),
      });

      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null);
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

  return (
    <div className="page-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">AI Debate Studio</p>
          <h1>Let multiple AI agents argue their way to a sharper decision.</h1>
          <p className="hero-copy">
            Configure each agent&apos;s system prompt, set the debate objective,
            and watch a web-enabled, round-by-round discussion stream live.
          </p>
        </div>
        <div className="hero-card">
          <span className="hero-label">How it works</span>
          <p>Start with two agents, add more as needed, then launch the debate.</p>
          <p>Every turn is generated server-side with live web search available.</p>
        </div>
      </header>

      <main className="workspace">
        <section className="panel control-panel">
          <div className="panel-heading">
            <div>
              <p className="panel-kicker">Setup</p>
              <h2>Debate configuration</h2>
            </div>
            <button
              type="button"
              className="ghost-button"
              onClick={resetWorkspace}
              disabled={isRunning}
            >
              Clear transcript
            </button>
          </div>

          <form className="debate-form" onSubmit={startDebate}>
            <label className="field">
              <span>Debate topic</span>
              <textarea
                rows="3"
                placeholder="Example: Should a mid-sized SaaS company adopt AI agents for internal support operations in 2026?"
                value={form.topic}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    topic: event.target.value,
                  }))
                }
              />
            </label>

            <label className="field">
              <span>Debate prompt</span>
              <textarea
                rows="4"
                placeholder="Set the objective, desired tone, constraints, or success criteria for the debate."
                value={form.debatePrompt}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    debatePrompt: event.target.value,
                  }))
                }
              />
            </label>

            <label className="field compact-field">
              <span>Rounds per agent</span>
              <input
                type="number"
                min="1"
                max="5"
                value={form.rounds}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    rounds: event.target.value,
                  }))
                }
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
                onClick={addAgent}
                disabled={isRunning}
              >
                Add agent
              </button>
            </div>

            <div className="agents-grid">
              {agents.map((agent, index) => (
                <article className="agent-card" key={agent.id}>
                  <div className="agent-card-header">
                    <input
                      className="agent-name-input"
                      value={agent.name}
                      onChange={(event) =>
                        updateAgent(agent.id, "name", event.target.value)
                      }
                      disabled={isRunning}
                      aria-label={`Agent ${index + 1} name`}
                    />
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => removeAgent(agent.id)}
                      disabled={isRunning || agents.length <= 2}
                      aria-label={`Remove ${agent.name}`}
                    >
                      ×
                    </button>
                  </div>
                  <textarea
                    rows="6"
                    value={agent.systemPrompt}
                    onChange={(event) =>
                      updateAgent(agent.id, "systemPrompt", event.target.value)
                    }
                    disabled={isRunning}
                    placeholder="Define the agent's persona, priorities, and decision style."
                  />
                </article>
              ))}
            </div>

            {error ? <p className="error-banner">{error}</p> : null}

            <div className="action-row">
              <button type="submit" className="primary-button" disabled={isRunning}>
                {isRunning ? "Debate in progress..." : "Start debate"}
              </button>
              <p className="status-copy">{status}</p>
            </div>
          </form>
        </section>

        <section className="panel transcript-panel">
          <div className="panel-heading">
            <div>
              <p className="panel-kicker">Live transcript</p>
              <h2>Agent discussion</h2>
            </div>
          </div>

          <div className="transcript-stream">
            {transcriptMessages.length === 0 ? (
              <div className="empty-state">
                <p>No debate yet.</p>
                <span>
                  Start a run to watch agents respond in chat format round by
                  round.
                </span>
              </div>
            ) : (
              transcriptMessages.map((message) => (
                <article className="message-card" key={message.id}>
                  <div className="message-meta">
                    <div>
                      <span className="speaker-badge">{message.agentName}</span>
                      <span className="round-badge">Round {message.round}</span>
                    </div>
                    <span className="message-time">{message.timestamp}</span>
                  </div>
                  <p className="message-body">{message.content}</p>
                  {message.sources?.length ? (
                    <div className="sources">
                      <span>Sources</span>
                      {message.sources.map((source) => (
                        <a
                          key={`${message.id}-${source.url}`}
                          href={source.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {source.title || source.url}
                        </a>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))
            )}
          </div>

          {summary ? (
            <section className="summary-card">
              <p className="panel-kicker">Decision summary</p>
              <h3>What the debate landed on</h3>
              <p>{summary.content}</p>
            </section>
          ) : null}
        </section>
      </main>
    </div>
  );
}
