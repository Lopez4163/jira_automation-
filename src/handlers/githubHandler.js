const axios = require("axios");
const db = require("../db");

function axiosErrorDetails(err) {
  if (!err.response) return { message: err.message };
  return {
    message: err.message,
    status: err.response.status,
    data: err.response.data
  };
}

function extractIssueNumberFromPR(pullRequest) {
  const branchName = pullRequest?.head?.ref || "";
  const title = pullRequest?.title || "";
  const body = pullRequest?.body || "";
  const branchMatch = branchName.match(/issue-(\d+)/i);
  if (branchMatch) return parseInt(branchMatch[1], 10);
  const titleMatch = title.match(/#(\d+)/);
  if (titleMatch) return parseInt(titleMatch[1], 10);
  const bodyMatch = body.match(/#(\d+)/);
  if (bodyMatch) return parseInt(bodyMatch[1], 10);
  return null;
}

function pickTransition(transitions, preferredNames, fallbackKeyword) {
  const normalized = preferredNames.map(name => name.toLowerCase());
  const exact = transitions.find(t => normalized.includes((t.name || "").toLowerCase()));
  if (exact) return exact;
  return transitions.find(t => (t.name || "").toLowerCase().includes(fallbackKeyword));
}

async function handleGithubWebhook(req, res) {
  const requestId = `gh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const event = req.headers["x-github-event"];
    const { action, pull_request } = req.body;
    const allowedActions = new Set(["opened", "reopened", "synchronize"]);
    const isMergedEvent = event === "pull_request" && action === "closed" && pull_request?.merged === true;

    // Handle PR lifecycle events that indicate PR is active/updated.
    if ((event !== "pull_request" || !allowedActions.has(action)) && !isMergedEvent) {
      return res.status(200).json({ message: "Event ignored" });
    }

    if (!pull_request?.number || !pull_request?.html_url) {
      console.error(`[${requestId}] Invalid GitHub PR payload`, {
        event,
        action,
        hasPullRequest: Boolean(pull_request)
      });
      return res.status(400).json({ error: "Invalid pull_request payload" });
    }

    const prNumber = pull_request.number;
    const prUrl = pull_request.html_url;
    const prTitle = pull_request.title;

    // Extract issue number from branch name, title, or body.
    let githubIssueNumber = extractIssueNumberFromPR(pull_request);
    if (!githubIssueNumber && isMergedEvent) {
      const byPR = db.getByPRNumber(prNumber);
      if (byPR?.github_issue_number) {
        githubIssueNumber = byPR.github_issue_number;
      }
    }

    if (!githubIssueNumber) {
      console.log(`[${requestId}] Could not find issue number in PR, skipping`);
      return res.status(200).json({ message: "No issue number found" });
    }

    console.log(`[${requestId}] PR #${prNumber} (${action}) for issue #${githubIssueNumber}`);

    // Update DB mapping
    db.updateWithPR(githubIssueNumber, prNumber, prUrl);

    // Get Jira ticket from mapping
    const mapping = db.getByIssueNumber(githubIssueNumber);
    if (!mapping) {
      console.log(`[${requestId}] No Jira mapping found for issue #${githubIssueNumber}`);
      return res.status(200).json({ message: "No mapping found" });
    }

    const jiraTicket = mapping.jira_ticket;
    console.log(`[${requestId}] Updating Jira ticket ${jiraTicket} with PR #${prNumber}`);

    // Post PR link as comment on Jira ticket
    const jiraCommentText = isMergedEvent
      ? `Claude PR has been merged.\n\nPR #${prNumber}: ${prTitle}\n${prUrl}`
      : `Claude Code has opened a PR for this ticket.\n\nPR #${prNumber}: ${prTitle}\n${prUrl}`;

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
                text: jiraCommentText
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
      console.error(`[${requestId}] Jira PR comment failed`, axiosErrorDetails(err));
    }

    // Transition Jira ticket based on PR state.
    try {
      const transitionsRes = await axios.get(
        `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${jiraTicket}/transitions`,
        {
          auth: {
            username: process.env.JIRA_EMAIL,
            password: process.env.JIRA_API_TOKEN
          },
          timeout: 15000
        }
      );

      const transitions = transitionsRes.data.transitions || [];
      const targetTransition = isMergedEvent
        ? pickTransition(
          transitions,
          ["Done", "Closed", "Complete"],
          "done"
        )
        : pickTransition(
          transitions,
          ["In Review", "Code Review", "Ready for Review"],
          "review"
        );

      const targetName = isMergedEvent ? "Done" : "In Review";
      if (targetTransition) {
        await axios.post(
          `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${jiraTicket}/transitions`,
          { transition: { id: targetTransition.id } },
          {
            auth: {
              username: process.env.JIRA_EMAIL,
              password: process.env.JIRA_API_TOKEN
            },
            timeout: 15000
          }
        );
        console.log(`[${requestId}] Transitioned ${jiraTicket} to ${targetTransition.name}`);
      } else {
        console.log(
          `[${requestId}] No ${targetName} transition found for ${jiraTicket}. Available: ${transitions.map(t => t.name).join(", ")}`
        );
      }
    } catch (err) {
      console.error(`[${requestId}] Jira transition failed`, axiosErrorDetails(err));
    }

    // Close mapped GitHub issue when PR is merged.
    if (isMergedEvent) {
      try {
        await axios.patch(
          `https://api.github.com/repos/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/issues/${githubIssueNumber}`,
          { state: "closed" },
          {
            headers: {
              Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
              Accept: "application/vnd.github+json"
            },
            timeout: 15000
          }
        );
        console.log(`[${requestId}] Closed GitHub issue #${githubIssueNumber} after merge`);
      } catch (err) {
        console.error(`[${requestId}] Failed to close GitHub issue #${githubIssueNumber}`, axiosErrorDetails(err));
      }
    }

    const responseState = isMergedEvent ? "merged" : "active";
    res.status(200).json({ success: true, jiraTicket, prNumber, state: responseState });

  } catch (err) {
    console.error(`[${requestId}] Error handling GitHub webhook`, axiosErrorDetails(err));
    res.status(500).json({ error: err.message });
  }
}

module.exports = { handleGithubWebhook };
