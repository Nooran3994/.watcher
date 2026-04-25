#!/usr/bin/env node

const { run } = require("../.agents/workflows/error-logger");

const args = process.argv.slice(2);
const command = args[0];

if (!command) {
    console.log("Usage: node bin/error-logger.js <command>");
    console.log("Commands: setup, analyze");
    process.exit(1);
}

const context = {
    env: "cli",
    cwd: process.cwd()
};

const result = run(command, context);

if (result.status === "error") {
    console.error(`❌ Error: ${result.message}`);
    if (result.error) console.error(result.error);
    process.exit(1);
} else {
    console.log(`✅ Success:`);
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
}