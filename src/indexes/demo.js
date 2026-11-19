// Demo inputs for the Indexes page (`npm run demo`).
//
// Everything here is invented. The baskets and the capital spending tracker are built from
// the invented companies of the stocks demo (six-letter tickers no real share has), through
// the same arithmetic as the real indexes, so the demo is internally consistent: the
// contributions add up, four quarters make a trailing total, and so on. The tokens, model
// providers, machines and energy prices below are made up too, from fixed seeds, so every
// request and every server shows the same thing. Nothing is named after a real product.

import { noise, pick } from '../tradfi/util.js';
import { isoDay } from './math.js';

const DAY = 86400000;
const NOTE = 'Invented for the demo. Not real companies, prices, tokens or filings.';
const DEMO = [{ name: 'Demo data', state: 'ok', note: NOTE }];

const co = (symbol, name, reason) => ({ symbol, name, reason });

// The real methods and their wording, with invented constituents in place of the real ones.
export function demoConfig(config) {
  const swap = {
    'data-center': { baseDate: '2025-01-02', constituents: [
      co('HAVNRT', 'Havenrowe Realty Trust', 'Invented property trust, standing in for a data-center landlord.'),
      co('STOWLD', 'Stowelden Logistics Properties', 'Invented property company, standing in for a second landlord.'),
      co('LUMGRD', 'Lumengard Power Co.', 'Invented utility, standing in for a power supplier.'),
      co('SOLVYN', 'Solvynne Renewables Inc.', 'Invented generator, standing in for contracted clean power.'),
      co('GRIMSH', 'Grimshawe Industrial Corp.', 'Invented machinery maker, standing in for cooling equipment.'),
      co('ZEFRND', 'Zefrindo Networks Inc.', 'Invented network-equipment maker.'),
      co('OKTRVN', 'Oktravane Data Systems Corp.', 'Invented data-processing company.')
    ] },
    semis: { baseDate: '2025-01-02', constituents: [
      co('QUILLN', 'Quilvexa Microsystems Inc.', 'Invented chip maker.'),
      co('HEXALN', 'Hexaline Devices Inc.', 'Invented computer maker.'),
      co('ZEFRND', 'Zefrindo Networks Inc.', 'Invented network-equipment maker.'),
      co('BEXFRD', 'Bexforde Tooling Co.', 'Invented machine-tool maker, standing in for chip-making equipment.'),
      co('CHEMRA', 'Chemoraq Specialty Chemicals', 'Invented chemicals company, standing in for chip materials.')
    ] },
    capex: { companies: [
      co('VELQRX', 'Velquorix Cloudworks Corp.', 'Invented cloud company.'),
      co('BRYMOR', 'Brymoor Software Group', 'Invented software company.'),
      co('OKTRVN', 'Oktravane Data Systems Corp.', 'Invented data-processing company.'),
      co('STRMIQ', 'Streamiqo Media Inc.', 'Invented media company.'),
      co('VOXTEL', 'Voxtellan Communications', 'Invented network operator.')
    ] },
    'gpu-demand': { suppliers: [
      co('QUILLN', 'Quilvexa Microsystems Inc.', 'Invented chip maker.'),
      co('HEXALN', 'Hexaline Devices Inc.', 'Invented computer maker.'),
      co('ZEFRND', 'Zefrindo Networks Inc.', 'Invented network-equipment maker.')
    ] },
    'ai-crypto': { candidates: [
      { coin: 'DGRID', name: 'Demo Grid', reason: 'Invented compute-network token.' },
      { coin: 'DTENS', name: 'Demo Tensor', reason: 'Invented machine-learning network token.' },
      { coin: 'DAGNT', name: 'Demo Agent', reason: 'Invented AI-agent token.' },
      { coin: 'DFRAME', name: 'Demo Frame', reason: 'Invented rendering-network token.' },
      { coin: 'DNODE', name: 'Demo Node', reason: 'Invented GPU-marketplace token.' },
      { coin: 'DGONE', name: 'Demo Gone', reason: 'Invented token that is not listed, to show how a missing one is reported.' }
    ] },
    compute: { source: { name: 'Demo data', api: null, docs: null, region: 'demo-region-1', everyHours: 6 }, basket: [
      { id: 'g8', name: 'Demo G8 (8 accelerators, 96 vCPU)', group: 'GPU', reason: 'Invented large training node.' },
      { id: 'g1', name: 'Demo G1 (1 accelerator, 40 vCPU)', group: 'GPU', reason: 'Invented single-accelerator machine.' },
      { id: 'g1o', name: 'Demo G1-old (1 older accelerator, 24 vCPU)', group: 'GPU', reason: 'Invented previous-generation machine.' },
      { id: 'gs', name: 'Demo GS (1 small accelerator, 4 vCPU)', group: 'GPU', reason: 'Invented small inference machine.' },
      { id: 'c8a', name: 'Demo C8-a (8 vCPU, 32 GB)', group: 'CPU', reason: 'Invented general-purpose machine.' },
      { id: 'c8b', name: 'Demo C8-b (8 vCPU, 32 GB)', group: 'CPU', reason: 'Invented general-purpose machine.' }
    ] },
    inference: { snapshots: [] },
    energy: {}
  };
  const summary = {
    'data-center': 'Equal-weighted basket of seven invented companies from the stocks demo, from daily closing prices, rebalanced daily and rebased to 100.',
    semis: 'Equal-weighted basket of five invented companies from the stocks demo, from daily closing prices, rebalanced daily and rebased to 100.',
    capex: 'Capital expenditure of five invented companies from the stocks demo, by calendar quarter; the index is the trailing-four-quarter total, rebased to 100.',
    'gpu-demand': 'Half the trailing-four-quarter revenue of three invented suppliers, half the trailing-four-quarter capital spending of five invented buyers, each rebased to 100.',
    compute: 'Equal-weighted average change in the hourly list price of six invented machines.',
    energy: 'Half an invented industrial electricity price, half an invented natural gas price (monthly), each against its own level in the base month.',
    'ai-crypto': 'Equal-weighted basket of invented tokens, from invented daily closes, rebalanced daily and rebased to 100.',
    inference: 'Equal-weighted average change in the list price of a fixed set of invented models, from dated tables of invented prices.'
  };
  // The method shown is the real one, word for word. The real companies and services it
  // names belong to the live index; the demo puts invented ones in their place.
  const methodNote = 'Demo: the method and limits below are those of the real index, and the companies, services and sources they name are the real index’s. Every constituent and figure on this page is invented and stands in for them.';
  return { ...config, indexes: config.indexes.map((d) => ({ ...d, ...(swap[d.id] || {}), summary: summary[d.id] || d.summary, methodNote })) };
}

