import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Octokit } from "octokit";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 读取配置：CLI > .env > 默认
const owner = process.argv[2] || process.env.OWNER || "pro-collection";
const repo = process.argv[3] || process.env.REPO || "interview-question";
const outDir = process.argv[4] || process.env.OUT_DIR || "out";
const token = process.env.GH_TOKEN || undefined;

const octokit = new Octokit({
  auth: token,
  userAgent: "issue-exporter-obsidian/1.2",
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sanitize = (s) =>
  (s ?? "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();

function truncTitleForFilename(title, maxLen = 80) {
  const t = sanitize(title);
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen - 1) + "…";
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

function issueToFrontmatter(issue) {
  const labels = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));
  const milestone = issue.milestone?.title || null;
  const fm = {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    author: issue.user?.login,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    labels,
    milestone,
    url: issue.html_url,
  };
  const body =
    "---\n" +
    Object.entries(fm)
      .map(([k, v]) => {
        if (Array.isArray(v)) return `${k}: [${v.map((x) => JSON.stringify(x)).join(", ")}]`;
        if (v === null || v === undefined) return `${k}: null`;
        return `${k}: ${JSON.stringify(v)}`;
      })
      .join("\n") +
    "\n---\n";
  return body;
}

function wrapIssueMarkdown(issue) {
  const fm = issueToFrontmatter(issue);
  const body = issue.body || "";
  return `${fm}\n# ${issue.title}\n\n> #${issue.number} · 原帖：${issue.html_url}\n\n${body}\n`;
}

async function fetchAllIssues({ owner, repo }) {
  const per_page = 100;
  let page = 1;
  let all = [];
  while (true) {
    const res = await octokit.rest.issues.listForRepo({
      owner,
      repo,
      state: "all",
      per_page,
      page,
      direction: "asc",
      sort: "created",
    });
    const batch = res.data.filter((it) => !it.pull_request);
    all.push(...batch);
    if (batch.length < per_page) break;
    await sleep(250);
    page++;
  }
  return all;
}

async function main() {
  console.log(`Repo: ${owner}/${repo}`);
  console.log(`Output: ${outDir}`);

  const issues = await fetchAllIssues({ owner, repo });
  console.log(`Total issues fetched: ${issues.length}`);

  const dirIssues = path.join(outDir, "issues");
  const dirByLabel = path.join(outDir, "by-label");
  const dirByMs = path.join(outDir, "by-milestone");
  await Promise.all([ensureDir(dirIssues), ensureDir(dirByLabel), ensureDir(dirByMs)]);

  // 索引结构
  const indexByLabel = new Map();     // label -> Set(issueNumber)
  const indexByMilestone = new Map(); // milestoneTitle -> Set(issueNumber)
  const numToMeta = new Map();        // number -> { filenameNoExt, displayText }

  // 写 issues/*.md，并构建映射
  for (const it of issues) {
    const titlePart = truncTitleForFilename(it.title, 80);
    const baseName = `${it.number}. ${titlePart}`;
    const filePath = path.join(dirIssues, `${baseName}.md`);
    await fs.writeFile(filePath, wrapIssueMarkdown(it), "utf-8");

    // Obsidian 双链目标（不带 .md）
    const filenameNoExt = baseName;
    const displayText = `#${it.number} ${sanitize(it.title)}`;

    numToMeta.set(it.number, { filenameNoExt, displayText });

    // 统计标签
    const labels = (it.labels || []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);
    for (const lb of labels) {
      if (!indexByLabel.has(lb)) indexByLabel.set(lb, new Set());
      indexByLabel.get(lb).add(it.number);
    }

    // 统计里程碑
    const ms = it.milestone?.title;
    if (ms) {
      if (!indexByMilestone.has(ms)) indexByMilestone.set(ms, new Set());
      indexByMilestone.get(ms).add(it.number);
    }
  }

  // 标签/里程碑文件名去冲突
  const takenNames = new Set();
  const safeName = (name) => {
    const s = sanitize(name);
    if (!takenNames.has(s)) {
      takenNames.add(s);
      return s;
    }
    let i = 2;
    while (takenNames.has(`${s}-${i}`)) i++;
    const t = `${s}-${i}`;
    takenNames.add(t);
    return t;
  };

  // 映射：分类显示名 -> 文件名
  const labelToFile = new Map([...indexByLabel.keys()].map((k) => [k, safeName(k)]));
  const msToFile = new Map([...indexByMilestone.keys()].map((k) => [k, safeName(k)]));

  // 生成按标签索引
  for (const [lb, set] of indexByLabel) {
    const arr = [...set].sort((a, b) => a - b);
    const lines = arr.map((n) => {
      const meta = numToMeta.get(n);
      return `- [[issues/${meta.filenameNoExt}|${meta.displayText}]]`;
    });
    const md =
      `# 标签：${lb}\n\n共 ${arr.length} 题\n\n` +
      lines.join("\n") +
      "\n";
    await fs.writeFile(path.join(dirByLabel, `${labelToFile.get(lb)}.md`), md, "utf-8");
  }

  // 生成按里程碑索引
  for (const [ms, set] of indexByMilestone) {
    const arr = [...set].sort((a, b) => a - b);
    const lines = arr.map((n) => {
      const meta = numToMeta.get(n);
      return `- [[issues/${meta.filenameNoExt}|${meta.displayText}]]`;
    });
    const md =
      `# 里程碑（难度）：${ms}\n\n共 ${arr.length} 题\n\n` +
      lines.join("\n") +
      "\n";
    await fs.writeFile(path.join(dirByMs, `${msToFile.get(ms)}.md`), md, "utf-8");
  }

  // 总索引
  const allLabels = [...indexByLabel.keys()].sort((a, b) => a.localeCompare(b, "zh"));
  const allMs = [...indexByMilestone.keys()].sort((a, b) => a.localeCompare(b, "zh"));
  const msLines = allMs.length
    ? allMs.map((ms) => `- [[by-milestone/${msToFile.get(ms)}|${ms}]]`).join("\n")
    : "_无里程碑_";
  const lbLines = allLabels.length
    ? allLabels.map((lb) => `- [[by-label/${labelToFile.get(lb)}|${lb}]]`).join("\n")
    : "_无标签_";

  const indexMd =
    `# ${owner}/${repo} 面试题离线索引\n\n` +
    `- 共导出 Issues：**${issues.length}**\n` +
    `- 两种视图：里程碑（难度） & 标签\n\n` +
    `## 里程碑视图\n${msLines}\n\n` +
    `## 标签视图\n${lbLines}\n`;

  await fs.writeFile(path.join(outDir, "index.md"), indexMd, "utf-8");

  console.log("Done.");
  console.log(`Put the '${outDir}' folder into your Obsidian vault and open 'index.md'.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
