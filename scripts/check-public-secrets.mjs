import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { rules } from "./lib/publicSecretPatterns.mjs";

function filesystemFiles(root = process.cwd()) {
  const excludedDirectories = new Set([".git", "node_modules", "artifacts", "cache", "coverage", "dist", "work"]);
  const result = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && !lstatSync(absolute).isSymbolicLink()) result.push(relative(root, absolute));
    }
  };
  walk(root);
  return result;
}

let files;
try {
  const listed = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  files = listed.split("\0").filter(Boolean);
} catch {
  files = filesystemFiles();
}
const skippedExtensions = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2",
  ".ttf", ".otf", ".zip", ".gz", ".pdf", ".mp4", ".mov", ".webm", ".mp3", ".wav", ".sqlite", ".db",
]);

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
