# AI Debate Studio

A web app where multiple AI agents debate a user-defined topic, use Gemini with Google Search grounding when helpful, and work toward a decision summary.

## Features

- Starts with two agents by default and lets you add more before launching a debate
- Separate topic and debate-objective inputs
- Configurable system prompt for every agent
- Live chat-style transcript streamed from the server
- Gemini-powered agent turns with Google Search grounding for current information
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

3. Add your Gemini API key to `.env`.

4. Start the development servers:

   ```bash
   npm run dev
   ```

5. Open `http://localhost:5173`.

## Environment variables

- `GEMINI_API_KEY` - required
- `PORT` - optional, defaults to `3001`
- `GEMINI_MODEL` - optional, defaults to `gemini-2.5-flash`

## Production

Build the frontend:

```bash
npm run build
```

Then run the server:

```bash
npm start
```
