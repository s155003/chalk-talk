// Renders the app in headless Chrome, runs a simulation, drags a receiver,
// watches an animation, asks the coordinator one question, and screenshots
// each state. Fails on console errors, page errors, failed requests, literal
// undefined/NaN text, em dashes, or horizontal overflow at phone width.
// Usage: node scripts/verify.mjs [baseUrl] [--no-coach]
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const BASE = process.argv.find((a) => a.startsWith("http")) || "http://localhost:3000";
const NO_COACH = process.argv.includes("--no-coach");
const OUT = path.resolve("screenshots");
fs.mkdirSync(OUT, { recursive: true });
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => fs.existsSync(p));
if (!CHROME) throw new Error("No Chrome or Edge found");

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const problems = [];
page.on("console", (m) => { if (m.type() === "error") problems.push(`console.error: ${m.text()}`); });
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("requestfailed", (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
page.on("response", (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });
const assert = (c, m) => { if (!c) problems.push(`assert: ${m}`); };
async function shot(name, clip) { await page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: !clip, clip }); console.log("saved", name); }
async function textChecks(label) {
  const t = await page.evaluate(() => document.body.innerText);
  assert(!t.includes("undefined") && !t.includes("NaN"), `${label}: no undefined/NaN text`);
  assert(!t.includes("\u2014"), `${label}: no em dash`);
}

await page.goto(BASE, { waitUntil: "networkidle0" });
await page.waitForSelector("#board path.route");
assert((await page.$$("#board path.route")).length === 5, "five routes drawn");
assert((await page.$$("#board path.x")).length === 5, "five defenders drawn");
assert((await page.$$(".prow:not(.hdr)")).length === 5, "five play-bar rows");
assert(!(await page.$eval("#results-empty", (n) => n.hidden)), "results empty before a run");
await textChecks("landing");
await shot("1-board");

// Run the simulation
await page.click("#run-btn");
await page.waitForSelector("#results-body:not([hidden]) .strip");
const stripCells = await page.$$eval("#results-body .strip .val", (ns) => ns.map((n) => n.textContent));
assert(stripCells.length === 7, "seven summary cells");
assert((await page.$$("#results-body table.sheet tbody tr")).length === 5, "five receiver rows");
assert((await page.$$("#results-body .chart rect.bar")).length >= 8, "histogram bars drawn");
await textChecks("results");
await shot("2-results");

// Change coverage, pin, rerun to get deltas
await page.click("#pin-btn");
await page.select("#coverage", "Cover 1");
await page.click("#run-btn");
await page.waitForFunction(() => document.querySelectorAll("#results-body .delta").length >= 5);
await textChecks("compare");
await shot("3-compare");

// Drag the X receiver inward
await page.evaluate(() => window.scrollTo(0, 0));
await new Promise((r) => setTimeout(r, 200));
const cxBefore = await page.$eval('#board circle.o[data-id="X"]', (n) => Number(n.getAttribute("cx")));
const circle = await page.$('#board circle.o[data-id="X"]');
const box = await circle.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 8 });
await page.mouse.up();
const newY = await page.$eval('#board circle.o[data-id="X"]', (n) => Number(n.getAttribute("cx")));
assert(newY > cxBefore + 3, `drag moved X inward (cx ${cxBefore} -> ${newY}, box ${JSON.stringify(box)})`);
assert((await page.$eval("#run-hint", (n) => n.textContent)).includes("changed"), "dirty hint after drag");

// Watch one snap
await page.evaluate(() => window.scrollTo(0, 0));
await page.click("#watch-btn");
await page.waitForSelector("#anim");
await new Promise((r) => setTimeout(r, 1500));
const bw = await page.$(".boardwrap");
await bw.screenshot({ path: path.join(OUT, "4-animation.png") });
console.log("saved 4-animation");
await page.waitForFunction(() => /EPA/.test(document.querySelector("#anim-caption")?.textContent || ""), { timeout: 15000 });
assert(true, "animation finished with a result caption");

// Coordinator
if (!NO_COACH) {
  await page.type("#chat-text", "Critique this play in three sentences.");
  await page.click("#chat-send");
  await page.waitForSelector(".msg.wait");
  await page.waitForFunction(() => !document.querySelector(".msg.wait"), { timeout: 180000 });
  const coachErr = await page.$eval("#chat-error", (n) => (n.hidden ? "" : n.textContent));
  assert(!coachErr, `coach reply ok (${coachErr})`);
  assert((await page.$$(".msg.coach")).length >= 1, "coach replied");
  await textChecks("coach");
  await shot("5-coach");
}

// Mobile
await page.setViewport({ width: 390, height: 800 });
await new Promise((r) => setTimeout(r, 400));
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
assert(overflow <= 1, `no horizontal overflow at phone width (got ${overflow})`);
await shot("6-mobile");

await browser.close();
if (problems.length) { console.error("\nPROBLEMS:\n" + problems.map((p) => "  " + p).join("\n")); process.exit(1); }
console.log("\nAll checks passed.");
