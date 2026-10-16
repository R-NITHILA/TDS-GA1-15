
import express from "express";
import fs from "node:fs";

const app = express();
app.use(express.json({ limit: "1mb" }));

const rawOrders = fs.readFileSync(
  new URL("./orders.jsonl", import.meta.url),
  "utf8"
).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));

// Keep the latest version of each order.
const latest = new Map();

for (const row of rawOrders) {
  const previous = latest.get(row.id);

  if (
    !previous ||
    Date.parse(row.updated_at) > Date.parse(previous.updated_at)
  ) {
    latest.set(row.id, row);
  }
}

const orders = [...latest.values()];

const RATES_URL = process.env.RATES_URL || "";
const RATES_PATH = new URL("./rates.json", import.meta.url);
let ratesData = null;

async function loadRates() {
  if (ratesData) return ratesData;

  try {
    ratesData = JSON.parse(fs.readFileSync(RATES_PATH, "utf8"));
    return ratesData;
  } catch {}

  if (process.env.RATES_JSON) {
    try {
      ratesData = JSON.parse(process.env.RATES_JSON);
      return ratesData;
    } catch {}
  }

  if (process.env.RATES_FILE && fs.existsSync(process.env.RATES_FILE)) {
    try {
      ratesData = JSON.parse(
        fs.readFileSync(process.env.RATES_FILE, "utf8")
      );
      return ratesData;
    } catch {}
  }

  if (RATES_URL) {
    try {
      const response = await fetch(RATES_URL, {
        signal: AbortSignal.timeout(5000)
      });

      if (response.ok) {
        ratesData = await response.json();
        return ratesData;
      }
    } catch (error) {
      console.error("Could not load rates:", error.message);
    }
  }

  return null;
}

// Rates use USD value per unit of currency.
function getRate(data, from, to) {
  if (from === to) return 1;
  if (!data) return null;

  if (data.usd_per_unit) {
    const fromRate = Number(data.usd_per_unit[from]);
    const toRate = Number(data.usd_per_unit[to]);

    if (
      Number.isFinite(fromRate) && fromRate > 0 &&
      Number.isFinite(toRate) && toRate > 0
    ) {
      return fromRate / toRate;
    }
  }

  const containers = [
    data,
    data.rates,
    data.exchangeRates,
    data.conversionRates
  ].filter(Boolean);

  for (const container of containers) {
    if (Array.isArray(container)) {
      for (const item of container) {
        const fromCurrency =
          item.from || item.base || item.source || item.currency;
        const toCurrency =
          item.to || item.quote || item.target || item.targetCurrency;
        const rate = Number(
          item.rate ?? item.exchange_rate ?? item.value
        );

        if (fromCurrency === from && toCurrency === to &&
            Number.isFinite(rate) && rate > 0) {
          return rate;
        }

        if (fromCurrency === to && toCurrency === from &&
            Number.isFinite(rate) && rate > 0) {
          return 1 / rate;
        }
      }
    } else if (typeof container === "object") {
      const direct = Number(
        container?.[from]?.[to] ??
        container?.[from]?.[to.toLowerCase()]
      );

      if (Number.isFinite(direct) && direct > 0) return direct;

      const base =
        container.base ||
        container.baseCurrency ||
        data.base ||
        data.baseCurrency;

      const values = container.rates || container;

      if (base === from && Number(values[to]) > 0) {
        return Number(values[to]);
      }

      if (base === to && Number(values[from]) > 0) {
        return 1 / Number(values[from]);
      }

      if (from === "USD" && Number(values[to]) > 0) {
        return Number(values[to]);
      }

      if (to === "USD" && Number(values[from]) > 0) {
        return 1 / Number(values[from]);
      }
    }
  }

  return null;
}

function businessDate(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

function moneyRound(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function monthRange(question) {
  const match = question.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d{2})\b/i
  );

  if (!match) return null;

  const months = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december"
  ];

  const month = months.indexOf(match[1].toLowerCase()) + 1;
  const year = Number(match[2]);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;

  return [
    `${year}-${String(month).padStart(2, "0")}-01`,
    `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`
  ];
}

