// src/cli/stdin-reader.ts
async function readJsonFromStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      try {
        resolve(input.trim() ? JSON.parse(input) : void 0);
      } catch (e) {
        reject(new Error(`Failed to parse hook input: ${e}`));
      }
    });
  });
}

// src/cli/adapters/claude-code.ts
var claudeCodeAdapter = {
  normalizeInput(raw) {
    const r = raw ?? {};
    return {
      sessionId: r.session_id,
      cwd: r.cwd ?? process.cwd(),
      prompt: r.prompt,
      toolName: r.tool_name,
      toolInput: r.tool_input,
      toolResponse: r.tool_response,
      transcriptPath: r.transcript_path
    };
  },
  formatOutput(result) {
    if (result.hookSpecificOutput) {
      return { hookSpecificOutput: result.hookSpecificOutput };
    }
    return { continue: result.continue ?? true, suppressOutput: result.suppressOutput ?? true };
  }
};

// src/cli/adapters/cursor.ts
var cursorAdapter = {
  normalizeInput(raw) {
    const r = raw ?? {};
    const isShellCommand = !!r.command && !r.tool_name;
    return {
      sessionId: r.conversation_id || r.generation_id,
      // conversation_id preferred
      cwd: r.workspace_roots?.[0] ?? process.cwd(),
      // First workspace root
      prompt: r.prompt,
      toolName: isShellCommand ? "Bash" : r.tool_name,
      toolInput: isShellCommand ? { command: r.command } : r.tool_input,
      toolResponse: isShellCommand ? { output: r.output } : r.result_json,
      // result_json not tool_response
      transcriptPath: void 0,
      // Cursor doesn't provide transcript
      // Cursor-specific fields for file edits
      filePath: r.file_path,
      edits: r.edits
    };
  },
  formatOutput(result) {
    return { continue: result.continue ?? true };
  }
};

// src/cli/adapters/raw.ts
var rawAdapter = {
  normalizeInput(raw) {
    const r = raw;
    return {
      sessionId: r.sessionId ?? r.session_id ?? "unknown",
      cwd: r.cwd ?? process.cwd(),
      prompt: r.prompt,
      toolName: r.toolName ?? r.tool_name,
      toolInput: r.toolInput ?? r.tool_input,
      toolResponse: r.toolResponse ?? r.tool_response,
      transcriptPath: r.transcriptPath ?? r.transcript_path,
      filePath: r.filePath ?? r.file_path,
      edits: r.edits
    };
  },
  formatOutput(result) {
    return result;
  }
};

// src/cli/adapters/index.ts
function getPlatformAdapter(platform) {
  switch (platform) {
    case "claude-code":
      return claudeCodeAdapter;
    case "cursor":
      return cursorAdapter;
    case "raw":
      return rawAdapter;
    default:
      throw new Error(`Unknown platform: ${platform}`);
  }
}

// src/shared/worker-utils.ts
import path from "path";
import { homedir as homedir3 } from "os";
import { readFileSync as readFileSync3 } from "fs";

