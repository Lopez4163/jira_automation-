const axios = require("axios");
const db = require("../db");

async function handleGithubWebhook(req, res) {
  try {
    const event = req.headers["x-github-event"];
    const { action, pull_request, issue } = req.body;

    // Only handle PR opened events
    if (event !== "pull_request" || action !== "opened") {
      return res.status(200).json({ message: "Event ignored" });
    }

    const prNumber = pull_request.number;
    const prUrl = pull_request.html_url;
    const prTitle = pull_request.title;

    // Extract issue number from PR body or branch name
    const branchName = pull_request.head.ref;
    const issueMatch = branchName.match(/issue-(\d+)/) || prTitle.match(/#(\d+)/);

    if (!issueMatch) {
      console.log("Could not find issue number in PR, skipping");
      return res.status(200).json({ message: "No issue number found" });
    }

    const githubIssueNumber = parseInt(issueMatch[1]);
    console.log(`PR #${prNumber} opened for issue #${githubIssueNumber}`);

    // Update DB mapping
    db.updateWithPR(githubIssueNumber, prNumber, prUrl);

    // Get Jira ticket from mapping
    const mapping = db.getByIssueNumber(githubIssueNumber);
    if (!mapping) {
      console.log(`No Jira mapping found for issue #${githubIssueNumber}`);
      return res.status(200).json({ message: "No mapping found" });
    }

    const jiraTicket = mapping.jira_ticket;
    console.log(`Updating Jira ticket ${jiraTicket} with PR #${prNumber}`);

    // Post PR link as comment on Jira ticket
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
              text: `✅ Claude Code has opened a PR for this ticket!\n\nPR #${prNumber}: ${prTitle}\n${prUrl}`
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

    // Transition Jira ticket to "In Review"
    const transitionsRes = await axios.get(
      `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${jiraTicket}/transitions`,
      {
        auth: {
          username: process.env.JIRA_EMAIL,
          password: process.env.JIRA_API_TOKEN
        }
      }
    );

    const inReview = transitionsRes.data.transitions.find(
      t => t.name.toLowerCase().includes("review") || t.name.toLowerCase().includes("progress")
    );

    if (inReview) {
      await axios.post(
        `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${jiraTicket}/transitions`,
        { transition: { id: inReview.id } },
        {
          auth: {
            username: process.env.JIRA_EMAIL,
            password: process.env.JIRA_API_TOKEN
          }
        }
      );
      console.log(`Transitioned ${jiraTicket} to ${inReview.name}`);
    }

    res.status(200).json({ success: true, jiraTicket, prNumber });

  } catch (err) {
    console.error("Error handling GitHub webhook:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { handleGithubWebhook };