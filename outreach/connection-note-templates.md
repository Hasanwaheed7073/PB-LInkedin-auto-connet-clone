# Connection note templates — reverse recruiting to active job seekers

For pasting into **Dashboard → Templates**. Placeholders are the ones the app supports:
`{{firstName}}`, `{{lastName}}`, `{{company}}`, `{{jobTitle}}`.

Two constraints from your own data and settings, so nothing gets skipped at send time:

- **`{{company}}` is empty for every lead in this batch.** A lead whose values cannot fill a
  template is skipped rather than sent a note with a gap in it, so a template using `{{company}}`
  would silently drop the entire list. Do not use it.
- **`{{jobTitle}}` holds a role *category*** ("AI & Data", "Cybersecurity & IT"), not a job title.
  It reads naturally as "in AI & Data" and badly as "as a AI & Data". Templates below are written
  accordingly.
- `MAX_CONNECTION_NOTE_CHARS` is set to 280 in your environment. All three fit.

---

## The principle these are built on

Do not pitch in a connection request. The note has one job: get accepted. A request that reads as
a sales approach gets ignored, and on a list of people already fielding recruiter spam it gets
ignored harder.

Say something true, specific to their situation, and ask for nothing. The conversation happens
after they accept.

Also: these people are having a bad month. Write like someone who has noticed that.

---

## A — No-ask (recommended default)

```
Hi {{firstName}} — saw you're in the middle of a search right now. I spend most of my time around
people running senior searches in {{jobTitle}}, so I mostly wanted to connect and follow along.
No pitch. Happy to pass on anything useful I come across.
```

**Why it works:** names their situation, states the reason for connecting, explicitly removes the
sales threat. "No pitch" is doing real work — it is the objection they already have.

## B — Specific-observation

```
Hi {{firstName}} — you came up while I was looking at people searching in {{jobTitle}}. The market
there is brutal right now and I know how little of that is about the candidate. Connecting in case
it's useful to have someone in your corner who watches these roles.
```

**Why it works:** "how little of that is about the candidate" is the sentence that lands with
someone 200 applications in. It is also true, which is why it can be said plainly.

## C — Shortest

```
Hi {{firstName}} — noticed you're searching. I work with people running searches in {{jobTitle}}.
Connecting in case it's helpful down the line.
```

**Why it works:** low information, low threat, high accept rate. Use as the control in an A/B —
if the longer notes do not beat this, they are not earning their length.

---

## Running the test properly

Create all three as separate templates and split the batch across them — roughly 20 leads each
from the ranked list, taking every third lead so the score distribution is even across variants.
Otherwise you are testing the message against lead quality, not against the other messages.

At 20 sends per variant you will see accept rates but nothing statistically solid. That is fine;
you are looking for a variant that is obviously worse, not for a p-value.

---

## After they accept — send by hand

The worker sends connection requests only. `MESSAGE` exists in the queue schema but is deliberately
not implemented, and the worker fails such a job explicitly rather than pretending to run it. So
follow-ups are yours to send, which is the right way round for the first hundred anyway — you learn
more from twenty real conversations than from any automation.

**Wait 2–3 days after they accept.** Messaging the same hour reveals the request as a funnel step.

```
Thanks for connecting, {{firstName}}.

Genuine question, not a lead-in to anything: how's the search actually going? I ask because most
people I talk to in {{jobTitle}} are getting nowhere with applications and it takes them a few
months to work out it isn't them — it's that the process is broken at the employer end.

If you want a second pair of eyes on how you're going about it, happy to look. And if you just
want to vent about it, that's fine too.
```

Then **stop and listen.** The pitch, if there is one, comes after they have told you what is
actually going wrong. If they say "applications go nowhere", that is your opening, and you have
their own words to use.

---

## What not to say

- No guarantees about outcomes, timelines, or salary. Do not promise placement.
- No invented statistics. If you cite a number, it should be one you can show.
- No "I help people land 6-figure roles in 30 days." They have read a hundred of those this month
  and it is the exact reason they will not answer.
- Nothing that implies you know their employment status as fact — you know what a public post said.
