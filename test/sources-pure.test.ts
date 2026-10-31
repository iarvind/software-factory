// The intake adapters' pure parts: text conversion, payload → request mapping, verdict
// parsing, the retrying fetch (against a stubbed fetch). No network, no database.
import { test } from "node:test";
import assert from "node:assert/strict";

// The adapters import db.ts, which exits without DATABASE_URL. Nothing here queries, so any URL does
// (pg connects lazily); hence the dynamic imports below.
process.env.DATABASE_URL ||= "postgres://unused@127.0.0.1:1/unused";
const util = await import("../server/lib/sources/util.ts");
const slack = await import("../server/lib/sources/slack.ts");
const jira = await import("../server/lib/sources/jira.ts");
const github = await import("../server/lib/sources/github.ts");
const linear = await import("../server/lib/sources/linear.ts");

test("isDecision takes bare verdicts only", () => {
  for (const t of ["approve", "Approve", " APPROVED. ", "lgtm", "LGTM!", "/approve", "**approve**", "ship it"]) assert.equal(util.isDecision(t), "approve", t);
  for (const t of ["reject", "Rejected", "/reject", "_decline_"]) assert.equal(util.isDecision(t), "reject", t);
  for (const t of ["approve this but rename the button", "I don't approve", "", "yes", "looks good to me, but"]) assert.equal(util.isDecision(t), null, t);
});

test("changesRequested finds 'changes: …'", () => {
  assert.equal(util.changesRequested("changes: rename the button"), "rename the button");
  assert.equal(util.changesRequested("**Changes:** use a dropdown\nand a label"), "use a dropdown\nand a label");
  assert.equal(util.changesRequested("request changes - tests are missing"), "tests are missing");
  assert.equal(util.changesRequested("these changes look fine"), null);
  assert.equal(util.changesRequested("changes:"), null);
});

test("toMrkdwn escapes and converts a little markdown, and leaves #123 alone", () => {
  assert.equal(util.toMrkdwn("a < b & <!channel>"), "a &lt; b &amp; &lt;!channel&gt;");
  assert.equal(util.toMrkdwn("**done**: see [the PR](https://github.com/o/r/pull/1)"), "*done*: see <https://github.com/o/r/pull/1|the PR>");
  assert.equal(util.toMrkdwn('#123 "Add export" is done'), '#123 "Add export" is done');
  assert.equal(util.toMrkdwn("## Plan\nstep"), "*Plan*\nstep");
});

test("decisionHint and linkLines stand in for buttons", () => {
  const plan = [{ text: "Approve", data: "approve:7" }, { text: "Reject", data: "reject:7" }];
  assert.equal(util.decisionHint(plan, { where: "in a comment" }), "Reply 'approve' (Approve) or 'reject' (Reject) in a comment.");
  assert.equal(util.decisionHint(plan, { md: true, where: "to this issue" }), "Reply **approve** (Approve) or **reject** (Reject) to this issue.");
  assert.match(util.decisionHint([{ text: "Approve", data: "review-approve:3" }, { text: "Review", url: "http://x/items/3" }]), /'approve'.*'changes:'/);
  assert.equal(util.decisionHint([{ text: "Open PR", url: "https://x" }]), "");
  assert.equal(util.linkLines([{ text: "Open PR", url: "https://x/1" }, { text: "Go", data: "approve:1" }]), "Open PR: https://x/1");
  assert.equal(util.linkLines([{ text: "Open PR", url: "https://x/1" }], true), "[Open PR](https://x/1)");
});

test("retryAfterMs reads seconds, dates and rate-limit resets", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  assert.equal(util.retryAfterMs(new Headers({ "retry-after": "7" }), now), 7000);
  assert.equal(util.retryAfterMs(new Headers({ "retry-after": "Fri, 30 Oct 2026 12:00:10 GMT" }), now), 10_000);
  assert.equal(util.retryAfterMs(new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 30) }), now), 30_000);
  assert.equal(util.retryAfterMs(new Headers({ "x-ratelimit-remaining": "5" }), now), null);
});

