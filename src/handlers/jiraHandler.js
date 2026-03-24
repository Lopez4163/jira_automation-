const axios = require("axios");
const db = require("../db");

async function handleJiraWebhook(req, res) {
  try {
    const { issue, webhookEvent } = req.body;

    if (webhookEvent !== "jira:issue_created") {
      return res.status(200).json({ message: "Event ignored" });
    }

    const jiraTicket = issue.key;
    const summary = issue.fields.summary;
    const description = issue.fields.description?.content
      ?.map(block => block.content?.map(c => c.text).join(""))
      .join("\n") || "No description provided.";
    const issueType = issue.fields.issuetype?.name || "Task";
    const priority = issue.fields.priority?.name || "Medium";

    console.log(`Received Jira ticket: ${jiraTicket} - ${summary}`);

    // Create GitHub Issue
    const githubRes = await axios.post(
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
        }
      }
    );

    const githubIssueNumber = githubRes.data.number;
    console.log(`Created GitHub issue #${githubIssueNumber}`);

    // Save mapping
    db.createMapping(jiraTicket, githubIssueNumber);

    // Trigger Claude Code workflow
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
        }
      }
    );

    console.log(`Triggered Claude Code workflow for issue #${githubIssueNumber}`);

    // Comment on Jira ticket
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
        }
      }
    );

    res.status(200).json({ success: true, githubIssueNumber, jiraTicket });

  } catch (err) {
    console.error("Error handling Jira webhook:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { handleJiraWebhook };