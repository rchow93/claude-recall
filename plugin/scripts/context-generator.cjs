"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/services/context-generator.ts
var context_generator_exports = {};
__export(context_generator_exports, {
  generateContext: () => generateContext
});
module.exports = __toCommonJS(context_generator_exports);

// src/services/context/ContextBuilder.ts
var import_path9 = __toESM(require("path"), 1);
var import_os6 = require("os");
var import_fs6 = require("fs");

// src/services/sqlite/SessionStore.ts
var import_bun_sqlite = require("bun:sqlite");

// src/shared/paths.ts
var import_path3 = require("path");
var import_os3 = require("os");
var import_fs3 = require("fs");
var import_url = require("url");

// src/shared/SettingsDefaultsManager.ts
var import_fs = require("fs");
var import_path = require("path");
var import_os = require("os");

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
    CLAUDE_RECALL_DATA_DIR: (0, import_path.join)((0, import_os.homedir)(), ".claude-recall"),
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
      if (!(0, import_fs.existsSync)(settingsPath)) {
        const defaults = this.getAllDefaults();
        try {
          const dir = (0, import_path.dirname)(settingsPath);
          if (!(0, import_fs.existsSync)(dir)) {
            (0, import_fs.mkdirSync)(dir, { recursive: true });
          }
          (0, import_fs.writeFileSync)(settingsPath, JSON.stringify(defaults, null, 2), "utf-8");
          console.log("[SETTINGS] Created settings file with defaults:", settingsPath);
        } catch (error) {
          console.warn("[SETTINGS] Failed to create settings file, using in-memory defaults:", settingsPath, error);
        }
        return defaults;
      }
      const settingsData = (0, import_fs.readFileSync)(settingsPath, "utf-8");
      const settings = JSON.parse(settingsData);
      let flatSettings = settings;
      if (settings.env && typeof settings.env === "object") {
        flatSettings = settings.env;
        try {
          (0, import_fs.writeFileSync)(settingsPath, JSON.stringify(flatSettings, null, 2), "utf-8");
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

// src/utils/logger.ts
var import_fs2 = require("fs");
var import_path2 = require("path");
var import_os2 = require("os");
var LogLevel = /* @__PURE__ */ ((LogLevel2) => {
  LogLevel2[LogLevel2["DEBUG"] = 0] = "DEBUG";
  LogLevel2[LogLevel2["INFO"] = 1] = "INFO";
  LogLevel2[LogLevel2["WARN"] = 2] = "WARN";
  LogLevel2[LogLevel2["ERROR"] = 3] = "ERROR";
  LogLevel2[LogLevel2["SILENT"] = 4] = "SILENT";
  return LogLevel2;
})(LogLevel || {});
var DEFAULT_DATA_DIR = (0, import_path2.join)((0, import_os2.homedir)(), ".claude-recall");
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
      const logsDir = (0, import_path2.join)(DEFAULT_DATA_DIR, "logs");
      if (!(0, import_fs2.existsSync)(logsDir)) {
        (0, import_fs2.mkdirSync)(logsDir, { recursive: true });
      }
      const date = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
      this.logFilePath = (0, import_path2.join)(logsDir, `claude-recall-${date}.log`);
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
        const settingsPath = (0, import_path2.join)(DEFAULT_DATA_DIR, "settings.json");
        if ((0, import_fs2.existsSync)(settingsPath)) {
          const settingsData = (0, import_fs2.readFileSync)(settingsPath, "utf-8");
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
        (0, import_fs2.appendFileSync)(this.logFilePath, logLine + "\n", "utf8");
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

// src/shared/paths.ts
var import_meta = {};
function getDirname() {
  if (typeof __dirname !== "undefined") {
    return __dirname;
  }
  return (0, import_path3.dirname)((0, import_url.fileURLToPath)(import_meta.url));
}
var _dirname = getDirname();
var DATA_DIR = SettingsDefaultsManager.get("CLAUDE_RECALL_DATA_DIR");
var CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || (0, import_path3.join)((0, import_os3.homedir)(), ".claude");
var ARCHIVES_DIR = (0, import_path3.join)(DATA_DIR, "archives");
var LOGS_DIR = (0, import_path3.join)(DATA_DIR, "logs");
var TRASH_DIR = (0, import_path3.join)(DATA_DIR, "trash");
var BACKUPS_DIR = (0, import_path3.join)(DATA_DIR, "backups");
var MODES_DIR = (0, import_path3.join)(DATA_DIR, "modes");
var USER_SETTINGS_PATH = (0, import_path3.join)(DATA_DIR, "settings.json");
var DB_PATH = (0, import_path3.join)(DATA_DIR, "claude-recall.db");
var VECTOR_DB_DIR = (0, import_path3.join)(DATA_DIR, "vector-db");
var CLAUDE_SETTINGS_PATH = (0, import_path3.join)(CLAUDE_CONFIG_DIR, "settings.json");
var CLAUDE_COMMANDS_DIR = (0, import_path3.join)(CLAUDE_CONFIG_DIR, "commands");
var CLAUDE_MD_PATH = (0, import_path3.join)(CLAUDE_CONFIG_DIR, "CLAUDE.md");
function ensureDir(dirPath) {
  (0, import_fs3.mkdirSync)(dirPath, { recursive: true });
}
function getPackageRoot() {
  return (0, import_path3.join)(_dirname, "..");
}

// src/services/sqlite/SessionStore.ts
var SessionStore = class {
  db;
  constructor(dbPath = DB_PATH) {
    if (dbPath !== ":memory:") {
      ensureDir(DATA_DIR);
    }
    this.db = new import_bun_sqlite.Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.initializeSchema();
    this.ensureWorkerPortColumn();
    this.ensurePromptTrackingColumns();
    this.removeSessionSummariesUniqueConstraint();
    this.addObservationHierarchicalFields();
    this.makeObservationsTextNullable();
    this.createUserPromptsTable();
    this.ensureDiscoveryTokensColumn();
    this.createPendingMessagesTable();
    this.renameSessionIdColumns();
    this.repairSessionIdColumnRename();
    this.addFailedAtEpochColumn();
  }
  /**
   * Initialize database schema using migrations (migration004)
   * This runs the core SDK tables migration if no tables exist
   */
  initializeSchema() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    const appliedVersions = this.db.prepare("SELECT version FROM schema_versions ORDER BY version").all();
    const maxApplied = appliedVersions.length > 0 ? Math.max(...appliedVersions.map((v) => v.version)) : 0;
    if (maxApplied === 0) {
      logger.info("DB", "Initializing fresh database with migration004");
      this.db.run(`
        CREATE TABLE IF NOT EXISTS sdk_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content_session_id TEXT UNIQUE NOT NULL,
          memory_session_id TEXT UNIQUE,
          project TEXT NOT NULL,
          user_prompt TEXT,
          started_at TEXT NOT NULL,
          started_at_epoch INTEGER NOT NULL,
          completed_at TEXT,
          completed_at_epoch INTEGER,
          status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active'
        );

        CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id);
        CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id);
        CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project);
        CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status);
        CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC);

        CREATE TABLE IF NOT EXISTS observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          text TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery')),
          created_at TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_observations_sdk_session ON observations(memory_session_id);
        CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project);
        CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
        CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC);

        CREATE TABLE IF NOT EXISTS session_summaries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_session_id TEXT UNIQUE NOT NULL,
          project TEXT NOT NULL,
          request TEXT,
          investigated TEXT,
          learned TEXT,
          completed TEXT,
          next_steps TEXT,
          files_read TEXT,
          files_edited TEXT,
          notes TEXT,
          created_at TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
        CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project);
        CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
      `);
      this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4, (/* @__PURE__ */ new Date()).toISOString());
      logger.info("DB", "Migration004 applied successfully");
    }
  }
  /**
   * Ensure worker_port column exists (migration 5)
   */
  ensureWorkerPortColumn() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(5);
    if (applied) return;
    const tableInfo = this.db.query("PRAGMA table_info(sdk_sessions)").all();
    const hasWorkerPort = tableInfo.some((col) => col.name === "worker_port");
    if (!hasWorkerPort) {
      this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER");
      logger.debug("DB", "Added worker_port column to sdk_sessions table");
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5, (/* @__PURE__ */ new Date()).toISOString());
  }
  /**
   * Ensure prompt tracking columns exist (migration 6)
   */
  ensurePromptTrackingColumns() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(6);
    if (applied) return;
    const sessionsInfo = this.db.query("PRAGMA table_info(sdk_sessions)").all();
    const hasPromptCounter = sessionsInfo.some((col) => col.name === "prompt_counter");
    if (!hasPromptCounter) {
      this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0");
      logger.debug("DB", "Added prompt_counter column to sdk_sessions table");
    }
    const observationsInfo = this.db.query("PRAGMA table_info(observations)").all();
    const obsHasPromptNumber = observationsInfo.some((col) => col.name === "prompt_number");
    if (!obsHasPromptNumber) {
      this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER");
      logger.debug("DB", "Added prompt_number column to observations table");
    }
    const summariesInfo = this.db.query("PRAGMA table_info(session_summaries)").all();
    const sumHasPromptNumber = summariesInfo.some((col) => col.name === "prompt_number");
    if (!sumHasPromptNumber) {
      this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER");
      logger.debug("DB", "Added prompt_number column to session_summaries table");
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6, (/* @__PURE__ */ new Date()).toISOString());
  }
  /**
   * Remove UNIQUE constraint from session_summaries.memory_session_id (migration 7)
   */
  removeSessionSummariesUniqueConstraint() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(7);
    if (applied) return;
    const summariesIndexes = this.db.query("PRAGMA index_list(session_summaries)").all();
    const hasUniqueConstraint = summariesIndexes.some((idx) => idx.unique === 1);
    if (!hasUniqueConstraint) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7, (/* @__PURE__ */ new Date()).toISOString());
      return;
    }
    logger.debug("DB", "Removing UNIQUE constraint from session_summaries.memory_session_id");
    this.db.run("BEGIN TRANSACTION");
    this.db.run(`
      CREATE TABLE session_summaries_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        prompt_number INTEGER,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
      )
    `);
    this.db.run(`
      INSERT INTO session_summaries_new
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, files_read, files_edited, notes,
             prompt_number, created_at, created_at_epoch
      FROM session_summaries
    `);
    this.db.run("DROP TABLE session_summaries");
    this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries");
    this.db.run(`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `);
    this.db.run("COMMIT");
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7, (/* @__PURE__ */ new Date()).toISOString());
    logger.debug("DB", "Successfully removed UNIQUE constraint from session_summaries.memory_session_id");
  }
  /**
   * Add hierarchical fields to observations table (migration 8)
   */
  addObservationHierarchicalFields() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8);
    if (applied) return;
    const tableInfo = this.db.query("PRAGMA table_info(observations)").all();
    const hasTitle = tableInfo.some((col) => col.name === "title");
    if (hasTitle) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8, (/* @__PURE__ */ new Date()).toISOString());
      return;
    }
    logger.debug("DB", "Adding hierarchical fields to observations table");
    this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `);
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8, (/* @__PURE__ */ new Date()).toISOString());
    logger.debug("DB", "Successfully added hierarchical fields to observations table");
  }
  /**
   * Make observations.text nullable (migration 9)
   * The text field is deprecated in favor of structured fields (title, subtitle, narrative, etc.)
   */
  makeObservationsTextNullable() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9);
    if (applied) return;
    const tableInfo = this.db.query("PRAGMA table_info(observations)").all();
    const textColumn = tableInfo.find((col) => col.name === "text");
    if (!textColumn || textColumn.notnull === 0) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9, (/* @__PURE__ */ new Date()).toISOString());
      return;
    }
    logger.debug("DB", "Making observations.text nullable");
    this.db.run("BEGIN TRANSACTION");
    this.db.run(`
      CREATE TABLE observations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT,
        type TEXT NOT NULL CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change')),
        title TEXT,
        subtitle TEXT,
        facts TEXT,
        narrative TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        prompt_number INTEGER,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
      )
    `);
    this.db.run(`
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             created_at, created_at_epoch
      FROM observations
    `);
    this.db.run("DROP TABLE observations");
    this.db.run("ALTER TABLE observations_new RENAME TO observations");
    this.db.run(`
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `);
    this.db.run("COMMIT");
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9, (/* @__PURE__ */ new Date()).toISOString());
    logger.debug("DB", "Successfully made observations.text nullable");
  }
  /**
   * Create user_prompts table with FTS5 support (migration 10)
   */
  createUserPromptsTable() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10);
    if (applied) return;
    const tableInfo = this.db.query("PRAGMA table_info(user_prompts)").all();
    if (tableInfo.length > 0) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10, (/* @__PURE__ */ new Date()).toISOString());
      return;
    }
    logger.debug("DB", "Creating user_prompts table with FTS5 support");
    this.db.run("BEGIN TRANSACTION");
    this.db.run(`
      CREATE TABLE user_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        prompt_number INTEGER NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(content_session_id) REFERENCES sdk_sessions(content_session_id) ON DELETE CASCADE
      );

      CREATE INDEX idx_user_prompts_claude_session ON user_prompts(content_session_id);
      CREATE INDEX idx_user_prompts_created ON user_prompts(created_at_epoch DESC);
      CREATE INDEX idx_user_prompts_prompt_number ON user_prompts(prompt_number);
      CREATE INDEX idx_user_prompts_lookup ON user_prompts(content_session_id, prompt_number);
    `);
    this.db.run(`
      CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
        prompt_text,
        content='user_prompts',
        content_rowid='id'
      );
    `);
    this.db.run(`
      CREATE TRIGGER user_prompts_ai AFTER INSERT ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(rowid, prompt_text)
        VALUES (new.id, new.prompt_text);
      END;

      CREATE TRIGGER user_prompts_ad AFTER DELETE ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
        VALUES('delete', old.id, old.prompt_text);
      END;

      CREATE TRIGGER user_prompts_au AFTER UPDATE ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
        VALUES('delete', old.id, old.prompt_text);
        INSERT INTO user_prompts_fts(rowid, prompt_text)
        VALUES (new.id, new.prompt_text);
      END;
    `);
    this.db.run("COMMIT");
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10, (/* @__PURE__ */ new Date()).toISOString());
    logger.debug("DB", "Successfully created user_prompts table with FTS5 support");
  }
  /**
   * Ensure discovery_tokens column exists (migration 11)
   * CRITICAL: This migration was incorrectly using version 7 (which was already taken by removeSessionSummariesUniqueConstraint)
   * The duplicate version number may have caused migration tracking issues in some databases
   */
  ensureDiscoveryTokensColumn() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11);
    if (applied) return;
    const observationsInfo = this.db.query("PRAGMA table_info(observations)").all();
    const obsHasDiscoveryTokens = observationsInfo.some((col) => col.name === "discovery_tokens");
    if (!obsHasDiscoveryTokens) {
      this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0");
      logger.debug("DB", "Added discovery_tokens column to observations table");
    }
    const summariesInfo = this.db.query("PRAGMA table_info(session_summaries)").all();
    const sumHasDiscoveryTokens = summariesInfo.some((col) => col.name === "discovery_tokens");
    if (!sumHasDiscoveryTokens) {
      this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0");
      logger.debug("DB", "Added discovery_tokens column to session_summaries table");
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11, (/* @__PURE__ */ new Date()).toISOString());
  }
  /**
   * Create pending_messages table for persistent work queue (migration 16)
   * Messages are persisted before processing and deleted after success.
   * Enables recovery from SDK hangs and worker crashes.
   */
  createPendingMessagesTable() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16);
    if (applied) return;
    const tables = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all();
    if (tables.length > 0) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16, (/* @__PURE__ */ new Date()).toISOString());
      return;
    }
    logger.debug("DB", "Creating pending_messages table");
    this.db.run(`
      CREATE TABLE pending_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER NOT NULL,
        content_session_id TEXT NOT NULL,
        message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')),
        tool_name TEXT,
        tool_input TEXT,
        tool_response TEXT,
        cwd TEXT,
        last_user_message TEXT,
        last_assistant_message TEXT,
        prompt_number INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'processed', 'failed')),
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at_epoch INTEGER NOT NULL,
        started_processing_at_epoch INTEGER,
        completed_at_epoch INTEGER,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)");
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16, (/* @__PURE__ */ new Date()).toISOString());
    logger.debug("DB", "pending_messages table created successfully");
  }
  /**
   * Rename session ID columns for semantic clarity (migration 17)
   * - claude_session_id → content_session_id (user's observed session)
   * - sdk_session_id → memory_session_id (memory agent's session for resume)
   *
   * IDEMPOTENT: Checks each table individually before renaming.
   * This handles databases in any intermediate state (partial migration, fresh install, etc.)
   */
  renameSessionIdColumns() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17);
    if (applied) return;
    logger.debug("DB", "Checking session ID columns for semantic clarity rename");
    let renamesPerformed = 0;
    const safeRenameColumn = (table, oldCol, newCol) => {
      const tableInfo = this.db.query(`PRAGMA table_info(${table})`).all();
      const hasOldCol = tableInfo.some((col) => col.name === oldCol);
      const hasNewCol = tableInfo.some((col) => col.name === newCol);
      if (hasNewCol) {
        return false;
      }
      if (hasOldCol) {
        this.db.run(`ALTER TABLE ${table} RENAME COLUMN ${oldCol} TO ${newCol}`);
        logger.debug("DB", `Renamed ${table}.${oldCol} to ${newCol}`);
        return true;
      }
      logger.warn("DB", `Column ${oldCol} not found in ${table}, skipping rename`);
      return false;
    };
    if (safeRenameColumn("sdk_sessions", "claude_session_id", "content_session_id")) renamesPerformed++;
    if (safeRenameColumn("sdk_sessions", "sdk_session_id", "memory_session_id")) renamesPerformed++;
    if (safeRenameColumn("pending_messages", "claude_session_id", "content_session_id")) renamesPerformed++;
    if (safeRenameColumn("observations", "sdk_session_id", "memory_session_id")) renamesPerformed++;
    if (safeRenameColumn("session_summaries", "sdk_session_id", "memory_session_id")) renamesPerformed++;
    if (safeRenameColumn("user_prompts", "claude_session_id", "content_session_id")) renamesPerformed++;
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17, (/* @__PURE__ */ new Date()).toISOString());
    if (renamesPerformed > 0) {
      logger.debug("DB", `Successfully renamed ${renamesPerformed} session ID columns`);
    } else {
      logger.debug("DB", "No session ID column renames needed (already up to date)");
    }
  }
  /**
   * Repair session ID column renames (migration 19)
   * DEPRECATED: Migration 17 is now fully idempotent and handles all cases.
   * This migration is kept for backwards compatibility but does nothing.
   */
  repairSessionIdColumnRename() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(19);
    if (applied) return;
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(19, (/* @__PURE__ */ new Date()).toISOString());
  }
  /**
   * Add failed_at_epoch column to pending_messages (migration 20)
   * Used by markSessionMessagesFailed() for error recovery tracking
   */
  addFailedAtEpochColumn() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20);
    if (applied) return;
    const tableInfo = this.db.query("PRAGMA table_info(pending_messages)").all();
    const hasColumn = tableInfo.some((col) => col.name === "failed_at_epoch");
    if (!hasColumn) {
      this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER");
      logger.debug("DB", "Added failed_at_epoch column to pending_messages table");
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20, (/* @__PURE__ */ new Date()).toISOString());
  }
  /**
   * Update the memory session ID for a session
   * Called by SDKAgent when it captures the session ID from the first SDK message
   */
  updateMemorySessionId(sessionDbId, memorySessionId) {
    this.db.prepare(`
      UPDATE sdk_sessions
      SET memory_session_id = ?
      WHERE id = ?
    `).run(memorySessionId, sessionDbId);
  }
  /**
   * Mark a session as completed
   * Called by SessionEnd hook when the user exits Claude Code
   */
  markSessionCompleted(contentSessionId) {
    const now = /* @__PURE__ */ new Date();
    const nowEpoch = now.getTime();
    const result = this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed',
          completed_at = ?,
          completed_at_epoch = ?
      WHERE content_session_id = ? AND status = 'active'
    `).run(now.toISOString(), nowEpoch, contentSessionId);
    return result.changes > 0;
  }
  /**
   * Mark a session as completed by database ID
   */
  markSessionCompletedById(sessionDbId) {
    const now = /* @__PURE__ */ new Date();
    const nowEpoch = now.getTime();
    const result = this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed',
          completed_at = ?,
          completed_at_epoch = ?
      WHERE id = ? AND status = 'active'
    `).run(now.toISOString(), nowEpoch, sessionDbId);
    return result.changes > 0;
  }
  /**
   * Mark stale sessions as completed
   * Sessions are considered stale if they've been active for longer than the threshold
   * and have no recent activity.
   *
   * @param maxAgeMs Maximum age in milliseconds (default: 2 hours)
   * @param excludeSessionDbIds Session IDs to exclude (e.g., currently active in memory)
   * @returns Number of sessions marked as completed
   */
  markStaleSessions(maxAgeMs = 2 * 60 * 60 * 1e3, excludeSessionDbIds = []) {
    const now = /* @__PURE__ */ new Date();
    const nowEpoch = now.getTime();
    const cutoffEpoch = nowEpoch - maxAgeMs;
    const exclusionClause = excludeSessionDbIds.length > 0 ? `AND id NOT IN (${excludeSessionDbIds.join(",")})` : "";
    const result = this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed',
          completed_at = ?,
          completed_at_epoch = ?
      WHERE status = 'active'
        AND started_at_epoch < ?
        ${exclusionClause}
    `).run(now.toISOString(), nowEpoch, cutoffEpoch);
    if (result.changes > 0) {
      logger.info("DB", `Marked ${result.changes} stale sessions as completed`, {
        maxAgeMs,
        cutoffEpoch,
        excludedCount: excludeSessionDbIds.length
      });
    }
    return result.changes;
  }
  /**
   * Get recent session summaries for a project
   */
  getRecentSummaries(project, limit = 10) {
    const stmt = this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `);
    return stmt.all(project, limit);
  }
  /**
   * Get recent summaries with session info for context display
   */
  getRecentSummariesWithSessionInfo(project, limit = 3) {
    const stmt = this.db.prepare(`
      SELECT
        memory_session_id, request, learned, completed, next_steps,
        prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `);
    return stmt.all(project, limit);
  }
  /**
   * Get recent observations for a project
   */
  getRecentObservations(project, limit = 20) {
    const stmt = this.db.prepare(`
      SELECT type, text, prompt_number, created_at
      FROM observations
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `);
    return stmt.all(project, limit);
  }
  /**
   * Get recent observations across all projects (for web UI)
   */
  getAllRecentObservations(limit = 100) {
    const stmt = this.db.prepare(`
      SELECT id, type, title, subtitle, text, project, prompt_number, created_at, created_at_epoch
      FROM observations
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `);
    return stmt.all(limit);
  }
  /**
   * Get recent summaries across all projects (for web UI)
   */
  getAllRecentSummaries(limit = 50) {
    const stmt = this.db.prepare(`
      SELECT id, request, investigated, learned, completed, next_steps,
             files_read, files_edited, notes, project, prompt_number,
             created_at, created_at_epoch
      FROM session_summaries
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `);
    return stmt.all(limit);
  }
  /**
   * Get recent user prompts across all sessions (for web UI)
   */
  getAllRecentUserPrompts(limit = 100) {
    const stmt = this.db.prepare(`
      SELECT
        up.id,
        up.content_session_id,
        s.project,
        up.prompt_number,
        up.prompt_text,
        up.created_at,
        up.created_at_epoch
      FROM user_prompts up
      LEFT JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      ORDER BY up.created_at_epoch DESC
      LIMIT ?
    `);
    return stmt.all(limit);
  }
  /**
   * Get all unique projects from the database (for web UI project filter)
   */
  getAllProjects() {
    const stmt = this.db.prepare(`
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
      ORDER BY project ASC
    `);
    const rows = stmt.all();
    return rows.map((row) => row.project);
  }
  /**
   * Get latest user prompt with session info for a Claude session
   * Used for syncing prompts to Chroma during session initialization
   */
  getLatestUserPrompt(contentSessionId) {
    const stmt = this.db.prepare(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.content_session_id = ?
      ORDER BY up.created_at_epoch DESC
      LIMIT 1
    `);
    return stmt.get(contentSessionId);
  }
  /**
   * Get recent sessions with their status and summary info
   */
  getRecentSessionsWithStatus(project, limit = 3) {
    const stmt = this.db.prepare(`
      SELECT * FROM (
        SELECT
          s.memory_session_id,
          s.status,
          s.started_at,
          s.started_at_epoch,
          s.user_prompt,
          CASE WHEN sum.memory_session_id IS NOT NULL THEN 1 ELSE 0 END as has_summary
        FROM sdk_sessions s
        LEFT JOIN session_summaries sum ON s.memory_session_id = sum.memory_session_id
        WHERE s.project = ? AND s.memory_session_id IS NOT NULL
        GROUP BY s.memory_session_id
        ORDER BY s.started_at_epoch DESC
        LIMIT ?
      )
      ORDER BY started_at_epoch ASC
    `);
    return stmt.all(project, limit);
  }
  /**
   * Get observations for a specific session
   */
  getObservationsForSession(memorySessionId) {
    const stmt = this.db.prepare(`
      SELECT title, subtitle, type, prompt_number
      FROM observations
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch ASC
    `);
    return stmt.all(memorySessionId);
  }
  /**
   * Get a single observation by ID
   */
  getObservationById(id) {
    const stmt = this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id = ?
    `);
    return stmt.get(id) || null;
  }
  /**
   * Get observations by array of IDs with ordering and limit
   */
  getObservationsByIds(ids, options = {}) {
    if (ids.length === 0) return [];
    const { orderBy = "date_desc", limit, project, type, concepts, files } = options;
    const orderClause = orderBy === "date_asc" ? "ASC" : "DESC";
    const limitClause = limit ? `LIMIT ${limit}` : "";
    const placeholders = ids.map(() => "?").join(",");
    const params = [...ids];
    const additionalConditions = [];
    if (project) {
      additionalConditions.push("project = ?");
      params.push(project);
    }
    if (type) {
      if (Array.isArray(type)) {
        const typePlaceholders = type.map(() => "?").join(",");
        additionalConditions.push(`type IN (${typePlaceholders})`);
        params.push(...type);
      } else {
        additionalConditions.push("type = ?");
        params.push(type);
      }
    }
    if (concepts) {
      const conceptsList = Array.isArray(concepts) ? concepts : [concepts];
      const conceptConditions = conceptsList.map(
        () => "EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)"
      );
      params.push(...conceptsList);
      additionalConditions.push(`(${conceptConditions.join(" OR ")})`);
    }
    if (files) {
      const filesList = Array.isArray(files) ? files : [files];
      const fileConditions = filesList.map(() => {
        return "(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))";
      });
      filesList.forEach((file) => {
        params.push(`%${file}%`, `%${file}%`);
      });
      additionalConditions.push(`(${fileConditions.join(" OR ")})`);
    }
    const whereClause = additionalConditions.length > 0 ? `WHERE id IN (${placeholders}) AND ${additionalConditions.join(" AND ")}` : `WHERE id IN (${placeholders})`;
    const stmt = this.db.prepare(`
      SELECT *
      FROM observations
      ${whereClause}
      ORDER BY created_at_epoch ${orderClause}
      ${limitClause}
    `);
    return stmt.all(...params);
  }
  /**
   * Get summary for a specific session
   */
  getSummaryForSession(memorySessionId) {
    const stmt = this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at,
        created_at_epoch
      FROM session_summaries
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `);
    return stmt.get(memorySessionId) || null;
  }
  /**
   * Get aggregated files from all observations for a session
   */
  getFilesForSession(memorySessionId) {
    const stmt = this.db.prepare(`
      SELECT files_read, files_modified
      FROM observations
      WHERE memory_session_id = ?
    `);
    const rows = stmt.all(memorySessionId);
    const filesReadSet = /* @__PURE__ */ new Set();
    const filesModifiedSet = /* @__PURE__ */ new Set();
    for (const row of rows) {
      if (row.files_read) {
        const files = JSON.parse(row.files_read);
        if (Array.isArray(files)) {
          files.forEach((f) => filesReadSet.add(f));
        }
      }
      if (row.files_modified) {
        const files = JSON.parse(row.files_modified);
        if (Array.isArray(files)) {
          files.forEach((f) => filesModifiedSet.add(f));
        }
      }
    }
    return {
      filesRead: Array.from(filesReadSet),
      filesModified: Array.from(filesModifiedSet)
    };
  }
  /**
   * Get session by ID
   */
  getSessionById(id) {
    const stmt = this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project, user_prompt
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `);
    return stmt.get(id) || null;
  }
  /**
   * Get SDK sessions by SDK session IDs
   * Used for exporting session metadata
   */
  getSdkSessionsBySessionIds(memorySessionIds) {
    if (memorySessionIds.length === 0) return [];
    const placeholders = memorySessionIds.map(() => "?").join(",");
    const stmt = this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project, user_prompt,
             started_at, started_at_epoch, completed_at, completed_at_epoch, status
      FROM sdk_sessions
      WHERE memory_session_id IN (${placeholders})
      ORDER BY started_at_epoch DESC
    `);
    return stmt.all(...memorySessionIds);
  }
  /**
   * Get current prompt number by counting user_prompts for this session
   * Replaces the prompt_counter column which is no longer maintained
   */
  getPromptNumberFromUserPrompts(contentSessionId) {
    const result = this.db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
    `).get(contentSessionId);
    return result.count;
  }
  /**
   * Create a new SDK session (idempotent - returns existing session ID if already exists)
   *
   * CRITICAL ARCHITECTURE: Session ID Threading
   * ============================================
   * This function is the KEY to how claude-recall stays unified across hooks:
   *
   * - NEW hook calls: createSDKSession(session_id, project, prompt)
   * - SAVE hook calls: createSDKSession(session_id, '', '')
   * - Both use the SAME session_id from Claude Code's hook context
   *
   * IDEMPOTENT BEHAVIOR (INSERT OR IGNORE):
   * - Prompt #1: session_id not in database → INSERT creates new row
   * - Prompt #2+: session_id exists → INSERT ignored, fetch existing ID
   * - Result: Same database ID returned for all prompts in conversation
   *
   * WHY THIS MATTERS:
   * - NO "does session exist?" checks needed anywhere
   * - NO risk of creating duplicate sessions
   * - ALL hooks automatically connected via session_id
   * - SAVE hook observations go to correct session (same session_id)
   * - SDKAgent continuation prompt has correct context (same session_id)
   *
   * This is KISS in action: Trust the database UNIQUE constraint and
   * INSERT OR IGNORE to handle both creation and lookup elegantly.
   */
  createSDKSession(contentSessionId, project, userPrompt) {
    const now = /* @__PURE__ */ new Date();
    const nowEpoch = now.getTime();
    this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (content_session_id, memory_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, 'active')
    `).run(contentSessionId, project, userPrompt, now.toISOString(), nowEpoch);
    const row = this.db.prepare("SELECT id FROM sdk_sessions WHERE content_session_id = ?").get(contentSessionId);
    return row.id;
  }
  /**
   * Save a user prompt
   */
  saveUserPrompt(contentSessionId, promptNumber, promptText) {
    const now = /* @__PURE__ */ new Date();
    const nowEpoch = now.getTime();
    const stmt = this.db.prepare(`
      INSERT INTO user_prompts
      (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(contentSessionId, promptNumber, promptText, now.toISOString(), nowEpoch);
    return result.lastInsertRowid;
  }
  /**
   * Get user prompt by session ID and prompt number
   * Returns the prompt text, or null if not found
   */
  getUserPrompt(contentSessionId, promptNumber) {
    const stmt = this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `);
    const result = stmt.get(contentSessionId, promptNumber);
    return result?.prompt_text ?? null;
  }
  /**
   * Store an observation (from SDK parsing)
   * Assumes session already exists (created by hook)
   */
  storeObservation(memorySessionId, project, observation, promptNumber, discoveryTokens = 0, overrideTimestampEpoch) {
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      memorySessionId,
      project,
      observation.type,
      observation.title,
      observation.subtitle,
      JSON.stringify(observation.facts),
      observation.narrative,
      JSON.stringify(observation.concepts),
      JSON.stringify(observation.files_read),
      JSON.stringify(observation.files_modified),
      promptNumber || null,
      discoveryTokens,
      timestampIso,
      timestampEpoch
    );
    return {
      id: Number(result.lastInsertRowid),
      createdAtEpoch: timestampEpoch
    };
  }
  /**
   * Store a session summary (from SDK parsing)
   * Assumes session already exists - will fail with FK error if not
   */
  storeSummary(memorySessionId, project, summary, promptNumber, discoveryTokens = 0, overrideTimestampEpoch) {
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      memorySessionId,
      project,
      summary.request,
      summary.investigated,
      summary.learned,
      summary.completed,
      summary.next_steps,
      summary.notes,
      promptNumber || null,
      discoveryTokens,
      timestampIso,
      timestampEpoch
    );
    return {
      id: Number(result.lastInsertRowid),
      createdAtEpoch: timestampEpoch
    };
  }
  /**
   * ATOMIC: Store observations + summary (no message tracking)
   *
   * Simplified version for use with claim-and-delete queue pattern.
   * Messages are deleted from queue immediately on claim, so there's no
   * message completion to track. This just stores observations and summary.
   *
   * @param memorySessionId - SDK memory session ID
   * @param project - Project name
   * @param observations - Array of observations to store (can be empty)
   * @param summary - Optional summary to store
   * @param promptNumber - Optional prompt number
   * @param discoveryTokens - Discovery tokens count
   * @param overrideTimestampEpoch - Optional override timestamp
   * @returns Object with observation IDs, optional summary ID, and timestamp
   */
  storeObservations(memorySessionId, project, observations, summary, promptNumber, discoveryTokens = 0, overrideTimestampEpoch) {
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();
    const storeTx = this.db.transaction(() => {
      const observationIds = [];
      const obsStmt = this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const observation of observations) {
        const result = obsStmt.run(
          memorySessionId,
          project,
          observation.type,
          observation.title,
          observation.subtitle,
          JSON.stringify(observation.facts),
          observation.narrative,
          JSON.stringify(observation.concepts),
          JSON.stringify(observation.files_read),
          JSON.stringify(observation.files_modified),
          promptNumber || null,
          discoveryTokens,
          timestampIso,
          timestampEpoch
        );
        observationIds.push(Number(result.lastInsertRowid));
      }
      let summaryId = null;
      if (summary) {
        const summaryStmt = this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const result = summaryStmt.run(
          memorySessionId,
          project,
          summary.request,
          summary.investigated,
          summary.learned,
          summary.completed,
          summary.next_steps,
          summary.notes,
          promptNumber || null,
          discoveryTokens,
          timestampIso,
          timestampEpoch
        );
        summaryId = Number(result.lastInsertRowid);
      }
      return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
    });
    return storeTx();
  }
  /**
   * @deprecated Use storeObservations instead. This method is kept for backwards compatibility.
   *
   * ATOMIC: Store observations + summary + mark pending message as processed
   *
   * This method wraps observation storage, summary storage, and message completion
   * in a single database transaction to prevent race conditions. If the worker crashes
   * during processing, either all operations succeed together or all fail together.
   *
   * This fixes the observation duplication bug where observations were stored but
   * the message wasn't marked complete, causing reprocessing on crash recovery.
   *
   * @param memorySessionId - SDK memory session ID
   * @param project - Project name
   * @param observations - Array of observations to store (can be empty)
   * @param summary - Optional summary to store
   * @param messageId - Pending message ID to mark as processed
   * @param pendingStore - PendingMessageStore instance for marking complete
   * @param promptNumber - Optional prompt number
   * @param discoveryTokens - Discovery tokens count
   * @param overrideTimestampEpoch - Optional override timestamp
   * @returns Object with observation IDs, optional summary ID, and timestamp
   */
  storeObservationsAndMarkComplete(memorySessionId, project, observations, summary, messageId, _pendingStore, promptNumber, discoveryTokens = 0, overrideTimestampEpoch) {
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();
    const storeAndMarkTx = this.db.transaction(() => {
      const observationIds = [];
      const obsStmt = this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const observation of observations) {
        const result = obsStmt.run(
          memorySessionId,
          project,
          observation.type,
          observation.title,
          observation.subtitle,
          JSON.stringify(observation.facts),
          observation.narrative,
          JSON.stringify(observation.concepts),
          JSON.stringify(observation.files_read),
          JSON.stringify(observation.files_modified),
          promptNumber || null,
          discoveryTokens,
          timestampIso,
          timestampEpoch
        );
        observationIds.push(Number(result.lastInsertRowid));
      }
      let summaryId;
      if (summary) {
        const summaryStmt = this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const result = summaryStmt.run(
          memorySessionId,
          project,
          summary.request,
          summary.investigated,
          summary.learned,
          summary.completed,
          summary.next_steps,
          summary.notes,
          promptNumber || null,
          discoveryTokens,
          timestampIso,
          timestampEpoch
        );
        summaryId = Number(result.lastInsertRowid);
      }
      const updateStmt = this.db.prepare(`
        UPDATE pending_messages
        SET
          status = 'processed',
          completed_at_epoch = ?,
          tool_input = NULL,
          tool_response = NULL
        WHERE id = ? AND status = 'processing'
      `);
      updateStmt.run(timestampEpoch, messageId);
      return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
    });
    return storeAndMarkTx();
  }
  // REMOVED: cleanupOrphanedSessions - violates "EVERYTHING SHOULD SAVE ALWAYS"
  // There's no such thing as an "orphaned" session. Sessions are created by hooks
  // and managed by Claude Code's lifecycle. Worker restarts don't invalidate them.
  // Marking all active sessions as 'failed' on startup destroys the user's current work.
  /**
   * Get session summaries by IDs (for hybrid Chroma search)
   * Returns summaries in specified temporal order
   */
  getSessionSummariesByIds(ids, options = {}) {
    if (ids.length === 0) return [];
    const { orderBy = "date_desc", limit, project } = options;
    const orderClause = orderBy === "date_asc" ? "ASC" : "DESC";
    const limitClause = limit ? `LIMIT ${limit}` : "";
    const placeholders = ids.map(() => "?").join(",");
    const params = [...ids];
    const whereClause = project ? `WHERE id IN (${placeholders}) AND project = ?` : `WHERE id IN (${placeholders})`;
    if (project) params.push(project);
    const stmt = this.db.prepare(`
      SELECT * FROM session_summaries
      ${whereClause}
      ORDER BY created_at_epoch ${orderClause}
      ${limitClause}
    `);
    return stmt.all(...params);
  }
  /**
   * Get user prompts by IDs (for hybrid Chroma search)
   * Returns prompts in specified temporal order
   */
  getUserPromptsByIds(ids, options = {}) {
    if (ids.length === 0) return [];
    const { orderBy = "date_desc", limit, project } = options;
    const orderClause = orderBy === "date_asc" ? "ASC" : "DESC";
    const limitClause = limit ? `LIMIT ${limit}` : "";
    const placeholders = ids.map(() => "?").join(",");
    const params = [...ids];
    const projectFilter = project ? "AND s.project = ?" : "";
    if (project) params.push(project);
    const stmt = this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.id IN (${placeholders}) ${projectFilter}
      ORDER BY up.created_at_epoch ${orderClause}
      ${limitClause}
    `);
    return stmt.all(...params);
  }
  /**
   * Get a unified timeline of all records (observations, sessions, prompts) around an anchor point
   * @param anchorEpoch The anchor timestamp (epoch milliseconds)
   * @param depthBefore Number of records to retrieve before anchor (any type)
   * @param depthAfter Number of records to retrieve after anchor (any type)
   * @param project Optional project filter
   * @returns Object containing observations, sessions, and prompts for the specified window
   */
  getTimelineAroundTimestamp(anchorEpoch, depthBefore = 10, depthAfter = 10, project) {
    return this.getTimelineAroundObservation(null, anchorEpoch, depthBefore, depthAfter, project);
  }
  /**
   * Get timeline around a specific observation ID
   * Uses observation ID offsets to determine time boundaries, then fetches all record types in that window
   */
  getTimelineAroundObservation(anchorObservationId, anchorEpoch, depthBefore = 10, depthAfter = 10, project) {
    const projectFilter = project ? "AND project = ?" : "";
    const projectParams = project ? [project] : [];
    let startEpoch;
    let endEpoch;
    if (anchorObservationId !== null) {
      const beforeQuery = `
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${projectFilter}
        ORDER BY id DESC
        LIMIT ?
      `;
      const afterQuery = `
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${projectFilter}
        ORDER BY id ASC
        LIMIT ?
      `;
      try {
        const beforeRecords = this.db.prepare(beforeQuery).all(anchorObservationId, ...projectParams, depthBefore + 1);
        const afterRecords = this.db.prepare(afterQuery).all(anchorObservationId, ...projectParams, depthAfter + 1);
        if (beforeRecords.length === 0 && afterRecords.length === 0) {
          return { observations: [], sessions: [], prompts: [] };
        }
        startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
        endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
      } catch (err) {
        logger.error("DB", "Error getting boundary observations", void 0, { error: err, project });
        return { observations: [], sessions: [], prompts: [] };
      }
    } else {
      const beforeQuery = `
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${projectFilter}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `;
      const afterQuery = `
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${projectFilter}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;
      try {
        const beforeRecords = this.db.prepare(beforeQuery).all(anchorEpoch, ...projectParams, depthBefore);
        const afterRecords = this.db.prepare(afterQuery).all(anchorEpoch, ...projectParams, depthAfter + 1);
        if (beforeRecords.length === 0 && afterRecords.length === 0) {
          return { observations: [], sessions: [], prompts: [] };
        }
        startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
        endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
      } catch (err) {
        logger.error("DB", "Error getting boundary timestamps", void 0, { error: err, project });
        return { observations: [], sessions: [], prompts: [] };
      }
    }
    const obsQuery = `
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${projectFilter}
      ORDER BY created_at_epoch ASC
    `;
    const sessQuery = `
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${projectFilter}
      ORDER BY created_at_epoch ASC
    `;
    const promptQuery = `
      SELECT up.*, s.project, s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${projectFilter.replace("project", "s.project")}
      ORDER BY up.created_at_epoch ASC
    `;
    const observations = this.db.prepare(obsQuery).all(startEpoch, endEpoch, ...projectParams);
    const sessions = this.db.prepare(sessQuery).all(startEpoch, endEpoch, ...projectParams);
    const prompts = this.db.prepare(promptQuery).all(startEpoch, endEpoch, ...projectParams);
    return {
      observations,
      sessions: sessions.map((s) => ({
        id: s.id,
        memory_session_id: s.memory_session_id,
        project: s.project,
        request: s.request,
        completed: s.completed,
        next_steps: s.next_steps,
        created_at: s.created_at,
        created_at_epoch: s.created_at_epoch
      })),
      prompts: prompts.map((p) => ({
        id: p.id,
        content_session_id: p.content_session_id,
        prompt_number: p.prompt_number,
        prompt_text: p.prompt_text,
        project: p.project,
        created_at: p.created_at,
        created_at_epoch: p.created_at_epoch
      }))
    };
  }
  /**
   * Get a single user prompt by ID
   */
  getPromptById(id) {
    const stmt = this.db.prepare(`
      SELECT
        p.id,
        p.content_session_id,
        p.prompt_number,
        p.prompt_text,
        s.project,
        p.created_at,
        p.created_at_epoch
      FROM user_prompts p
      LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
      WHERE p.id = ?
      LIMIT 1
    `);
    return stmt.get(id) || null;
  }
  /**
   * Get multiple user prompts by IDs
   */
  getPromptsByIds(ids) {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const stmt = this.db.prepare(`
      SELECT
        p.id,
        p.content_session_id,
        p.prompt_number,
        p.prompt_text,
        s.project,
        p.created_at,
        p.created_at_epoch
      FROM user_prompts p
      LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
      WHERE p.id IN (${placeholders})
      ORDER BY p.created_at_epoch DESC
    `);
    return stmt.all(...ids);
  }
  /**
   * Get full session summary by ID (includes request_summary and learned_summary)
   */
  getSessionSummaryById(id) {
    const stmt = this.db.prepare(`
      SELECT
        id,
        memory_session_id,
        content_session_id,
        project,
        user_prompt,
        request_summary,
        learned_summary,
        status,
        created_at,
        created_at_epoch
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `);
    return stmt.get(id) || null;
  }
  /**
   * Close the database connection
   */
  close() {
    this.db.close();
  }
  // ===========================================
  // Import Methods (for import-memories script)
  // ===========================================
  /**
   * Import SDK session with duplicate checking
   * Returns: { imported: boolean, id: number }
   */
  importSdkSession(session) {
    const existing = this.db.prepare(
      "SELECT id FROM sdk_sessions WHERE content_session_id = ?"
    ).get(session.content_session_id);
    if (existing) {
      return { imported: false, id: existing.id };
    }
    const stmt = this.db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, user_prompt,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      session.content_session_id,
      session.memory_session_id,
      session.project,
      session.user_prompt,
      session.started_at,
      session.started_at_epoch,
      session.completed_at,
      session.completed_at_epoch,
      session.status
    );
    return { imported: true, id: result.lastInsertRowid };
  }
  /**
   * Import session summary with duplicate checking
   * Returns: { imported: boolean, id: number }
   */
  importSessionSummary(summary) {
    const existing = this.db.prepare(
      "SELECT id FROM session_summaries WHERE memory_session_id = ?"
    ).get(summary.memory_session_id);
    if (existing) {
      return { imported: false, id: existing.id };
    }
    const stmt = this.db.prepare(`
      INSERT INTO session_summaries (
        memory_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      summary.memory_session_id,
      summary.project,
      summary.request,
      summary.investigated,
      summary.learned,
      summary.completed,
      summary.next_steps,
      summary.files_read,
      summary.files_edited,
      summary.notes,
      summary.prompt_number,
      summary.discovery_tokens || 0,
      summary.created_at,
      summary.created_at_epoch
    );
    return { imported: true, id: result.lastInsertRowid };
  }
  /**
   * Import observation with duplicate checking
   * Duplicates are identified by memory_session_id + title + created_at_epoch
   * Returns: { imported: boolean, id: number }
   */
  importObservation(obs) {
    const existing = this.db.prepare(`
      SELECT id FROM observations
      WHERE memory_session_id = ? AND title = ? AND created_at_epoch = ?
    `).get(obs.memory_session_id, obs.title, obs.created_at_epoch);
    if (existing) {
      return { imported: false, id: existing.id };
    }
    const stmt = this.db.prepare(`
      INSERT INTO observations (
        memory_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      obs.memory_session_id,
      obs.project,
      obs.text,
      obs.type,
      obs.title,
      obs.subtitle,
      obs.facts,
      obs.narrative,
      obs.concepts,
      obs.files_read,
      obs.files_modified,
      obs.prompt_number,
      obs.discovery_tokens || 0,
      obs.created_at,
      obs.created_at_epoch
    );
    return { imported: true, id: result.lastInsertRowid };
  }
  /**
   * Import user prompt with duplicate checking
   * Duplicates are identified by content_session_id + prompt_number
   * Returns: { imported: boolean, id: number }
   */
  importUserPrompt(prompt) {
    const existing = this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
    `).get(prompt.content_session_id, prompt.prompt_number);
    if (existing) {
      return { imported: false, id: existing.id };
    }
    const stmt = this.db.prepare(`
      INSERT INTO user_prompts (
        content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      prompt.content_session_id,
      prompt.prompt_number,
      prompt.prompt_text,
      prompt.created_at,
      prompt.created_at_epoch
    );
    return { imported: true, id: result.lastInsertRowid };
  }
};

// src/utils/project-name.ts
var import_path4 = __toESM(require("path"), 1);
function getProjectName(cwd) {
  if (!cwd || cwd.trim() === "") {
    logger.warn("PROJECT_NAME", "Empty cwd provided, using fallback", { cwd });
    return "unknown-project";
  }
  const basename2 = import_path4.default.basename(cwd);
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

// src/services/context/ContextConfigLoader.ts
var import_path6 = __toESM(require("path"), 1);
var import_os4 = require("os");

// src/services/domain/ModeManager.ts
var import_fs4 = require("fs");
var import_path5 = require("path");
var ModeManager = class _ModeManager {
  static instance = null;
  activeMode = null;
  modesDir;
  constructor() {
    const packageRoot = getPackageRoot();
    const possiblePaths = [
      (0, import_path5.join)(packageRoot, "modes"),
      // Production (plugin/modes)
      (0, import_path5.join)(packageRoot, "..", "plugin", "modes")
      // Development (src/../plugin/modes)
    ];
    const foundPath = possiblePaths.find((p) => (0, import_fs4.existsSync)(p));
    this.modesDir = foundPath || possiblePaths[0];
  }
  /**
   * Get singleton instance
   */
  static getInstance() {
    if (!_ModeManager.instance) {
      _ModeManager.instance = new _ModeManager();
    }
    return _ModeManager.instance;
  }
  /**
   * Parse mode ID for inheritance pattern (parent--override)
   */
  parseInheritance(modeId) {
    const parts = modeId.split("--");
    if (parts.length === 1) {
      return { hasParent: false, parentId: "", overrideId: "" };
    }
    if (parts.length > 2) {
      throw new Error(
        `Invalid mode inheritance: ${modeId}. Only one level of inheritance supported (parent--override)`
      );
    }
    return {
      hasParent: true,
      parentId: parts[0],
      overrideId: modeId
      // Use the full modeId (e.g., code--es) to find the override file
    };
  }
  /**
   * Check if value is a plain object (not array, not null)
   */
  isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  /**
   * Deep merge two objects
   * - Recursively merge nested objects
   * - Replace arrays completely (no merging)
   * - Override primitives
   */
  deepMerge(base, override) {
    const result = { ...base };
    for (const key in override) {
      const overrideValue = override[key];
      const baseValue = base[key];
      if (this.isPlainObject(overrideValue) && this.isPlainObject(baseValue)) {
        result[key] = this.deepMerge(baseValue, overrideValue);
      } else {
        result[key] = overrideValue;
      }
    }
    return result;
  }
  /**
   * Load a mode file from disk without inheritance processing
   */
  loadModeFile(modeId) {
    const modePath = (0, import_path5.join)(this.modesDir, `${modeId}.json`);
    if (!(0, import_fs4.existsSync)(modePath)) {
      throw new Error(`Mode file not found: ${modePath}`);
    }
    const jsonContent = (0, import_fs4.readFileSync)(modePath, "utf-8");
    return JSON.parse(jsonContent);
  }
  /**
   * Load a mode profile by ID with inheritance support
   * Caches the result for subsequent calls
   *
   * Supports inheritance via parent--override pattern (e.g., code--ko)
   * - Loads parent mode recursively
   * - Loads override file from modes directory
   * - Deep merges override onto parent
   */
  loadMode(modeId) {
    const inheritance = this.parseInheritance(modeId);
    if (!inheritance.hasParent) {
      try {
        const mode = this.loadModeFile(modeId);
        this.activeMode = mode;
        logger.debug("SYSTEM", `Loaded mode: ${mode.name} (${modeId})`, void 0, {
          types: mode.observation_types.map((t) => t.id),
          concepts: mode.observation_concepts.map((c) => c.id)
        });
        return mode;
      } catch (error) {
        logger.warn("SYSTEM", `Mode file not found: ${modeId}, falling back to 'code'`);
        if (modeId === "code") {
          throw new Error("Critical: code.json mode file missing");
        }
        return this.loadMode("code");
      }
    }
    const { parentId, overrideId } = inheritance;
    let parentMode;
    try {
      parentMode = this.loadMode(parentId);
    } catch (error) {
      logger.warn("SYSTEM", `Parent mode '${parentId}' not found for ${modeId}, falling back to 'code'`);
      parentMode = this.loadMode("code");
    }
    let overrideConfig;
    try {
      overrideConfig = this.loadModeFile(overrideId);
      logger.debug("SYSTEM", `Loaded override file: ${overrideId} for parent ${parentId}`);
    } catch (error) {
      logger.warn("SYSTEM", `Override file '${overrideId}' not found, using parent mode '${parentId}' only`);
      this.activeMode = parentMode;
      return parentMode;
    }
    if (!overrideConfig) {
      logger.warn("SYSTEM", `Invalid override file: ${overrideId}, using parent mode '${parentId}' only`);
      this.activeMode = parentMode;
      return parentMode;
    }
    const mergedMode = this.deepMerge(parentMode, overrideConfig);
    this.activeMode = mergedMode;
    logger.debug("SYSTEM", `Loaded mode with inheritance: ${mergedMode.name} (${modeId} = ${parentId} + ${overrideId})`, void 0, {
      parent: parentId,
      override: overrideId,
      types: mergedMode.observation_types.map((t) => t.id),
      concepts: mergedMode.observation_concepts.map((c) => c.id)
    });
    return mergedMode;
  }
  /**
   * Get currently active mode
   */
  getActiveMode() {
    if (!this.activeMode) {
      throw new Error("No mode loaded. Call loadMode() first.");
    }
    return this.activeMode;
  }
  /**
   * Get all observation types from active mode
   */
  getObservationTypes() {
    return this.getActiveMode().observation_types;
  }
  /**
   * Get all observation concepts from active mode
   */
  getObservationConcepts() {
    return this.getActiveMode().observation_concepts;
  }
  /**
   * Get icon for a specific observation type
   */
  getTypeIcon(typeId) {
    const type = this.getObservationTypes().find((t) => t.id === typeId);
    return type?.emoji || "\u{1F4DD}";
  }
  /**
   * Get work emoji for a specific observation type
   */
  getWorkEmoji(typeId) {
    const type = this.getObservationTypes().find((t) => t.id === typeId);
    return type?.work_emoji || "\u{1F4DD}";
  }
  /**
   * Validate that a type ID exists in the active mode
   */
  validateType(typeId) {
    return this.getObservationTypes().some((t) => t.id === typeId);
  }
  /**
   * Get label for a specific observation type
   */
  getTypeLabel(typeId) {
    const type = this.getObservationTypes().find((t) => t.id === typeId);
    return type?.label || typeId;
  }
};

// src/services/context/ContextConfigLoader.ts
function loadContextConfig() {
  const settingsPath = import_path6.default.join((0, import_os4.homedir)(), ".claude-recall", "settings.json");
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  const modeId = settings.CLAUDE_RECALL_MODE;
  const isCodeMode = modeId === "code" || modeId.startsWith("code--");
  let observationTypes;
  let observationConcepts;
  if (isCodeMode) {
    observationTypes = new Set(
      settings.CLAUDE_RECALL_CONTEXT_OBSERVATION_TYPES.split(",").map((t) => t.trim()).filter(Boolean)
    );
    observationConcepts = new Set(
      settings.CLAUDE_RECALL_CONTEXT_OBSERVATION_CONCEPTS.split(",").map((c) => c.trim()).filter(Boolean)
    );
  } else {
    const mode = ModeManager.getInstance().getActiveMode();
    observationTypes = new Set(mode.observation_types.map((t) => t.id));
    observationConcepts = new Set(mode.observation_concepts.map((c) => c.id));
  }
  return {
    totalObservationCount: parseInt(settings.CLAUDE_RECALL_CONTEXT_OBSERVATIONS, 10),
    fullObservationCount: parseInt(settings.CLAUDE_RECALL_CONTEXT_FULL_COUNT, 10),
    sessionCount: parseInt(settings.CLAUDE_RECALL_CONTEXT_SESSION_COUNT, 10),
    showReadTokens: settings.CLAUDE_RECALL_CONTEXT_SHOW_READ_TOKENS === "true",
    showWorkTokens: settings.CLAUDE_RECALL_CONTEXT_SHOW_WORK_TOKENS === "true",
    showSavingsAmount: settings.CLAUDE_RECALL_CONTEXT_SHOW_SAVINGS_AMOUNT === "true",
    showSavingsPercent: settings.CLAUDE_RECALL_CONTEXT_SHOW_SAVINGS_PERCENT === "true",
    observationTypes,
    observationConcepts,
    fullObservationField: settings.CLAUDE_RECALL_CONTEXT_FULL_FIELD,
    showLastSummary: settings.CLAUDE_RECALL_CONTEXT_SHOW_LAST_SUMMARY === "true",
    showLastMessage: settings.CLAUDE_RECALL_CONTEXT_SHOW_LAST_MESSAGE === "true"
  };
}

// src/services/context/types.ts
var colors = {
  reset: "\x1B[0m",
  bright: "\x1B[1m",
  dim: "\x1B[2m",
  cyan: "\x1B[36m",
  green: "\x1B[32m",
  yellow: "\x1B[33m",
  blue: "\x1B[34m",
  magenta: "\x1B[35m",
  gray: "\x1B[90m",
  red: "\x1B[31m"
};
var CHARS_PER_TOKEN_ESTIMATE = 4;
var SUMMARY_LOOKAHEAD = 1;

// src/services/context/TokenCalculator.ts
function calculateObservationTokens(obs) {
  const obsSize = (obs.title?.length || 0) + (obs.subtitle?.length || 0) + (obs.narrative?.length || 0) + JSON.stringify(obs.facts || []).length;
  return Math.ceil(obsSize / CHARS_PER_TOKEN_ESTIMATE);
}
function calculateTokenEconomics(observations) {
  const totalObservations = observations.length;
  const totalReadTokens = observations.reduce((sum, obs) => {
    return sum + calculateObservationTokens(obs);
  }, 0);
  const totalDiscoveryTokens = observations.reduce((sum, obs) => {
    return sum + (obs.discovery_tokens || 0);
  }, 0);
  const savings = totalDiscoveryTokens - totalReadTokens;
  const savingsPercent = totalDiscoveryTokens > 0 ? Math.round(savings / totalDiscoveryTokens * 100) : 0;
  return {
    totalObservations,
    totalReadTokens,
    totalDiscoveryTokens,
    savings,
    savingsPercent
  };
}
function getWorkEmoji(obsType) {
  return ModeManager.getInstance().getWorkEmoji(obsType);
}
function formatObservationTokenDisplay(obs, config) {
  const readTokens = calculateObservationTokens(obs);
  const discoveryTokens = obs.discovery_tokens || 0;
  const workEmoji = getWorkEmoji(obs.type);
  const discoveryDisplay = discoveryTokens > 0 ? `${workEmoji} ${discoveryTokens.toLocaleString()}` : "-";
  return { readTokens, discoveryTokens, discoveryDisplay, workEmoji };
}
function shouldShowContextEconomics(config) {
  return config.showReadTokens || config.showWorkTokens || config.showSavingsAmount || config.showSavingsPercent;
}

// src/services/context/ObservationCompiler.ts
var import_path7 = __toESM(require("path"), 1);
var import_os5 = require("os");
var import_fs5 = require("fs");
function queryObservations(db, project, config) {
  const typeArray = Array.from(config.observationTypes);
  const typePlaceholders = typeArray.map(() => "?").join(",");
  const conceptArray = Array.from(config.observationConcepts);
  const conceptPlaceholders = conceptArray.map(() => "?").join(",");
  return db.db.prepare(`
    SELECT
      id, memory_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified, discovery_tokens,
      created_at, created_at_epoch
    FROM observations
    WHERE project = ?
      AND type IN (${typePlaceholders})
      AND EXISTS (
        SELECT 1 FROM json_each(concepts)
        WHERE value IN (${conceptPlaceholders})
      )
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(project, ...typeArray, ...conceptArray, config.totalObservationCount);
}
function querySummaries(db, project, config) {
  return db.db.prepare(`
    SELECT id, memory_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(project, config.sessionCount + SUMMARY_LOOKAHEAD);
}
function queryObservationsMulti(db, projects, config) {
  const typeArray = Array.from(config.observationTypes);
  const typePlaceholders = typeArray.map(() => "?").join(",");
  const conceptArray = Array.from(config.observationConcepts);
  const conceptPlaceholders = conceptArray.map(() => "?").join(",");
  const projectPlaceholders = projects.map(() => "?").join(",");
  return db.db.prepare(`
    SELECT
      id, memory_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified, discovery_tokens,
      created_at, created_at_epoch, project
    FROM observations
    WHERE project IN (${projectPlaceholders})
      AND type IN (${typePlaceholders})
      AND EXISTS (
        SELECT 1 FROM json_each(concepts)
        WHERE value IN (${conceptPlaceholders})
      )
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(...projects, ...typeArray, ...conceptArray, config.totalObservationCount);
}
function querySummariesMulti(db, projects, config) {
  const projectPlaceholders = projects.map(() => "?").join(",");
  return db.db.prepare(`
    SELECT id, memory_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch, project
    FROM session_summaries
    WHERE project IN (${projectPlaceholders})
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(...projects, config.sessionCount + SUMMARY_LOOKAHEAD);
}
function cwdToDashed(cwd) {
  return cwd.replace(/\//g, "-");
}
function extractPriorMessages(transcriptPath) {
  try {
    if (!(0, import_fs5.existsSync)(transcriptPath)) {
      return { userMessage: "", assistantMessage: "" };
    }
    const content = (0, import_fs5.readFileSync)(transcriptPath, "utf-8").trim();
    if (!content) {
      return { userMessage: "", assistantMessage: "" };
    }
    const lines = content.split("\n").filter((line) => line.trim());
    let lastAssistantMessage = "";
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const line = lines[i];
        if (!line.includes('"type":"assistant"')) {
          continue;
        }
        const entry = JSON.parse(line);
        if (entry.type === "assistant" && entry.message?.content && Array.isArray(entry.message.content)) {
          let text = "";
          for (const block of entry.message.content) {
            if (block.type === "text") {
              text += block.text;
            }
          }
          text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
          if (text) {
            lastAssistantMessage = text;
            break;
          }
        }
      } catch (parseError) {
        logger.debug("PARSER", "Skipping malformed transcript line", { lineIndex: i }, parseError);
        continue;
      }
    }
    return { userMessage: "", assistantMessage: lastAssistantMessage };
  } catch (error) {
    logger.failure("WORKER", `Failed to extract prior messages from transcript`, { transcriptPath }, error);
    return { userMessage: "", assistantMessage: "" };
  }
}
function getPriorSessionMessages(observations, config, currentSessionId, cwd) {
  if (!config.showLastMessage || observations.length === 0) {
    return { userMessage: "", assistantMessage: "" };
  }
  const priorSessionObs = observations.find((obs) => obs.memory_session_id !== currentSessionId);
  if (!priorSessionObs) {
    return { userMessage: "", assistantMessage: "" };
  }
  const priorSessionId = priorSessionObs.memory_session_id;
  const dashedCwd = cwdToDashed(cwd);
  const transcriptPath = import_path7.default.join((0, import_os5.homedir)(), ".claude", "projects", dashedCwd, `${priorSessionId}.jsonl`);
  return extractPriorMessages(transcriptPath);
}
function prepareSummariesForTimeline(displaySummaries, allSummaries) {
  const mostRecentSummaryId = allSummaries[0]?.id;
  return displaySummaries.map((summary, i) => {
    const olderSummary = i === 0 ? null : allSummaries[i + 1];
    return {
      ...summary,
      displayEpoch: olderSummary ? olderSummary.created_at_epoch : summary.created_at_epoch,
      displayTime: olderSummary ? olderSummary.created_at : summary.created_at,
      shouldShowLink: summary.id !== mostRecentSummaryId
    };
  });
}
function buildTimeline(observations, summaries) {
  const timeline = [
    ...observations.map((obs) => ({ type: "observation", data: obs })),
    ...summaries.map((summary) => ({ type: "summary", data: summary }))
  ];
  timeline.sort((a, b) => {
    const aEpoch = a.type === "observation" ? a.data.created_at_epoch : a.data.displayEpoch;
    const bEpoch = b.type === "observation" ? b.data.created_at_epoch : b.data.displayEpoch;
    return aEpoch - bEpoch;
  });
  return timeline;
}
function getFullObservationIds(observations, count) {
  return new Set(
    observations.slice(0, count).map((obs) => obs.id)
  );
}

// src/services/context/formatters/MarkdownFormatter.ts
function formatHeaderDateTime() {
  const now = /* @__PURE__ */ new Date();
  const date = now.toLocaleDateString("en-CA");
  const time = now.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).toLowerCase().replace(" ", "");
  const tz = now.toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop();
  return `${date} ${time} ${tz}`;
}
function renderMarkdownHeader(project) {
  return [
    `# [${project}] recent context, ${formatHeaderDateTime()}`,
    ""
  ];
}
function renderMarkdownLegend() {
  const mode = ModeManager.getInstance().getActiveMode();
  const typeLegendItems = mode.observation_types.map((t) => `${t.emoji} ${t.id}`).join(" | ");
  return [
    `**Legend:** session-request | ${typeLegendItems}`,
    ""
  ];
}
function renderMarkdownColumnKey() {
  return [
    `**Column Key**:`,
    `- **Read**: Tokens to read this observation (cost to learn it now)`,
    `- **Work**: Tokens spent on work that produced this record ( research, building, deciding)`,
    ""
  ];
}
function renderMarkdownContextIndex() {
  return [
    `**Context Index:** This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.`,
    "",
    `When you need implementation details, rationale, or debugging context:`,
    `- Use MCP tools (search, get_observations) to fetch full observations on-demand`,
    `- Critical types ( bugfix, decision) often need detailed fetching`,
    `- Trust this index over re-reading code for past decisions and learnings`,
    ""
  ];
}
function renderMarkdownContextEconomics(economics, config) {
  const output = [];
  output.push(`**Context Economics**:`);
  output.push(`- Loading: ${economics.totalObservations} observations (${economics.totalReadTokens.toLocaleString()} tokens to read)`);
  output.push(`- Work investment: ${economics.totalDiscoveryTokens.toLocaleString()} tokens spent on research, building, and decisions`);
  if (economics.totalDiscoveryTokens > 0 && (config.showSavingsAmount || config.showSavingsPercent)) {
    let savingsLine = "- Your savings: ";
    if (config.showSavingsAmount && config.showSavingsPercent) {
      savingsLine += `${economics.savings.toLocaleString()} tokens (${economics.savingsPercent}% reduction from reuse)`;
    } else if (config.showSavingsAmount) {
      savingsLine += `${economics.savings.toLocaleString()} tokens`;
    } else {
      savingsLine += `${economics.savingsPercent}% reduction from reuse`;
    }
    output.push(savingsLine);
  }
  output.push("");
  return output;
}
function renderMarkdownDayHeader(day) {
  return [
    `### ${day}`,
    ""
  ];
}
function renderMarkdownFileHeader(file) {
  return [
    `**${file}**`,
    `| ID | Time | T | Title | Read | Work |`,
    `|----|------|---|-------|------|------|`
  ];
}
function renderMarkdownTableRow(obs, timeDisplay, config) {
  const title = obs.title || "Untitled";
  const icon = ModeManager.getInstance().getTypeIcon(obs.type);
  const { readTokens, discoveryDisplay } = formatObservationTokenDisplay(obs, config);
  const readCol = config.showReadTokens ? `~${readTokens}` : "";
  const workCol = config.showWorkTokens ? discoveryDisplay : "";
  return `| #${obs.id} | ${timeDisplay || '"'} | ${icon} | ${title} | ${readCol} | ${workCol} |`;
}
function renderMarkdownFullObservation(obs, timeDisplay, detailField, config) {
  const output = [];
  const title = obs.title || "Untitled";
  const icon = ModeManager.getInstance().getTypeIcon(obs.type);
  const { readTokens, discoveryDisplay } = formatObservationTokenDisplay(obs, config);
  output.push(`**#${obs.id}** ${timeDisplay || '"'} ${icon} **${title}**`);
  if (detailField) {
    output.push("");
    output.push(detailField);
    output.push("");
  }
  const tokenParts = [];
  if (config.showReadTokens) {
    tokenParts.push(`Read: ~${readTokens}`);
  }
  if (config.showWorkTokens) {
    tokenParts.push(`Work: ${discoveryDisplay}`);
  }
  if (tokenParts.length > 0) {
    output.push(tokenParts.join(", "));
  }
  output.push("");
  return output;
}
function renderMarkdownSummaryItem(summary, formattedTime) {
  const summaryTitle = `${summary.request || "Session started"} (${formattedTime})`;
  return [
    `**#S${summary.id}** ${summaryTitle}`,
    ""
  ];
}
function renderMarkdownSummaryField(label, value) {
  if (!value) return [];
  return [`**${label}**: ${value}`, ""];
}
function renderMarkdownPreviouslySection(priorMessages) {
  if (!priorMessages.assistantMessage) return [];
  return [
    "",
    "---",
    "",
    `**Previously**`,
    "",
    `A: ${priorMessages.assistantMessage}`,
    ""
  ];
}
function renderMarkdownFooter(totalDiscoveryTokens, totalReadTokens) {
  const workTokensK = Math.round(totalDiscoveryTokens / 1e3);
  return [
    "",
    `Access ${workTokensK}k tokens of past research & decisions for just ${totalReadTokens.toLocaleString()}t. Use MCP search tools to access memories by ID.`
  ];
}
function renderMarkdownEmptyState(project) {
  return `# [${project}] recent context, ${formatHeaderDateTime()}

No previous sessions found for this project yet.`;
}

// src/services/context/formatters/ColorFormatter.ts
function formatHeaderDateTime2() {
  const now = /* @__PURE__ */ new Date();
  const date = now.toLocaleDateString("en-CA");
  const time = now.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).toLowerCase().replace(" ", "");
  const tz = now.toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop();
  return `${date} ${time} ${tz}`;
}
function renderColorHeader(project) {
  return [
    "",
    `${colors.bright}${colors.cyan}[${project}] recent context, ${formatHeaderDateTime2()}${colors.reset}`,
    `${colors.gray}${"\u2500".repeat(60)}${colors.reset}`,
    ""
  ];
}
function renderColorLegend() {
  const mode = ModeManager.getInstance().getActiveMode();
  const typeLegendItems = mode.observation_types.map((t) => `${t.emoji} ${t.id}`).join(" | ");
  return [
    `${colors.dim}Legend: session-request | ${typeLegendItems}${colors.reset}`,
    ""
  ];
}
function renderColorColumnKey() {
  return [
    `${colors.bright}Column Key${colors.reset}`,
    `${colors.dim}  Read: Tokens to read this observation (cost to learn it now)${colors.reset}`,
    `${colors.dim}  Work: Tokens spent on work that produced this record ( research, building, deciding)${colors.reset}`,
    ""
  ];
}
function renderColorContextIndex() {
  return [
    `${colors.dim}Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${colors.reset}`,
    "",
    `${colors.dim}When you need implementation details, rationale, or debugging context:${colors.reset}`,
    `${colors.dim}  - Use MCP tools (search, get_observations) to fetch full observations on-demand${colors.reset}`,
    `${colors.dim}  - Critical types ( bugfix, decision) often need detailed fetching${colors.reset}`,
    `${colors.dim}  - Trust this index over re-reading code for past decisions and learnings${colors.reset}`,
    ""
  ];
}
function renderColorContextEconomics(economics, config) {
  const output = [];
  output.push(`${colors.bright}${colors.cyan}Context Economics${colors.reset}`);
  output.push(`${colors.dim}  Loading: ${economics.totalObservations} observations (${economics.totalReadTokens.toLocaleString()} tokens to read)${colors.reset}`);
  output.push(`${colors.dim}  Work investment: ${economics.totalDiscoveryTokens.toLocaleString()} tokens spent on research, building, and decisions${colors.reset}`);
  if (economics.totalDiscoveryTokens > 0 && (config.showSavingsAmount || config.showSavingsPercent)) {
    let savingsLine = "  Your savings: ";
    if (config.showSavingsAmount && config.showSavingsPercent) {
      savingsLine += `${economics.savings.toLocaleString()} tokens (${economics.savingsPercent}% reduction from reuse)`;
    } else if (config.showSavingsAmount) {
      savingsLine += `${economics.savings.toLocaleString()} tokens`;
    } else {
      savingsLine += `${economics.savingsPercent}% reduction from reuse`;
    }
    output.push(`${colors.green}${savingsLine}${colors.reset}`);
  }
  output.push("");
  return output;
}
function renderColorDayHeader(day) {
  return [
    `${colors.bright}${colors.cyan}${day}${colors.reset}`,
    ""
  ];
}
function renderColorFileHeader(file) {
  return [
    `${colors.dim}${file}${colors.reset}`
  ];
}
function renderColorTableRow(obs, time, showTime, config) {
  const title = obs.title || "Untitled";
  const icon = ModeManager.getInstance().getTypeIcon(obs.type);
  const { readTokens, discoveryTokens, workEmoji } = formatObservationTokenDisplay(obs, config);
  const timePart = showTime ? `${colors.dim}${time}${colors.reset}` : " ".repeat(time.length);
  const readPart = config.showReadTokens && readTokens > 0 ? `${colors.dim}(~${readTokens}t)${colors.reset}` : "";
  const discoveryPart = config.showWorkTokens && discoveryTokens > 0 ? `${colors.dim}(${workEmoji} ${discoveryTokens.toLocaleString()}t)${colors.reset}` : "";
  return `  ${colors.dim}#${obs.id}${colors.reset}  ${timePart}  ${icon}  ${title} ${readPart} ${discoveryPart}`;
}
function renderColorFullObservation(obs, time, showTime, detailField, config) {
  const output = [];
  const title = obs.title || "Untitled";
  const icon = ModeManager.getInstance().getTypeIcon(obs.type);
  const { readTokens, discoveryTokens, workEmoji } = formatObservationTokenDisplay(obs, config);
  const timePart = showTime ? `${colors.dim}${time}${colors.reset}` : " ".repeat(time.length);
  const readPart = config.showReadTokens && readTokens > 0 ? `${colors.dim}(~${readTokens}t)${colors.reset}` : "";
  const discoveryPart = config.showWorkTokens && discoveryTokens > 0 ? `${colors.dim}(${workEmoji} ${discoveryTokens.toLocaleString()}t)${colors.reset}` : "";
  output.push(`  ${colors.dim}#${obs.id}${colors.reset}  ${timePart}  ${icon}  ${colors.bright}${title}${colors.reset}`);
  if (detailField) {
    output.push(`    ${colors.dim}${detailField}${colors.reset}`);
  }
  if (readPart || discoveryPart) {
    output.push(`    ${readPart} ${discoveryPart}`);
  }
  output.push("");
  return output;
}
function renderColorSummaryItem(summary, formattedTime) {
  const summaryTitle = `${summary.request || "Session started"} (${formattedTime})`;
  return [
    `${colors.yellow}#S${summary.id}${colors.reset} ${summaryTitle}`,
    ""
  ];
}
function renderColorSummaryField(label, value, color) {
  if (!value) return [];
  return [`${color}${label}:${colors.reset} ${value}`, ""];
}
function renderColorPreviouslySection(priorMessages) {
  if (!priorMessages.assistantMessage) return [];
  return [
    "",
    "---",
    "",
    `${colors.bright}${colors.magenta}Previously${colors.reset}`,
    "",
    `${colors.dim}A: ${priorMessages.assistantMessage}${colors.reset}`,
    ""
  ];
}
function renderColorFooter(totalDiscoveryTokens, totalReadTokens) {
  const workTokensK = Math.round(totalDiscoveryTokens / 1e3);
  return [
    "",
    `${colors.dim}Access ${workTokensK}k tokens of past research & decisions for just ${totalReadTokens.toLocaleString()}t. Use MCP search tools to access memories by ID.${colors.reset}`
  ];
}
function renderColorEmptyState(project) {
  return `
${colors.bright}${colors.cyan}[${project}] recent context, ${formatHeaderDateTime2()}${colors.reset}
${colors.gray}${"\u2500".repeat(60)}${colors.reset}

${colors.dim}No previous sessions found for this project yet.${colors.reset}
`;
}

// src/services/context/sections/HeaderRenderer.ts
function renderHeader(project, economics, config, useColors) {
  const output = [];
  if (useColors) {
    output.push(...renderColorHeader(project));
  } else {
    output.push(...renderMarkdownHeader(project));
  }
  if (useColors) {
    output.push(...renderColorLegend());
  } else {
    output.push(...renderMarkdownLegend());
  }
  if (useColors) {
    output.push(...renderColorColumnKey());
  } else {
    output.push(...renderMarkdownColumnKey());
  }
  if (useColors) {
    output.push(...renderColorContextIndex());
  } else {
    output.push(...renderMarkdownContextIndex());
  }
  if (shouldShowContextEconomics(config)) {
    if (useColors) {
      output.push(...renderColorContextEconomics(economics, config));
    } else {
      output.push(...renderMarkdownContextEconomics(economics, config));
    }
  }
  return output;
}

// src/shared/timeline-formatting.ts
var import_path8 = __toESM(require("path"), 1);
function parseJsonArray(json) {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    logger.debug("PARSER", "Failed to parse JSON array, using empty fallback", {
      preview: json?.substring(0, 50)
    }, err);
    return [];
  }
}
function formatDateTime(dateInput) {
  const date = new Date(dateInput);
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });
}
function formatTime(dateInput) {
  const date = new Date(dateInput);
  return date.toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });
}
function formatDate(dateInput) {
  const date = new Date(dateInput);
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}
function toRelativePath(filePath, cwd) {
  if (import_path8.default.isAbsolute(filePath)) {
    return import_path8.default.relative(cwd, filePath);
  }
  return filePath;
}
function extractFirstFile(filesModified, cwd, filesRead) {
  const modified = parseJsonArray(filesModified);
  if (modified.length > 0) {
    return toRelativePath(modified[0], cwd);
  }
  if (filesRead) {
    const read = parseJsonArray(filesRead);
    if (read.length > 0) {
      return toRelativePath(read[0], cwd);
    }
  }
  return "General";
}