// A repeatable wandering path around 1.
const path = (seed, t, scale = 1) => Math.exp(scale * (0.32 * noise(t / (300 * DAY), seed) + 0.18 * noise(t / (70 * DAY), seed + 1) + 0.09 * noise(t / (14 * DAY), seed + 2) + 0.04 * noise(t / (2 * DAY), seed + 3)));

export function createDemoInputs({ now = Date.now }) {
  const today = () => Math.floor(now() / DAY) * DAY;

  // Invented tokens: one daily close each, up to yesterday. One starts half-way through
  // the window and one is not listed at all, so both cases are on show.
  const TOKENS = { DGRID: [4.2, 11], DTENS: [310, 12], DAGNT: [0.84, 13], DFRAME: [6.1, 14], DNODE: [1.9, 15] };
  async function crypto(def) {
    const end = today() - DAY, n = def.days || 400;
    const listed = def.candidates.filter((c) => TOKENS[c.coin]).map((c) => {
      const [base, seed] = TOKENS[c.coin];
      const points = [];
      for (let d = end - (c.coin === 'DNODE' ? Math.floor(n / 2) : n - 1) * DAY; d <= end; d += DAY) points.push({ t: isoDay(d), v: Number((base * path(seed, d, 1.6)).toPrecision(6)) });
      return { coin: c.coin, points };
    });
    return { state: 'ok', note: '', listed, dropped: def.candidates.filter((c) => !TOKENS[c.coin]).map((c) => c.coin), sources: DEMO };
  }

  // Sixty months of invented power and gas prices, ending two months back, as the real
  // electricity figures do.
  async function energy(def) {
    const t = new Date(now());
    const months = [];
    for (let i = (def.years || 5) * 12 + 10; i >= 2; i--) months.push(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - i, 1));
    const season = (ms) => 1 + 0.06 * Math.cos((new Date(ms).getUTCMonth() - 6.5) / 12 * 2 * Math.PI);
    return {
      state: 'ok', note: '', variant: 'demo', sources: DEMO,
      electricity: { name: 'Demo average industrial electricity price', unit: 'cents per kWh', url: null, source: 'Demo data', points: months.map((m, i) => ({ t: isoDay(m), v: Number((7.4 * (1 + 0.0035 * i) * season(m) * path(31, m, 0.12)).toFixed(2)) })) },
      gas: { name: 'Demo natural gas hub price, monthly average', unit: 'USD per million Btu', url: null, source: 'Demo data', points: months.map((m) => ({ t: isoDay(m), v: Number((3.1 * path(32, m, 1.1)).toFixed(2)) })) }
    };
  }

  // Invented list prices, changing in steps as list prices do. One machine has no price,
  // to show how that is reported.
  const MACHINES = { g8: [98.32, 3], g1: [6.98, 2], g1o: [3.67, 2], gs: [0.526, 1], c8a: [0.384, 1] };
  async function prices(def) {
    const end = today(), n = 240;
    const items = def.basket.map((m) => {
      if (!MACHINES[m.id]) return { id: m.id, points: [], state: 'missing', note: 'Demo: no price is listed for this machine.' };
      const [base, cuts] = MACHINES[m.id];
      const seed = m.id.length * 7 + m.id.charCodeAt(1);
      // Each cut lands on its own day and takes a few percent off from then on.
      const steps = Array.from({ length: cuts }, (_, k) => ({ at: Math.floor(pick(seed, k, 20, n - 10)), by: pick(seed, 40 + k, 0.04, 0.14) }));
      const points = [];
      for (let i = 0; i < n; i++) {
        // Before a cut the price was higher; the latest price is the base.
        const v = steps.filter((x) => i < x.at).reduce((f, x) => f / (1 - x.by), base);
        points.push({ t: isoDay(end - (n - 1 - i) * DAY), v: Number(v.toPrecision(5)) });
      }
      return { id: m.id, points, state: 'ok', note: '' };
    });
    return { state: 'ok', note: '', items, started: isoDay(end - (n - 1) * DAY), lastRun: now(), lastOk: now(), sources: DEMO };
  }

  // Four dated tables of invented model prices from invented providers.
  async function snapshots() {
    const t = today();
    const table = (daysAgo, rows) => ({ asOf: isoDay(t - daysAgo * DAY), note: 'Demo: invented providers, models and prices.', rows: rows.map(([provider, model, input, output]) => ({ provider, model, input, output, url: null })) });
    return [
      table(420, [['Demo Lab A', 'atlas-large', 12, 60], ['Demo Lab A', 'atlas-small', 0.8, 4], ['Demo Lab B', 'beacon-pro', 10, 50], ['Demo Lab B', 'beacon-lite', 0.5, 2.5], ['Demo Lab C', 'cirrus-max', 9, 36]]),
      table(270, [['Demo Lab A', 'atlas-large', 10, 50], ['Demo Lab A', 'atlas-small', 0.6, 3], ['Demo Lab B', 'beacon-pro', 10, 50], ['Demo Lab B', 'beacon-lite', 0.5, 2.5], ['Demo Lab C', 'cirrus-max', 8, 32], ['Demo Lab C', 'cirrus-mini', 0.3, 1.2]]),
      table(120, [['Demo Lab A', 'atlas-large', 8, 40], ['Demo Lab A', 'atlas-small', 0.4, 2], ['Demo Lab B', 'beacon-pro', 8, 40], ['Demo Lab B', 'beacon-lite', 0.25, 1.25], ['Demo Lab C', 'cirrus-max', 8, 32], ['Demo Lab C', 'cirrus-mini', 0.2, 0.8]]),
      table(14, [['Demo Lab A', 'atlas-large', 8, 40], ['Demo Lab A', 'atlas-small', 0.2, 1], ['Demo Lab B', 'beacon-pro', 6, 30], ['Demo Lab B', 'beacon-lite', 0.25, 1.25], ['Demo Lab C', 'cirrus-max', 6, 24], ['Demo Lab C', 'cirrus-mini', 0.2, 0.8]])
    ];
  }

  return { crypto, energy, prices, snapshots, health: () => [{ name: 'Indexes demo data', state: 'ok', note: NOTE, lastOk: now(), lastError: null }] };
}
