/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';
import * as fs from "fs";
import * as vscode from 'vscode';
import * as util from '../common';
import * as telemetry from '../telemetry';
import { PersistentFolderState } from './persistentState';
import { CppSettings } from './settings';
import { ABTestSettings, getABTestSettings } from '../abTesting';
import { getCustomConfigProviders } from './customProviders';
const configVersion: number = 4;

type Environment = { [key: string]: string | string[] };

// No properties are set in the config since we want to apply vscode settings first (if applicable).
// That code won't trigger if another value is already set.
// The property defaults are moved down to applyDefaultIncludePathsAndFrameworks.
function getDefaultConfig(): Configuration {
    if (process.platform === 'darwin') {
        return { name: "Mac" };
    } else if (process.platform === 'win32') {
        return { name: "Win32" };
    } else {
        return { name: "Linux" };
    }
}

function getDefaultCppProperties(): ConfigurationJson {
    return {
        configurations: [getDefaultConfig()],
        version: configVersion
    };
}

export interface ConfigurationJson {
    configurations: Configuration[];
    env?: {[key: string]: string | string[]};
    version: number;
}

export interface Configuration {
    name: string;
    compilerPath?: string;
    cStandard?: string;
    cppStandard?: string;
    includePath?: string[];
    macFrameworkPath?: string[];
    windowsSdkVersion?: string;
    defines?: string[];
    intelliSenseMode?: string;
    compileCommands?: string;
    forcedInclude?: string[];
    configurationProvider?: string;
    browse?: Browse;
}

export interface Browse {
    path?: string[];
    limitSymbolsToIncludedHeaders?: boolean | string;
    databaseFilename?: string;
}

export interface CompilerDefaults {
    compilerPath: string;
    cStandard: string;
    cppStandard: string;
    includes: string[];
    frameworks: string[];
    windowsSdkVersion: string;
    intelliSenseMode: string;
}

export class CppProperties {
    private rootUri: vscode.Uri;
    private propertiesFile: vscode.Uri = null;
    private readonly configFolder: string;
    private configurationJson: ConfigurationJson = null;
    private currentConfigurationIndex: PersistentFolderState<number>;
    private configFileWatcher: vscode.FileSystemWatcher = null;
    private configFileWatcherFallbackTime: Date = new Date(); // Used when file watching fails.
    private compileCommandFileWatchers: fs.FSWatcher[] = [];
    private defaultCompilerPath: string = null;
    private defaultCStandard: string = null;
    private defaultCppStandard: string = null;
    private defaultIncludes: string[] = null;
    private defaultFrameworks: string[] = null;
    private defaultWindowsSdkVersion: string = null;
    private vcpkgIncludes: string[] = [];
    private vcpkgPathReady: boolean = false;
    private defaultIntelliSenseMode: string = null;
    private readonly configurationGlobPattern: string = "c_cpp_properties.json";
    private disposables: vscode.Disposable[] = [];
    private configurationsChanged = new vscode.EventEmitter<Configuration[]>();
    private selectionChanged = new vscode.EventEmitter<number>();
    private compileCommandsChanged = new vscode.EventEmitter<string>();

    // Any time the default settings are parsed and assigned to `this.configurationJson`,
    // we want to track when the default includes have been added to it.
    private configurationIncomplete: boolean = true;

    constructor(rootUri: vscode.Uri) {
        console.assert(rootUri !== undefined);
        this.rootUri = rootUri;
        let rootPath: string = rootUri ? rootUri.fsPath : "";
        this.currentConfigurationIndex = new PersistentFolderState<number>("CppProperties.currentConfigurationIndex", -1, rootPath);
        this.configFolder = path.join(rootPath, ".vscode");

        let configFilePath: string = path.join(this.configFolder, "c_cpp_properties.json");
        if (fs.existsSync(configFilePath)) {
            this.propertiesFile = vscode.Uri.file(configFilePath);
            this.parsePropertiesFile();
        }
        if (!this.configurationJson) {
            this.resetToDefaultSettings(this.CurrentConfigurationIndex === -1);
        }

        this.configFileWatcher = vscode.workspace.createFileSystemWatcher(path.join(this.configFolder, this.configurationGlobPattern));
        this.disposables.push(this.configFileWatcher);
        this.configFileWatcher.onDidCreate((uri) => {
            this.propertiesFile = uri;
            this.handleConfigurationChange();
        });

        this.configFileWatcher.onDidDelete(() => {
            this.propertiesFile = null;
            this.resetToDefaultSettings(true);
            this.handleConfigurationChange();
        });

        this.configFileWatcher.onDidChange(() => {
            this.handleConfigurationChange();
        });

        this.buildVcpkgIncludePath();

        this.disposables.push(vscode.Disposable.from(this.configurationsChanged, this.selectionChanged, this.compileCommandsChanged));
    }

