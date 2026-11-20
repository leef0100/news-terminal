# Voices: the reading list and how each entry was checked

What `/api/voices` draws on. The list is `config/voices.json`; the server fetches the feed
addresses in that file and nothing else. Checks were made on 2026-11-19. The build shell has
no internet access, and the web-fetch tool used for research opens only addresses that a
search has surfaced, so **most feeds could not be opened directly**. Every entry says which
of these applies:

- **live**: the feed itself was fetched and recent items were seen.
- **reader**: the feed address and items were seen only in a third-party feed reader's listing.
- **stated**: the author's own site gives this feed address; the feed was not fetched.
- **convention**: the publication's own page was fetched and shows the platform (Substack
  `/feed`, Ghost `/rss/`, WordPress `/feed/`); the address follows that platform's standard
  and was not fetched. These are the most likely to need correcting.
- **none**: no feed could be confirmed, so the entry has no feed (site and X link only).

An X handle is listed only where the author's own site or publication page shows it. Where
it does not, the entry has no handle and no "Add to My panel" button, however well known the
account is.

**Before launch:** start the server with network access, open Voices once, and read the
Status page. Each feed that fails appears there by name ("Voices: <publication>") with the
error; fix or remove its `feed` in the config. Nothing else needs changing.

Code: `src/voices/` (`index.js` router, `poller.js` feed reading, `config.js` validation,
`demo.js` invented list). Parsing of titles, links and dates is `src/ingest/rss.js`.

## What is kept, and what is not

- Kept per piece: title, link, date, and at most 200 characters of the feed's own public
  `<description>` (Atom `<summary>`), tags stripped. Newest 10 per voice.
- Never kept or passed on: `<content:encoded>`, Atom `<content>`, or anything else that is
  the body of a piece. Newsletter feeds do carry full text for free posts; it is parsed past
  and dropped. Nothing is fetched from behind a login, and no article page is ever fetched.
- For paid posts a newsletter's feed carries the public subtitle or preview the author chose
  to publish in the feed. That is what the 200 characters come from. Set `"excerpt": false`
  on an entry to show titles only (done for Calculated Risk, which asks for no excerpts).
- Links: only `http(s)` links are passed on; the page checks them again before making a link.

## Polling

Each feed at most every 15 minutes (the config and the code both refuse less), three at a
time, with `If-None-Match` / `If-Modified-Since`, a cap of 240 requests an hour across all
feeds, a 10 second timeout and a 4 MB limit per answer. A failing feed is retried after 15,
30, 60 ... minutes up to 6 hours (longer if it sends `Retry-After`) and keeps its last good
items. Redirects are followed only to https on the same host (with or without `www.`).
Feeds are read only while someone has the page open; after 30 minutes without a request the
server stops asking.

User-Agent: `Halftone-Voices/0.1 (market terminal reading list; titles and links only; each
feed at most every 15 minutes; <VOICES_CONTACT>)`. Set `VOICES_CONTACT` to a URL or email so
a feed owner can reach the operator; without it no contact is invented.

## The list (31)

