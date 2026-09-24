import { cleanLine } from "./text";

/**
 * Mix numbers mentioned in an archived playlist page, most likely first.
 *
 * Every 8tracks page layout from 2011 to 2020 mentions its own mix number several
 * times (like buttons, embed links, share metadata), while links to other mixes
 * appear at most once or twice. Mentions in attributes that only ever refer to the
 * page's own mix count extra.
 *
 * All patterns are linear-time, so a hostile page can't make this slow.
 */
export function rankMixIds(html: string, limit = 5): string[] {
  const scores = new Map<string, number>();
  const add = (id: string, weight: number): void => {
    if (id.length > 9 || /^0/.test(id)) return;
    scores.set(id, (scores.get(id) ?? 0) + weight);
  };
  for (const m of html.matchAll(/mixes\/(\d{1,12})/g)) add(m[1]!, 1);
  for (const m of html.matchAll(/data-mix[_-]id=["'](\d{1,12})["']/g)) add(m[1]!, 3);
  for (const m of html.matchAll(/[?&](?:amp;)?mix_id=(\d{1,12})/g)) add(m[1]!, 2);
  for (const m of html.matchAll(/"restful_url":"https?:\/\/8tracks\.com\/mixes\/(\d{1,12})"/g)) add(m[1]!, 3);
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))
    .slice(0, limit)
    .map(([id]) => id);
}

function metaOgTitle(html: string): string | null {
  // Attribute order varies by era: 2011 pages put content= before property=.
  for (const tag of html.matchAll(/<meta\b[^>]{0,600}>/gi)) {
    const t = tag[0];
    if (!/\bproperty\s*=\s*["']og:title["']/i.test(t)) continue;
    const content = t.match(/\bcontent\s*=\s*"([^"]{0,500})"/i) ?? t.match(/\bcontent\s*=\s*'([^']{0,500})'/i);
    if (content?.[1]) return content[1];
  }
  return null;
}

/**
 * The playlist's name as shown on the archived page, or null.
 * Page titles looked like "8tracks radio | Name (19 songs) | free and music playlist"
 * or "Name | username | 8tracks"; this keeps just the name.
 */
export function extractTitle(html: string): string | null {
  const og = metaOgTitle(html);
  if (og) {
    const name = cleanLine(og, 200);
    if (name) return name;
  }
  const title = html.match(/<title[^>]{0,200}>([^<]{1,500})<\/title>/i)?.[1];
  if (!title) return null;
  const name = cleanLine(title, 300)
    .replace(/^8tracks radio\s*\|\s*/i, "")
    .split(" | ")[0]!
    .replace(/\s*\(\d+ songs?\)\s*$/i, "")
    .trim();
  return name ? cleanLine(name, 200) : null;
}