    public get ConfigurationsChanged(): vscode.Event<Configuration[]> { return this.configurationsChanged.event; }
    public get SelectionChanged(): vscode.Event<number> { return this.selectionChanged.event; }
    public get CompileCommandsChanged(): vscode.Event<string> { return this.compileCommandsChanged.event; }
    public get Configurations(): Configuration[] { return this.configurationJson.configurations; }
    public get CurrentConfigurationIndex(): number { return this.currentConfigurationIndex.Value; }
    public get CurrentConfiguration(): Configuration { return this.Configurations[this.CurrentConfigurationIndex]; }

    public get CurrentConfigurationProvider(): string|null {
        if (this.CurrentConfiguration.configurationProvider) {
            return this.CurrentConfiguration.configurationProvider;
        }
        return new CppSettings(this.rootUri).defaultConfigurationProvider;
    }

    public get ConfigurationNames(): string[] {
        let result: string[] = [];
        this.configurationJson.configurations.forEach((config: Configuration) => result.push(config.name));
        return result;
    }

    public set CompilerDefaults(compilerDefaults: CompilerDefaults) {
        this.defaultCompilerPath = compilerDefaults.compilerPath;
        this.defaultCStandard = compilerDefaults.cStandard;
        this.defaultCppStandard = compilerDefaults.cppStandard;
        this.defaultIncludes = compilerDefaults.includes;
        this.defaultFrameworks = compilerDefaults.frameworks;
        this.defaultWindowsSdkVersion = compilerDefaults.windowsSdkVersion;
        this.defaultIntelliSenseMode = compilerDefaults.intelliSenseMode;

        // defaultPaths is only used when there isn't a c_cpp_properties.json, but we don't send the configuration changed event
        // to the language server until the default include paths and frameworks have been sent.
        this.handleConfigurationChange();
    }

    public get VcpkgInstalled(): boolean {
        return this.vcpkgIncludes.length > 0;
    }

    private onConfigurationsChanged(): void {
        this.configurationsChanged.fire(this.Configurations);
    }

    private onSelectionChanged(): void {
        this.selectionChanged.fire(this.CurrentConfigurationIndex);
    }

    private onCompileCommandsChanged(path: string): void {
        this.compileCommandsChanged.fire(path);
    }

    public onDidChangeSettings(): void {
        // Default settings may have changed in a way that affects the configuration.
        // Just send another message since the language server will sort out whether anything important changed or not.
        if (!this.propertiesFile) {
            this.resetToDefaultSettings(true);
            this.handleConfigurationChange();
        } else if (!this.configurationIncomplete) {
            this.handleConfigurationChange();
        }
    }

    private resetToDefaultSettings(resetIndex: boolean): void {
        this.configurationJson = getDefaultCppProperties();
        if (resetIndex || this.CurrentConfigurationIndex < 0 ||
            this.CurrentConfigurationIndex >= this.configurationJson.configurations.length) {
            this.currentConfigurationIndex.Value = this.getConfigIndexForPlatform(this.configurationJson);
        }
        this.configurationIncomplete = true;
    }

