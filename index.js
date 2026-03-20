#!/usr/bin/env node
const path = require("path");
const { Command } = require("commander");
const chalk = require("chalk");
const inquirer = require("inquirer");
const { exec } = require("child_process");
const fetch = require("node-fetch");
const OpenAI = require("openai");
const fs = require("fs");
const low = require("lowdb");
const FileSync = require("lowdb/adapters/FileSync");

const adapter = new FileSync("history.json");
const db = low(adapter);
db.defaults({ history: [] }).write();

const program = new Command();
const PROVIDER = process.env.SMARTCLI_PROVIDER || "ollama";

// ===== HISTORY =====
function saveHistory(input) {
  db.get("history").push({ input, time: Date.now() }).write();
}

// ===== VALIDATOR =====
function isValidCommand(cmd) {
  if (!cmd) return false;
  cmd = cmd.trim();
  if (!/^[a-z0-9]/i.test(cmd)) return false;
  if (cmd.split(" ").length > 50) return false;
  return true;
}

// ===== PROMPT =====
function prompt(input) {
  return `
You are a CLI command generator.

STRICT RULES:
- Output ONLY JSON array of shell commands
- NO explanation
- NO text
- NO backticks
- NO sentences
- If unsure → []

Examples:

Input: create two folders client and server
Output: ["mkdir client server"]

Input: install express mongoose
Output: ["npm install express mongoose"]

Input: ${input}
Output:
`;
}

// ===== CLEAN =====
function clean(res) {
  if (!res) return null;
  const match = res.match(/\[[\s\S]*\]/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  return null;
}

// ===== AI =====
async function parseAI(input) {
  if (PROVIDER === "ollama") return ollama(input);
  if (PROVIDER === "openai") return openai(input);
  return null;
}

async function ollama(input) {
  try {
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mistral", prompt: prompt(input), stream: false })
    });
    const data = await res.json();
    return clean(data.response);
  } catch { return null; }
}

async function openai(input) {
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt(input) }]
    });
    return clean(res.choices[0].message.content);
  } catch { return null; }
}

// ===== RETRY =====
async function getValidCommands(input) {
  for (let i = 0; i < 2; i++) {
    const cmds = await parseAI(input);
    if (!cmds) continue;
    const valid = cmds.filter(isValidCommand);
    if (valid.length) return valid;
  }
  return null;
}

// ===== FALLBACK =====
function fallback(input) {
  input = input.toLowerCase();

  if (input.includes("folder") || input.includes("directory")) {
    if (input.includes("and")) {
      const names = input
        .split(/and|,/)
        .map(s => s.replace(/[^a-z0-9_-]/g, "").trim())
        .filter(Boolean);
      if (names.length > 0) return [`mkdir ${names.join(" ")}`];
    }
    return ["mkdir new-folder"];
  }

  if (input.includes("install")) {
    const list = input
      .split("install")[1]
      ?.split(/,|\s+/)
      .map(p => p.trim())
      .filter(Boolean);
    if (list?.length) return [`npm install ${list.join(" ")}`];
  }

  if (input.includes("start") || input.includes("run")) return ["npm start"];

  if (input.includes("file")) {
    const match = input.match(/file\s([a-z0-9._-]+)/);
    const name = match ? match[1] : "index.js";
    return [`touch ${name}`];
  }

  if (input.includes("git init")) return ["git init"];
  if (input.includes("commit")) return ["git add .", "git commit -m 'auto commit'"];
  if (input.includes("branch") || input.includes("feature")) {
    const name = input.replace(/create|branch|feature/g, "").trim().replace(/\s+/g, "-");
    return [`git checkout -b ${name || "new-branch"}`];
  }

  if (input.includes("push")) return ["git push -f"];

  return null;
}

// ===== RUN =====
function run(cmd, cwd) {
  return new Promise(resolve => {
    exec(cmd, { cwd }, (e, out, err) => {
      if (out) console.log(out);
      if (err) console.log(err);
      resolve({ error: e ? err || e.message : null });
    });
  });
}

// ===== FIX =====
async function fixCommand(cmd, error, input) {
  const fixPrompt = `
Command failed.

Original command:
${cmd}

Error:
${error}

User intent:
${input}

Return ONLY ONE corrected shell command.
No explanation. No backticks. No extra text.
`;
  try {
    let res;
    if (PROVIDER === "ollama") {
      const r = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "mistral", prompt: fixPrompt, stream: false })
      });
      const data = await r.json();
      res = data.response;
    }

    if (PROVIDER === "openai") {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const r = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: fixPrompt }]
      });
      res = r.choices[0].message.content;
    }

    if (!res) return null;

    const lines = res.split("\n").map(l => l.trim()).filter(Boolean);
    for (let l of lines) {
      if (isValidCommand(l)) return l;
    }
    return null;
  } catch { return null; }
}

// ===== AGENT EXECUTION WITH CONFIRM =====
async function agentExecute(commands, input) {
  let cwd = process.cwd();

  for (let cmd of commands) {
    if (!cmd) continue;

    if (cmd.startsWith("cd ")) {
      cwd = path.resolve(cwd, cmd.replace("cd ", ""));
      console.log(chalk.blue("📁 cd →", cwd));
      continue;
    }

    console.log(chalk.blue("👉", cmd));

    // === ASK USER BEFORE EXECUTION ===
    const { ok } = await inquirer.prompt([
      { type: "confirm", name: "ok", message: "run?" }
    ]);
    if (!ok) {
      console.log(chalk.yellow("⏭ skipped"));
      continue;
    }

    let result = await run(cmd, cwd);

    if (result.error) {
      console.log("❌ fixing...");
      const fixed = await fixCommand(cmd, result.error, input);
      if (!fixed) { console.log("❌ could not fix"); continue; }
      console.log("🔁", fixed);

      // Ask again before retrying
      const { retry } = await inquirer.prompt([
        { type: "confirm", name: "retry", message: "run fixed command?" }
      ]);
      if (!retry) continue;

      await run(fixed, cwd);
    }
  }
}

// ===== MAIN =====
program.argument("<input>");

program.action(async (input) => {
  console.log(chalk.blue(`\n🧠 ${input}\n`));

  saveHistory(input);

  let cmd = await getValidCommands(input);
  if (!cmd) cmd = fallback(input);

  if (!cmd) return console.log("❌ failed");

  console.log(chalk.green(JSON.stringify(cmd, null, 2)));

  await agentExecute(cmd, input);
});

program.parse();