/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import TelemetryReporter from 'vscode-extension-telemetry';
import * as util from './common';

interface IPackageInfo {
    name: string;
    version: string;
    aiKey: string;
}

let telemetryReporter: TelemetryReporter;

export function activate(): void {
}

export function deactivate(): void {
}

export function logDebuggerEvent(eventName: string, properties?: { [key: string]: string }): void {
}

export function logLanguageServerEvent(eventName: string, properties?: { [key: string]: string }, metrics?: { [key: string]: number }): void {
}

function createReporter(): TelemetryReporter {
}

function getPackageInfo(): IPackageInfo {
}