     private applyDefaultIncludePathsAndFrameworks(): void {
        if (this.configurationIncomplete && this.defaultIncludes && this.defaultFrameworks && this.vcpkgPathReady) {
            let configuration: Configuration = this.CurrentConfiguration;
            let settings: CppSettings = new CppSettings(this.rootUri);
            let isUnset: (input: any) => boolean = (input: any) => {
                // default values for "default" config settings is null.
                return input === null;
            };

            // Anything that has a vscode setting for it will be resolved in updateServerOnFolderSettingsChange.
            // So if a property is currently unset, but has a vscode setting, don't set it yet, otherwise the linkage
            // to the setting will be lost if this configuration is saved into a c_cpp_properties.json file.

            // Only add settings from the default compiler if user hasn't explicitly set the corresponding VS Code setting.

            if (isUnset(settings.defaultIncludePath)) {
                // We don't add system includes to the includePath anymore. The language server has this information.
                let abTestSettings: ABTestSettings = getABTestSettings();
                let rootFolder: string = abTestSettings.UseRecursiveIncludes ? "${workspaceFolder}/**" : "${workspaceFolder}";
                configuration.includePath = [rootFolder].concat(this.vcpkgIncludes);
            }
            // browse.path is not set by default anymore. When it is not set, the includePath will be used instead.
            if (isUnset(settings.defaultDefines)) {
                configuration.defines = (process.platform === 'win32') ? ["_DEBUG", "UNICODE", "_UNICODE"] : [];
            }
            if (isUnset(settings.defaultMacFrameworkPath) && process.platform === 'darwin') {
                configuration.macFrameworkPath = this.defaultFrameworks;
            }
            if (isUnset(settings.defaultWindowsSdkVersion) && this.defaultWindowsSdkVersion && process.platform === 'win32') {
                configuration.windowsSdkVersion = this.defaultWindowsSdkVersion;
            }
            if (isUnset(settings.defaultCompilerPath) && this.defaultCompilerPath) {
                configuration.compilerPath = this.defaultCompilerPath;
            }
            if (isUnset(settings.defaultCStandard) && this.defaultCStandard) {
                configuration.cStandard = this.defaultCStandard;
            }
            if (isUnset(settings.defaultCppStandard) && this.defaultCppStandard) {
                configuration.cppStandard = this.defaultCppStandard;
            }
            if (isUnset(settings.defaultIntelliSenseMode)) {
                configuration.intelliSenseMode = this.defaultIntelliSenseMode;
            }
            this.configurationIncomplete = false;
        }
    }

    private get ExtendedEnvironment(): Environment {
        let result: Environment = {};
        if (this.configurationJson.env) {
            Object.assign(result, this.configurationJson.env);
        }

        result["workspaceFolderBasename"] = this.rootUri ? path.basename(this.rootUri.fsPath) : "";
        return result;
    }

    private async buildVcpkgIncludePath(): Promise<void> {
        try {
            // Check for vcpkgRoot and include relevent paths if found.
            let vcpkgRoot: string = util.getVcpkgRoot();
            if (vcpkgRoot) {
                let list: string[] = await util.readDir(vcpkgRoot);
                if (list !== undefined) {
                    // For every *directory* in the list (non-recursive). Each directory is basically a platform.
                    list.forEach((entry) => {
                        if (entry !== "vcpkg") {
                            let pathToCheck: string = path.join(vcpkgRoot, entry);
                            if (fs.existsSync(pathToCheck)) {
                                let p: string = path.join(pathToCheck, "include");
                                if (fs.existsSync(p)) {
                                    p = p.replace(/\\/g, "/");
                                    p = p.replace(vcpkgRoot, "${vcpkgRoot}");
                                    this.vcpkgIncludes.push(p);
                                }
                            }
                        }
                    });
                }
            }
        } catch (error) {} finally {
            this.vcpkgPathReady = true;
            this.handleConfigurationChange();
        }
    }

    private getConfigIndexForPlatform(config: any): number {
        let plat: string;
        if (process.platform === 'darwin') {
            plat = "Mac";
        } else if (process.platform === 'win32') {
            plat = "Win32";
        } else {
            plat = "Linux";
        }
        for (let i: number = 0; i < this.configurationJson.configurations.length; i++) {
            if (config.configurations[i].name === plat) {
                return i;
            }
        }
        return this.configurationJson.configurations.length - 1;
    }

    private getIntelliSenseModeForPlatform(name: string): string {
        // Do the built-in configs first.
        if (name === "Linux") {
            return "gcc-x64";
        } else if (name === "Mac") {
            return "clang-x64";
        } else if (name === "Win32") {
            return "msvc-x64";
        } else if (process.platform === 'win32') {
            // Custom configs default to the OS's preference.
            return "msvc-x64";
        } else if (process.platform === 'darwin') {
            return "clang-x64";
        } else {
            return "gcc-x64";
        }
    }

    public addToIncludePathCommand(path: string): void {
        this.handleConfigurationEditCommand((document: vscode.TextDocument) => {
            telemetry.logLanguageServerEvent("addToIncludePath");
            this.parsePropertiesFile(); // Clear out any modifications we may have made internally.
            let config: Configuration = this.CurrentConfiguration;
            if (config.includePath === undefined) {
                config.includePath = ["${default}"];
            }
            config.includePath.splice(config.includePath.length, 0, path);
            fs.writeFileSync(this.propertiesFile.fsPath, JSON.stringify(this.configurationJson, null, 4));
            this.handleConfigurationChange();
        });
    }