test("fetchRetry waits out a 429, does not repeat a POST after a 503, and reports status and body", async () => {
  const real = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async () => (++calls === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } }) : new Response("{\"ok\":true}", { status: 200 }))) as typeof fetch;
    const res = await util.fetchRetry("https://example.test/a", { label: "t GET /a" });
    assert.equal(res.status, 200);
    assert.equal(calls, 2);

    calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response("upstream down", { status: 503 }); }) as typeof fetch;
    await assert.rejects(util.fetchRetry("https://example.test/b", { method: "POST", body: "{}", label: "t POST /b" }), (e: unknown) => {
      assert.ok(e instanceof util.FetchError);
      assert.equal(e.status, 503);
      assert.match(e.message, /t POST \/b → HTTP 503: upstream down/);
      return true;
    });
    assert.equal(calls, 1);

    globalThis.fetch = (async () => new Response(null, { status: 304 })) as typeof fetch;
    assert.equal((await util.fetchRetry("https://example.test/c", { accept: [304] })).status, 304);
  } finally {
    globalThis.fetch = real;
  }
});

test("slackToText turns Slack markup into plain text", () => {
  const names: Record<string, string> = { U222: "Priya" };
  const raw = "<@U0BOT> please fix <https://example.com/a?b=1&amp;c=2|the export> for <@U222> in <#C1|eng> &lt;soon&gt; <!here> <mailto:a@b.co|a@b.co> <http://example.com|example.com> <@U999>";
  assert.equal(slack.slackToText(raw, (id) => names[id], "U0BOT"), "please fix the export (https://example.com/a?b=1&c=2) for @Priya in #eng <soon> @here a@b.co http://example.com @U999");
  assert.equal(slack.slackToText("hi <@U1|sam> <!subteam^S1|@platform>"), "hi @sam @platform");
});

test("postBlocks: text in a section, data buttons with their values and styles, link buttons with URLs", () => {
  const { text, blocks } = slack.postBlocks({ text: "Plan for #4 <b>", level: "success", buttons: [{ text: "Approve", data: "approve:9" }, { text: "Reject", data: "reject:9" }, { text: "Open", url: "http://127.0.0.1:8282/items/4" }] });
  assert.equal(text, "Plan for #4 &lt;b&gt;");
  assert.equal(blocks[0].type, "section");
  assert.equal(blocks[0].text.text, ":white_check_mark: Plan for #4 &lt;b&gt;");
  const actions = blocks.at(-1)!;
  assert.equal(actions.type, "actions");
  const [ok, no, open] = actions.elements;
  assert.deepEqual([ok.action_id, ok.value, ok.style], ["approve", "approve:9", "primary"]);
  assert.deepEqual([no.action_id, no.value, no.style], ["reject", "reject:9", "danger"]);
  assert.ok(no.confirm);
  assert.equal(open.url, "http://127.0.0.1:8282/items/4");
  assert.equal(open.value, undefined);
  assert.equal(slack.postBlocks({ text: "x".repeat(7000) }).blocks.length, 3); // sections hold 3000 characters
  assert.equal(slack.appManifest.settings.socket_mode_enabled, true);
  assert.ok(slack.appManifest.settings.event_subscriptions.bot_events.includes("message.mpim")); // mpim:history is asked for; the event must be too
});

test("pieces never cuts inside a link, an escape or an emoji", () => {
  const link = "<https://github.com/o/r/pull/1|the pull request>";
  for (const pad of [2870, 2880, 2890, 2899]) {
    const parts = slack.pieces(`${"a".repeat(pad)} ${link} and &amp; more &lt;b&gt; after`);
    assert.ok(parts.length >= 2, String(pad));
    for (const p of parts) {
      assert.ok(p.length <= 2900);
      assert.equal(p.split("<").length, p.split(">").length, `unbalanced link at ${pad}: …${p.slice(-40)}`);
      assert.doesNotMatch(p, /&[a-z]{0,3}$/, `split escape at ${pad}`);
    }
    assert.equal(parts.join(""), `${"a".repeat(pad)} ${link} and &amp; more &lt;b&gt; after`);
  }
  for (const pad of [2894, 2895, 2896, 2897, 2898, 2899]) {
    const whole = `${"x".repeat(pad)}&amp;yyyy`;
    const parts = slack.pieces(whole);
    assert.equal(parts.join(""), whole);
    assert.equal(parts.filter((p) => p.includes("&amp;")).length, 1, String(pad)); // in one piece, whole
  }
  const emoji = slack.pieces(`${"x".repeat(2899)}😀tail`);
  assert.equal(emoji[0].length, 2899);
  assert.ok(emoji[1].startsWith("😀"));
  assert.deepEqual(slack.pieces(`${"y".repeat(2000)}\n${"z".repeat(2000)}`).map((p) => p.length), [2000, 2000]); // line breaks still win
});

