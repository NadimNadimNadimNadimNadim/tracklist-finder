/**
 * Fixtures based on real Wayback Machine captures of 8tracks pages. The snippets
 * below were copied from actual captures (2011, 2012 and 2020 page layouts); the
 * rest of each page is omitted.
 */

/** FeelGoodPlaylists' "New Feel Good Indie July 2011", captured 2011-11-07. */
export const PAGE_2011_FGP = `<!DOCTYPE html><html><head>
<title>New Feel Good Indie July 2011 | FeelGoodPlaylists | 8tracks</title>
<meta content="New Feel Good Indie July 2011" property="og:title" />
<meta content="http://8tracks.com/mixes/343265/player_v3/autoplay" property="og:video" />
<link href="http://8tracks.com/mixes/343265/player_v3?autoplay=true" rel="video_src" />
</head><body>
<script>var mix = {"web_path":"/feelgoodplaylists/new-feel-good-indie-july-2011","restful_url":"http://8tracks.com/mixes/343265","name":"New Feel Good Indie July 2011"};</script>
<a href="/flaggings?flag=nsfw_cover&amp;mix_id=343265" class="flaggable "><span>flag</span></a>
<span id="like_button"> <form accept-charset="UTF-8" action="/mixes/343265/toggle_like" class="like inactive p p_not_owner on white_button_form" data-mix_id="343265" data-owner_id="158318" method="post"></form></span>
<a class="white_button" title="Embed" href="http://8tracks.com/mixes/343265/embed" rel="local">Embed</a>
<h6 class="floated">This mix is public.</h6> <a class="publish_toggle" href="/mixes/343265/make_private" rel="local" data-action="mix_private">make private</a>
<div class="edit_links clear"> <a href="/mixes/343265/edit_tracks" class="edit_tracks">Edit tracks</a> | <a href="/mixes/343265/edit" class="edit">Edit description</a></div>
<div class="sidebar"><a href="/mixes/350784">The Happy Ukulele</a></div>
</body></html>`;

/** madelinerose7's "get on your study grind!", captured 2012-06-21. */
export const PAGE_2012_STUDY = `<!DOCTYPE html><html><head>
<title>get on your study grind! | madelinerose7 | 5,000+ likes | 46,000+ listens</title>
<meta content="get on your study grind!" property="og:title" />
<meta content="http://8tracks.com/mixes/432459/player_v3/autoplay" property="og:video" />
<meta itemprop="embedURL" content="http://8tracks.com/mixes/432459/player_v3" />
</head><body>
<span id="like_button" class="edit_disable"> <a href="/mixes/432459/toggle_like" class="like inactive p p_not_owner on white_button" data-method="post" data-mix_id="432459" data-owner_id="134137" rel="nofollow">like</a></span>
<a class="flag" title="Flag mix art as NSFW" href="/flaggings?flag=nsfw_cover&amp;mix_id=432459">&nbsp;</a>
<a class="white_button edit_disable" title="Embed" href="http://8tracks.com/mixes/432459/embed" rel="local">Embed</a>
<form accept-charset="UTF-8" action="/mixes/432459" class="edit_mix" id="edit_mix_432459"></form>
</body></html>`;

/** The same playlist, captured 2020-02-12 after the site redesign. */
export const PAGE_2020_STUDY = `<!DOCTYPE html><html><head>
<title>8tracks radio | get on your study grind! (19 songs) | free and music playlist </title>
<meta property="og:title" content="get on your study grind!" />
<meta property="twitter:player" content="https://8tracks.com/mixes/432459/player_v3_universal?modest=1" />
<meta property="al:android:url" content="android-app://com.e8tracks/http/8tracks.com/mixes/432459" />
</head><body>
<div style="display: none;"> <meta itemprop="embedUrl" content="https://8tracks.com/mixes/432459/player_v3_universal/autoplay" /> </div>
<a class="flag" rel="nofollow login_required" data-href="/flaggings?flag=nsfw_cover&mix_id=432459"><span class="i-flag"></span></a>
<div class="mix_interactions"> <a id="like_button" href="/mixes/432459/toggle_like" class="flatbutton like inactive edit_disable p p_not_owner on" data-method="post" data-mix_id="432459" data-owner_id="134137" rel="signup_required">like</a></div>
<div class="similar"><a href="/mixes/458972">The Anti-Anxiety Playlist</a><a href="/mixes/6569944">Feel Good Indie July 2015</a></div>
</body></html>`;

