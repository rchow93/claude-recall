import { readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface AutoApproveRule {
  from: string;
  to: string;
  type?: string;
  priority?: string;
}

export interface MessageRulesConfig {
  auto_approve?: AutoApproveRule[];
}

let rulesCache: MessageRulesConfig | null = null;
let rulesMtime = 0;
let resolvedPath: string | null = null;

function getRulesPath(): string {
  if (resolvedPath) return resolvedPath;
  resolvedPath = process.env.CLAUDE_RECALL_MESSAGE_RULES
    ?? join(process.env.CLAUDE_RECALL_DATA_DIR ?? join(homedir(), '.claude-recall'), 'message-rules.json');
  return resolvedPath;
}

export function resetRulesCache(): void {
  rulesCache = null;
  rulesMtime = 0;
  resolvedPath = null;
}

export function loadAutoApproveRules(): AutoApproveRule[] {
  try {
    const path = getRulesPath();
    if (!existsSync(path)) return [];
    const stat = statSync(path);
    const mtime = stat.mtimeMs;
    if (rulesCache && mtime === rulesMtime) return rulesCache.auto_approve ?? [];
    const raw = readFileSync(path, 'utf-8');
    rulesCache = JSON.parse(raw) as MessageRulesConfig;
    rulesMtime = mtime;
    return rulesCache.auto_approve ?? [];
  } catch {
    return [];
  }
}

export function matchesAutoApproveRule(from: string, to: string, type: string, priority: string): boolean {
  const rules = loadAutoApproveRules();
  return matchesRules(rules, from, to, type, priority);
}

export function matchesRules(rules: AutoApproveRule[], from: string, to: string, type: string, priority: string): boolean {
  for (const rule of rules) {
    const fromMatch = rule.from === '*' || rule.from === from;
    const toMatch = rule.to === '*' || rule.to === to;
    const typeMatch = !rule.type || rule.type === '*' || rule.type === type;
    const priorityMatch = !rule.priority || rule.priority === '*' || rule.priority === priority;
    if (fromMatch && toMatch && typeMatch && priorityMatch) return true;
  }
  return false;
}
