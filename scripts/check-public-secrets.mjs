import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

const listed = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
);

const files = listed.split("\0").filter(Boolean);
const skippedExtensions = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2",
  ".ttf", ".zip", ".gz", ".pdf", ".mp4", ".mov", ".sqlite", ".db",
]);

const joined = (...parts) => new RegExp(parts.join(""), "i");
const rules = [
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
];

const suspiciousNames = [
  /(^|\/)\.env($|\.)/i,
  /(^|\/)(id_rsa|id_ed25519)$/i,
  /\.(pem|key|p12|pfx)$/i,
];

const findings = [];

for (const file of files) {
  const normalized = file.replaceAll("\\", "/");
  const isSafeExample = normalized === ".env.example" || normalized.endsWith("/.env.example");
  if (!isSafeExample && suspiciousNames.some((pattern) => pattern.test(normalized))) {
    findings.push({ file: normalized, line: 1, rule: "sensitive filename" });
    continue;
  }

  if (skippedExtensions.has(extname(file).toLowerCase())) continue;

  let size;
  try {
    size = statSync(file).size;
  } catch {
    continue;
  }
  if (size > 1_000_000) continue;

  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const rule of rules) {
      if (rule.pattern.test(line)) {
        findings.push({ file: normalized, line: index + 1, rule: rule.name });
      }
    }
  });
}

if (findings.length > 0) {
  console.error("Potential secrets found. Values are hidden:");
  findings.forEach(({ file, line, rule }) => console.error(`- ${file}:${line} (${rule})`));
  process.exit(1);
}

console.log(`Secret scan passed for ${files.length} publishable files`);