function dateFilter(question) {
  const range = monthRange(question);

  if (range) {
    return date => date >= range[0] && date < range[1];
  }

  const between = question.match(
    /\bfrom\s+(\d{4}-\d{2}-\d{2})\s+(?:to|through|until)\s+(\d{4}-\d{2}-\d{2})\b/i
  );

  if (between) {
    return date => date >= between[1] && date <= between[2];
  }

  const exactDate = question.match(/\b(20\d{2}-\d{2}-\d{2})\b/);

  if (exactDate) {
    return date => date === exactDate[1];
  }

  const year = question.match(/\b(20\d{2})\b/);

  if (year) {
    return date => date.startsWith(year[1]);
  }

  return null;
}

function extractCurrency(question) {
  if (/\b(usd|us dollars?|dollars?)\b/i.test(question)) return "USD";
  if (/\b(eur|euros?)\b/i.test(question)) return "EUR";
  if (/\b(inr|rupees?)\b|₹/i.test(question)) return "INR";
  return null;
}

function extractFilter(question, values) {
  for (const value of values) {
    if (value == null) continue;

    const escaped = String(value).replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

    if (new RegExp(`\\b${escaped}\\b`, "i").test(question)) {
      return value;
    }
  }

  return null;
}

const regions = [...new Set(orders.map(order => order.region).filter(Boolean))];
const products = [...new Set(orders.map(order => order.product).filter(Boolean))];
const customers = [...new Set(orders.map(order => order.customer).filter(Boolean))];

function detectMetric(question) {
  // Explicit counting questions must not become revenue sums.
  if (
    /\b(count|number of|how many orders|orders were|order count)\b/i.test(question)
  ) {
    return "count";
  }

  if (/\b(quantity|units|items sold|how many items|how many units)\b/i.test(question)) {
    return "quantity";
  }

  if (/\b(refund|refunded|refunds)\b/i.test(question)) {
    return "refunded";
  }

  if (/\b(void|voided|cancelled|canceled)\b/i.test(question)) {
    return "void";
  }

  return "revenue";
}

function isTopQuestion(question) {
  return /\b(top|most|highest|best-selling|best selling|largest|which product|which customer|rank)\b/i.test(question);
}

function getGroupField(question) {
  if (/\bcustomer(?:s)?\b/i.test(question)) return "customer";
  if (/\bregion\b/i.test(question)) return "region";
  return "product";
}

function isDistinctCustomerQuestion(question) {
  return (
    /\b(distinct|unique|different)\s+customers?\b/i.test(question) ||
    /\bhow many customers\b/i.test(question)
  );
}

