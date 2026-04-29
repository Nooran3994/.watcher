#!/usr/bin/env node
'use strict';

/**
 * error-logger CLI entry point
 * Anchors all paths to __dirname so this can be called from any working directory.
 * The user's project directory is determined by process.cwd() (IDE workspace root).
 */

const path = require('path');
const fs   = require('fs');

// Tool root = one level up from bin/
const toolRoot  = path.resolve(__dirname, '..');
const agentPath = path.join(toolRoot, '.agents', 'workflows', 'error-logger');

// Verify agent module exists before requiring
if (!fs.existsSync(path.join(agentPath, 'index.js'))) {
    process.stderr.write(
        '[ERROR] Agent module not found at: ' + agentPath + '\n' +
        '        Ensure the .watcher tool directory is intact.\n'
    );
    process.exit(1);
}

const { run } = require(agentPath);

// Parse arguments
const args        = process.argv.slice(2);
const command     = args[0];
const projectFlag = args.indexOf('--project-dir');
const projectDir  = projectFlag !== -1 ? args[projectFlag + 1] : process.cwd();

if (!command) {
    process.stdout.write(
        'Usage: node bin/error-logger.js <command> [--project-dir <path>]\n' +
        'Commands: setup, analyze\n'
    );
    process.exit(1);
}

const context = {
    env:      'cli',
    cwd:      path.resolve(projectDir),   // user project directory
    toolRoot: toolRoot                     // tool installation directory
};

const result = run(command, context);

if (!result || result.status === 'error') {
    process.stderr.write('[ERROR] ' + (result ? result.message : 'Unknown error') + '\n');
    if (result && result.error) process.stderr.write(result.error + '\n');
    process.exit(1);
} else {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(0);
}