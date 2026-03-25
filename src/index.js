require("dotenv").config();
const express = require("express");
const db = require("./db");
const { handleJiraWebhook } = require("./handlers/jiraHandler");
const { handleGithubWebhook } = require("./handlers/githubHandler");

const REQUIRED_ENV_VARS = [
  "JIRA_DOMAIN",
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
  "GITHUB_OWNER",
  "GITHUB_REPO",
  "GITHUB_TOKEN"
];

const missingVars = REQUIRED_ENV_VARS.filter(key => !process.env[key]);
if (missingVars.length > 0) {
  console.error(`Missing required environment variables: ${missingVars.join(", ")}`);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    console.log(`${req.method} ${req.path} -> ${res.statusCode} (${durationMs}ms)`);
  });
  next();
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/jira-webhook", handleJiraWebhook);
app.post("/github-webhook", handleGithubWebhook);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Automation server running on port ${PORT}`);
  db.init();
});