// src/services/context/sections/TimelineRenderer.ts
function groupTimelineByDay(timeline) {
  const itemsByDay = /* @__PURE__ */ new Map();
  for (const item of timeline) {
    const itemDate = item.type === "observation" ? item.data.created_at : item.data.displayTime;
    const day = formatDate(itemDate);
    if (!itemsByDay.has(day)) {
      itemsByDay.set(day, []);
    }
    itemsByDay.get(day).push(item);
  }
  const sortedEntries = Array.from(itemsByDay.entries()).sort((a, b) => {
    const aDate = new Date(a[0]).getTime();
    const bDate = new Date(b[0]).getTime();
    return aDate - bDate;
  });
  return new Map(sortedEntries);
}
function getDetailField(obs, config) {
  if (config.fullObservationField === "narrative") {
    return obs.narrative;
  }
  return obs.facts ? parseJsonArray(obs.facts).join("\n") : null;
}
function renderDayTimeline(day, dayItems, fullObservationIds, config, cwd, useColors) {
  const output = [];
  if (useColors) {
    output.push(...renderColorDayHeader(day));
  } else {
    output.push(...renderMarkdownDayHeader(day));
  }
  let currentFile = null;
  let lastTime = "";
  let tableOpen = false;
  for (const item of dayItems) {
    if (item.type === "summary") {
      if (tableOpen) {
        output.push("");
        tableOpen = false;
        currentFile = null;
        lastTime = "";
      }
      const summary = item.data;
      const formattedTime = formatDateTime(summary.displayTime);
      if (useColors) {
        output.push(...renderColorSummaryItem(summary, formattedTime));
      } else {
        output.push(...renderMarkdownSummaryItem(summary, formattedTime));
      }
    } else {
      const obs = item.data;
      const file = extractFirstFile(obs.files_modified, cwd, obs.files_read);
      const time = formatTime(obs.created_at);
      const showTime = time !== lastTime;
      const timeDisplay = showTime ? time : "";
      lastTime = time;
      const shouldShowFull = fullObservationIds.has(obs.id);
      if (file !== currentFile) {
        if (tableOpen) {
          output.push("");
        }
        if (useColors) {
          output.push(...renderColorFileHeader(file));
        } else {
          output.push(...renderMarkdownFileHeader(file));
        }
        currentFile = file;
        tableOpen = true;
      }
      if (shouldShowFull) {
        const detailField = getDetailField(obs, config);
        if (useColors) {
          output.push(...renderColorFullObservation(obs, time, showTime, detailField, config));
        } else {
          if (tableOpen && !useColors) {
            output.push("");
            tableOpen = false;
          }
          output.push(...renderMarkdownFullObservation(obs, timeDisplay, detailField, config));
          currentFile = null;
        }
      } else {
        if (useColors) {
          output.push(renderColorTableRow(obs, time, showTime, config));
        } else {
          output.push(renderMarkdownTableRow(obs, timeDisplay, config));
        }
      }
    }
  }
  if (tableOpen) {
    output.push("");
  }
  return output;
}
function renderTimeline(timeline, fullObservationIds, config, cwd, useColors) {
  const output = [];
  const itemsByDay = groupTimelineByDay(timeline);
  for (const [day, dayItems] of itemsByDay) {
    output.push(...renderDayTimeline(day, dayItems, fullObservationIds, config, cwd, useColors));
  }
  return output;
}

