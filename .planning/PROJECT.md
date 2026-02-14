# ActualIntesa

## What This Is

A Node.js CLI tool that automatically syncs bank transactions from Intesa San Paolo (Italy) into Actual Budget. It uses the GoCardless Bank Account Data API (formerly Nordigen) for Open Banking access and the @actual-app/api package to push transactions into Actual Budget. Built for personal use — one command to keep your budget up to date.

## Core Value

Transactions from Intesa San Paolo appear in Actual Budget accurately and without duplicates. If nothing else works, the sync must be reliable.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] First-run setup guides user through GoCardless authentication (secret_id, secret_key)
- [ ] Setup creates a bank connection (requisition) for Intesa San Paolo and opens auth link in browser
- [ ] User configures Actual Budget connection (server URL, password, budget ID) in .env
- [ ] On each run, fetch new transactions from GoCardless since last sync date
- [ ] Map GoCardless fields to Actual format: bookingDate → date, creditorName/debtorName → payee, transactionAmount.amount → amount (cents integer, sign-aware), remittanceInformationUnstructured → notes
- [ ] Import mapped transactions into the configured Actual Budget account via @actual-app/api
- [ ] Duplicate detection using GoCardless transactionId as imported_id in Actual
- [ ] Save last sync date to .env so next run only fetches new transactions
- [ ] --setup flag to re-run the bank connection flow
- [ ] --dry-run flag to preview transactions without importing
- [ ] Detect expired GoCardless requisition and print clear warning telling user to run --setup
- [ ] Single account configuration (one Intesa account → one Actual account)

### Out of Scope

- Multi-account sync — single account keeps it simple for v1
- Scheduled/cron execution — manual CLI runs only
- Email notifications on link expiry — clear terminal warning instead
- OAuth login alternatives — GoCardless handles bank auth via PSD2
- GUI or web interface — CLI only

## Context

- GoCardless Bank Account Data API is free for personal use. API portal: https://bankaccountdata.gocardless.com
- Intesa San Paolo institution_id: BCITITMM (or search for "Intesa")
- PSD2 bank links expire after ~90 days, requiring re-authentication
- Actual Budget runs as a local server (default http://localhost:5006) or remote
- @actual-app/api is the official Node.js client for Actual Budget

## Constraints

- **Tech stack**: Node.js with ES modules, node-fetch or axios, @actual-app/api, dotenv
- **Auth**: GoCardless requires secret_id + secret_key from their portal, then a requisition flow with browser redirect
- **Data format**: Actual Budget expects amounts in cents as integers
- **Storage**: Config and state stored in local .env file (no database)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| GoCardless over screen scraping | Open Banking/PSD2 compliant, free for personal use, reliable API | — Pending |
| Single account only | Simplicity for v1, covers primary use case | — Pending |
| .env for all config and state | No database needed, simple to inspect and edit | — Pending |
| CLI-only, no scheduling | Manual runs sufficient, avoids complexity | — Pending |

---
*Last updated: 2026-02-14 after initialization*