test("slack timestamps order exactly", () => {
  assert.ok(slack.cmpTs("1700000000.000200", "1700000000.000199") > 0);
  assert.ok(slack.cmpTs("1700000000.000200", "1700000001.000001") < 0);
  assert.equal(slack.cmpTs("1700000000.000200", "1700000000.0002"), 0);
  assert.deepEqual(["1700000000.000300", "1699999999.999999", "1700000000.000020"].sort(slack.cmpTs), ["1699999999.999999", "1700000000.000020", "1700000000.000300"]);
});

test("mayDecide matches stable ids and usernames, any case, with or without @, and never an empty or missing id", () => {
  const ctx = (approvers: unknown) => ({ config: { approvers } });
  const list = ctx("U0123ABCD, @Priya\n5b10ac8d82e05b22cc7d4ef5, sam@team.com");
  assert.equal(util.mayDecide(list, "U0123ABCD"), true);
  assert.equal(util.mayDecide(list, "u0123abcd"), true);
  assert.equal(util.mayDecide(list, "U999", "priya"), true); // a username matches when the id does not
  assert.equal(util.mayDecide(list, "@PRIYA"), true);
  assert.equal(util.mayDecide(list, "5b10ac8d82e05b22cc7d4ef5", null), true);
  assert.equal(util.mayDecide(list, null, " Sam@Team.com "), true);
  assert.equal(util.mayDecide(list, "U999", "mallory"), false);
  assert.equal(util.mayDecide(list), false); // with approvers listed, no identity decides nothing
  assert.equal(util.mayDecide(list, "", null, undefined, "@"), false);
  assert.equal(util.mayDecide(ctx(""), "anyone"), true); // empty list: anyone who can write there
  assert.equal(util.mayDecide(ctx(undefined)), true);
});

test("external ids: one per thread or ticket, then ref#2, ref#3 for later requests on it", () => {
  assert.equal(util.nextExternalId("ENG-4", "ENG-4"), "ENG-4#2");
  assert.equal(util.nextExternalId("ENG-4", "ENG-4#2"), "ENG-4#3");
  assert.equal(util.nextExternalId("ENG-4", "ENG-4#9"), "ENG-4#10");
  assert.equal(util.nextExternalId("ENG-4", null), "ENG-4#2");
  assert.equal(util.nextExternalId("ENG-4", "ENG-42"), "ENG-4#2"); // another issue's id is no basis
  assert.equal(github.issueRef("o/r", 17), "o/r#17");
  assert.equal(util.nextExternalId(github.issueRef("o/r", 17), "o/r#17"), "o/r#17#2");
  assert.equal(util.nextExternalId(github.issueRef("o/r", 17), "17"), "o/r#17#2"); // an item from before the repository was in the id
  assert.equal(util.nextExternalId("9f1c-uuid", "9f1c-uuid#2"), "9f1c-uuid#3");
});

const sampleAdf: import("../server/lib/sources/jira.ts").Adf = {
  type: "doc", version: 1, content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Export" }] },
    { type: "paragraph", content: [
      { type: "text", text: "Add a " }, { type: "text", text: "CSV", marks: [{ type: "strong" }] }, { type: "text", text: " button, see " },
      { type: "text", text: "the spec", marks: [{ type: "link", attrs: { href: "https://wiki/spec" } }] }, { type: "text", text: "." },
      { type: "hardBreak" }, { type: "mention", attrs: { id: "abc", text: "@Priya" } }, { type: "text", text: " owns it." },
    ] },
    { type: "bulletList", content: [
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "dates as ISO" }] }] },
      { type: "listItem", content: [
        { type: "paragraph", content: [{ type: "text", text: "columns" }] },
        { type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "id" }] }] }, { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "name", marks: [{ type: "code" }] }] }] }] },
      ] },
    ] },
    { type: "codeBlock", attrs: { language: "sql" }, content: [{ type: "text", text: "select 1;" }] },
    { type: "paragraph", content: [{ type: "inlineCard", attrs: { url: "https://x.atlassian.net/browse/ENG-1" } }] },
    { type: "mediaSingle", content: [{ type: "media", attrs: { id: "m1", type: "file" } }] },
  ],
};

