import { execFileSync } from "node:child_process";

const base = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "HEAD^";

const changedFiles = execFileSync(
  "git",
  ["diff", "--name-only", "--diff-filter=ACMR", "-z", base, "HEAD"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter((file) => /\.(?:[cm]?js|tsx?|jsx|json|css|scss|md|ya?ml)$/.test(file));

if (changedFiles.length === 0) {
  console.log("No changed files to format-check.");
} else {
  execFileSync("node_modules/.bin/prettier", ["--check", ...changedFiles], {
    stdio: "inherit",
  });
}