    public updateCustomConfigurationProvider(providerId: string): Thenable<void> {
        return new Promise<void>((resolve) => {
            if (this.propertiesFile) {
                this.handleConfigurationEditCommand((document: vscode.TextDocument) => {
                    this.parsePropertiesFile(); // Clear out any modifications we may have made internally.
                    let config: Configuration = this.CurrentConfiguration;
                    if (providerId) {
                        config.configurationProvider = providerId;
                    } else {
                        delete config.configurationProvider;
                    }
                    fs.writeFileSync(this.propertiesFile.fsPath, JSON.stringify(this.configurationJson, null, 4));
                    this.handleConfigurationChange();
                    resolve();
                });
            } else {
                let settings: CppSettings = new CppSettings(this.rootUri);
                if (providerId) {
                    settings.update("default.configurationProvider", providerId);
                } else {
                    settings.update("default.configurationProvider", undefined); // delete the setting
                }
                this.CurrentConfiguration.configurationProvider = providerId;
                resolve();
            }
        });
    }

    public setCompileCommands(path: string): void {
        this.handleConfigurationEditCommand((document: vscode.TextDocument) => {
            this.parsePropertiesFile(); // Clear out any modifications we may have made internally.
            let config: Configuration = this.CurrentConfiguration;
            config.compileCommands = path;
            fs.writeFileSync(this.propertiesFile.fsPath, JSON.stringify(this.configurationJson, null, 4));
            this.handleConfigurationChange();
        });
    }

    public select(index: number): Configuration {
        if (index === this.configurationJson.configurations.length) {
            this.handleConfigurationEditCommand(vscode.window.showTextDocument);
            return;
        }
        this.currentConfigurationIndex.Value = index;
        this.onSelectionChanged();
    }

    private resolveDefaults(entries: string[], defaultValue: string[]): string[] {
        let result: string[] = [];
        entries.forEach(entry => {
            if (entry === "${default}") {
                // package.json default values for string[] properties is null.
                // If no default is set, return an empty array instead of an array with `null` in it.
                if (defaultValue !== null) {
                    result = result.concat(defaultValue);
                }
            } else {
                result.push(entry);
            }
        });
        return result;
    }

    private resolveAndSplit(paths: string[] | undefined, defaultValue: string[], env: Environment): string[] {
        let result: string[] = [];
        if (paths) {
            paths.forEach(entry => {
                let entries: string[] = util.resolveVariables(entry, env).split(";").filter(e => e);
                entries = this.resolveDefaults(entries, defaultValue);
                result = result.concat(entries);
            });
        }
        return result;
    }

    private resolveVariables(input: string | boolean, defaultValue: string | boolean, env: Environment): string | boolean {
        if (input === undefined || input === "${default}") {
            input = defaultValue;
        }
        if (typeof input === "boolean") {
            return input;
        }
        return util.resolveVariables(input, env);
    }

    private updateConfiguration(property: string[], defaultValue: string[], env: Environment): string[];
    private updateConfiguration(property: string, defaultValue: string, env: Environment): string;
    private updateConfiguration(property: string | boolean, defaultValue: boolean, env: Environment): boolean;
    private updateConfiguration(property, defaultValue, env): any {
        if (util.isString(property) || util.isString(defaultValue)) {
            return this.resolveVariables(property, defaultValue, env);
        } else if (util.isBoolean(property) || util.isBoolean(defaultValue)) {
            return this.resolveVariables(property, defaultValue, env);
        } else if (util.isArrayOfString(property) || util.isArrayOfString(defaultValue)) {
            if (property) {
                return this.resolveAndSplit(property, defaultValue, env);
            } else if (property === undefined && defaultValue) {
                return this.resolveAndSplit(defaultValue, [], env);
            }
        }
        return property;
    }

