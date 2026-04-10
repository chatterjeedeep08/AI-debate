export default function HeroSection() {
  return (
    <header className="hero">
      <div>
        <p className="eyebrow">AI Debate Studio</p>
        <h1>Let multiple AI agents argue their way to a sharper decision.</h1>
        <p className="hero-copy">
          Configure each agent&apos;s system prompt, add supporting files and
          topic images, then watch a web-enabled, round-by-round discussion
          stream live.
        </p>
      </div>
      <div className="hero-card">
        <span className="hero-label">How it works</span>
        <p>Start with two agents, add more as needed, then launch the debate.</p>
        <p>Prompt files are ingested into context, and topic images are passed directly to Gemini.</p>
      </div>
    </header>
  );
}