// src/utils/logger.ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
var LogLevel = /* @__PURE__ */ ((LogLevel2) => {
  LogLevel2[LogLevel2["DEBUG"] = 0] = "DEBUG";
  LogLevel2[LogLevel2["INFO"] = 1] = "INFO";
  LogLevel2[LogLevel2["WARN"] = 2] = "WARN";
  LogLevel2[LogLevel2["ERROR"] = 3] = "ERROR";
  LogLevel2[LogLevel2["SILENT"] = 4] = "SILENT";
  return LogLevel2;
})(LogLevel || {});
var DEFAULT_DATA_DIR = join(homedir(), ".claude-recall");
var Logger = class {
  level = null;
  useColor;
  logFilePath = null;
  logFileInitialized = false;
  constructor() {
    this.useColor = process.stdout.isTTY ?? false;
  }
  /**
   * Initialize log file path and ensure directory exists (lazy initialization)
   */
  ensureLogFileInitialized() {
    if (this.logFileInitialized) return;
    this.logFileInitialized = true;
    try {
      const logsDir = join(DEFAULT_DATA_DIR, "logs");
      if (!existsSync(logsDir)) {
        mkdirSync(logsDir, { recursive: true });
      }
      const date = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
      this.logFilePath = join(logsDir, `claude-recall-${date}.log`);
    } catch (error) {
      console.error("[LOGGER] Failed to initialize log file:", error);
      this.logFilePath = null;
    }
  }
  /**
   * Lazy-load log level from settings file
   * Uses direct file reading to avoid circular dependency with SettingsDefaultsManager
   */
  getLevel() {
    if (this.level === null) {
      try {
        const settingsPath = join(DEFAULT_DATA_DIR, "settings.json");
        if (existsSync(settingsPath)) {
          const settingsData = readFileSync(settingsPath, "utf-8");
          const settings = JSON.parse(settingsData);
          const envLevel = (settings.CLAUDE_RECALL_LOG_LEVEL || "INFO").toUpperCase();
          this.level = LogLevel[envLevel] ?? 1 /* INFO */;
        } else {
          this.level = 1 /* INFO */;
        }
      } catch (error) {
        this.level = 1 /* INFO */;
      }
    }
    return this.level;
  }
  /**
   * Create correlation ID for tracking an observation through the pipeline
   */
  correlationId(sessionId, observationNum) {
    return `obs-${sessionId}-${observationNum}`;
  }
  /**
   * Create session correlation ID
   */
  sessionId(sessionId) {
    return `session-${sessionId}`;
  }
  /**
   * Format data for logging - create compact summaries instead of full dumps
   */
  formatData(data) {
    if (data === null || data === void 0) return "";
    if (typeof data === "string") return data;
    if (typeof data === "number") return data.toString();
    if (typeof data === "boolean") return data.toString();
    if (typeof data === "object") {
      if (data instanceof Error) {
        return this.getLevel() === 0 /* DEBUG */ ? `${data.message}
${data.stack}` : data.message;
      }
      if (Array.isArray(data)) {
        return `[${data.length} items]`;
      }
      const keys = Object.keys(data);
      if (keys.length === 0) return "{}";
      if (keys.length <= 3) {
        return JSON.stringify(data);
      }
      return `{${keys.length} keys: ${keys.slice(0, 3).join(", ")}...}`;
    }
    return String(data);
  }
  /**
   * Format a tool name and input for compact display
   */
  formatTool(toolName, toolInput) {
    if (!toolInput) return toolName;
    let input = toolInput;
    if (typeof toolInput === "string") {
      try {
        input = JSON.parse(toolInput);
      } catch {
        input = toolInput;
      }
    }
    if (toolName === "Bash" && input.command) {
      return `${toolName}(${input.command})`;
    }
    if (input.file_path) {
      return `${toolName}(${input.file_path})`;
    }
    if (input.notebook_path) {
      return `${toolName}(${input.notebook_path})`;
    }
    if (toolName === "Glob" && input.pattern) {
      return `${toolName}(${input.pattern})`;
    }
    if (toolName === "Grep" && input.pattern) {
      return `${toolName}(${input.pattern})`;
    }
    if (input.url) {
      return `${toolName}(${input.url})`;
    }
    if (input.query) {
      return `${toolName}(${input.query})`;
    }
    if (toolName === "Task") {
      if (input.subagent_type) {
        return `${toolName}(${input.subagent_type})`;
      }
      if (input.description) {
        return `${toolName}(${input.description})`;
      }
    }
    if (toolName === "Skill" && input.skill) {
      return `${toolName}(${input.skill})`;
    }
    if (toolName === "LSP" && input.operation) {
      return `${toolName}(${input.operation})`;
    }
    return toolName;
  }
  /**
   * Format timestamp in local timezone (YYYY-MM-DD HH:MM:SS.mmm)
   */
  formatTimestamp(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    const ms = String(date.getMilliseconds()).padStart(3, "0");
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
  }
  /**
   * Core logging method
   */
  log(level, component, message, context, data) {
    if (level < this.getLevel()) return;
    this.ensureLogFileInitialized();
    const timestamp = this.formatTimestamp(/* @__PURE__ */ new Date());
    const levelStr = LogLevel[level].padEnd(5);
    const componentStr = component.padEnd(6);
    let correlationStr = "";
    if (context?.correlationId) {
      correlationStr = `[${context.correlationId}] `;
    } else if (context?.sessionId) {
      correlationStr = `[session-${context.sessionId}] `;
    }
    let dataStr = "";
    if (data !== void 0 && data !== null) {
      if (data instanceof Error) {
        dataStr = this.getLevel() === 0 /* DEBUG */ ? `
${data.message}
${data.stack}` : ` ${data.message}`;
      } else if (this.getLevel() === 0 /* DEBUG */ && typeof data === "object") {
        dataStr = "\n" + JSON.stringify(data, null, 2);
      } else {
        dataStr = " " + this.formatData(data);
      }
    }
    let contextStr = "";
    if (context) {
      const { sessionId, memorySessionId, correlationId, ...rest } = context;
      if (Object.keys(rest).length > 0) {
        const pairs = Object.entries(rest).map(([k, v]) => `${k}=${v}`);
        contextStr = ` {${pairs.join(", ")}}`;
      }
    }
    const logLine = `[${timestamp}] [${levelStr}] [${componentStr}] ${correlationStr}${message}${contextStr}${dataStr}`;
    if (this.logFilePath) {
      try {
        appendFileSync(this.logFilePath, logLine + "\n", "utf8");
      } catch (error) {
        process.stderr.write(`[LOGGER] Failed to write to log file: ${error}
`);
      }
    } else {
      process.stderr.write(logLine + "\n");
    }
  }
  // Public logging methods
  debug(component, message, context, data) {
    this.log(0 /* DEBUG */, component, message, context, data);
  }
  info(component, message, context, data) {
    this.log(1 /* INFO */, component, message, context, data);
  }
  warn(component, message, context, data) {
    this.log(2 /* WARN */, component, message, context, data);
  }
  error(component, message, context, data) {
    this.log(3 /* ERROR */, component, message, context, data);
  }
  /**
   * Log data flow: input → processing
   */
  dataIn(component, message, context, data) {
    this.info(component, `\u2192 ${message}`, context, data);
  }
  /**
   * Log data flow: processing → output
   */
  dataOut(component, message, context, data) {
    this.info(component, `\u2190 ${message}`, context, data);
  }
  /**
   * Log successful completion
   */
  success(component, message, context, data) {
    this.info(component, `\u2713 ${message}`, context, data);
  }
  /**
   * Log failure
   */
  failure(component, message, context, data) {
    this.error(component, `\u2717 ${message}`, context, data);
  }
  /**
   * Log timing information
   */
  timing(component, message, durationMs, context) {
    this.info(component, `\u23F1 ${message}`, context, { duration: `${durationMs}ms` });
  }
  /**
   * Happy Path Error - logs when the expected "happy path" fails but we have a fallback
   *
   * Semantic meaning: "When the happy path fails, this is an error, but we have a fallback."
   *
   * Use for:
   * ✅ Unexpected null/undefined values that should theoretically never happen
   * ✅ Defensive coding where silent fallback is acceptable
   * ✅ Situations where you want to track unexpected nulls without breaking execution
   *
   * DO NOT use for:
   * ❌ Nullable fields with valid default behavior (use direct || defaults)
   * ❌ Critical validation failures (use logger.warn or throw Error)
   * ❌ Try-catch blocks where error is already logged (redundant)
   *
   * @param component - Component where error occurred
   * @param message - Error message describing what went wrong
   * @param context - Optional context (sessionId, correlationId, etc)
   * @param data - Optional data to include
   * @param fallback - Value to return (defaults to empty string)
   * @returns The fallback value
   */
  happyPathError(component, message, context, data, fallback = "") {
    const stack = new Error().stack || "";
    const stackLines = stack.split("\n");
    const callerLine = stackLines[2] || "";
    const callerMatch = callerLine.match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/);
    const location = callerMatch ? `${callerMatch[1].split("/").pop()}:${callerMatch[2]}` : "unknown";
    const enhancedContext = {
      ...context,
      location
    };
    this.warn(component, `[HAPPY-PATH] ${message}`, enhancedContext, data);
    return fallback;
  }
};
var logger = new Logger();