| Entry | Publication | X handle | Feed | Feed check |
|---|---|---|---|---|
| Citrini | Citrini Research | not listed (see below) | citriniresearch.com/feed | **live** (newest 4 Nov 2026) |
| Lyn Alden | Lyn Alden Investment Strategy | LynAldenContact (home page) | lynalden.com/feed/ | reader (feeder.co, newest 15 Jul 2026) |
| Noah Smith | Noahpinion | not shown on site | noahpinion.blog/feed | convention (Substack) |
| Adam Tooze | Chartbook | not shown on site | adamtooze.substack.com/feed | convention (Substack) |
| Joseph Politano | Apricitas Economics | not shown on site | apricitas.io/feed | convention (Substack) |
| Robin J Brooks | Robin J Brooks | not shown on site | robinjbrooks.substack.com/feed | convention (Substack) |
| Kyla Scanlon | Kyla's Newsletter | not shown on site | kyla.substack.com/feed | convention (Substack) |
| Calculated Risk | Calculated Risk | none linked | feeds.feedburner.com/CalculatedRisk | stated on the blog; reader copy was old |
| Doomberg | Doomberg | not shown on site | newsletter.doomberg.com/feed | convention (Substack) |
| Ben Thompson | Stratechery | benthompson (site header) | stratechery.com/feed/ | reader (inoreader listing; recency not confirmed) |
| Dylan Patel | SemiAnalysis | dylan522p (author page) | newsletter.semianalysis.com/feed | convention (Substack) |
| Benedict Evans | Benedict Evans | benedictevans (site header) | none | none |
| Byrne Hobart | The Diff | ByrneHobart (about page) | thediff.co/rss/ | convention (Ghost) |
| Aswath Damodaran | Musings on Markets | none linked | aswathdamodaran.blogspot.com/feeds/posts/default | reader (feeder.co, items from Nov 2026) |
| Ed Zitron | Where's Your Ed At | edzitron (site footer) | wheresyoured.at/rss/ | stated on the about page |
| Tomasz Tunguz | Tomasz Tunguz | ttunguz (about page) | none | none |
| Michael Burry | Cassandra Unchained | not shown on site | michaeljburry.substack.com/feed | convention (Substack) |
| Arthur Hayes | Crypto Trader Digest | not shown on site | cryptohayes.substack.com/feed | convention (Substack) |
| Coin Metrics | State of the Network | not shown on site | coinmetrics.substack.com/feed | convention (Substack) |
| Bankless | Bankless | BanklessHQ (site footer) | bankless.com/rss/feed | stated on the site |
| Unchained | Unchained | Unchained_pod (header, footer) | unchainedcrypto.com/feed/ | convention (WordPress) |
| Glassnode | Glassnode Research | not shown on site | research.glassnode.com/rss/ | convention (Ghost) |
| Joel John and team | Decentralised.co | joel_john95 (about page) | decentralised.co/feed | convention (Substack) |
| Galaxy Research | Galaxy | galaxyhq (page metadata) | none | none |
| Liberty Street Economics | Federal Reserve Bank of New York | libertystecon (blog page) | libertystreeteconomics.newyorkfed.org/feed/ | stated on the blog |
| FEDS Notes | Federal Reserve Board | federalreserve (feeds page) | federalreserve.gov/feeds/feeds_notes.xml | stated on the Board's feeds page |
| Ben Carlson | A Wealth of Common Sense | awealthofcs (contact page) | awealthofcommonsense.com/feed/ | convention (WordPress) |
| Sam Ro | TKer | not stated on site | tker.co/feed | convention (Substack) |
| Patrick McKenzie | Bits about Money | patio11 (author page) | none | none |
| Tadas Viskanta | Abnormal Returns | not found on page | abnormalreturns.com/feed/ | convention (WordPress) |
| Barry Ritholtz | The Big Picture | not found on page | ritholtz.com/feed/ | convention (WordPress) |

Totals: 15 handles verified on the author's own pages; 27 feeds (1 live, 3 reader, 5 stated,
18 convention); 4 entries with no feed. The exact page read for each entry is in its
`verified` note in the config.

Suggested panel (eight verified handles): LynAldenContact, dylan522p, benthompson,
ByrneHobart, edzitron, BanklessHQ, galaxyhq, libertystecon.

### Citrini Research

The customer asked for it by name. Its feed was fetched live. Its X handle could **not** be
verified to the standard above: the account generally attributed to it appears only on
third-party pages; the publication's home, about and support pages, a post page and the part
of the feed that was read do not link an X account. So the entry has no handle and is not in
the suggested panel. To add it: open the X profile in a browser, confirm its profile link
points at citriniresearch.com, then add `"x": "<handle>"` to the entry and, if wanted, its id
to `suggested`.

## Dropped, and why

| Candidate | Why |
|---|---|
| Haseeb Qureshi (haseebq.com) | Handle and feed verified, but recent posts are personal essays, not market commentary. |
| a16z crypto | Its site and newsletter now redirect to a differently named site; not re-verified. |
| The DeFi Report | Has moved hosts; neither the new feed nor a handle could be confirmed. |
| FT Alphaville | Only an old http feed address seen in a third-party reader; no handle verified. |
| Epsilon Theory | Neither a feed address nor a handle seen on the pages fetched. |
| Apollo, The Daily Spark | The page redirects to the firm's main site; no feed found. |
| Alpha Architect | Its site refused the fetch. |
| Joseph Wang (Fed Guy), The Overshoot, Net Interest, Concoda, Fabricated Knowledge, Capital Wars, Exponential View | Their own pages were not surfaced by search, so nothing could be checked. |
| Handles for Sam Ro, Calculated Risk, and every Substack-only writer above | Not shown on the author's own pages; the entries stay, without a handle. |

## Known limits

- Eighteen feed addresses rest on platform convention and have not answered a request from
  this code. Expect a few to need correcting on first run.
- The reader-listed copies of two feeds were stale or undated (Stratechery, Calculated Risk),
  so those may publish little through the public feed.
- Some feeds may refuse automated clients whatever the User-Agent; such a feed shows as
  "could not be read" on its card and on the Status page, and the rest are unaffected.
- A handle can change hands. Handles should be re-checked whenever the list is edited.
