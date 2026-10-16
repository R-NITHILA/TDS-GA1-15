import express from "express";
import fs from "node:fs";
import crypto from "node:crypto";

const app = express();
app.use(express.json({ limit: "1mb" }));

const rawOrders = fs.readFileSync(new URL("./orders.jsonl", import.meta.url), "utf8")
  .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));

// Latest updated_at row is authoritative for each order ID.
const latest = new Map();
for (const row of rawOrders) {
  const prev = latest.get(row.id);
  if (!prev || Date.parse(row.updated_at) > Date.parse(prev.updated_at)) latest.set(row.id, row);
}
const orders = [...latest.values()];

const DEFAULT_RATES_URL = process.env.RATES_URL || "";
const LOCAL_RATES_PATH = new URL("./rates.json", import.meta.url);
let ratesData = null;
async function loadRates() {
  if (ratesData) return ratesData;
  try { ratesData = JSON.parse(fs.readFileSync(LOCAL_RATES_PATH, "utf8")); return ratesData; } catch {}
  if (process.env.RATES_JSON) {
    try { ratesData = JSON.parse(process.env.RATES_JSON); return ratesData; } catch {}
  }
  if (process.env.RATES_FILE && fs.existsSync(process.env.RATES_FILE)) {
    try { ratesData = JSON.parse(fs.readFileSync(process.env.RATES_FILE, "utf8")); return ratesData; } catch {}
  }
  if (DEFAULT_RATES_URL) {
    try {
      const r = await fetch(DEFAULT_RATES_URL, { signal: AbortSignal.timeout(3500) });
      if (r.ok) ratesData = await r.json();
    } catch (e) { console.error("Could not load exchange rates:", e.message); }
  }
  return ratesData;
}
function getRate(data, from, to) {
  if (from === to) return 1;
  if (!data) return null;
  // This API defines the USD value of one unit of each currency.
  // Convert from -> USD -> target using usd_per_unit[from] / usd_per_unit[to].
  if (data.usd_per_unit && Number.isFinite(Number(data.usd_per_unit[from])) && Number(data.usd_per_unit[from]) > 0
      && Number.isFinite(Number(data.usd_per_unit[to])) && Number(data.usd_per_unit[to]) > 0) {
    return Number(data.usd_per_unit[from]) / Number(data.usd_per_unit[to]);
  }
  // Accept common shapes: {rates:{EUR:0.9}}, {USD:{EUR:...}},
  // or {rates:[{from,to,rate}]} / [{base,quote,rate}].
  const containers = [data, data.rates, data.exchangeRates, data.conversionRates].filter(Boolean);
  for (const c of containers) {
    if (Array.isArray(c)) {
      for (const r of c) {
        const f = r.from || r.base || r.source || r.currency;
        const t = r.to || r.quote || r.target || r.targetCurrency;
        const v = Number(r.rate ?? r.exchange_rate ?? r.value);
        if (f === from && t === to && Number.isFinite(v)) return v;
        if (f === to && t === from && Number.isFinite(v) && v !== 0) return 1 / v;
      }
    } else if (typeof c === "object") {
      const direct = Number(c?.[from]?.[to] ?? c?.[from]?.[to.toLowerCase()]);
      if (Number.isFinite(direct) && direct > 0) return direct;
      const base = c.base || c.baseCurrency || data.base || data.baseCurrency;
      const values = c.rates || c;
      if (base === from && Number.isFinite(Number(values[to]))) return Number(values[to]);
      if (base === to && Number.isFinite(Number(values[from])) && Number(values[from]) !== 0) return 1 / Number(values[from]);
      if (from === "USD" && Number.isFinite(Number(values[to]))) return Number(values[to]);
      if (to === "USD" && Number.isFinite(Number(values[from])) && Number(values[from]) !== 0) return 1 / Number(values[from]);
    }
  }
  return null;
}
function businessDate(iso) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(iso));
}
function moneyRound(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function monthRange(q) {
  const m = q.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d{2})\b/i);
  if (!m) return null;
  const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  const i = months.indexOf(m[1].toLowerCase()) + 1, y = Number(m[2]);
  return [`${y}-${String(i).padStart(2,"0")}-01`, `${i === 12 ? y+1 : y}-${String(i === 12 ? 1 : i+1).padStart(2,"0")}-01`];
}
function dateFilter(q) {
  const mr = monthRange(q);
  if (mr) return d => d >= mr[0] && d < mr[1];
  const between = q.match(/\bfrom\s+(\d{4}-\d{2}-\d{2})\s+(?:to|through|until)\s+(\d{4}-\d{2}-\d{2})\b/i);
  if (between) return d => d >= between[1] && d <= between[2];
  const iso = q.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) return d => d === iso[1];
  const year = q.match(/\b(20\d{2})\b/);
  if (year) return d => d.startsWith(year[1]);
  return null;
}
function extractCurrency(q) {
  if (/\b(usd|dollars?|US dollars?)\b/i.test(q)) return "USD";
  if (/\b(eur|euros?)\b/i.test(q)) return "EUR";
  if (/\b(inr|rupees?|₹)\b/i.test(q)) return "INR";
  return null;
}
function extractFilter(q, field, values) {
  for (const value of values) {
    const re = new RegExp(`\\b${String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(q)) return value;
  }
  return null;
}
const regions = [...new Set(orders.map(o=>o.region))];
const products = [...new Set(orders.map(o=>o.product))];
const customers = [...new Set(orders.map(o=>o.customer))];



function detectMetric(q) {
  // Count orders before checking refund amounts.
  if (/\b(count|number of|how many orders|orders were|order count)\b/i.test(q)) {
    return "count";
  }
  if (/\b(refund|refunded|refunds)\b/i.test(q)) return "refunded";
  if (/\b(void|voided|cancelled|canceled)\b/i.test(q)) return "void";
  if (/\b(quantity|units|items sold|how many (?:units|items))\b/i.test(q)) {
    return "quantity";
  }
  return "revenue";
}

async function answerQuestion(question) {
  const q = String(question || "").trim();
  if (!q) throw new Error("question is required");
  const region = extractFilter(q, "region", regions);
  const product = extractFilter(q, "product", products);
  const customer = extractFilter(q, "customer", customers);
  const status = /\b(refund|refunded|refunds)\b/i.test(q) ? "refunded"
    : /\bvoid|voided|cancelled|canceled\b/i.test(q) ? "void"
    : /\bpaid\b/i.test(q) ? "paid" : null;
  const targetCurrency = extractCurrency(q) || "USD";
  const dateFn = dateFilter(q);
  const timeField = /\b(updated|last updated|update date)\b/i.test(q) ? "updated_at" : "created_at";
  let rows = orders.filter(o => {
    if (region && o.region.toLowerCase() !== region.toLowerCase()) return false;
    if (product && o.product.toLowerCase() !== product.toLowerCase()) return false;
    if (customer && o.customer.toLowerCase() !== customer.toLowerCase()) return false;
    if (status && o.status !== status) return false;
    if (dateFn && !dateFn(businessDate(o[timeField]))) return false;
    return true;
  });

  if (/\b(top|most|highest|best-selling|best selling|largest|which product|which customer|rank)\b/i.test(q)
      && /\b(product|customer|region)\b/i.test(q)) {
    const groupField = /\bcustomer\b/i.test(q) ? "customer" : /\bregion\b/i.test(q) ? "region" : "product";
    const metric = detectMetric(q);
    const groups = new Map();
    for (const o of rows) {
      const key = o[groupField];
      const val = metric === "quantity" ? o.qty : metric === "count" ? 1 : metric === "refunded" ? (o.status === "refunded" ? o.amount : 0) : (o.status === "paid" ? o.amount : 0);
      groups.set(key, (groups.get(key) || 0) + val);
    }
    const sorted = [...groups].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0]));
    const topN = Number(q.match(/\btop\s+(\d+)\b/i)?.[1] || 1);
    return sorted.slice(0, Math.min(topN, 20)).map(([name,value])=>({[groupField]:name,value:moneyRound(value)}));
  }

  if (/\b(list|show|which|what are)\b/i.test(q) && /\border ids?\b/i.test(q)) return rows.map(o=>o.id);
  if (/\baverage|avg\b/i.test(q)) {
    if (!rows.length) return 0;
    return moneyRound(rows.reduce((s,o)=>s+o.amount,0)/rows.length);
  }
  // Distinct-customer questions count unique customer IDs after all filters.
  // This must run before the generic count metric (which counts orders).
  if (/\b(distinct|unique|different)\s+customers?\b/i.test(q)
      || /\bhow many customers\b/i.test(q)) {
    return new Set(rows.map(o => o.customer)).size;
  }

  const metric = detectMetric(q);
  if (metric === "count") return rows.length;
  if (metric === "quantity") return rows.reduce((s,o)=>s+o.qty,0);

  // Revenue includes only paid orders. Refund questions sum refunded order amounts.
  const relevant = metric === "refunded" ? rows.filter(o=>o.status==="refunded")
    : metric === "void" ? rows.filter(o=>o.status==="void")
    : rows.filter(o=>o.status==="paid");

  const rates = await loadRates();
  let total = 0;
  for (const o of relevant) {
    const rate = getRate(rates, o.currency, targetCurrency);
    if (rate == null) {
      if (o.currency !== targetCurrency) {
        throw new Error(`Exchange rate ${o.currency} to ${targetCurrency} is unavailable. Configure RATES_URL or RATES_JSON.`);
      }
      total += o.amount;
    } else total += o.amount * rate;
  }
  return moneyRound(total);
}

app.get("/", (_req,res)=>res.json({
  service:"Acme Appliances order ledger agent",
  status:"ok",
  orderRows:rawOrders.length,
  currentOrders:orders.length,
  endpoint:"POST /",
  body:{question:"What was the total revenue in USD from the North region in March 2026?"}
}));
app.get("/health", (_req,res)=>res.json({status:"ok", orders:orders.length}));
app.post("/", async (req,res)=> {
  try {
    if (!req.body || typeof req.body.question !== "string") return res.status(400).json({error:"Expected JSON body with a string question"});
    const answer = await answerQuestion(req.body.question);
    res.json({answer});
  } catch (e) {
    console.error(e);
    res.status(422).json({error:e.message});
  }
});
app.post("/ask", async (req,res)=> {
  try {
    if (!req.body || typeof req.body.question !== "string") return res.status(400).json({error:"Expected JSON body with a string question"});
    res.json({answer: await answerQuestion(req.body.question)});
  } catch (e) { res.status(422).json({error:e.message}); }
});
const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", ()=>console.log(`Ledger agent listening on ${port}; current orders: ${orders.length}`));