// src/shared/hook-constants.ts
var HOOK_TIMEOUTS = {
  DEFAULT: 3e5,
  // Standard HTTP timeout (5 min for slow systems)
  HEALTH_CHECK: 3e4,
  // Worker health check (30s for slow systems)
  WORKER_STARTUP_WAIT: 1e3,
  WORKER_STARTUP_RETRIES: 300,
  PRE_RESTART_SETTLE_DELAY: 2e3,
  // Give files time to sync before restart
  POWERSHELL_COMMAND: 1e4,
  // PowerShell process enumeration (10s - typically completes in <1s)
  WINDOWS_MULTIPLIER: 1.5
  // Platform-specific adjustment
};
var HOOK_EXIT_CODES = {
  SUCCESS: 0,
  FAILURE: 1,
  /** Blocking error - for SessionStart, shows stderr to user only */
  BLOCKING_ERROR: 2
};
function getTimeout(baseTimeout) {
  return process.platform === "win32" ? Math.round(baseTimeout * HOOK_TIMEOUTS.WINDOWS_MULTIPLIER) : baseTimeout;
}

// src/shared/SettingsDefaultsManager.ts
import { readFileSync as readFileSync2, writeFileSync, existsSync as existsSync2, mkdirSync as mkdirSync2 } from "fs";
import { join as join2, dirname } from "path";
import { homedir as homedir2 } from "os";

// src/constants/observation-metadata.ts
var DEFAULT_OBSERVATION_TYPES_STRING = "bugfix,feature,refactor,discovery,decision,change";
var DEFAULT_OBSERVATION_CONCEPTS_STRING = "how-it-works,why-it-exists,what-changed,problem-solution,gotcha,pattern,trade-off";