    private updateServerOnFolderSettingsChange(): void {
        let settings: CppSettings = new CppSettings(this.rootUri);
        let env: Environment = this.ExtendedEnvironment;
        for (let i: number = 0; i < this.configurationJson.configurations.length; i++) {
            let configuration: Configuration = this.configurationJson.configurations[i];

            configuration.includePath = this.updateConfiguration(configuration.includePath, settings.defaultIncludePath, env);
            configuration.defines = this.updateConfiguration(configuration.defines, settings.defaultDefines, env);
            configuration.macFrameworkPath = this.updateConfiguration(configuration.macFrameworkPath, settings.defaultMacFrameworkPath, env);
            configuration.windowsSdkVersion = this.updateConfiguration(configuration.windowsSdkVersion, settings.defaultWindowsSdkVersion, env);
            configuration.forcedInclude = this.updateConfiguration(configuration.forcedInclude, settings.defaultForcedInclude, env);
            configuration.compileCommands = this.updateConfiguration(configuration.compileCommands, settings.defaultCompileCommands, env);
            configuration.compilerPath = this.updateConfiguration(configuration.compilerPath, settings.defaultCompilerPath, env);
            configuration.cStandard = this.updateConfiguration(configuration.cStandard, settings.defaultCStandard, env);
            configuration.cppStandard = this.updateConfiguration(configuration.cppStandard, settings.defaultCppStandard, env);
            configuration.intelliSenseMode = this.updateConfiguration(configuration.intelliSenseMode, settings.defaultIntelliSenseMode, env);
            configuration.configurationProvider = this.updateConfiguration(configuration.configurationProvider, settings.defaultConfigurationProvider, env);

            if (!configuration.browse) {
                configuration.browse = {};
            }

            if (!configuration.browse.path) {
                if (settings.defaultBrowsePath) {
                    configuration.browse.path = settings.defaultBrowsePath;
                } else if (configuration.includePath) {
                    // If the user doesn't set browse.path, copy the includePath over. Make sure ${workspaceFolder} is in there though...
                    configuration.browse.path = configuration.includePath.slice(0);
                    if (-1 === configuration.includePath.findIndex((value: string, index: number) => {
                        return !!value.match(/^\$\{(workspaceRoot|workspaceFolder)\}(\\|\\\*\*|\/|\/\*\*)?$/g);
                    })) {
                        configuration.browse.path.push("${workspaceFolder}");
                    }
                }
            } else {
                configuration.browse.path = this.updateConfiguration(configuration.browse.path, settings.defaultBrowsePath, env);
            }

            configuration.browse.limitSymbolsToIncludedHeaders = this.updateConfiguration(configuration.browse.limitSymbolsToIncludedHeaders, settings.defaultLimitSymbolsToIncludedHeaders, env);
            configuration.browse.databaseFilename = this.updateConfiguration(configuration.browse.databaseFilename, settings.defaultDatabaseFilename, env);
        }

        this.updateCompileCommandsFileWatchers();
        if (!this.configurationIncomplete) {
            this.onConfigurationsChanged();
        }
    }

    // Dispose existing and loop through cpp and populate with each file (exists or not) as you go.
    // paths are expected to have variables resolved already
    public updateCompileCommandsFileWatchers(): void {
        this.compileCommandFileWatchers.forEach((watcher: fs.FSWatcher) => watcher.close());
        this.compileCommandFileWatchers = []; //reset it
        let filePaths: Set<string> = new Set<string>();
        this.configurationJson.configurations.forEach(c => {
            if (c.compileCommands !== undefined && fs.existsSync(c.compileCommands)) {
                filePaths.add(c.compileCommands);
            }
        });
        try {
            filePaths.forEach((path: string) => {
                this.compileCommandFileWatchers.push(fs.watch(path, (event: string, filename: string) => {
                    if (event !== "rename") {
                        this.onCompileCommandsChanged(path);
                    }
                }));
            });
        } catch (e) {
            // The file watcher limit is hit.
            // TODO: Check if the compile commands file has a higher timestamp during the interval timer.
        }
    }

