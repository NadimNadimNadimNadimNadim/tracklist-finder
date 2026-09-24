export interface AppConfig {
  environment: string;
  version: string;
  userAgent: string;
}

// Printable ASCII only, so config can never inject extra lines into a header.
const printable = (s: string, max: number): string => s.replace(/[^\x20-\x7e]/g, "").slice(0, max);

function safeContact(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const v = raw.trim();
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(v)) return printable(v, 200);
  try {
    const u = new URL(v);
    if (u.protocol === "https:" && !u.username && !u.password) return printable(u.href, 200);
  } catch {
    // Fall through.
  }
  return "";
}

export function readConfig(env: Env): AppConfig {
  const environment = printable(String(env.ENVIRONMENT ?? "development"), 32) || "development";
  const version = printable(String(env.VERSION ?? "dev"), 64) || "dev";
  const contact = safeContact(env.CONTACT);
  return {
    environment,
    version,
    userAgent: `tracklist-finder/${version.slice(0, 12)} (looks up archived 8tracks playlists${contact ? `; ${contact}` : ""})`,
  };
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/** One JSON object per line, which Workers Logs indexes for searching. */
export function consoleLogger(base: Record<string, unknown>): Logger {
  const write = (level: string, event: string, fields: Record<string, unknown> = {}): void => {
    const line = JSON.stringify({ level, event, ...base, ...fields });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };
  return {
    info: (e, f) => write("info", e, f),
    warn: (e, f) => write("warn", e, f),
    error: (e, f) => write("error", e, f),
  };
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