// src/shared/SettingsDefaultsManager.ts
var SettingsDefaultsManager = class {
  /**
   * Default values for all settings
   */
  static DEFAULTS = {
    CLAUDE_RECALL_MODEL: "claude-sonnet-4-5",
    CLAUDE_RECALL_CONTEXT_OBSERVATIONS: "50",
    CLAUDE_RECALL_WORKER_PORT: "37777",
    CLAUDE_RECALL_WORKER_HOST: "127.0.0.1",
    CLAUDE_RECALL_SKIP_TOOLS: "ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",
    // AI Provider Configuration
    CLAUDE_RECALL_PROVIDER: "claude",
    // Default to Claude
    CLAUDE_RECALL_GEMINI_API_KEY: "",
    // Empty by default, can be set via UI or env
    CLAUDE_RECALL_GEMINI_MODEL: "gemini-2.5-flash-lite",
    // Default Gemini model (highest free tier RPM)
    CLAUDE_RECALL_GEMINI_RATE_LIMITING_ENABLED: "true",
    // Rate limiting ON by default for free tier users
    CLAUDE_RECALL_OPENROUTER_API_KEY: "",
    // Empty by default, can be set via UI or env
    CLAUDE_RECALL_OPENROUTER_MODEL: "xiaomi/mimo-v2-flash:free",
    // Default OpenRouter model (free tier)
    CLAUDE_RECALL_OPENROUTER_SITE_URL: "",
    // Optional: for OpenRouter analytics
    CLAUDE_RECALL_OPENROUTER_APP_NAME: "claude-recall",
    // App name for OpenRouter analytics
    CLAUDE_RECALL_OPENROUTER_MAX_CONTEXT_MESSAGES: "20",
    // Max messages in context window
    CLAUDE_RECALL_OPENROUTER_MAX_TOKENS: "100000",
    // Max estimated tokens (~100k safety limit)
    // System Configuration
    CLAUDE_RECALL_DATA_DIR: join2(homedir2(), ".claude-recall"),
    CLAUDE_RECALL_LOG_LEVEL: "INFO",
    CLAUDE_RECALL_PYTHON_VERSION: "3.13",
    CLAUDE_CODE_PATH: "",
    // Empty means auto-detect via 'which claude'
    CLAUDE_RECALL_MODE: "code",
    // Default mode profile
    // Token Economics
    CLAUDE_RECALL_CONTEXT_SHOW_READ_TOKENS: "true",
    CLAUDE_RECALL_CONTEXT_SHOW_WORK_TOKENS: "true",
    CLAUDE_RECALL_CONTEXT_SHOW_SAVINGS_AMOUNT: "true",
    CLAUDE_RECALL_CONTEXT_SHOW_SAVINGS_PERCENT: "true",
    // Observation Filtering
    CLAUDE_RECALL_CONTEXT_OBSERVATION_TYPES: DEFAULT_OBSERVATION_TYPES_STRING,
    CLAUDE_RECALL_CONTEXT_OBSERVATION_CONCEPTS: DEFAULT_OBSERVATION_CONCEPTS_STRING,
    // Display Configuration
    CLAUDE_RECALL_CONTEXT_FULL_COUNT: "5",
    CLAUDE_RECALL_CONTEXT_FULL_FIELD: "narrative",
    CLAUDE_RECALL_CONTEXT_SESSION_COUNT: "10",
    // Feature Toggles
    CLAUDE_RECALL_CONTEXT_SHOW_LAST_SUMMARY: "true",
    CLAUDE_RECALL_CONTEXT_SHOW_LAST_MESSAGE: "false"
  };
  /**
   * Get all defaults as an object
   */
  static getAllDefaults() {
    return { ...this.DEFAULTS };
  }
  /**
   * Get a default value from defaults (no environment variable override)
   */
  static get(key) {
    return this.DEFAULTS[key];
  }
  /**
   * Get an integer default value
   */
  static getInt(key) {
    const value = this.get(key);
    return parseInt(value, 10);
  }
  /**
   * Get a boolean default value
   */
  static getBool(key) {
    const value = this.get(key);
    return value === "true";
  }
  /**
   * Load settings from file with fallback to defaults
   * Returns merged settings with defaults as fallback
   * Handles all errors (missing file, corrupted JSON, permissions) by returning defaults
   */
  static loadFromFile(settingsPath) {
    try {
      if (!existsSync2(settingsPath)) {
        const defaults = this.getAllDefaults();
        try {
          const dir = dirname(settingsPath);
          if (!existsSync2(dir)) {
            mkdirSync2(dir, { recursive: true });
          }
          writeFileSync(settingsPath, JSON.stringify(defaults, null, 2), "utf-8");
          console.log("[SETTINGS] Created settings file with defaults:", settingsPath);
        } catch (error) {
          console.warn("[SETTINGS] Failed to create settings file, using in-memory defaults:", settingsPath, error);
        }
        return defaults;
      }
      const settingsData = readFileSync2(settingsPath, "utf-8");
      const settings = JSON.parse(settingsData);
      let flatSettings = settings;
      if (settings.env && typeof settings.env === "object") {
        flatSettings = settings.env;
        try {
          writeFileSync(settingsPath, JSON.stringify(flatSettings, null, 2), "utf-8");
          console.log("[SETTINGS] Migrated settings file from nested to flat schema:", settingsPath);
        } catch (error) {
          console.warn("[SETTINGS] Failed to auto-migrate settings file:", settingsPath, error);
        }
      }
      const result = { ...this.DEFAULTS };
      for (const key of Object.keys(this.DEFAULTS)) {
        if (flatSettings[key] !== void 0) {
          result[key] = flatSettings[key];
        }
      }
      return result;
    } catch (error) {
      console.warn("[SETTINGS] Failed to load settings, using defaults:", settingsPath, error);
      return this.getAllDefaults();
    }
  }
};

