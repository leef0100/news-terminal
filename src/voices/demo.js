// Demo reading list. Every writer, publication, handle and title here is invented: none
// is a real person, a real publication or anything anyone wrote. Items carry no links,
// because there is nothing real to link to, and handles are placeholders that the page
// shows as text and never links to X.
const H = 3600000;

export const DEMO_GROUPS = [
  { id: 'macro', name: 'Macro' },
  { id: 'equities-ai', name: 'Equities and AI infrastructure' },
  { id: 'crypto', name: 'Crypto' },
  { id: 'desks', name: 'Research desks and newsletters' }
];

const V = (id, name, publication, group, covers, x, titles) => ({ id, name, publication, group, covers, x, titles });
export const DEMO_VOICES = [
  V('demo-brenk', 'Odalys Brenk', 'The Tidewater Ledger', 'macro', 'Rates, liquidity and central banks', 'hftdemo_tide', [
    ['What the reserve drain is and is not telling us', 'A walk through three balance-sheet lines and why they moved together last month.'],
    ['Notes from a quiet auction week', ''],
    ['Term premium, explained with one chart', 'The measure everyone quotes, and the two assumptions inside it.'],
    ['A reader asks: does the curve still matter?', '']]),
  V('demo-varga', 'Ilse Varga', 'Second Derivative', 'macro', 'Growth, inflation and labour data', 'hftdemo_second', [
    ['Payrolls preview: the revisions are the story', 'Why the first print has been the least useful number three months running.'],
    ['Shelter is slowing, slowly', ''],
    ['Five charts on real incomes', '']]),
  V('demo-okonjo', 'Tobias Okonjo-Reyes', 'Carry and Roll', 'macro', 'Currencies and cross-border flows', null, [
    ['Who is hedging, and who has stopped', 'Survey data and forward points disagree; here is how I read the gap.'],
    ['The yen question, again', ''],
    ['Reserve managers and the long end', '']]),
  V('demo-halloran', 'Mirren Halloran', 'Rack Units', 'equities-ai', 'Data centers, power and AI compute supply', 'hftdemo_racks', [
    ['Counting megawatts: what the interconnection queues say', 'A tally of announced capacity against what utilities have actually signed.'],
    ['Liquid cooling is a supply chain, not a product', ''],
    ['Notes on a hyperscaler capex call', 'Three questions the analysts did not ask.'],
    ['How long does a GPU last on the books?', '']]),
  V('demo-prakash', 'Devika Prakash-Lund', 'Gross Margin', 'equities-ai', 'Semiconductor and software earnings', 'hftdemo_margin', [
    ['Reading the inventory line this quarter', ''],
    ['Backlog is not revenue: a primer', 'What the footnotes say about cancellation terms.'],
    ['Seat counts versus usage pricing', '']]),
  V('demo-achterberg', 'Corwin Achterberg', 'The Footnote Desk', 'equities-ai', 'Accounting and company filings', null, [
    ['Three disclosures worth a second look', ''],
    ['Useful life changes, in plain words', 'What happens to earnings when a depreciation schedule is stretched.'],
    ['Leased or owned: the data-center edition', '']]),
  V('demo-sato', 'Renko Sato-Whitlow', 'Mempool Notes', 'crypto', 'On-chain activity and market structure', 'hftdemo_mempool', [
    ['Stablecoin supply: where the new issuance went', 'Breaking the month down by chain and by venue.'],
    ['Funding flipped. So what?', ''],
    ['A slow week for fees', ''],
    ['What exchange balances can and cannot show', '']]),
  V('demo-idowu', 'Marguerite Idowu', 'Basis Points and Blocks', 'crypto', 'Derivatives, basis and liquidity', 'hftdemo_basis', [
    ['The basis trade in three numbers', ''],
    ['Options skew after the expiry', 'Positioning as the open-interest tables show it, strike by strike.'],
    ['Perpetuals are not futures: a refresher', '']]),
  V('demo-lindqvist', 'Aksel Lindqvist-Mora', 'Validator Weekly', 'crypto', 'Staking, protocols and governance', 'hftdemo_valid', [
    ['Governance digest: four votes to watch', ''],
    ['Staking yields, net of everything', 'Fees, slashing and downtime, with a worked example.'],
    ['An upgrade timeline, annotated', '']]),
  V('demo-northfold', 'Northfold Research', 'Northfold Morning Note', 'desks', 'Daily cross-asset summary', 'hftdemo_north', [
    ['Morning note: three things on the tape', ''],
    ['Chart of the day: breadth', 'The share of an invented index above its 200-day average.'],
    ['Week ahead: data and supply', ''],
    ['Morning note: earnings in brief', '']]),
  V('demo-quill', 'Quill Street Economics', 'The Quill Street Brief', 'desks', 'Economic research notes', 'hftdemo_quill', [
    ['Working paper summary: credit and small firms', 'What a new invented dataset suggests about lending standards.'],
    ['A note on seasonal adjustment', ''],
    ['How we build our demo nowcast', '']]),
  V('demo-esperanza', 'Esperanza Vólkov', 'Links and Ledgers', 'desks', 'Curated links to markets writing', null, [
    ['Saturday links: ten things worth your time', ''],
    ['Midweek reading list', ''],
    ['The best charts I saw this month', '']])
];
export const DEMO_SUGGESTED = ['demo-brenk', 'demo-varga', 'demo-halloran', 'demo-prakash', 'demo-sato', 'demo-idowu', 'demo-northfold', 'demo-quill'];

// The same list on every server and every request: item times step back from a fixed
// point in the current hour, so the page looks alive without anything being random.
export function demoView(now) {
  const base = Math.floor(now() / H) * H;
  const byId = new Map();
  DEMO_VOICES.forEach((v, vi) => {
    const items = v.titles.map(([title, excerpt], i) => ({
      id: v.id + '-' + i,
      title,
      url: null,
      ts: base - (vi * 0.7 + 0.4) * H - i * (19 + vi * 3) * H,
      excerpt
    }));
    byId.set(v.id, { state: 'ok', checkedAt: base, items });
  });
  return (v) => byId.get(v.id);
}
