import { cleanLine, cleanParagraphs } from "./text";

export interface Track {
  title: string;
  artist: string;
  release: string | null;
  year: number | null;
  youtubeId: string | null;
}

export interface MixInfo {
  id: string;
  name: string | null;
  url: string | null;
  user: string | null;
  description: string | null;
  published: string | null;
  durationSec: number | null;
  plays: number | null;
  likes: number | null;
  certification: string | null;
  tags: string[];
  trackCountOnSite: number | null;
  cover: string | null;
}

export interface PageInfo {
  path: string;
  ids: string[];
  title: string | null;
  pageUrl: string;
  pageCapture: string | null;
}

export interface Tracklist {
  mix: MixInfo;
  tracks: Track[];
  sources: { trackFileUrl: string; trackFileCapture: string | null };
  page: PageInfo | null;
  warning: string | null;
}

const MAX_TRACKS = 500;
const MAX_TAGS = 20;
const WEB_PATH = /^\/[A-Za-z0-9._~-]{1,150}\/[A-Za-z0-9._~-]{1,150}$/;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const CERTIFICATIONS = new Set(["gold", "platinum", "diamond"]);

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function nonNegativeInt(v: unknown, max = 1e12): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : null;
}

/** Only https cover images on 8tracks' own image host are passed along. */
export function safeCoverUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 1000) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.hostname !== "images.8tracks.com" || u.port !== "" || u.username || u.password) return null;
  u.protocol = "https:";
  return u.href;
}

export function safeWebPath(v: unknown): string | null {
  return typeof v === "string" && WEB_PATH.test(v) ? v : null;
}

function isoDate(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** The parts of an archived track file we use, after checking their shapes. */
export interface TrackFile {
  raw: Json;
  tracks: Json[];
  webPath: string | null;
}

/**
 * Checks that an archived response really is a track file. Returns null for
 * anything else (an error page, an empty list, the wrong JSON).
 */
export function parseTrackFile(body: string): TrackFile | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isObject(data) || !Array.isArray(data.tracks)) return null;
  const tracks = data.tracks.filter(isObject).slice(0, MAX_TRACKS);
  if (tracks.length === 0) return null;
  return { raw: data, tracks, webPath: safeWebPath(data.web_path) };
}

export function shapeTracklist(args: {
  requestedId: string;
  file: TrackFile;
  trackFileUrl: string;
  trackFileCapture: string | null;
  page: PageInfo | null;
  warning: string | null;
}): Tracklist {
  const d = args.file.raw;
  const webPath = args.file.webPath;
  const coverUrls = isObject(d.cover_urls) ? d.cover_urls : {};
  const tags = typeof d.tag_list_cache === "string"
    ? d.tag_list_cache.split(",").map((t) => cleanLine(t, 60)).filter(Boolean).slice(0, MAX_TAGS)
    : [];
  const certification = typeof d.certification === "string" && CERTIFICATIONS.has(d.certification) ? d.certification : null;
  const id = nonNegativeInt(d.id, 999_999_999);

  const tracks: Track[] = args.file.tracks.map((t) => {
    const year = nonNegativeInt(t.year, 2100);
    const youtube = typeof t.you_tube_id === "string" && YOUTUBE_ID.test(t.you_tube_id) ? t.you_tube_id : null;
    return {
      title: cleanLine(t.name) || "Untitled",
      artist: cleanLine(t.performer) || "Unknown artist",
      release: cleanLine(t.release_name) || null,
      year: year !== null && year >= 1900 ? year : null,
      youtubeId: youtube,
    };
  });

  return {
    mix: {
      id: id !== null && id > 0 ? String(id) : args.requestedId,
      name: cleanLine(d.name, 200) || null,
      url: webPath ? `https://8tracks.com${webPath}` : null,
      user: webPath ? webPath.split("/")[1]! : null,
      description: cleanParagraphs(d.description) || null,
      published: isoDate(d.first_published_at),
      durationSec: nonNegativeInt(d.duration, 10 * 24 * 3600),
      plays: nonNegativeInt(d.plays_count),
      likes: nonNegativeInt(d.likes_count),
      certification,
      tags,
      trackCountOnSite: nonNegativeInt(d.tracks_count, 100_000),
      cover: safeCoverUrl(coverUrls.sq250) ?? safeCoverUrl(coverUrls.max200),
    },
    tracks,
    sources: { trackFileUrl: args.trackFileUrl, trackFileCapture: args.trackFileCapture },
    page: args.page,
    warning: args.warning,
  };
}