// src/utils/error-messages.ts
function getWorkerRestartInstructions(options = {}) {
  const {
    port,
    includeSkillFallback = false,
    customPrefix,
    actualError
  } = options;
  const prefix = customPrefix || "Worker service connection failed.";
  const portInfo = port ? ` (port ${port})` : "";
  let message = `${prefix}${portInfo}

`;
  message += `To restart the worker:
`;
  message += `1. Exit Claude Code completely
`;
  message += `2. Run: npm run worker:restart
`;
  message += `3. Restart Claude Code`;
  if (includeSkillFallback) {
    message += `

If that doesn't work, try: /troubleshoot`;
  }
  if (actualError) {
    message = `Worker Error: ${actualError}

${message}`;
  }
  return message;
}

// src/shared/worker-utils.ts
var MARKETPLACE_ROOT = path.join(homedir3(), ".claude", "plugins", "marketplaces", "askqai");
var HEALTH_CHECK_TIMEOUT_MS = getTimeout(HOOK_TIMEOUTS.HEALTH_CHECK);
var cachedPort = null;
function getWorkerPort() {
  if (cachedPort !== null) {
    return cachedPort;
  }
  const settingsPath = path.join(SettingsDefaultsManager.get("CLAUDE_RECALL_DATA_DIR"), "settings.json");
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  cachedPort = parseInt(settings.CLAUDE_RECALL_WORKER_PORT, 10);
  return cachedPort;
}
async function isWorkerHealthy() {
  const port = getWorkerPort();
  const response = await fetch(`http://127.0.0.1:${port}/api/readiness`);
  return response.ok;
}
function getPluginVersion() {
  const packageJsonPath = path.join(MARKETPLACE_ROOT, "package.json");
  const packageJson = JSON.parse(readFileSync3(packageJsonPath, "utf-8"));
  return packageJson.version;
}
async function getWorkerVersion() {
  const port = getWorkerPort();
  const response = await fetch(`http://127.0.0.1:${port}/api/version`);
  if (!response.ok) {
    throw new Error(`Failed to get worker version: ${response.status}`);
  }
  const data = await response.json();
  return data.version;
}
async function checkWorkerVersion() {
  const pluginVersion = getPluginVersion();
  const workerVersion = await getWorkerVersion();
  if (pluginVersion !== workerVersion) {
    logger.debug("SYSTEM", "Version check", {
      pluginVersion,
      workerVersion,
      note: "Mismatch will be auto-restarted by worker-service start command"
    });
  }
}
async function ensureWorkerRunning() {
  const maxRetries = 75;
  const pollInterval = 200;
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (await isWorkerHealthy()) {
        await checkWorkerVersion();
        return;
      }
    } catch (e) {
      logger.debug("SYSTEM", "Worker health check failed, will retry", {
        attempt: i + 1,
        maxRetries,
        error: e instanceof Error ? e.message : String(e)
      });
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }
  throw new Error(getWorkerRestartInstructions({
    port: getWorkerPort(),
    customPrefix: "Worker did not become ready within 15 seconds."
  }));
}

// src/utils/project-name.ts
import path3 from "path";

