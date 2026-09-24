const joined = (...parts) => new RegExp(parts.join(""), "i");

// Keep sample credentials assembled at runtime in tests so the scanner can scan its own source.
export const rules = [
  { name: "Alchemy API key", pattern: joined("alch", "_[A-Za-z0-9_-]{16,}") },
  { name: "GitHub token", pattern: joined("(?:ghp|github_pat)", "_[A-Za-z0-9_]{20,}") },
  { name: "private-key file body", pattern: joined("BEGIN ", "(?:RSA |EC |OPENSSH )?PRIVATE KEY") },
  {
    name: "64-byte private key assignment",
    pattern: joined("(?:PRIVATE_KEY|DEPLOYER_KEY|AUTOMATION_KEY|REWARD_KEY)", "\\s*[:=]\\s*[\\\"']?(?:0x)?[a-f0-9]{64}"),
  },
  {
    name: "password assignment",
    pattern: joined("(?:PASSWORD|PASSWD)", "\\s*[:=]\\s*[\\\"']?[^\\s\\\"']{8,}"),
  },
  {
    name: "Bitquery credential assignment",
    pattern: joined("(?:BITQUERY_API_KEY|BITQUERY_CLIENT_SECRET)", "\\s*[:=]\\s*[\\\"']?(?!process\\.env\\.|import\\.meta\\.env\\.|env\\.|YOUR_|REPLACE_)[A-Za-z0-9._~+/-]{32,}"),
  },
  {
    name: "Helius credential assignment",
    pattern: joined("HELIUS(?:_API)?_KEY", "\\s*[:=]\\s*[\\\"']?[A-Za-z0-9_-]{20,}"),
  },
  {
    name: "JWT credential",
    pattern: joined("\\beyJ[A-Za-z0-9_-]{16,}", "\\.eyJ[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{12,}\\b"),
  },
  {
    name: "QuickNode credential URL",
    pattern: joined("https?:\\/\\/[A-Za-z0-9.-]*quiknode\\.pro\\/", "[A-Za-z0-9_-]{16,}"),
  },
  {
    name: "Alchemy credential URL",
    pattern: joined("https?:\\/\\/[A-Za-z0-9.-]*g\\.alchemy\\.com\\/v2\\/", "[A-Za-z0-9_-]{16,}"),
  },
  {
    name: "credential in URL query",
    pattern: joined("https?:\\/\\/[^\\s\\\"'<>]*[?&](?:api-key|api_key|apikey|access_token|token)=", "[A-Za-z0-9._~-]{16,}"),
  },
  {
    name: "credential in URL authority",
    pattern: joined("https?:\\/\\/[^\\s\\/\\\"'@:]+:", "[^\\s\\/\\\"'@]{8,}@[A-Za-z0-9.-]+"),
  },
];
