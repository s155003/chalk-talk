// Drives the college game page in headless Chrome: loads teams, runs a call,
// compares every call, switches the defense, watches an animation, checks the
// scouting tabs, asks the coordinator once, and checks phone width.
// Usage: node scripts/verify_cfb.mjs [baseUrl] [--no-coach]
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const BASE = process.argv.find((a) => a.startsWith("http")) || "http://localhost:3000";
const NO_COACH = process.argv.includes("--no-coach");
const OUT = path.resolve("screenshots");
fs.mkdirSync(OUT, { recursive: true });
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome"].find((p) => fs.existsSync(p));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const problems = [];
page.on("console", (m) => { if (m.type() === "error") problems.push(`console.error: ${m.text()}`); });
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("requestfailed", (r) => { if (!r.url().includes("espncdn")) problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`); });
page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("espncdn")) problems.push(`http ${r.status()}: ${r.url()}`); });
const assert = (c, m) => { if (!c) problems.push(`assert: ${m}`); };
async function shot(name) { await page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: true }); console.log("saved", name); }
async function textChecks(label) {
  const t = await page.evaluate(() => document.body.innerText);
  assert(!/\bundefined\b|\bNaN\b|\bnull\b/.test(t), `${label}: no undefined/NaN/null text`);
  assert(!t.includes("\u2014"), `${label}: no em dash`);
}

await page.goto(BASE, { waitUntil: "networkidle0" });
await page.waitForSelector("#board circle.dot");
assert((await page.$$("#board circle.dot.off")).length === 11, "eleven offensive players drawn");
assert((await page.$$("#board circle.dot.def")).length === 11, "eleven defenders drawn");
assert((await page.$$("#personnel table tbody tr")).length === 22, "22 personnel rows");
assert((await page.$$("#scout-body table")).length === 2, "scouting tables rendered");
await textChecks("landing");
await shot("c1-board");

await page.click("#run-btn");
await page.waitForSelector("#results-body:not([hidden]) .strip");
assert((await page.$$("#results-body .strip .val")).length === 7, "seven summary cells");
assert((await page.$$("#results-body table tbody tr")).length === 3, "three pool rows");
await textChecks("results");
await shot("c2-results");

await page.click("#compare-btn");
await page.waitForSelector("#compare:not([hidden]) table tbody tr");
const rows = await page.$$("#compare table tbody tr");
assert(rows.length >= 4, `compare has rows (${rows.length})`);
await rows[0].click();
await page.waitForFunction(() => /expected points/.test(document.querySelector("#results-body .headline")?.textContent || ""));
await textChecks("compare");
await shot("c3-compare");

// switch defense and the scouting tab
await page.select("#def-team", "alabama");
await page.waitForFunction(() => document.querySelector("#scout-body")?.textContent.includes("Alabama"));
await page.click('.tab[data-side="offense"]');
await page.waitForFunction(() => document.querySelector("#scout-body")?.textContent.includes("offense has done"));
await textChecks("scout");

// pick a pass to a specific receiver
await page.select("#call-kind", "2");
const opts = await page.$$eval("#call-player option", (os) => os.map((o) => o.value));
assert(opts.length > 2, `receiver options exist (${opts.length})`);
await page.select("#call-player", opts[1]);
await page.click("#run-btn");
await page.waitForSelector("#results-body .pcard");
await textChecks("player");

await page.evaluate(() => window.scrollTo(0, 0));
await page.click("#watch-btn");
await page.waitForSelector("#anim");
await new Promise((r) => setTimeout(r, 1200));
const bw = await page.$(".boardwrap");
await bw.screenshot({ path: path.join(OUT, "c4-animation.png") });
console.log("saved c4-animation");
await new Promise((r) => setTimeout(r, 1400));
await shot("c5-player-pass");

if (!NO_COACH) {
  await page.type("#chat-text", "What should I call here, and why? Keep it short.");
  await page.click("#chat-send");
  await page.waitForSelector(".msg.wait");
  await page.waitForFunction(() => !document.querySelector(".msg.wait"), { timeout: 240000 });
  const err = await page.$eval("#chat-error", (n) => (n.hidden ? "" : n.textContent));
  assert(!err, `coach ok (${err})`);
  await textChecks("coach");
  await shot("c6-coach");
}

await page.setViewport({ width: 390, height: 800 });
await new Promise((r) => setTimeout(r, 400));
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
assert(overflow <= 1, `no horizontal overflow at phone width (got ${overflow})`);
await shot("c7-mobile");

await browser.close();
if (problems.length) { console.error("\nPROBLEMS:\n" + problems.map((p) => "  " + p).join("\n")); process.exit(1); }
console.log("\nAll checks passed.");
