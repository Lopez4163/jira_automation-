require("dotenv").config();
const express = require("express");
const db = require("./db");
const { handleJiraWebhook } = require("./handlers/jiraHandler");
const { handleGithubWebhook } = require("./handlers/githubHandler");

const app = express();
app.use(express.json());

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