// src/services/context/sections/SummaryRenderer.ts
function shouldShowSummary(config, mostRecentSummary, mostRecentObservation) {
  if (!config.showLastSummary || !mostRecentSummary) {
    return false;
  }
  const hasContent = !!(mostRecentSummary.investigated || mostRecentSummary.learned || mostRecentSummary.completed || mostRecentSummary.next_steps);
  if (!hasContent) {
    return false;
  }
  if (mostRecentObservation && mostRecentSummary.created_at_epoch <= mostRecentObservation.created_at_epoch) {
    return false;
  }
  return true;
}
function renderSummaryFields(summary, useColors) {
  const output = [];
  if (useColors) {
    output.push(...renderColorSummaryField("Investigated", summary.investigated, colors.blue));
    output.push(...renderColorSummaryField("Learned", summary.learned, colors.yellow));
    output.push(...renderColorSummaryField("Completed", summary.completed, colors.green));
    output.push(...renderColorSummaryField("Next Steps", summary.next_steps, colors.magenta));
  } else {
    output.push(...renderMarkdownSummaryField("Investigated", summary.investigated));
    output.push(...renderMarkdownSummaryField("Learned", summary.learned));
    output.push(...renderMarkdownSummaryField("Completed", summary.completed));
    output.push(...renderMarkdownSummaryField("Next Steps", summary.next_steps));
  }
  return output;
}