    public handleConfigurationEditCommand(onSuccess: (document: vscode.TextDocument) => void): void {
        if (this.propertiesFile && fs.existsSync(this.propertiesFile.fsPath)) {
            vscode.workspace.openTextDocument(this.propertiesFile).then((document: vscode.TextDocument) => {
                onSuccess(document);
            });
        } else {
            fs.mkdir(this.configFolder, (e: NodeJS.ErrnoException) => {
                if (!e || e.code === 'EEXIST') {
                    let fullPathToFile: string = path.join(this.configFolder, "c_cpp_properties.json");
                    let filePath: vscode.Uri = vscode.Uri.file(fullPathToFile).with({ scheme: "untitled" });
                    vscode.workspace.openTextDocument(filePath).then((document: vscode.TextDocument) => {
                        let edit: vscode.WorkspaceEdit = new vscode.WorkspaceEdit();
                        if (this.configurationJson) {
                            this.resetToDefaultSettings(true);
                        }
                        this.applyDefaultIncludePathsAndFrameworks();
                        let settings: CppSettings = new CppSettings(this.rootUri);
                        if (settings.defaultConfigurationProvider) {
                            this.configurationJson.configurations.forEach(config => {
                                config.configurationProvider = settings.defaultConfigurationProvider;
                            });
                            settings.update("default.configurationProvider", undefined); // delete the setting
                        }
                        edit.insert(document.uri, new vscode.Position(0, 0), JSON.stringify(this.configurationJson, null, 4));
                        vscode.workspace.applyEdit(edit).then((status) => {
                            // Fix for issue 163
                            // https://github.com/Microsoft/vscppsamples/issues/163
                            // Save the file to disk so that when the user tries to re-open the file it exists.
                            // Before this fix the file existed but was unsaved, so we went through the same
                            // code path and reapplied the edit.
                            document.save().then(() => {
                                this.propertiesFile = vscode.Uri.file(path.join(this.configFolder, "c_cpp_properties.json"));
                                vscode.workspace.openTextDocument(this.propertiesFile).then((document: vscode.TextDocument) => {
                                    onSuccess(document);
                                });
                            });
                        });
                    });
                }
            });
        }
    }

    private handleConfigurationChange(): void {
        this.configFileWatcherFallbackTime = new Date();
        if (this.propertiesFile) {
            this.parsePropertiesFile();
            // parsePropertiesFile can fail, but it won't overwrite an existing configurationJson in the event of failure.
            // this.configurationJson should only be undefined here if we have never successfully parsed the propertiesFile.
            if (this.configurationJson !== undefined) {
                if (this.CurrentConfigurationIndex < 0 ||
                    this.CurrentConfigurationIndex >= this.configurationJson.configurations.length) {
                    // If the index is out of bounds (during initialization or due to removal of configs), fix it.
                    this.currentConfigurationIndex.Value = this.getConfigIndexForPlatform(this.configurationJson);
                }
            }
        }

        if (this.configurationJson === undefined) {
            this.resetToDefaultSettings(true);  // I don't think there's a case where this will be hit anymore.
        }

        this.applyDefaultIncludePathsAndFrameworks();
        this.updateServerOnFolderSettingsChange();
    }

    private parsePropertiesFile(): void {
        try {
            let readResults: string = fs.readFileSync(this.propertiesFile.fsPath, 'utf8');
            if (readResults === "") {
                return; // Repros randomly when the file is initially created. The parse will get called again after the file is written.
            }

            // Try to use the same configuration as before the change.
            let newJson: ConfigurationJson = JSON.parse(readResults);
            if (!newJson || !newJson.configurations || newJson.configurations.length === 0) {
                throw { message: "Invalid configuration file. There must be at least one configuration present in the array." };
            }
            if (!this.configurationIncomplete && this.configurationJson && this.configurationJson.configurations &&
                this.CurrentConfigurationIndex >= 0 && this.CurrentConfigurationIndex < this.configurationJson.configurations.length) {
                for (let i: number = 0; i < newJson.configurations.length; i++) {
                    if (newJson.configurations[i].name === this.configurationJson.configurations[this.CurrentConfigurationIndex].name) {
                        this.currentConfigurationIndex.Value = i;
                        break;
                    }
                }
            }
            this.configurationJson = newJson;
            if (this.CurrentConfigurationIndex < 0 || this.CurrentConfigurationIndex >= newJson.configurations.length) {
                this.currentConfigurationIndex.Value = this.getConfigIndexForPlatform(newJson);
            }

            let dirty: boolean = false;
            for (let i: number = 0; i < this.configurationJson.configurations.length; i++) {
                let newId: string = getCustomConfigProviders().checkId(this.configurationJson.configurations[i].configurationProvider);
                if (newId !== this.configurationJson.configurations[i].configurationProvider) {
                    dirty = true;
                    this.configurationJson.configurations[i].configurationProvider = newId;
                }
            }

            // Remove disallowed variable overrides
            if (this.configurationJson.env) {
                delete this.configurationJson.env['workspaceRoot'];
                delete this.configurationJson.env['workspaceFolder'];
                delete this.configurationJson.env['workspaceFolderBasename'];
                delete this.configurationJson.env['default'];
            }

            // Warning: There is a chance that this is incorrect in the event that the c_cpp_properties.json file was created before
            // the system includes were available.
            this.configurationIncomplete = false;

            if (this.configurationJson.version !== configVersion) {
                dirty = true;
                if (this.configurationJson.version === undefined) {
                    this.updateToVersion2();
                }

                if (this.configurationJson.version === 2) {
                    this.updateToVersion3();
                }

                if (this.configurationJson.version === 3) {
                    this.updateToVersion4();
                } else {
                    this.configurationJson.version = configVersion;
                    vscode.window.showErrorMessage('Unknown version number found in c_cpp_properties.json. Some features may not work as expected.');
                }
            }

            if (dirty) {
                try {
                    fs.writeFileSync(this.propertiesFile.fsPath, JSON.stringify(this.configurationJson, null, 4));
                } catch (err) {
                    // Ignore write errors, the file may be under source control. Updated settings will only be modified in memory.
                    vscode.window.showWarningMessage('Attempt to update "' + this.propertiesFile.fsPath + '" failed (do you have write access?)');
                }
            }
        } catch (err) {
            vscode.window.showErrorMessage('Failed to parse "' + this.propertiesFile.fsPath + '": ' + err.message);
            throw err;
        }
    }

