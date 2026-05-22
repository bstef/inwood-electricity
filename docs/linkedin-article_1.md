# Your Data Is Already There. You're Just Not Looking at It.

Most businesses are sitting on a goldmine of operational data they never use. Not because it's hard to access — but because nobody has taken the time to connect the dots.

I had the same problem at home.

My electric utility sends me a notification email every time my daily power usage exceeds a threshold. I had over 200 of these emails sitting in my inbox. Useful data, completely inaccessible. I knew my summer electricity bills were high, but I had no idea *how* high, which days were the worst, or whether things were trending in the right direction.

So I built a tool to fix it. And in doing so, I was reminded of a pattern I see constantly in my infrastructure consulting work.

---

## What I Built — and Why It Matters Beyond My Electricity Bill

I built **Inwood Electricity** — a live, self-updating dashboard that automatically pulls data from those utility notification emails, parses the readings, and renders a full visualization: bar charts, monthly summaries, trend lines, and a searchable data table.

The whole thing runs on **Cloudflare Pages** with no backend server, no database, and no scheduled jobs. It costs nothing to run. When someone opens the dashboard, it checks a cache — if the data is fresh it serves it instantly, if not it pulls the latest from Gmail and refreshes. Every new email that arrives gets picked up automatically on the next load.

Here's what I learned after looking at a year's worth of data in one view for the first time:

- My peak single-day usage was **59.11 kWh** — nearly 4x my threshold — on July 6, 2025
- The entire last two weeks of June through July were consistently above 40 kWh daily
- Winter months barely crossed the 15 kWh threshold, often by less than a kilowatt
- Two months hit my 400 kWh monthly cap: August and December 2025

None of this was surprising in hindsight. But I had never *seen* it before. Once you can see it, you can act on it — adjust thermostat schedules, identify anomalies, plan ahead for high-cost months.

---

## The Business Pattern This Represents

Here's what's interesting from a consulting perspective: this exact pattern shows up in almost every business I work with.

Operational data exists. It's being generated constantly — in emails, in notification systems, in logs, in alerts. But it lives in silos. It's not visualized. Nobody has built the bridge between "data being generated" and "insight being consumed."

The gap isn't a data problem. It's an infrastructure and tooling problem.

Consider how many businesses receive automated notifications that nobody aggregates:

- **E-commerce**: order volume alerts, inventory threshold notifications, shipping exception emails
- **SaaS companies**: usage spike alerts, error rate notifications, billing threshold warnings
- **Field service operations**: maintenance alerts, equipment threshold notifications, dispatch confirmations
- **Facilities management**: energy consumption alerts, HVAC threshold notifications, utility overages

In every one of these cases, someone is receiving the emails. The data is right there in the subject line or body. But nobody has built the layer that aggregates it, stores it, and makes it visible over time.

The result? Decisions get made based on memory and instinct rather than trend data. Anomalies get missed. Patterns that would be obvious on a chart stay invisible in an inbox.

---

## What Modern Infrastructure Makes Possible

What's changed in the last few years is how cheap and fast it is to build this kind of tooling.

The Inwood Electricity dashboard uses:

- **Gmail API** — to read and parse the notification emails
- **Cloudflare Pages Functions** — serverless compute that runs the parsing logic on demand
- **Cloudflare KV** — a globally distributed key-value store for caching the results
- **A single static HTML file** — the entire frontend, no framework required

Total infrastructure cost: **$0/month**. Total build time from idea to deployed dashboard: a few hours.

This is what the serverless edge computing model enables. You don't need a server, a database, a DevOps team, or a SaaS subscription to build useful operational dashboards. You need the right architecture, the right APIs, and someone who knows how to connect them.

Five years ago, this project would have required provisioning a server, setting up a database, writing a backend API, deploying and maintaining all of it. Today it's a few hundred lines of JavaScript and a GitHub repo.

---

## The Broader Principle: Notifications Are Structured Data in Disguise

The thing that made this project work was a simple insight: notification emails follow a consistent format. Every PSE&G alert has the date and the kWh value in the same place, in the same format, every time.

That consistency is what makes parsing tractable. Two regular expressions are all it takes to extract a date and a number from 200 emails:

```
"Actual use for this period was 21.81 kWh at 05-20-26 12:00 A."
```

Pull the number before "kWh." Pull the date after "at." Done. You now have structured data from an unstructured source.

Most business notification systems follow the same pattern. Order confirmation emails. Inventory alerts. System health notifications. They're written by humans for humans, but they're generated by machines — which means they're consistent enough to parse programmatically.

The question worth asking about your own operations: **what notifications are you receiving that contain data you're not using?**

---

## What This Looks Like as a Client Engagement

When I take on infrastructure and tooling projects through Peacock Engineering, this is often where the most immediate value is found — not in building net-new systems, but in unlocking data that's already flowing through systems a client already has.

The engagement pattern typically looks like this:

**Discovery** — Audit what automated notifications and alerts the business is already receiving. Map them to the decisions those notifications are supposed to inform. Identify gaps between data being generated and insight being consumed.

**Architecture** — Design a lightweight data pipeline that reads from existing sources (email, webhooks, APIs, log streams) and aggregates into a queryable form. The goal is always the minimum viable infrastructure — no unnecessary complexity, no over-engineered solutions.

**Build and deploy** — Implement the pipeline and a visualization layer. In most cases this means serverless functions, a lightweight cache or database, and a dashboard that can be maintained without ongoing DevOps overhead.

**Hand-off** — Document the system thoroughly and train the team on how to extend it. The goal is never dependency — it's capability transfer.

The result is usually a dashboard or reporting tool that surfaces data the client's team already knew existed but had never been able to see in aggregate. The insights are rarely surprising. But seeing them clearly, consistently, in one place — that changes how decisions get made.

---

## The Takeaway

The infrastructure needed to turn operational noise into operational intelligence has never been more accessible. The gap between "we get a lot of notifications" and "we have visibility into our operations" is smaller than most organizations realize.

The question isn't whether the data exists. It almost always does.

The question is whether anyone has taken the time to build the bridge.

---

*Bobby Stef is a Senior Infrastructure & Systems Engineer with 19+ years of experience in networking, cloud infrastructure, and systems administration. He runs Peacock Engineering, an infrastructure and engineering consultancy based in New Jersey. The Inwood Electricity project is open source at github.com/bstef/inwood-electricity.*