// src/services/context/sections/FooterRenderer.ts
function renderPreviouslySection(priorMessages, useColors) {
  if (useColors) {
    return renderColorPreviouslySection(priorMessages);
  }
  return renderMarkdownPreviouslySection(priorMessages);
}
function renderFooter(economics, config, useColors) {
  if (!shouldShowContextEconomics(config) || economics.totalDiscoveryTokens <= 0 || economics.savings <= 0) {
    return [];
  }
  if (useColors) {
    return renderColorFooter(economics.totalDiscoveryTokens, economics.totalReadTokens);
  }
  return renderMarkdownFooter(economics.totalDiscoveryTokens, economics.totalReadTokens);
}

// src/services/context/ContextBuilder.ts
var VERSION_MARKER_PATH = import_path9.default.join(
  (0, import_os6.homedir)(),
  ".claude",
  "plugins",
  "marketplaces",
  "askqai",
  "plugin",
  ".install-version"
);
function initializeDatabase() {
  try {
    return new SessionStore();
  } catch (error) {
    if (error.code === "ERR_DLOPEN_FAILED") {
      try {
        (0, import_fs6.unlinkSync)(VERSION_MARKER_PATH);
      } catch (unlinkError) {
        logger.debug("SYSTEM", "Marker file cleanup failed (may not exist)", {}, unlinkError);
      }
      logger.error("SYSTEM", "Native module rebuild needed - restart Claude Code to auto-fix");
      return null;
    }
    throw error;
  }
}
function renderEmptyState(project, useColors) {
  return useColors ? renderColorEmptyState(project) : renderMarkdownEmptyState(project);
}
function buildContextOutput(project, observations, summaries, config, cwd, sessionId, useColors) {
  const output = [];
  const economics = calculateTokenEconomics(observations);
  output.push(...renderHeader(project, economics, config, useColors));
  const displaySummaries = summaries.slice(0, config.sessionCount);
  const summariesForTimeline = prepareSummariesForTimeline(displaySummaries, summaries);
  const timeline = buildTimeline(observations, summariesForTimeline);
  const fullObservationIds = getFullObservationIds(observations, config.fullObservationCount);
  output.push(...renderTimeline(timeline, fullObservationIds, config, cwd, useColors));
  const mostRecentSummary = summaries[0];
  const mostRecentObservation = observations[0];
  if (shouldShowSummary(config, mostRecentSummary, mostRecentObservation)) {
    output.push(...renderSummaryFields(mostRecentSummary, useColors));
  }
  const priorMessages = getPriorSessionMessages(observations, config, sessionId, cwd);
  output.push(...renderPreviouslySection(priorMessages, useColors));
  output.push(...renderFooter(economics, config, useColors));
  return output.join("\n").trimEnd();
}
async function generateContext(input, useColors = false) {
  const config = loadContextConfig();
  const cwd = input?.cwd ?? process.cwd();
  const project = getProjectName(cwd);
  const projects = input?.projects || [project];
  const db = initializeDatabase();
  if (!db) {
    return "";
  }
  try {
    const observations = projects.length > 1 ? queryObservationsMulti(db, projects, config) : queryObservations(db, project, config);
    const summaries = projects.length > 1 ? querySummariesMulti(db, projects, config) : querySummaries(db, project, config);
    if (observations.length === 0 && summaries.length === 0) {
      return renderEmptyState(project, useColors);
    }
    return buildContextOutput(
      project,
      observations,
      summaries,
      config,
      cwd,
      input?.session_id,
      useColors
    );
  } finally {
    db.close();
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  generateContext
});