// src/utils/worktree.ts
import { statSync, readFileSync as readFileSync4 } from "fs";
import path2 from "path";
var NOT_A_WORKTREE = {
  isWorktree: false,
  worktreeName: null,
  parentRepoPath: null,
  parentProjectName: null
};
function detectWorktree(cwd) {
  const gitPath = path2.join(cwd, ".git");
  let stat;
  try {
    stat = statSync(gitPath);
  } catch {
    return NOT_A_WORKTREE;
  }
  if (!stat.isFile()) {
    return NOT_A_WORKTREE;
  }
  let content;
  try {
    content = readFileSync4(gitPath, "utf-8").trim();
  } catch {
    return NOT_A_WORKTREE;
  }
  const match = content.match(/^gitdir:\s*(.+)$/);
  if (!match) {
    return NOT_A_WORKTREE;
  }
  const gitdirPath = match[1];
  const worktreesMatch = gitdirPath.match(/^(.+)[/\\]\.git[/\\]worktrees[/\\]([^/\\]+)$/);
  if (!worktreesMatch) {
    return NOT_A_WORKTREE;
  }
  const parentRepoPath = worktreesMatch[1];
  const worktreeName = path2.basename(cwd);
  const parentProjectName = path2.basename(parentRepoPath);
  return {
    isWorktree: true,
    worktreeName,
    parentRepoPath,
    parentProjectName
  };
}

// src/utils/project-name.ts
function getProjectName(cwd) {
  if (!cwd || cwd.trim() === "") {
    logger.warn("PROJECT_NAME", "Empty cwd provided, using fallback", { cwd });
    return "unknown-project";
  }
  const basename2 = path3.basename(cwd);
  if (basename2 === "") {
    const isWindows = process.platform === "win32";
    if (isWindows) {
      const driveMatch = cwd.match(/^([A-Z]):\\/i);
      if (driveMatch) {
        const driveLetter = driveMatch[1].toUpperCase();
        const projectName = `drive-${driveLetter}`;
        logger.info("PROJECT_NAME", "Drive root detected", { cwd, projectName });
        return projectName;
      }
    }
    logger.warn("PROJECT_NAME", "Root directory detected, using fallback", { cwd });
    return "unknown-project";
  }
  return basename2;
}
function getProjectContext(cwd) {
  const primary = getProjectName(cwd);
  if (!cwd) {
    return { primary, parent: null, isWorktree: false, allProjects: [primary] };
  }
  const worktreeInfo = detectWorktree(cwd);
  if (worktreeInfo.isWorktree && worktreeInfo.parentProjectName) {
    return {
      primary,
      parent: worktreeInfo.parentProjectName,
      isWorktree: true,
      allProjects: [worktreeInfo.parentProjectName, primary]
    };
  }
  return { primary, parent: null, isWorktree: false, allProjects: [primary] };
}

// src/cli/handlers/context.ts
var contextHandler = {
  async execute(input) {
    await ensureWorkerRunning();
    const cwd = input.cwd ?? process.cwd();
    const context = getProjectContext(cwd);
    const port = getWorkerPort();
    const projectsParam = context.allProjects.join(",");
    const url = `http://127.0.0.1:${port}/api/context/inject?projects=${encodeURIComponent(projectsParam)}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Context generation failed: ${response.status}`);
    }
    const result = await response.text();
    const additionalContext = result.trim();
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext
      }
    };
  }
};

// src/cli/handlers/session-init.ts
async function queryRAGContext(port, prompt, project, tokenBudget = 2e3) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/rag/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: prompt,
        project,
        limit: 5,
        tokenBudget
      })
    });
    if (!response.ok) {
      logger.debug("HOOK", "RAG query failed with status", { status: response.status });
      return { context: "", stats: { observationCount: 0, summaryCount: 0, queryTimeMs: 0, hotTierHit: false, available: false } };
    }
    const result = await response.json();
    return { context: result.context, stats: result.stats };
  } catch (err) {
    logger.debug("HOOK", "RAG query error", { error: err instanceof Error ? err.message : String(err) });
    return { context: "", stats: { observationCount: 0, summaryCount: 0, queryTimeMs: 0, hotTierHit: false, available: false } };
  }
}
var sessionInitHandler = {
  async execute(input) {
    await ensureWorkerRunning();
    const { sessionId, cwd, prompt } = input;
    if (!prompt) {
      throw new Error("sessionInitHandler requires prompt");
    }
    const project = getProjectName(cwd);
    const port = getWorkerPort();
    logger.debug("HOOK", "session-init: Calling /api/sessions/init", { contentSessionId: sessionId, project });
    const initResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentSessionId: sessionId,
        project,
        prompt
      })
      // Note: Removed signal to avoid Windows Bun cleanup issue (libuv assertion)
    });
    if (!initResponse.ok) {
      throw new Error(`Session initialization failed: ${initResponse.status}`);
    }
    const initResult = await initResponse.json();
    const sessionDbId = initResult.sessionDbId;
    const promptNumber = initResult.promptNumber;
    logger.debug("HOOK", "session-init: Received from /api/sessions/init", { sessionDbId, promptNumber, skipped: initResult.skipped });
    logger.debug("HOOK", `[ALIGNMENT] Hook Entry | contentSessionId=${sessionId} | prompt#=${promptNumber} | sessionDbId=${sessionDbId}`);
    if (initResult.skipped && initResult.reason === "private") {
      logger.info("HOOK", `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | skipped=true | reason=private`, {
        sessionId: sessionDbId
      });
      return { continue: true, suppressOutput: true };
    }
    if (input.platform !== "cursor" && sessionDbId) {
      const cleanedPrompt = prompt.startsWith("/") ? prompt.substring(1) : prompt;
      logger.debug("HOOK", "session-init: Calling /sessions/{sessionDbId}/init", { sessionDbId, promptNumber });
      const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionDbId}/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userPrompt: cleanedPrompt, promptNumber })
        // Note: Removed signal to avoid Windows Bun cleanup issue (libuv assertion)
      });
      if (!response.ok) {
        throw new Error(`SDK agent start failed: ${response.status}`);
      }
    } else if (input.platform === "cursor") {
      logger.debug("HOOK", "session-init: Skipping SDK agent init for Cursor platform", { sessionDbId, promptNumber });
    }
    logger.info("HOOK", `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | project=${project}`, {
      sessionId: sessionDbId
    });
    const ragResult = await queryRAGContext(port, prompt, project, 2e3);
    if (ragResult.context && ragResult.context.trim()) {
      logger.debug("HOOK", "RAG context retrieved", {
        sessionId: sessionDbId,
        promptNumber,
        contextLength: ragResult.context.length,
        observationCount: ragResult.stats.observationCount,
        summaryCount: ragResult.stats.summaryCount,
        queryTimeMs: ragResult.stats.queryTimeMs,
        hotTierHit: ragResult.stats.hotTierHit
      });
      return {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: ragResult.context
        }
      };
    }
    return { continue: true, suppressOutput: true };
  }
};