async function answerQuestion(question) {
  const q = String(question || "").trim();

  if (!q) throw new Error("question is required");

  const region = extractFilter(q, regions);
  const product = extractFilter(q, products);
  const customer = extractFilter(q, customers);

  const status = /\b(refund|refunded|refunds)\b/i.test(q)
    ? "refunded"
    : /\b(void|voided|cancelled|canceled)\b/i.test(q)
      ? "void"
      : /\bpaid\b/i.test(q)
        ? "paid"
        : null;

  const targetCurrency = extractCurrency(q) || "USD";
  const filterDate = dateFilter(q);
  const timeField =
    /\b(updated|last updated|update date)\b/i.test(q)
      ? "updated_at"
      : "created_at";

  let rows = orders.filter(order => {
    if (region && String(order.region).toLowerCase() !== String(region).toLowerCase()) {
      return false;
    }

    if (product && String(order.product).toLowerCase() !== String(product).toLowerCase()) {
      return false;
    }

    if (customer && String(order.customer).toLowerCase() !== String(customer).toLowerCase()) {
      return false;
    }

    if (status && order.status !== status) return false;

    if (
      filterDate &&
      (!order[timeField] || !filterDate(businessDate(order[timeField])))
    ) {
      return false;
    }

    return true;
  });

  // Ranking questions: aggregate the requested metric by product/customer/region.
  if (
    isTopQuestion(q) &&
    /\b(product|customer|region)\b/i.test(q)
  ) {
    const groupField = getGroupField(q);
    const metric = detectMetric(q);
    const groups = new Map();

    if (metric === "revenue" || metric === "refunded") {
      const rates = await loadRates();

      // Revenue means paid-order revenue; refunded means refunded amount.
      const wantedStatus = metric === "refunded" ? "refunded" : "paid";

      for (const order of rows) {
        if (order.status !== wantedStatus) continue;

        const amount = Number(order.amount);
        if (!Number.isFinite(amount)) continue;

        const rate = getRate(rates, order.currency, targetCurrency);

        if (rate == null) {
          throw new Error(
            `Exchange rate ${order.currency} to ${targetCurrency} is unavailable. Configure rates.json, RATES_JSON, or RATES_URL.`
          );
        }

        const key = order[groupField];
        groups.set(key, (groups.get(key) || 0) + amount * rate);
      }
    } else {
      for (const order of rows) {
        const key = order[groupField];
        const value = metric === "quantity"
          ? Number(order.qty || 0)
          : 1;

        groups.set(key, (groups.get(key) || 0) + value);
      }
    }

    const sorted = [...groups].sort(
      (a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))
    );

    const topN = Math.min(
      20,
      Number(q.match(/\btop\s+(\d+)\b/i)?.[1] || 1)
    );

    return sorted.slice(0, topN).map(([name, value]) => ({
      [groupField]: name,
      value: metric === "count" || metric === "quantity"
        ? value
        : moneyRound(value)
    }));
  }

  if (
    /\b(list|show|which|what are)\b/i.test(q) &&
    /\border ids?\b/i.test(q)
  ) {
    return rows.map(order => order.id);
  }

  if (isDistinctCustomerQuestion(q)) {
    return new Set(rows.map(order => order.customer)).size;
  }

  if (/\baverage|avg\b/i.test(q)) {
    if (!rows.length) return 0;

    const relevant = status
      ? rows
      : rows.filter(order => order.status === "paid");

    if (!relevant.length) return 0;

    return moneyRound(
      relevant.reduce((sum, order) => sum + Number(order.amount || 0), 0) /
      relevant.length
    );
  }

  const metric = detectMetric(q);

  if (metric === "count") return rows.length;

  if (metric === "quantity") {
    return rows.reduce((sum, order) => sum + Number(order.qty || 0), 0);
  }

  const wantedStatus = metric === "refunded"
    ? "refunded"
    : metric === "void"
      ? "void"
      : "paid";

  const relevant = rows.filter(order => order.status === wantedStatus);
  const rates = await loadRates();

  let total = 0;

  for (const order of relevant) {
    const amount = Number(order.amount);

    if (!Number.isFinite(amount)) continue;

    const rate = getRate(rates, order.currency, targetCurrency);

    if (rate == null) {
      throw new Error(
        `Exchange rate ${order.currency} to ${targetCurrency} is unavailable. Configure rates.json, RATES_JSON, or RATES_URL.`
      );
    }

    total += amount * rate;
  }

  return moneyRound(total);
}

app.get("/", (_req, res) => {
  res.json({
    service: "Acme Appliances order ledger agent",
    status: "ok",
    orderRows: rawOrders.length,
    currentOrders: orders.length,
    endpoint: "POST /",
    body: {
      question: "In April 2026, what was the top-selling product by revenue (in USD)?"
    }
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", orders: orders.length });
});

async function handleQuestion(req, res) {
  try {
    if (!req.body || typeof req.body.question !== "string") {
      return res.status(400).json({
        error: "Expected JSON body with a string question"
      });
    }

    const answer = await answerQuestion(req.body.question);
    return res.json({ answer });
  } catch (error) {
    console.error(error);
    return res.status(422).json({ error: error.message });
  }
}

app.post("/", handleQuestion);
app.post("/ask", handleQuestion);

const port = Number(process.env.PORT || 3000);

app.listen(port, "0.0.0.0", () => {
  console.log(
    `Ledger agent listening on ${port}; current orders: ${orders.length}`
  );
});
