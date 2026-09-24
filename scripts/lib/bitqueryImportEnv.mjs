import { parse as parseDotenv } from "dotenv";

export function prepareBitqueryEnv(input, oldContent) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("BITQUERY_CREDENTIALS_INVALID");
  }

  const hasApiKey = Object.hasOwn(input, "apiKey");
  const hasClientId = Object.hasOwn(input, "clientId");
  const hasClientSecret = Object.hasOwn(input, "clientSecret");
  let updates;
  let status;

  if (hasApiKey) {
    const apiKey = input.apiKey;
    if (hasClientId || hasClientSecret || typeof apiKey !== "string"
      || apiKey.length < 8 || /\s/.test(apiKey)) {
      throw new Error("BITQUERY_API_KEY_INVALID");
    }
    updates = {
      BITQUERY_CLIENT_ID: "",
      BITQUERY_CLIENT_SECRET: "",
      BITQUERY_API_KEY: apiKey,
    };
    status = "BITQUERY_API_KEY_INSTALLED";
  } else {
    const { clientId, clientSecret } = input;
    if (typeof clientId !== "string" || typeof clientSecret !== "string"
      || clientId.length < 8 || clientSecret.length < 8
      || /[\r\n]/.test(clientId) || /[\r\n]/.test(clientSecret)) {
      throw new Error("BITQUERY_CREDENTIALS_INVALID");
    }
    updates = {
      BITQUERY_CLIENT_ID: clientId,
      BITQUERY_CLIENT_SECRET: clientSecret,
      BITQUERY_API_KEY: "",
    };
    status = "BITQUERY_CREDENTIALS_INSTALLED";
  }

  const kept = oldContent.split(/\r?\n/).filter((line) => !Object.hasOwn(updates, line.split("=", 1)[0]));
  const nextContent = `${kept.filter(Boolean).join("\n")}\n${Object.entries(updates).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n")}\n`;
  const parsed = parseDotenv(nextContent);
  if (Object.entries(updates).some(([key, value]) => parsed[key] !== value)) {
    throw new Error("BITQUERY_ENV_ROUNDTRIP_FAILED");
  }
  return { nextContent, status };
}
