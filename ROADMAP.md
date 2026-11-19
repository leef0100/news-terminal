# Roadmap

Requested on 19 November 2026. Nothing here is built yet. Each item says what it would be,
where the data could come from, and what is uncertain. Sources are candidates to verify,
not confirmed.

## 1. AI and infrastructure indexes

A new "Indexes" page with five house indexes, each with a chart, its parts, and a plain
statement of how it is calculated. Every index is our own construction and must be labelled
as such, with its method published, so nobody mistakes it for an official benchmark.

| Index | What it would measure | Candidate inputs | Main uncertainty |
|---|---|---|---|
| **GPU demand** | How tight the market for AI chips is | GPU rental prices by model from public cloud and marketplace price lists; chip makers' data-center revenue from SEC filings (already connected) | Rental price lists are scattered and some forbid collection; filings are quarterly |
| **Compute** | The price of a unit of compute over time | Hourly prices for a fixed basket of GPU and CPU instances | Needs a stable basket and a daily collector |
| **Inference** | The price of running AI models | Published per-token prices of major model providers, weighted into a basket | Prices change by announcement, not continuously; weights are a judgement call |
| **Energy** | Power cost and supply for data centers | US Energy Information Administration open data (wholesale power, natural gas, generation); uranium and gas prices | EIA needs a free key; wholesale power is regional |
| **Data center** | Build-out and financial health of the sector | An equal- or cap-weighted basket of listed data-center, power and cooling companies; capital spending from the largest buyers' SEC filings | Share prices need a licensed feed (see READINESS.md) |

Also worth adding because they matter to the same reader:
- **AI capital spending tracker**: quarterly capex of the largest cloud and chip buyers, from
  SEC filings, as a chart and table. Cheap to build on what exists.
- **Semiconductor basket** and **AI-linked crypto basket** (compute and AI tokens), so the
  indexes can be compared with what traders can actually buy.
- **Stablecoin supply and exchange flows**, **ETF flows**, and **options positioning** for the
  crypto side: the three things a crypto desk checks daily that the terminal lacks.
- **Earnings transcripts and guidance changes**, linked from each company page.
- **Alerts**: a level crossed, a filing from a watched company, a new post from a watched
  account. Needs accounts first.

## 2. What the big funds hold

- **Source: SEC Form 13F**, already reachable through the EDGAR connection. Large managers
  (Citadel Advisors, Jane Street Group and thousands of others) must report holdings.
- **What it can show:** each manager's reported positions, the largest changes from the
  quarter before, and, on a company page, which large managers hold it.
- **What it cannot show, and the page must say so:** filings are quarterly and arrive up to
  45 days after quarter end, so they are old by the time they appear. They list US-listed
  shares and some options only: no short positions, no futures, no crypto, no foreign
  holdings. For a market maker such as Jane Street or Citadel Securities the list is mostly
  inventory and hedges, not a view on the market. It is a record of what was held, not what
  is held, and never a signal to copy.
- Also from the SEC: insider buying and selling (Form 4), and stakes above 5% (Schedules
  13D and 13G). These are timelier than 13F and worth building first.

## 3. Voices worth following

- A curated "Voices" section: research writers and well-known market commentators (Citrini
  Research and others), each with their latest published pieces and posts.
- **How:** publishers' own feeds (many newsletters publish RSS) for titles and links, and the
  X columns already in My panel for posts. A ready-made panel of suggested accounts would
  make My panel useful on first visit.
- **Limits:** titles and links only; paid research stays behind the author's paywall and is
  not copied or summarised from behind it. Opinions are shown as the author's, with a link,
  and are not turned into "calls" or scores by us.

## Suggested order

1. Fund holdings, insider trades and large stakes (data source already connected).
2. AI capital spending tracker and the data-center basket.
3. Voices, with a suggested panel.
4. Energy index (official data, free key).
5. Inference, compute and GPU demand indexes (need new collectors and careful method notes).
