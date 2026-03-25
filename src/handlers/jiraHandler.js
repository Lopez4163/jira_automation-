const axios = require("axios");
const db = require("../db");

function getTextFromAdfNode(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(getTextFromAdfNode).filter(Boolean).join("");
  if (typeof node.text === "string") return node.text;
  if (Array.isArray(node.content)) return node.content.map(getTextFromAdfNode).filter(Boolean).join("");
  return "";
}

function extractJiraDescription(rawDescription) {
  if (!rawDescription) return "No description provided.";
  if (typeof rawDescription === "string") return rawDescription.trim() || "No description provided.";
  const fromAdf = getTextFromAdfNode(rawDescription).trim();
  return fromAdf || "No description provided.";
}

function axiosErrorDetails(err) {
  if (!err.response) return { message: err.message };
  return {
    message: err.message,
    status: err.response.status,
    data: err.response.data
  };
}

async function handleJiraWebhook(req, res) {
  const requestId = `jira-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const { issue, webhookEvent } = req.body;

    if (webhookEvent !== "jira:issue_created") {
      return res.status(200).json({ message: "Event ignored" });
    }

    if (!issue?.key || !issue?.fields?.summary) {
      console.error(`[${requestId}] Invalid Jira payload`, {
        webhookEvent,
        hasIssue: Boolean(issue),
        issueKey: issue?.key
      });
      return res.status(400).json({ error: "Invalid Jira issue payload" });
    }

    const jiraTicket = issue.key;
    const summary = issue.fields.summary;
    const description = extractJiraDescription(issue.fields.description);
    const issueType = issue.fields.issuetype?.name || "Task";
    const priority = issue.fields.priority?.name || "Medium";

    console.log(`[${requestId}] Received Jira ticket: ${jiraTicket} - ${summary}`);

    // Create GitHub Issue
    let githubRes;
    try {
      githubRes = await axios.post(
        `https://api.github.com/repos/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/issues`,
        {
          title: `[${jiraTicket}] ${summary}`,
          body: `## Jira Ticket: ${jiraTicket}\n\n**Type:** ${issueType}\n**Priority:** ${priority}\n\n## Description\n${description}\n\n---\n*This issue was automatically created from Jira ticket ${jiraTicket}*`,
          labels: ["automation", "jira"]
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json"
          },
          timeout: 15000
        }
      );
    } catch (err) {
      console.error(`[${requestId}] GitHub issue creation failed`, axiosErrorDetails(err));
      return res.status(500).json({ error: "GitHub issue creation failed" });
    }

    const githubIssueNumber = githubRes.data.number;
    console.log(`[${requestId}] Created GitHub issue #${githubIssueNumber}`);

    // Save mapping
    db.createMapping(jiraTicket, githubIssueNumber);

    // Trigger Claude Code workflow
    try {
      await axios.post(
        `https://api.github.com/repos/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/dispatches`,
        {
          event_type: "claude-code-trigger",
          client_payload: {
            issue_number: githubIssueNumber,
            jira_ticket: jiraTicket,
            summary
          }
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json"
          },
          timeout: 15000
        }
      );
    } catch (err) {
      console.error(`[${requestId}] GitHub dispatch failed`, axiosErrorDetails(err));
      return res.status(500).json({ error: "GitHub dispatch failed" });
    }

    console.log(`[${requestId}] Triggered Claude Code workflow for issue #${githubIssueNumber}`);

    // Comment on Jira ticket
    try {
      await axios.post(
        `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${jiraTicket}/comment`,
        {
          body: {
            type: "doc",
            version: 1,
            content: [{
              type: "paragraph",
              content: [{
                type: "text",
                text: `GitHub Issue #${githubIssueNumber} created and Claude Code has been triggered. Track progress: https://github.com/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/issues/${githubIssueNumber}`
              }]
            }]
          }
        },
        {
          auth: {
            username: process.env.JIRA_EMAIL,
            password: process.env.JIRA_API_TOKEN
          },
          timeout: 15000
        }
      );
    } catch (err) {
      // Non-fatal for webhook completion; issue and dispatch already succeeded.
      console.error(`[${requestId}] Jira comment failed`, axiosErrorDetails(err));
    }

    res.status(200).json({ success: true, githubIssueNumber, jiraTicket });

  } catch (err) {
    console.error(`[${requestId}] Error handling Jira webhook`, axiosErrorDetails(err));
    res.status(500).json({ error: err.message });
  }
}

module.exports = { handleJiraWebhook };
