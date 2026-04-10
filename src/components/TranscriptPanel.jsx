export default function TranscriptPanel({ transcriptMessages, summary }) {
  return (
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
              Start a run to watch agents respond in chat format round by round.
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
  );
}