test("adfToText renders ADF as readable markdown", () => {
  assert.equal(jira.adfToText(sampleAdf), [
    "## Export", "", "Add a **CSV** button, see [the spec](https://wiki/spec).", "@Priya owns it.", "",
    "- dates as ISO", "- columns", "  1. id", "  2. `name`", "", "```sql", "select 1;", "```", "", "https://x.atlassian.net/browse/ENG-1", "", "[attachment]",
  ].join("\n"));
  assert.equal(jira.adfToText(null), "");
  assert.equal(jira.adfToText("  plain v2 text "), "plain v2 text");
  assert.equal(jira.adfToText({ type: "doc", content: [{ type: "somethingNew", content: [{ type: "text", text: "still read" }] }] }), "still read");
});

test("textToAdf makes valid ADF: no empty text nodes, URLs as links, a bold title", () => {
  const doc = jira.textToAdf("Line one\nhttps://github.com/o/r/pull/1.\n\n\nSecond paragraph", "Status");
  assert.equal(doc.type, "doc");
  assert.equal(doc.version, 1);
  const [title, p1, p2] = doc.content!;
  assert.deepEqual(title.content![0], { type: "text", text: "Status", marks: [{ type: "strong" }] });
  assert.deepEqual(p1.content!.map((n) => n.type), ["text", "hardBreak", "text", "text"]);
  assert.deepEqual(p1.content![2], { type: "text", text: "https://github.com/o/r/pull/1", marks: [{ type: "link", attrs: { href: "https://github.com/o/r/pull/1" } }] });
  assert.equal(p2.content![0].text, "Second paragraph");
  const empties = JSON.stringify(jira.textToAdf("\n\n")).includes('"text":""');
  assert.equal(empties, false);
  const c = jira.commentAdf({ text: "Plan ready", buttons: [{ text: "Approve", data: "approve:1" }, { text: "Reject", data: "reject:1" }] });
  assert.match(JSON.stringify(c), /Reply 'approve' \(Approve\) or 'reject' \(Reject\) in a comment/);
});

