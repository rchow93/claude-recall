/**
 * Date Expression Parser
 *
 * Converts a wide range of date expressions into epoch seconds.
 * Used by the MCP search tool's `since` and `until` params.
 *
 * Supports:
 *   - Numbers (epoch seconds, or epoch millis if > 10^12)
 *   - Keywords: "now", "today", "yesterday", "tomorrow"
 *   - Relative: "3 days ago", "2h ago", "30 minutes ago", "1 week ago"
 *   - Shortcuts: "last hour", "last day", "last week", "last month"
 *   - ISO 8601 strings: "2026-04-25", "2026-04-25T14:30:00Z"
 *
 * Returns null if the expression cannot be parsed.
 */

export function parseDateExpression(expr: string | number | undefined | null): number | null {
  if (expr == null) return null;

  // Number → epoch
  if (typeof expr === 'number') {
    if (!isFinite(expr) || expr <= 0) return null;
    // Heuristic: > 10^12 looks like millis; convert to seconds
    return expr > 1e12 ? Math.floor(expr / 1000) : Math.floor(expr);
  }

  const s = expr.trim().toLowerCase();
  if (!s) return null;

  const now = Math.floor(Date.now() / 1000);

  // Simple keywords
  if (s === 'now') return now;
  if (s === 'today') return midnightOffsetDays(0);
  if (s === 'yesterday') return midnightOffsetDays(-1);
  if (s === 'tomorrow') return midnightOffsetDays(1);

  // "X UNIT ago"
  const relMatch = s.match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|mon|month|months)\s*ago$/);
  if (relMatch) {
    const n = parseInt(relMatch[1], 10);
    const unit = relMatch[2];
    const secs = unitToSeconds(unit, n);
    if (secs !== null) return now - secs;
  }

  // "last hour" / "last day" / "last week" / "last month"
  const lastMatch = s.match(/^last\s+(hour|day|week|month)$/);
  if (lastMatch) {
    const secs = unitToSeconds(lastMatch[1], 1);
    if (secs !== null) return now - secs;
  }

  // Fallback: try Date.parse on the original (case-preserved) string
  const parsed = Date.parse(expr);
  if (!isNaN(parsed)) {
    return Math.floor(parsed / 1000);
  }

  return null;
}

function unitToSeconds(unit: string, n: number): number | null {
  if (/^(s|sec|secs|second|seconds)$/.test(unit)) return n;
  if (/^(m|min|mins|minute|minutes)$/.test(unit)) return n * 60;
  if (/^(h|hr|hrs|hour|hours)$/.test(unit)) return n * 3600;
  if (/^(d|day|days)$/.test(unit)) return n * 86400;
  if (/^(w|wk|wks|week|weeks)$/.test(unit)) return n * 7 * 86400;
  if (/^(mo|mon|month|months)$/.test(unit)) return n * 30 * 86400;  // approximate
  return null;
}

function midnightOffsetDays(offset: number): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return Math.floor(d.getTime() / 1000);
}