// src/cli/handlers/observation.ts
var observationHandler = {
  async execute(input) {
    await ensureWorkerRunning();
    const { sessionId, cwd, toolName, toolInput, toolResponse } = input;
    if (!toolName) {
      throw new Error("observationHandler requires toolName");
    }
    const port = getWorkerPort();
    const toolStr = logger.formatTool(toolName, toolInput);
    logger.dataIn("HOOK", `PostToolUse: ${toolStr}`, {
      workerPort: port
    });
    if (!cwd) {
      throw new Error(`Missing cwd in PostToolUse hook input for session ${sessionId}, tool ${toolName}`);
    }
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/observations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentSessionId: sessionId,
        tool_name: toolName,
        tool_input: toolInput,
        tool_response: toolResponse,
        cwd
      })
      // Note: Removed signal to avoid Windows Bun cleanup issue (libuv assertion)
    });
    if (!response.ok) {
      throw new Error(`Observation storage failed: ${response.status}`);
    }
    logger.debug("HOOK", "Observation sent successfully", { toolName });
    return { continue: true, suppressOutput: true };
  }
};

// src/shared/transcript-parser.ts
import { readFileSync as readFileSync5, existsSync as existsSync3 } from "fs";
function extractLastMessage(transcriptPath, role, stripSystemReminders = false) {
  if (!transcriptPath || !existsSync3(transcriptPath)) {
    throw new Error(`Transcript path missing or file does not exist: ${transcriptPath}`);
  }
  const content = readFileSync5(transcriptPath, "utf-8").trim();
  if (!content) {
    throw new Error(`Transcript file exists but is empty: ${transcriptPath}`);
  }
  const lines = content.split("\n");
  let foundMatchingRole = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = JSON.parse(lines[i]);
    if (line.type === role) {
      foundMatchingRole = true;
      if (line.message?.content) {
        let text = "";
        const msgContent = line.message.content;
        if (typeof msgContent === "string") {
          text = msgContent;
        } else if (Array.isArray(msgContent)) {
          text = msgContent.filter((c) => c.type === "text").map((c) => c.text).join("\n");
        } else {
          throw new Error(`Unknown message content format in transcript. Type: ${typeof msgContent}`);
        }
        if (stripSystemReminders) {
          text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
          text = text.replace(/\n{3,}/g, "\n\n").trim();
        }
        return text;
      }
    }
  }
  if (!foundMatchingRole) {
    throw new Error(`No message found for role '${role}' in transcript: ${transcriptPath}`);
  }
  return "";
}

