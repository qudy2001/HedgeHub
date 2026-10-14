import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CatalystError,
  createCatalyst,
  deleteCatalyst,
  listCatalysts,
  markCatalystsReviewed,
  updateCatalyst
} from "../server/catalystStore.js";
import { curatedCatalysts, researchWindow } from "../server/researchCatalysts.js";

const valid = {
  symbols: "tsla, nvda",
  title: "Robotaxi expansion update",
  category: "operating-update",
  date: "2026-10-20",
  dateStatus: "estimated",
  source: "Company IR",
  sourceUrl: "https://example.com/ir",
  note: "Watch for the city list"
};
const t0 = new Date("2026-10-14T12:00:00Z");

async function withCatalystFile(run, initial) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hedgehub-catalysts-"));
  const file = path.join(dir, "nested", "catalysts.json");
  const previous = process.env.RESEARCH_CATALYST_FILE;
  process.env.RESEARCH_CATALYST_FILE = file;
  try {
    if (initial !== undefined) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, typeof initial === "string" ? initial : JSON.stringify(initial));
    }
    await run(file);
  } finally {
    if (previous === undefined) delete process.env.RESEARCH_CATALYST_FILE;
    else process.env.RESEARCH_CATALYST_FILE = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const readFile = async (file) => JSON.parse(await fs.readFile(file, "utf8"));

test("created events are written in the format the research reader consumes", async () => {
  await withCatalystFile(async (file) => {
    const state = await createCatalyst(valid, t0);
    assert.equal(state.events.length, 1);
    assert.deepEqual(state.changed.symbols, ["TSLA", "NVDA"]);
    assert.match(state.changed.id, /^[0-9a-f-]{36}$/);
    assert.equal(state.changed.verifiedAt, t0.toISOString());
    assert.equal((await readFile(file)).events.length, 1);

    const window = researchWindow("2026-10-30", 30, "2026-10-14T00:00:00Z");
    const tsla = await curatedCatalysts("TSLA", window);
    assert.equal(tsla.events.length, 1);
    assert.equal(tsla.events[0].title, "Robotaxi expansion update");
    assert.equal(tsla.events[0].sourceUrl, "https://example.com/ir");
    assert.equal((await curatedCatalysts("AAPL", window)).events.length, 0);
  });
});

test("invalid events are rejected with a CatalystError", async () => {
  await withCatalystFile(async () => {
    const reject = (patch, message) =>
      assert.rejects(createCatalyst({ ...valid, ...patch }, t0), (error) => {
        assert.ok(error instanceof CatalystError);
        assert.equal(error.status, 400);
        assert.match(error.message, message);
        return true;
      });
    await reject({ symbols: "" }, /symbol/);
    await reject({ symbols: "TSLA$" }, /invalid symbol/);
    await reject({ title: "  " }, /title is required/);
    await reject({ title: "x".repeat(501) }, /title must be at most 500/);
    await reject({ note: "x".repeat(1001) }, /note must be at most 1000/);
    await reject({ category: "rumour" }, /category/);
    await reject({ dateStatus: "maybe" }, /dateStatus/);
    await reject({ date: "2026-02-30" }, /valid YYYY-MM-DD/);
    await reject({ date: "", dateStatus: "confirmed" }, /date is required/);
    await reject({ sourceUrl: "javascript:alert(1)" }, /sourceUrl/);
    await reject({ sourceUrl: "https://user:pw@example.com" }, /sourceUrl/);
    await reject({ sourceUrl: "" }, /sourceUrl/);
    assert.equal((await listCatalysts(t0)).events.length, 0);
  });
});

test("an unconfirmed event may omit its date", async () => {
  await withCatalystFile(async () => {
    const state = await createCatalyst({ ...valid, date: "", dateStatus: "unconfirmed" }, t0);
    assert.equal(state.changed.date, null);
  });
});

test("updates are partial, keep verifiedAt unless re-verified, and preserve unknown fields", async () => {
  const initial = { reviewedAt: "2026-10-10T00:00:00Z", owner: "ray", events: [] };
  await withCatalystFile(async (file) => {
    const created = (await createCatalyst(valid, t0)).changed;
    const raw = await readFile(file);
    raw.events[0].internalRef = "abc";
    await fs.writeFile(file, JSON.stringify(raw));

    const t1 = new Date("2026-10-15T09:00:00Z");
    const edited = (await updateCatalyst(created.id, { note: "City list published" }, t1)).changed;
    assert.equal(edited.note, "City list published");
    assert.equal(edited.title, valid.title);
    assert.equal(edited.verifiedAt, t0.toISOString());

    const t2 = new Date("2026-10-16T09:00:00Z");
    const reverified = (await updateCatalyst(created.id, { markVerified: true }, t2)).changed;
    assert.equal(reverified.verifiedAt, t2.toISOString());

    const after = await readFile(file);
    assert.equal(after.owner, "ray");
    assert.equal(after.reviewedAt, "2026-10-10T00:00:00Z");
    assert.equal(after.events[0].internalRef, "abc");
    assert.equal(after.events.length, 1);
  }, initial);
});

test("delete removes the event; unknown ids are a 404", async () => {
  await withCatalystFile(async () => {
    const { changed } = await createCatalyst(valid, t0);
    await assert.rejects(deleteCatalyst("nope", t0), (error) => error instanceof CatalystError && error.status === 404);
    await assert.rejects(updateCatalyst("nope", { note: "x" }, t0), (error) => error.status === 404);
    const state = await deleteCatalyst(changed.id, t0);
    assert.equal(state.events.length, 0);
  });
});

test("hand-written events without ids can be listed and edited, and get ids on the next write", async () => {
  const legacy = {
    events: [
      { symbols: ["TSLA"], title: "First", sourceUrl: "https://example.com/1" },
      { symbols: ["NVDA"], title: "Second", sourceUrl: "https://example.com/2" }
    ]
  };
  await withCatalystFile(async (file) => {
    const listed = await listCatalysts(t0);
    assert.deepEqual(listed.events.map((event) => event.id), ["legacy-0", "legacy-1"]);

    await updateCatalyst("legacy-1", { note: "edited" }, t0);
    const raw = await readFile(file);
    assert.ok(raw.events.every((event) => /^[0-9a-f-]{36}$/.test(event.id)));
    assert.equal(raw.events[0].title, "First");
    assert.equal(raw.events[1].note, "edited");
  }, legacy);
});

test("a corrupt file is reported and never overwritten", async () => {
  await withCatalystFile(async (file) => {
    await assert.rejects(listCatalysts(t0), (error) => error instanceof CatalystError && /not valid JSON/.test(error.message));
    await assert.rejects(createCatalyst(valid, t0), /not valid JSON/);
    assert.equal(await fs.readFile(file, "utf8"), "{ not json");
  }, "{ not json");
});

test("concurrent writes are not lost", async () => {
  await withCatalystFile(async () => {
    await Promise.all([
      createCatalyst({ ...valid, title: "A" }, t0),
      createCatalyst({ ...valid, title: "B" }, t0),
      createCatalyst({ ...valid, title: "C" }, t0)
    ]);
    const titles = (await listCatalysts(t0)).events.map((event) => event.title).sort();
    assert.deepEqual(titles, ["A", "B", "C"]);
  });
});

test("review status follows the seven-day rule used by the research checklist", async () => {
  await withCatalystFile(async () => {
    const missing = await listCatalysts(t0);
    assert.equal(missing.exists, false);
    assert.equal(missing.reviewStale, true);

    const reviewed = await markCatalystsReviewed(t0);
    assert.equal(reviewed.reviewedAt, t0.toISOString());
    assert.equal(reviewed.reviewStale, false);
    assert.equal(reviewed.exists, true);

    const sixDays = new Date(t0.getTime() + 6 * 86_400_000);
    const eightDays = new Date(t0.getTime() + 8 * 86_400_000);
    assert.equal((await listCatalysts(sixDays)).reviewStale, false);
    assert.equal((await listCatalysts(eightDays)).reviewStale, true);
    assert.equal((await listCatalysts(new Date(t0.getTime() - 1000))).reviewStale, true); // reviewed "in the future"
  });
});

test("the research reader still reports an unconfigured feed when no file exists", async () => {
  const previousFile = process.env.RESEARCH_CATALYST_FILE;
  const previousCwd = process.cwd();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hedgehub-nocatalysts-"));
  const window = researchWindow("2026-10-30", 30, "2026-10-14T00:00:00Z");
  try {
    delete process.env.RESEARCH_CATALYST_FILE;
    process.chdir(dir); // default location is <cwd>/data/catalysts.json, which does not exist here
    await assert.rejects(curatedCatalysts("TSLA", window), /not configured/);

    process.env.RESEARCH_CATALYST_FILE = path.join(dir, "missing.json"); // explicitly configured but absent
    await assert.rejects(curatedCatalysts("TSLA", window), (error) => error.code === "ENOENT");
  } finally {
    process.chdir(previousCwd);
    if (previousFile === undefined) delete process.env.RESEARCH_CATALYST_FILE;
    else process.env.RESEARCH_CATALYST_FILE = previousFile;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