    private updateToVersion2(): void {
        this.configurationJson.version = 2;
        // no-op. We don't automatically populate the browse.path anymore.
        // We use includePath if browse.path is not present which is what this code used to do.
    }

    private updateToVersion3(): void {
        this.configurationJson.version = 3;
        for (let i: number = 0; i < this.configurationJson.configurations.length; i++) {
            let config: Configuration = this.configurationJson.configurations[i];
            // Look for Mac configs and extra configs on Mac systems
            if (config.name === "Mac" || (process.platform === 'darwin' && config.name !== "Win32" && config.name !== "Linux")) {
                if (config.macFrameworkPath === undefined) {
                    config.macFrameworkPath = [
                        "/System/Library/Frameworks",
                        "/Library/Frameworks"
                    ];
                }
            }
        }
    }

    private updateToVersion4(): void {
        this.configurationJson.version = 4;
        // Update intelliSenseMode, compilerPath, cStandard, and cppStandard with the defaults if they're missing.
        // If VS Code settings exist for these properties, don't add them to c_cpp_properties.json
        let settings: CppSettings = new CppSettings(this.rootUri);
        for (let i: number = 0; i < this.configurationJson.configurations.length; i++) {
            let config: Configuration = this.configurationJson.configurations[i];

            if (config.intelliSenseMode === undefined && !settings.defaultIntelliSenseMode) {
                config.intelliSenseMode = this.getIntelliSenseModeForPlatform(config.name);
            }
            // Don't set the default if compileCommands exist, until it is fixed to have the correct value.
            if (config.compilerPath === undefined && this.defaultCompilerPath && !config.compileCommands && !settings.defaultCompilerPath) {
                config.compilerPath = this.defaultCompilerPath;
            }
            if (!config.cStandard && this.defaultCStandard && !settings.defaultCStandard) {
                config.cStandard = this.defaultCStandard;
            }
            if (!config.cppStandard && this.defaultCppStandard && !settings.defaultCppStandard) {
                config.cppStandard = this.defaultCppStandard;
            }
        }
    }

    public checkCppProperties(): void {
        // Check for change properties in case of file watcher failure.
        let propertiesFile: string = path.join(this.configFolder, "c_cpp_properties.json");
        fs.stat(propertiesFile, (err, stats) => {
            if (err) {
                if (this.propertiesFile !== null) {
                    this.propertiesFile = null; // File deleted.
                    this.resetToDefaultSettings(true);
                    this.handleConfigurationChange();
                }
            } else if (stats.mtime > this.configFileWatcherFallbackTime) {
                if (this.propertiesFile === null) {
                    this.propertiesFile = vscode.Uri.file(propertiesFile); // File created.
                }
                this.handleConfigurationChange();
            }
        });
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.disposables = [];

        this.compileCommandFileWatchers.forEach((watcher: fs.FSWatcher) => watcher.close());
        this.compileCommandFileWatchers = []; //reset it
    }
}
