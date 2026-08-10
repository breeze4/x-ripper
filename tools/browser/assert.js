#!/usr/bin/env node
// Scenario helper for tools/smoke-test: lists scenarios, reads fixture fields,
// and asserts a harness result file against a scenario's thresholds.
const fs = require("fs");

function usage(code) {
  const out = code ? console.error : console.log;
  out("assert.js — scenario registry and assertion helper for tools/smoke-test");
  out("Usage:");
  out("  assert.js list <scenarios.json>                    print scenario names");
  out("  assert.js get <scenarios.json> <name> <field>      print one fixture field");
  out("  assert.js check <scenarios.json> <name> <result>   assert result file, exit 1 on failure");
  out("Example: assert.js check tools/scenarios.json thread-long /tmp/thread-long.json");
  process.exit(code);
}

const [command, scenariosFile, name, extra] = process.argv.slice(2);

if (command === "-h" || command === "--help") {
  usage(0);
}

if (!command || !scenariosFile) {
  usage(2);
}

const scenarios = JSON.parse(fs.readFileSync(scenariosFile, "utf8"));

if (command === "list") {
  console.log(Object.keys(scenarios).join("\n"));
  process.exit(0);
}

const scenario = scenarios[name];

if (!scenario) {
  console.error(`Unknown scenario: ${name || "(missing)"}`);
  process.exit(2);
}

if (command === "get") {
  if (!extra || scenario[extra] === undefined) {
    console.error(`Unknown field: ${extra || "(missing)"}`);
    process.exit(2);
  }

  console.log(scenario[extra]);
  process.exit(0);
}

if (command !== "check") {
  usage(2);
}

if (!extra) {
  usage(2);
}

// agent-browser eval prints the evaluated value JSON-encoded, so the result
// file holds a JSON string containing JSON.
const result = JSON.parse(JSON.parse(fs.readFileSync(extra, "utf8").trim()));
const failures = [];
const check = (label, condition) => {
  if (!condition) {
    failures.push(label);
  }
};

if (result.threw) {
  check(`harness threw: ${result.threw}`, false);
}

if (scenario.kind === "thread") {
  const stats = result.stats || {};
  check(`entries ${stats.entryCount} >= ${scenario.minEntries}`, stats.entryCount >= scenario.minEntries);
  check(`expanded ${stats.expandedCount} >= ${scenario.minExpanded}`, stats.expandedCount >= scenario.minExpanded);
  check("scroll restored", result.scrollRestored === true);
} else {
  check(`response ok (error: ${result.error})`, result.ok === true);
}

check(`markdown chars ${result.markdownChars} >= ${scenario.minMarkdownChars}`, result.markdownChars >= scenario.minMarkdownChars);

if (scenario.minImages) {
  check(`images ${result.imageCount} >= ${scenario.minImages}`, result.imageCount >= scenario.minImages);
}

check("no Show more leak in markdown", result.hasShowMoreLeak !== true);

console.log(`  result: ${JSON.stringify({ ...result.stats, imageCount: result.imageCount, markdownChars: result.markdownChars })}`);

if (failures.length) {
  failures.forEach((failure) => console.error(`  FAIL: ${failure}`));
  process.exit(1);
}

console.log("  PASS");