// src/cli/handlers/summarize.ts
var summarizeHandler = {
  async execute(input) {
    await ensureWorkerRunning();
    const { sessionId, transcriptPath } = input;
    const port = getWorkerPort();
    if (!transcriptPath) {
      throw new Error(`Missing transcriptPath in Stop hook input for session ${sessionId}`);
    }
    const lastAssistantMessage = extractLastMessage(transcriptPath, "assistant", true);
    logger.dataIn("HOOK", "Stop: Requesting summary", {
      workerPort: port,
      hasLastAssistantMessage: !!lastAssistantMessage
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentSessionId: sessionId,
        last_assistant_message: lastAssistantMessage
      })
      // Note: Removed signal to avoid Windows Bun cleanup issue (libuv assertion)
    });
    if (!response.ok) {
      return { continue: true, suppressOutput: true };
    }
    logger.debug("HOOK", "Summary request sent successfully");
    return { continue: true, suppressOutput: true };
  }
};

// src/cli/handlers/user-message.ts
import { basename } from "path";
var userMessageHandler = {
  async execute(input) {
    await ensureWorkerRunning();
    const port = getWorkerPort();
    const project = basename(input.cwd ?? process.cwd());
    const response = await fetch(
      `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(project)}&colors=true`,
      { method: "GET" }
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch context: ${response.status}`);
    }
    const output = await response.text();
    console.error(
      "\n\n" + String.fromCodePoint(128221) + " Claude-Recall Context Loaded\n   " + String.fromCodePoint(8505, 65039) + "  Note: This appears as stderr but is informational only\n\n" + output + "\n\n" + String.fromCodePoint(128161) + " New! Wrap all or part of any message with <private> ... </private> to prevent storing sensitive information in your observation history.\n\n" + String.fromCodePoint(128172) + ` Community https://discord.gg/J4wttp9vDu
` + String.fromCodePoint(128250) + ` Watch live in browser http://localhost:${port}/
`
    );
    return { exitCode: HOOK_EXIT_CODES.USER_MESSAGE_ONLY };
  }
};

// src/cli/handlers/file-edit.ts
var fileEditHandler = {
  async execute(input) {
    await ensureWorkerRunning();
    const { sessionId, cwd, filePath, edits } = input;
    if (!filePath) {
      throw new Error("fileEditHandler requires filePath");
    }
    const port = getWorkerPort();
    logger.dataIn("HOOK", `FileEdit: ${filePath}`, {
      workerPort: port,
      editCount: edits?.length ?? 0
    });
    if (!cwd) {
      throw new Error(`Missing cwd in FileEdit hook input for session ${sessionId}, file ${filePath}`);
    }
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/observations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentSessionId: sessionId,
        tool_name: "write_file",
        tool_input: { filePath, edits },
        tool_response: { success: true },
        cwd
      })
      // Note: Removed signal to avoid Windows Bun cleanup issue (libuv assertion)
    });
    if (!response.ok) {
      throw new Error(`File edit observation storage failed: ${response.status}`);
    }
    logger.debug("HOOK", "File edit observation sent successfully", { filePath });
    return { continue: true, suppressOutput: true };
  }
};

// src/cli/handlers/session-end.ts
var sessionEndHandler = {
  async execute(input) {
    await ensureWorkerRunning();
    const { sessionId } = input;
    const port = getWorkerPort();
    logger.debug("HOOK", "SessionEnd: Marking session as completed", {
      contentSessionId: sessionId,
      workerPort: port
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/sessions/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contentSessionId: sessionId
        })
      });
      if (!response.ok) {
        logger.warn("HOOK", "SessionEnd: Failed to mark session completed", {
          contentSessionId: sessionId,
          status: response.status
        });
      } else {
        logger.debug("HOOK", "SessionEnd: Session marked as completed", { contentSessionId: sessionId });
      }
    } catch (error) {
      logger.warn("HOOK", "SessionEnd: Could not reach worker", { contentSessionId: sessionId, error });
    }
    return { continue: true, suppressOutput: true };
  }
};

// src/cli/handlers/index.ts
var handlers = {
  "context": contextHandler,
  "session-init": sessionInitHandler,
  "observation": observationHandler,
  "summarize": summarizeHandler,
  "session-end": sessionEndHandler,
  "user-message": userMessageHandler,
  "file-edit": fileEditHandler
};
function getEventHandler(eventType) {
  const handler = handlers[eventType];
  if (!handler) {
    throw new Error(`Unknown event type: ${eventType}`);
  }
  return handler;
}

// src/cli/hook-command.ts
async function hookCommand(platform, event) {
  try {
    const adapter = getPlatformAdapter(platform);
    const handler = getEventHandler(event);
    const rawInput = await readJsonFromStdin();
    const input = adapter.normalizeInput(rawInput);
    input.platform = platform;
    const result = await handler.execute(input);
    const output = adapter.formatOutput(result);
    console.log(JSON.stringify(output));
    process.exit(result.exitCode ?? HOOK_EXIT_CODES.SUCCESS);
  } catch (error) {
    console.error(`Hook error: ${error}`);
    process.exit(HOOK_EXIT_CODES.BLOCKING_ERROR);
  }
}
export {
  hookCommand
};
