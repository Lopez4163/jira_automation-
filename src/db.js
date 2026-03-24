const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "../automation.db"));

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jira_ticket TEXT UNIQUE NOT NULL,
      github_issue_number INTEGER,
      github_pr_number INTEGER,
      pr_url TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log("Database initialized");
}

function createMapping(jiraTicket, githubIssueNumber) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO mappings (jira_ticket, github_issue_number, status, updated_at)
    VALUES (?, ?, 'issue_created', CURRENT_TIMESTAMP)
  `);
  return stmt.run(jiraTicket, githubIssueNumber);
}

function updateWithPR(githubIssueNumber, prNumber, prUrl) {
  const stmt = db.prepare(`
    UPDATE mappings
    SET github_pr_number = ?, pr_url = ?, status = 'pr_opened', updated_at = CURRENT_TIMESTAMP
    WHERE github_issue_number = ?
  `);
  return stmt.run(prNumber, prUrl, githubIssueNumber);
}

function getByIssueNumber(githubIssueNumber) {
  return db.prepare("SELECT * FROM mappings WHERE github_issue_number = ?").get(githubIssueNumber);
}

function getByJiraTicket(jiraTicket) {
  return db.prepare("SELECT * FROM mappings WHERE jira_ticket = ?").get(jiraTicket);
}

module.exports = { init, createMapping, updateWithPR, getByIssueNumber, getByJiraTicket };