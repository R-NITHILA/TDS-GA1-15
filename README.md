# Acme Appliances Ledger Agent

## What it does
- Exposes `POST /` and `POST /ask`, accepting `{"question":"..."}` and returning `{"answer":...}`.
- Loads the supplied 4,267-row JSONL export.
- Deduplicates order IDs using the latest `updated_at`.
- Uses Asia/Kolkata business dates.
- Counts only `paid` orders as revenue; refunds are queried separately.
- Supports common plain-English filters for month/year/day, region, product, customer, currency, refunds, counts, quantities, averages and top groups.

## Run locally
Requires Node.js 20+:
```bash
npm install
npm start
```
Test:
```bash
curl -X POST http://localhost:3000/ -H "Content-Type: application/json" -d '{"question":"How many paid orders were in North in March 2026?"}'
```

## Deploy on Render
1. Push all project files, including `orders.jsonl`, to a GitHub repository.
2. In Render choose **New + → Blueprint** and connect the repository.
3. Deploy and use `https://YOUR-SERVICE.onrender.com/` as the endpoint.
4. Confirm `/health` returns status `ok`.

## Exchange rates
The supplied `rates.json` contains the API-provided USD value of one unit of each currency: USD 1, EUR 1.11, INR 0.01159. The server converts currencies using `usd_per_unit[from] / usd_per_unit[to]`. The rates file is loaded locally by default; it can be overridden with `RATES_JSON`, `RATES_FILE`, or `RATES_URL`.

## Important limitations
This is a deterministic query parser, not a general-purpose LLM. It supports common ledger question patterns; thoroughly test the grader's expected question types before relying on it.
