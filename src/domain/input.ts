import { AppError } from "../errors";

/** What the user asked for: a playlist address on 8tracks, or a mix number. */
export type PlaylistRef = { kind: "path"; path: string } | { kind: "id"; id: string };

export const MAX_INPUT_LENGTH = 2048;
const MAX_SEGMENT_LENGTH = 150;

// 8tracks usernames and playlist slugs only ever used these characters.
// Anything else (encoded slashes, dots-only segments, spaces, control characters)
// is rejected, which also means nothing unexpected can reach an outbound URL.
const SEGMENT = /^[A-Za-z0-9._~-]+$/;
const MIX_ID = /^[0-9]{1,9}$/;

const ALLOWED_HOSTS = new Set(["8tracks.com", "www.8tracks.com"]);

// First path segments that are sections of the 8tracks site, not usernames.
const RESERVED_FIRST_SEGMENTS = new Set([
  "about", "api", "apps", "blog", "city", "collections", "create_mix", "explore", "help", "login",
  "mix_sets", "mixes", "plus", "search", "sets", "signup", "songs", "tags", "tracks", "users",
]);

// Sub-pages of a playlist that should be treated as the playlist itself.
const PLAYLIST_SUBPAGES = new Set(["comments", "embed", "og", "play", "stats", "tracks"]);

const notAPlaylist =
  "Playlist links look like 8tracks.com/username/playlist-name. That link points somewhere else on the site.";

const bad = (message: string, internal?: string): AppError =>
  new AppError("BAD_INPUT", message, internal ? { internal } : {});

function normalizeMixId(raw: string): string | null {
  if (!MIX_ID.test(raw)) return null;
  const id = String(Number(raw));
  return id === "0" ? null : id;
}

function decodeSegment(segment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (decoded.length === 0 || decoded.length > MAX_SEGMENT_LENGTH) return null;
  if (decoded === "." || decoded === "..") return null;
  return SEGMENT.test(decoded) ? decoded : null;
}

/**
 * Turns whatever the user pasted into a PlaylistRef, or throws BAD_INPUT.
 *
 * Accepts:
 *   https://8tracks.com/user/playlist (any scheme, with or without www, trailing slash,
 *     query string, fragment, or a sub-page like /comments/2)
 *   8tracks.com/mixes/12345 or a bare mix number
 *   A Wayback Machine link wrapping any of the above
 */
export function parseInput(raw: unknown): PlaylistRef {
  if (typeof raw !== "string") throw bad("Paste a link to an 8tracks playlist.");
  let s = raw.trim();
  if (s.length === 0) throw bad("Paste a link to an 8tracks playlist.");
  if (s.length > MAX_INPUT_LENGTH) throw bad("That link is too long.");
  if (/[\u0000-\u001f\u007f]/.test(s)) throw bad("That link contains characters links can't have.");

  const bareId = normalizeMixId(s);
  if (bareId) return { kind: "id", id: bareId };

  // Unwrap one layer of Wayback Machine link.
  const wayback = s.match(/^(?:https?:\/\/)?(?:www\.)?web\.archive\.org\/web\/[^/]{1,32}\/(.+)$/i);
  if (wayback?.[1]) s = wayback[1];

  // Add a scheme if missing. A scheme must start with a letter, so "8tracks.com:80/..."
  // is not mistaken for one.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = "https://" + s.replace(/^\/+/, "");

  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw bad("That doesn't look like a link.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") throw bad("Only web links (http or https) are supported.");
  if (url.username !== "" || url.password !== "") throw bad("That link isn't an 8tracks.com link.", "userinfo present");
  if (url.port !== "") throw bad("That link isn't an 8tracks.com link.", "non-default port");
  if (!ALLOWED_HOSTS.has(url.hostname)) throw bad("That link isn't an 8tracks.com link.");

  const rawSegments = url.pathname.split("/").filter((p) => p !== "");
  const segments: string[] = [];
  for (const raw of rawSegments.slice(0, 4)) {
    const decoded = decodeSegment(raw);
    if (decoded === null) throw bad("That link has characters 8tracks playlist addresses never used.");
    segments.push(decoded);
  }
  if (rawSegments.length > 4) throw bad(notAPlaylist);

  if (segments[0]?.toLowerCase() === "mixes") {
    const id = segments[1] !== undefined ? normalizeMixId(segments[1]) : null;
    if (!id) throw bad("That mix number isn't valid.");
    return { kind: "id", id };
  }

  if (segments.length >= 3 && PLAYLIST_SUBPAGES.has(segments[2]!.toLowerCase())) segments.length = 2;

  const [user, slug] = segments;
  if (segments.length !== 2 || !user || !slug || RESERVED_FIRST_SEGMENTS.has(user.toLowerCase())) {
    throw bad(notAPlaylist);
  }
  return { kind: "path", path: `/${user}/${slug}` };
}


/** Checks a path produced by parseInput. Used again right before building outbound URLs. */
export function isSafePlaylistPath(path: string): boolean {
  const parts = path.split("/");
  return (
    parts.length === 3 &&
    parts[0] === "" &&
    parts.slice(1).every((p) => p.length > 0 && p.length <= MAX_SEGMENT_LENGTH && p !== "." && p !== ".." && SEGMENT.test(p))
  );
}

export const isSafeMixId = (id: string): boolean => normalizeMixId(id) === id;

/** Stable cache key. Different ways of writing the same link share one key. */
export function refKey(ref: PlaylistRef): string {
  return ref.kind === "id" ? `id:${ref.id}` : `path:${ref.path}`;
}
