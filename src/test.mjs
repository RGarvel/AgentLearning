import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errors.push(e.message));

const dom = new JSDOM(read("index.html"), { runScripts: "outside-only", url: "http://localhost/", virtualConsole: vc, pretendToBeVisual: true });
const w = dom.window;
w.scrollTo = () => {};
w.HTMLElement.prototype.scrollIntoView = () => {};
w.eval(read("assets/course-data.js"));
w.eval(read("assets/app.js"));

const $ = (s) => w.document.querySelector(s);
const $$ = (s) => Array.from(w.document.querySelectorAll(s));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, extra) => checks.push({ name, ok: !!ok, extra: extra || "" });

await wait(40);
check("sidebar", $$(".nav-ch").length === 33, String($$(".nav-ch").length));
check("home", !!$(".hero h1"));

let bad = [];
for (let n = 0; n <= 32; n++) {
  w.location.hash = "#/ch/" + n;
  await wait(50);
  const t = ($(".ch-title") || {}).textContent || "";
  const h2 = $$("#prose h2").length;
  const q = $$("#quizBody .q").length;
  if (!t.includes("第" + n + "章")) bad.push(n + ":title");
  if (h2 < 2) bad.push(n + ":h2");
  if (q !== 3) bad.push(n + ":quiz=" + q);
}
check("all chapters", bad.length === 0, bad.join(","));

const opt = $("#quizBody .q[data-q='0'] .opt");
if (opt) {
  opt.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await wait(40);
}
check("quiz feedback", $$("#quizBody .explain").length === 1);

const s = $("#search");
s.value = "handoff";
s.dispatchEvent(new w.Event("input", { bubbles: true }));
await wait(220);
check("search", !$("#searchResults").hidden && $$("#searchResults .sr-item").length > 0);

w.location.hash = "#/resources";
await wait(120);
check("resources page", w.document.querySelectorAll(".rescard").length === 8, String(w.document.querySelectorAll(".rescard").length));
check("ref index 33", w.document.querySelectorAll(".refch").length === 33, String(w.document.querySelectorAll(".refch").length));
w.location.hash = "#/ch/7";
await wait(80);
check("chapter refs", w.document.querySelectorAll(".railrefs .ref").length > 0, String(w.document.querySelectorAll(".railrefs .ref").length));

w.location.hash = "#/ch/7";
await wait(90);
check("inline refs", w.document.querySelectorAll("a.src-ref").length > 5, String(w.document.querySelectorAll("a.src-ref").length));

check("no errors", errors.length === 0, errors.join(" | "));

let failed = 0;
for (const c of checks) { if (!c.ok) failed++; console.log((c.ok ? "PASS " : "FAIL ") + c.name + (c.extra ? " [" + c.extra + "]" : "")); }
console.log((checks.length - failed) + "/" + checks.length + " passed");
process.exit(failed ? 1 : 0);