/** What the Wayback Machine returns when 8tracks served an error page. */
export const PAGE_ERROR = `<!DOCTYPE html><html><head><title>8tracks radio | Oops!</title></head>
<body><p>Oops! It looks like the mix you are trying to listen to is not currently available.</p></body></html>`;

export const STUDY_TRACKS: ReadonlyArray<readonly [string, string, string | null]> = [
  ["Teardrop", "Massive Attack", "Mezzanine"],
  ["Your Hand In Mine", "Explosions In The Sky", "The Earth Is Not A Cold Dead Place"],
  ["Nuvole bianche", "Ludovico Einaudi", "Radio1 concerto (Rome 2005)"],
  ["Transatlanticism", "Death Cab for Cutie", "Transatlanticism"],
  ["Into the Dark", "Sebastion Larsson", "Classic"],
  ["Concerning the UFO Sighting Near Highland, Illinois", "Sufjan Stevens", null],
  ["The Only Moment We Were Alone", "Explosions In The Sky", null],
  ["Chopin Nocturne No. 7 in C-Sharp Minor, Op. 27, No. 1", "Artur Rubenstein", null],
  ["Paper Bird", "Parachutes", null],
  ["Losing You to You", "Hammock", null],
  ["Moonlight Sonata, I. Adagio sostenuto", "Daniela Ruso", null],
  ["Gemini Unbound", "Bury the Sound", null],
  ["Hurricane", "30 Seconds To Mars", "This Is War"],
  ["Crystalised", "The xx", "xx"],
  ["Don't Know Why", "Norah Jones", null],
  ["Hallelujah", "Rufus Wainwright", "Shrek"],
  ["Bloodbuzz Ohio", "The National", "High Violet"],
  ["Albion", "Babyshambles", null],
  ["Pirates of the Caribbean (piano cover)", "Jarrod Radnich", null],
];

export interface TrackFileOptions {
  id: number;
  webPath: string | null;
  name: string;
  tracks: ReadonlyArray<readonly [string, string, string | null]>;
  extra?: Record<string, unknown>;
  trackExtra?: Record<string, unknown>;
}

/** A track file shaped like the real tracks_for_international.jsonh responses. */
export function trackFile(o: TrackFileOptions): string {
  return JSON.stringify({
    status: "200 OK",
    errors: null,
    notices: null,
    logged_in: false,
    api_version: 3,
    tracks: o.tracks.map(([name, performer, release], i) => ({
      id: 4780891 + i,
      name,
      performer,
      release_name: release,
      year: null,
      uid: 4780891 + i,
      report_delay_s: 17,
      you_tube_id: "u7K72X4eo_s",
      is_soundcloud: false,
      ...o.trackExtra,
    })),
    id: o.id,
    web_path: o.webPath,
    name: o.name,
    description: "Got an essay to work on?\r\n\r\nEnjoy!",
    plays_count: 53543,
    likes_count: 5209,
    tag_list_cache: "study, instrumental, classical, homework, sleep",
    first_published_at: "2011-11-08T16:48:04Z",
    certification: "platinum",
    duration: 6305,
    tracks_count: o.tracks.length,
    cover_urls: { sq250: "https://images.8tracks.com/cover/i/000/432/459/study-4312.jpg?rect=8,0,332,332&q=98&fm=jpg&fit=max&w=250&h=250" },
    ...o.extra,
  });
}

export const STUDY_PATH = "/madelinerose7/get-on-your-study-grind";
export const STUDY_URL = "https://8tracks.com" + STUDY_PATH;
export const STUDY_TRACK_FILE = trackFile({ id: 432459, webPath: STUDY_PATH, name: "get on your study grind!", tracks: STUDY_TRACKS });
