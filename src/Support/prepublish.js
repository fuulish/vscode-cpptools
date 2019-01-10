/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

/**
 * This file is used during local debugging of the extension and should not be referenced by any
 * other source files.
 */

const fs = require("fs");
const cp = require("child_process");
const path = require("path");

if (!process.env.CPPTOOLS_DEV && fs.existsSync('./node_modules')) {
    console.warn("WARNING: Skipping npm install since it appears to have been executed already.");
} else {
    console.log(">> npm install");
    cp.execSync("npm install", { stdio: [0, 1, 2] });
}

// Compile the TypeScript code
console.log(">> tsc -p ./");
cp.execSync("tsc -p ./", {stdio:[0, 1, 2]});

// If the required debugger file doesn't exist, make sure it is copied.
if (process.env.CPPTOOLS_DEV || !fs.existsSync('./debugAdapters/bin/cppdbg.ad7Engine.json')) {
    const copyDebuggerDependenciesJSFile = './out/src/Support/copyDebuggerDependencies.js';

    // Required for nightly builds. Nightly builds do not enable CPPTOOLS_DEV.
    console.log(">> node " + copyDebuggerDependenciesJSFile);
    cp.execSync("node " + copyDebuggerDependenciesJSFile, { stdio: [0, 1, 2] });
}