test("jiraIssueToDraft maps an issue to a request", () => {
  const issue: import("../server/lib/sources/jira.ts").JiraIssue = {
    id: "10042", key: "ENG-42",
    fields: {
      summary: "Add CSV export", description: sampleAdf, labels: ["factory", "factory-picked", "reports"], updated: "2026-10-30T14:03:11.123+0000",
      priority: { id: "2", name: "High" }, reporter: { accountId: "u1", displayName: "Priya" }, issuetype: { name: "Story" },
      comment: { total: 2, comments: [
        { id: "100", author: { accountId: "u2", displayName: "Sam" }, created: "2026-10-29T10:00:00.000+0000", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Also XLSX?" }] }] } },
        { id: "101", author: { accountId: "bot", displayName: "Factory" }, created: "2026-10-29T11:00:00.000+0000", body: "picked up" },
      ] },
    },
  };
  const d = jira.jiraIssueToDraft(issue, "https://x.atlassian.net", { skipLabels: ["factory-picked", "factory"], selfAccountId: "bot" });
  assert.equal(d.title, "ENG-42: Add CSV export");
  assert.equal(d.externalId, "ENG-42");
  assert.equal(d.externalUrl, "https://x.atlassian.net/browse/ENG-42");
  assert.equal(d.priority, 2);
  assert.deepEqual(d.labels, ["reports", "story"]);
  assert.deepEqual(d.origin, { kind: "jira", key: "ENG-42", baseUrl: "https://x.atlassian.net" });
  assert.equal(d.requesterName, "Priya");
  assert.match(d.body!, /^## Export/);
  assert.match(d.body!, /Comments on ENG-42:\n- Sam \(2026-10-29\): Also XLSX\?$/);
  assert.doesNotMatch(d.body!, /picked up/);
  assert.equal(jira.jiraIssueToDraft({ id: "1", key: "A-1" }, "https://x.atlassian.net").body, "(no description)");
});

test("jira helpers: priorities, JQL with a cursor, dates in the user's zone, base URLs", () => {
  assert.deepEqual([{ name: "Highest" }, { name: "Medium" }, { name: "Lowest" }, { id: "4", name: "Custom" }, null].map((p) => jira.jiraPriority(p)), [1, 3, 5, 4, 3]);
  assert.equal(jira.sinceJql(jira.DEFAULT_JQL, null), "(labels = factory AND statusCategory != Done) ORDER BY updated ASC");
  assert.equal(jira.sinceJql("project = ENG order by created desc", "2026/10/30 14:05"), '(project = ENG) AND updated >= "2026/10/30 14:05" ORDER BY updated ASC');
  const d = new Date("2026-10-30T14:05:59Z");
  assert.equal(jira.jqlDate(d, "UTC"), "2026/10/30 14:05");
  assert.equal(jira.jqlDate(d, "Asia/Kolkata"), "2026/10/30 19:35");
  assert.equal(jira.jqlDate(d, "Not/AZone"), "2026/10/30 14:05");
  assert.equal(jira.normalizeBase("yourteam.atlassian.net/jira/software/projects/ENG/boards/1"), "https://yourteam.atlassian.net");
  assert.equal(jira.normalizeBase("https://api.atlassian.com/ex/jira/abc-123/"), "https://api.atlassian.com/ex/jira/abc-123");
});

test("jira links go to the site, also when the API goes through api.atlassian.com", () => {
  const scoped = "https://api.atlassian.com/ex/jira/abc-123";
  assert.equal(jira.browseUrl("ENG-1", scoped, "yourteam.atlassian.net/jira/software/projects/ENG"), "https://yourteam.atlassian.net/browse/ENG-1");
  assert.equal(jira.browseUrl("ENG-1", scoped, ""), `${scoped}/browse/ENG-1`); // no site given: the base is all there is
  assert.equal(jira.browseUrl("ENG-1", "https://yourteam.atlassian.net", null), "https://yourteam.atlassian.net/browse/ENG-1");
  assert.equal(jira.browseUrl("ENG-1", "https://yourteam.atlassian.net", "not a url at all"), "https://yourteam.atlassian.net/browse/ENG-1"); // unusable: the base
  const d = jira.jiraIssueToDraft({ id: "1", key: "ENG-1" }, scoped, { siteUrl: "https://yourteam.atlassian.net" });
  assert.equal(d.externalUrl, "https://yourteam.atlassian.net/browse/ENG-1");
  assert.deepEqual(d.origin, { kind: "jira", key: "ENG-1", baseUrl: scoped });
});

test("jira comments are cut to fit, keeping what to reply and the links", () => {
  const c = jira.commentAdf({ title: "Plan", text: "x".repeat(50_000), buttons: [{ text: "Approve", data: "approve:1" }, { text: "Open", url: "https://f/items/1" }] });
  const text = JSON.stringify(c);
  const chars = (c.content ?? []).flatMap((p) => p.content ?? []).reduce((n, t) => n + (t.text?.length ?? 0), 0);
  assert.ok(chars <= 32_000, String(chars));
  assert.match(text, /cut; the rest is in the factory/);
  assert.match(text, /Reply 'approve' \(Approve\) in a comment/);
  assert.match(text, /https:\/\/f\/items\/1/);
  assert.equal(JSON.stringify(jira.commentAdf({ text: "short" })).includes("cut;"), false);
});

test("jira: a closed request's issue counts as asked again only for a trigger label put back or a reopen", () => {
  assert.deepEqual(jira.jqlLabels(jira.DEFAULT_JQL), ["factory"]);
  assert.deepEqual(jira.jqlLabels('project = ENG AND labels in (factory, "ai-ready") AND labels != wontdo'), ["factory", "ai-ready"]);
  assert.deepEqual(jira.jqlLabels("assignee = currentUser()"), []);
  const o = { since: "2026-10-30T12:00:00.000Z", selfAccountId: "bot", triggers: ["factory"], doneStatuses: new Set(["10002"]) };
  const h = (created: string, author: string, items: NonNullable<import("../server/lib/sources/jira.ts").JiraHistory["items"]>) => ({ created, author: { accountId: author }, items });
  assert.equal(jira.askedAgain([h("2026-10-30T13:00:00.000+0000", "u1", [{ field: "labels", fromString: "ui", toString: "factory ui" }])], o)?.author?.accountId, "u1");
  assert.ok(jira.askedAgain([h("2026-10-30T13:00:00.000+0000", "u1", [{ field: "status", from: "10002", to: "10000" }])], o)); // Done → To Do
  assert.equal(jira.askedAgain([h("2026-10-30T13:00:00.000+0000", "u1", [{ field: "status", from: "10000", to: "10001" }])], o), null); // moved between open statuses
  assert.equal(jira.askedAgain([h("2026-10-30T13:00:00.000+0000", "u1", [{ field: "labels", fromString: "factory", toString: "factory ui" }])], o), null); // another label
  assert.equal(jira.askedAgain([h("2026-10-30T13:00:00.000+0000", "bot", [{ field: "status", from: "10002", to: "10000" }])], o), null); // the factory itself
  assert.equal(jira.askedAgain([h("2026-10-30T11:00:00.000+0000", "u1", [{ field: "labels", fromString: "", toString: "factory" }])], o), null); // before it closed
  assert.equal(jira.askedAgain([h("2026-10-30T13:00:00.000+0000", "u1", [{ field: "labels", fromString: "factory" }])], o), null); // all labels removed: no toString of its own
});

test("githubIssueToDraft maps an issue to a request", () => {
  const d = github.githubIssueToDraft(
    { number: 17, title: "Dark mode", body: "Please add dark mode.", html_url: "https://github.com/o/r/issues/17", user: { login: "priya" }, labels: [{ name: "factory" }, { name: "ui" }, "good first issue"] },
    "o/r", "factory",
    [{ id: 1, body: "Also the login page", user: { login: "sam" } }, { id: 2, body: `picked up\n\n${github.MARKER}`, user: { login: "bot" } }],
  );
  assert.equal(d.title, "Dark mode");
  assert.equal(d.externalId, "o/r#17"); // the repository is part of it: another repository's #17 is another issue
  assert.equal(d.externalUrl, "https://github.com/o/r/issues/17");
  assert.deepEqual(d.origin, { kind: "github", repo: "o/r", issue: 17 });
  assert.deepEqual(d.labels, ["ui", "good first issue"]);
  assert.equal(d.requesterName, "priya");
  assert.equal(d.body, "Please add dark mode.\n\nComments on o/r#17:\n- sam: Also the login page");
  assert.equal(github.githubIssueToDraft({ number: 3, body: null }, "o/r").body, "(no description)");
});

test("githubComment links the factory's #id, says what to reply, and carries the marker", () => {
  const body = github.githubComment({ text: "Plan for #12 ready (see #120 too)", level: "warning", buttons: [{ text: "Approve", data: "approve:5" }, { text: "Reject", data: "reject:5" }, { text: "Open", url: "http://f/items/12" }] }, 12, "http://f/items/12");
  assert.equal(body, [
    "⚠️ Plan for [#12](http://f/items/12) ready (see #120 too)",
    "Reply **approve** (Approve) or **reject** (Reject) to this issue.",
    "[Open](http://f/items/12)",
    github.MARKER,
  ].join("\n\n"));
  assert.equal(github.parseRepo("https://github.com/o/r.git"), "o/r");
  assert.throws(() => github.parseRepo("not a repo"));
});

test("linearIssueToDraft, linearFilter and priorities", () => {
  const d = linear.linearIssueToDraft({
    id: "9f1c-uuid", identifier: "ENG-7", title: "Rate limit /export", description: "Too many calls.\n\n- 100/min", url: "https://linear.app/t/issue/ENG-7",
    priority: 2, creator: { id: "u1", name: "Priya Shah", displayName: "priya" }, labels: { nodes: [{ name: "Factory" }, { name: "backend" }] },
  });
  assert.equal(d.title, "ENG-7: Rate limit /export");
  assert.equal(d.externalId, "9f1c-uuid");
  assert.equal(d.externalUrl, "https://linear.app/t/issue/ENG-7");
  assert.deepEqual(d.origin, { kind: "linear", issueId: "9f1c-uuid", identifier: "ENG-7" });
  assert.deepEqual(d.labels, ["backend"]);
  assert.equal(d.priority, 2);
  assert.equal(d.requesterName, "priya");
  assert.equal(d.body, "Too many calls.\n\n- 100/min");
  assert.deepEqual([0, 1, 4, null, 9].map(linear.linearPriority), [3, 1, 4, 3, 3]);
  assert.deepEqual(linear.linearFilter({ label: "factory", teamKey: "ENG", states: ["Todo", "In Progress"], since: "2026-10-30T00:00:00.000Z" }), {
    labels: { some: { name: { eqIgnoreCase: "factory" } } }, updatedAt: { gt: "2026-10-30T00:00:00.000Z" }, team: { key: { eq: "ENG" } }, state: { name: { in: ["Todo", "In Progress"] } },
  });
  assert.deepEqual(linear.linearFilter({ label: "factory" }).state, { type: { nin: ["completed", "canceled", "duplicate"] } });
  assert.match(linear.linearComment({ text: "Built", buttons: [{ text: "Approve", data: "review-approve:3" }] }), /^Built\n\nReply \*\*approve\*\* in a comment to accept the change/);
});

test("linear: personal keys go bare, anything else as a Bearer token", () => {
  assert.equal(linear.linearAuth("lin_api_abc123"), "lin_api_abc123");
  assert.equal(linear.linearAuth("  lin_api_abc123\n"), "lin_api_abc123");
  assert.equal(linear.linearAuth("lin_oauth_xyz"), "Bearer lin_oauth_xyz");
  assert.equal(linear.linearAuth("8f2c1d0e-oauth-access-token"), "Bearer 8f2c1d0e-oauth-access-token");
  assert.equal(linear.linearAuth("Bearer lin_oauth_xyz"), "Bearer lin_oauth_xyz"); // pasted with the prefix: not doubled
});

test("linear and github: asked again means the trigger label put back or a reopen, by someone else, after the request closed", () => {
  const states: Record<string, string> = { s1: "unstarted", s2: "started", s3: "completed" };
  const o = { since: "2026-10-30T12:00:00.000Z", selfId: "bot", labelIds: ["lab-factory"], inTrigger: (id: string) => states[id] !== "completed" };
  assert.ok(linear.linearAskedAgain([{ createdAt: "2026-10-30T13:00:00.000Z", actor: { id: "u1" }, addedLabelIds: ["lab-factory"] }], o));
  assert.ok(linear.linearAskedAgain([{ createdAt: "2026-10-30T13:00:00.000Z", actor: { id: "u1" }, fromStateId: "s3", toStateId: "s1" }], o));
  assert.equal(linear.linearAskedAgain([{ createdAt: "2026-10-30T13:00:00.000Z", actor: { id: "u1" }, fromStateId: "s1", toStateId: "s2" }], o), null);
  assert.equal(linear.linearAskedAgain([{ createdAt: "2026-10-30T13:00:00.000Z", actor: { id: "bot" }, addedLabelIds: ["lab-factory"] }], o), null);
  assert.equal(linear.linearAskedAgain([{ createdAt: "2026-10-30T11:00:00.000Z", actor: { id: "u1" }, addedLabelIds: ["lab-factory"] }], o), null);

  const ev = (event: string, login: string, at: string, label?: string) => ({ event, actor: { login }, created_at: at, ...(label ? { label: { name: label } } : {}) });
  const since = "2026-10-30T12:00:00Z";
  assert.equal(github.retrigger([ev("labeled", "priya", "2026-10-30T11:00:00Z", "factory"), ev("reopened", "sam", "2026-10-30T13:00:00Z")], "factory", since, "bot")?.actor?.login, "sam");
  assert.ok(github.retrigger([ev("labeled", "priya", "2026-10-30T13:00:00Z", "Factory")], "factory", since, "bot"));
  assert.equal(github.retrigger([ev("labeled", "priya", "2026-10-30T13:00:00Z", "ui"), ev("commented", "priya", "2026-10-30T13:00:00Z")], "factory", since, "bot"), null);
  assert.equal(github.retrigger([ev("reopened", "bot", "2026-10-30T13:00:00Z")], "factory", since, "bot"), null);
});

test("config helpers", () => {
  assert.deepEqual(util.cfgList("Todo, In Progress\nDone,,"), ["Todo", "In Progress", "Done"]);
  assert.equal(util.cfgBool(undefined, true), true);
  assert.equal(util.cfgBool("false", true), false);
  assert.equal(util.cfgBool(false, true), false);
  assert.equal(util.cfgStr(undefined, "factory-picked"), "factory-picked");
  assert.equal(util.cfgStr("", "factory-picked"), "");
  assert.equal(util.titleFrom("\n  ## Fix the login\nmore", "x"), "Fix the login");
  assert.equal(util.titleFrom("", "fallback"), "fallback");
});
