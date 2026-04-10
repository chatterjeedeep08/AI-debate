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
- Hardened API request validation, upload restrictions, CORS allowlisting, and rate limiting

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
- `CORS_ALLOWED_ORIGINS` - comma-separated browser origins allowed to call the API
- `TRUST_PROXY` - set to `true` when the app runs behind a trusted reverse proxy
- `MAX_JSON_BODY_BYTES` - optional JSON body limit for API requests
- `API_GLOBAL_RATE_LIMIT_WINDOW_MS` - window for global API throttling
- `API_GLOBAL_RATE_LIMIT_IP_MAX` - per-IP requests allowed in the global window
- `API_GLOBAL_RATE_LIMIT_USER_MAX` - per-authenticated-user requests allowed in the global window
- `API_HEALTH_RATE_LIMIT_IP_MAX` - per-IP health-check limit in the global window
- `DEBATE_RATE_LIMIT_WINDOW_MS` - window for debate creation throttling
- `DEBATE_RATE_LIMIT_IP_MAX` - per-IP debate runs allowed in the debate window
- `DEBATE_RATE_LIMIT_USER_MAX` - per-authenticated-user debate runs allowed in the debate window
- `DEBATE_MAX_IN_FLIGHT_IP` - maximum concurrent debate runs allowed per IP

## Security notes

- Keep secrets only in ignored environment files or your deployment platform's secret manager.
- Do not use `VITE_`-prefixed variables for secrets. The build now fails if a client-exposed variable name looks sensitive.
- Production browser origins should be explicitly set in `CORS_ALLOWED_ORIGINS`.

## Production

Build the frontend:

```bash
npm run build
```

Then run the server:

```bash
npm start
```
