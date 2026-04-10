const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const REQUEST_TIMEOUT_MS = 45_000;

function getAnthropicApiKey() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is missing. Add it to your .env file to use Claude models.",
    );
  }

  return process.env.ANTHROPIC_API_KEY;
}

export async function createAnthropicMessage(payload) {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": API_VERSION,
      "x-api-key": getAnthropicApiKey(),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    if (data) {
      throw new Error(JSON.stringify(data));
    }

    throw new Error(`Anthropic request failed with status ${response.status}.`);
  }

  return data;
}
