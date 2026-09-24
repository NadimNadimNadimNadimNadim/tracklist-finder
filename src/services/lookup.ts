import { AppError } from "../errors";
import type { PlaylistRef } from "../domain/input";
import { extractTitle, rankMixIds } from "../domain/extract";
import { parseTrackFile, shapeTracklist } from "../domain/tracklist";
import type { PageInfo, Tracklist } from "../domain/tracklist";
import type { WaybackClient } from "./wayback";

/** Anything that can turn a PlaylistRef into a Tracklist. Decorators wrap this. */
export interface Lookup {
  lookup(ref: PlaylistRef): Promise<LookupOutcome>;
}

export interface LookupOutcome {
  result: Tracklist;
  /** Where the answer came from, for logs and the X-Cache header. */
  source: "archive" | "cache";
}

const MAX_TRACK_FILE_CANDIDATES = 3;

const RENAMED_WARNING =
  "The saved tracklist is filed under a different address than the link you pasted. The playlist may have been renamed, so double-check that it's the right one.";

const samePath = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

/** Talks to the Wayback Machine. No caching or rate limiting here; see decorators. */
export class ArchiveLookup implements Lookup {
  constructor(private readonly wayback: WaybackClient) {}

  async lookup(ref: PlaylistRef): Promise<LookupOutcome> {
    const page = ref.kind === "path" ? await this.findPage(ref.path) : null;
    const ids = page ? page.ids : ref.kind === "id" ? [ref.id] : [];
    try {
      return { result: await this.findTracks(ids, page), source: "archive" };
    } catch (e) {
      if (e instanceof AppError && e.code === "TRACKS_NOT_ARCHIVED" && page) {
        throw new AppError(e.code, e.message, { details: { ...e.details, page } });
      }
      throw e;
    }
  }

  /**
   * Finds the archived playlist page and the mix numbers on it. Tries the capture
   * nearest 2019 (8tracks' final months), then one nearest 2013 in case the later
   * capture is an error page. If the address has capitals and nothing was saved,
   * tries the lowercase version too.
   */
  async findPage(path: string): Promise<PageInfo> {
    const variants = path === path.toLowerCase() ? [path] : [path, path.toLowerCase()];
    for (const variant of variants) {
      for (const year of ["2019", "2013"] as const) {
        const capture = await this.wayback.getPage(variant, year);
        if (capture === null) break; // Never archived at any date. Try the next variant.
        const ids = rankMixIds(capture.body);
        if (ids.length > 0) {
          return {
            path: variant,
            ids,
            title: extractTitle(capture.body),
            pageUrl: capture.viewUrl,
            pageCapture: capture.timestamp,
          };
        }
      }
    }
    throw new AppError(
      "PAGE_NOT_ARCHIVED",
      "The Wayback Machine doesn't have a usable copy of that playlist page, so the mix can't be identified.",
      { details: { path } },
    );
  }

  /**
   * Loads track files for the candidate mix numbers (best first) and returns the
   * first one that belongs to the requested playlist.
   */
  async findTracks(ids: string[], page: PageInfo | null): Promise<Tracklist> {
    let closest: Tracklist | null = null;
    for (const id of ids.slice(0, MAX_TRACK_FILE_CANDIDATES)) {
      const capture = await this.wayback.getTrackFile(id);
      if (capture === null) continue;
      const file = parseTrackFile(capture.body);
      if (file === null) continue;
      const matches = page === null || file.webPath === null || samePath(file.webPath, page.path);
      const shaped = shapeTracklist({
        requestedId: id,
        file,
        trackFileUrl: capture.viewUrl,
        trackFileCapture: capture.timestamp,
        page,
        warning: matches ? null : RENAMED_WARNING,
      });
      if (matches) return shaped;
      closest ??= shaped;
    }
    if (closest) return closest;
    throw new AppError(
      "TRACKS_NOT_ARCHIVED",
      "The Wayback Machine saved this playlist's page, but not the file that lists its tracks.",
      { details: { mixId: ids[0] ?? null } },
    );
  }
}
