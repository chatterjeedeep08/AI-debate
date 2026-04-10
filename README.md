# AI Debate Studio

A web app where multiple AI agents debate a user-defined topic, optionally use live web search, and work toward a decision summary.

## Features

- Starts with two agents by default and lets you add more before launching a debate
- Separate topic and debate-objective inputs
- Configurable system prompt for every agent
- Live chat-style transcript streamed from the server
- Gemini and Claude model selection from the setup panel
- Web-backed debate turns when the selected model supports live search in this app
- Moderator summary at the end with the emerging recommendation

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a local environment file:

   ```bash
   copy .env.example .env
   ```

3. Add at least one provider key to `.env`:

   - `GEMINI_API_KEY` for Gemini models
   - `ANTHROPIC_API_KEY` for Claude models

4. Start the development servers:

   ```bash
   npm run dev
   ```

5. Open `http://localhost:5173`.

## Environment variables

- `GEMINI_API_KEY` - required for Gemini models
- `ANTHROPIC_API_KEY` - required for Claude models
- `PORT` - optional, defaults to `3001`
- `GEMINI_MODEL` - optional backend fallback model, defaults to `gemini-2.5-flash`

## Production

Build the frontend:

```bash
npm run build
```

Then run the server:

```bash
npm start
```
