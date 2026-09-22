#!/usr/bin/env node
/**
 * URET control plane — Notion foundation setup.
 *
 * Creates (or reuses) the five URET databases under the URET parent page,
 * wires their relations, and optionally seeds one example record chain.
 *
 * Usage (from Termux):
 *   NOTION_TOKEN=secret_... node create-uret-databases.js [--no-seed]
 *
 * Targets @notionhq/client v5 and Notion API version 2025-09-03, where a
 * database is a container of one or more *data sources*:
 *   - databases.create({ parent, title, initial_data_source: { properties } })
 *   - schemas live on the data source: dataSources.update({ data_source_id, properties })
 *   - relations point at a data source: { relation: { data_source_id, dual_property | single_property } }
 *   - pages are created with parent { type: "data_source_id", data_source_id }
 *
 * Safe to re-run: existing URET databases under the parent page are detected by
 * title and reused, missing properties/relations are added, and example records
 * are only created if a record with the same Name does not already exist.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { Client, isFullBlock, isFullDatabase, isFullDataSource, isFullPage } = require("@notionhq/client");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PARENT_PAGE_ID = "3e3f821231f380f19079fe93749933e9";
const NOTION_VERSION = "2025-09-03";
const COUNTER_FILE = path.join(__dirname, "uret-id-counters.json");
const LOCK_FILE = COUNTER_FILE + ".lock";
const ID_PREFIXES = ["OPP", "SPEC", "WP", "EVD", "REL"];

const opts = (names) => names.map((name) => ({ name }));

// Non-relation schema for each database. Relations are wired in a second phase
// (see RELATIONS) because they need the data source IDs of the other databases.
const DATABASES = {
  opportunities: {
    title: "URET – Opportunities",
    idPrefix: "OPP",
    properties: {
      "URET ID": { rich_text: {} },
      Name: { title: {} },
      Status: { select: { options: opts(["Idea", "Active", "Parked", "Done"]) } },
      "Asset type": {
        multi_select: { options: opts(["App/PWA", "Ebook", "Video series", "Landing page / site", "Template"]) },
      },
      "Project / Asset": { rich_text: {} },
      "Problem summary": { rich_text: {} },
      "Target users": { rich_text: {} },
      "Success metrics": { rich_text: {} },
      "Next action": { rich_text: {} },
      Created: { created_time: {} },
      "Last updated": { last_edited_time: {} },
    },
  },
  specs: {
    title: "URET – Specs",
    idPrefix: "SPEC",
    properties: {
      "URET ID": { rich_text: {} },
      Name: { title: {} },
      Version: { rich_text: {} },
      Summary: { rich_text: {} },
      "Scope in": { rich_text: {} },
      "Scope out": { rich_text: {} },
      Constraints: { rich_text: {} },
      Status: { select: { options: opts(["Draft", "Approved", "Superseded"]) } },
      Repo: { url: {} },
      Branch: { rich_text: {} },
    },
  },
  workPackages: {
    title: "URET – Work Packages",
    idPrefix: "WP",
    properties: {
      "URET ID": { rich_text: {} },
      Name: { title: {} },
      Type: { select: { options: opts(["Prototype", "Feature", "Bug fix", "Research", "Hardening"]) } },
      Worker: { select: { options: opts(["Claude Code", "AI Studio", "Hermes", "Manual", "Other"]) } },
      Status: { select: { options: opts(["Draft", "In progress", "Done", "Blocked"]) } },
      Summary: { rich_text: {} },
      Instructions: { rich_text: {} },
      Outputs: { rich_text: {} },
      "Commit / PR": { url: {} },
      "Start date": { date: {} },
      "End date": { date: {} },
    },
  },
  evidence: {
    title: "URET – Evidence",
    idPrefix: "EVD",
    properties: {
      "URET ID": { rich_text: {} },
      Name: { title: {} },
      Type: {
        select: { options: opts(["Test results", "User feedback", "Research", "Metrics", "Observation"]) },
      },
      Summary: { rich_text: {} },
      Verdict: { select: { options: opts(["Pass", "Fail", "Mixed", "N/A"]) } },
      "Evidence link": { url: {} },
      Date: { date: {} },
    },
  },
  releases: {
    title: "URET – Releases",
    idPrefix: "REL",
    properties: {
      "URET ID": { rich_text: {} },
      Name: { title: {} },
      Version: { rich_text: {} },
      Date: { date: {} },
      Summary: { rich_text: {} },
      "Production URL": { url: {} },
      "Test URL": { url: {} },
      Status: { select: { options: opts(["Planned", "Released", "Superseded"]) } },
    },
  },
};

// Each entry adds relation property `prop` on `from`, pointing at `to`.
// With `synced`, it is a two-way (dual_property) relation and Notion creates
// the reverse property on `to`, which we make sure is named `synced`.
// Without `synced`, it is one-way (single_property) — Evidence has no
// "Releases" property in the URET schema.
const RELATIONS = [
  { from: "specs", prop: "Opportunity", to: "opportunities", synced: "Specs" },
  { from: "releases", prop: "Opportunity", to: "opportunities", synced: "Releases" },
  { from: "workPackages", prop: "Spec", to: "specs", synced: "Work packages" },
  { from: "releases", prop: "Spec", to: "specs", synced: "Releases" },
  { from: "evidence", prop: "Work package", to: "workPackages", synced: "Evidence" },
  { from: "releases", prop: "Evidence", to: "evidence", synced: null },
];

// ---------------------------------------------------------------------------
// Logging (never prints the token)
// ---------------------------------------------------------------------------

const TOKEN = (process.env.NOTION_TOKEN || "").trim();

function redact(value) {
  const text = String(value);
  return TOKEN ? text.split(TOKEN).join("[REDACTED]") : text;
}

const log = (...parts) => console.log(redact(parts.join(" ")));
const warn = (...parts) => console.warn(redact(["WARN:", ...parts].join(" ")));

// ---------------------------------------------------------------------------
// URET ID counters
// ---------------------------------------------------------------------------

// Single-writer guard: an exclusive lock file prevents two concurrent runs from
// handing out the same ID. A crashed run leaves the lock behind; it is reported
// rather than silently removed.
function acquireLock() {
  try {
    const fd = fs.openSync(LOCK_FILE, "wx");
    fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
    fs.closeSync(fd);
  } catch (err) {
    if (err.code === "EEXIST") {
      throw new Error(
        `Lock file ${path.basename(LOCK_FILE)} exists — another run may be in progress. ` +
          "If no other run is active, delete the lock file and retry."
      );
    }
    throw err;
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch (err) {
    if (err.code !== "ENOENT") warn(`Could not remove lock file: ${err.message}`);
  }
}

function readCounters() {
  let counters = {};
  if (fs.existsSync(COUNTER_FILE)) {
    counters = JSON.parse(fs.readFileSync(COUNTER_FILE, "utf8"));
  }
  for (const prefix of ID_PREFIXES) {
    if (counters[prefix] === undefined) counters[prefix] = 0;
    if (!Number.isInteger(counters[prefix]) || counters[prefix] < 0) {
      throw new Error(`Invalid counter for ${prefix} in ${path.basename(COUNTER_FILE)}: ${counters[prefix]}`);
    }
  }
  return counters;
}

// Atomic write: write a temp file, fsync, then rename over the original.
function writeCounters(counters) {
  const tmp = `${COUNTER_FILE}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, JSON.stringify(counters, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, COUNTER_FILE);
}

function formatUretId(prefix, n) {
  return `${prefix}-${String(n).padStart(3, "0")}`;
}

// Persists the increment before the ID is used, so a failure later can leave a
// gap but can never reuse an ID.
function nextUretId(prefix) {
  if (!ID_PREFIXES.includes(prefix)) throw new Error(`Unknown URET ID prefix: ${prefix}`);
  const counters = readCounters();
  counters[prefix] += 1;
  writeCounters(counters);
  return formatUretId(prefix, counters[prefix]);
}

// ---------------------------------------------------------------------------
// Notion helpers
// ---------------------------------------------------------------------------

const normId = (id) => String(id).replace(/-/g, "").toLowerCase();
const normTitle = (title) => String(title).replace(/[‐-―-]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
const text = (content) => [{ type: "text", text: { content } }];

async function listChildDatabases(notion, pageId) {
  const found = [];
  let cursor;
  do {
    const res = await notion.blocks.children.list({ block_id: pageId, start_cursor: cursor, page_size: 100 });
    for (const block of res.results) {
      if (isFullBlock(block) && block.type === "child_database" && !block.in_trash) {
        found.push({ id: block.id, title: block.child_database.title });
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return found;
}

// Returns { databaseId, dataSourceId, created } for one URET database.
async function ensureDatabase(notion, key, def, existingChildren) {
  const matches = existingChildren.filter((c) => normTitle(c.title) === normTitle(def.title));

  if (matches.length > 1) {
    throw new Error(
      `Found ${matches.length} databases titled "${def.title}" under the parent page ` +
        `(${matches.map((m) => m.id).join(", ")}). Remove or rename the duplicates, then re-run.`
    );
  }

  if (matches.length === 1) {
    const db = await notion.databases.retrieve({ database_id: matches[0].id });
    if (!isFullDatabase(db)) throw new Error(`Could not read database "${def.title}" (${matches[0].id}).`);
    if (db.in_trash) throw new Error(`Database "${def.title}" (${db.id}) is in the trash. Restore or delete it, then re-run.`);
    if (!db.data_sources.length) throw new Error(`Database "${def.title}" (${db.id}) has no data source.`);
    if (db.data_sources.length > 1) {
      warn(`"${def.title}" has ${db.data_sources.length} data sources; using the first (${db.data_sources[0].name}).`);
    }
    log(`  = Reusing existing "${def.title}" (database ${db.id})`);
    return { databaseId: db.id, dataSourceId: db.data_sources[0].id, created: false };
  }

  log(`  + Creating "${def.title}"`);
  const db = await notion.databases.create({
    parent: { type: "page_id", page_id: PARENT_PAGE_ID },
    title: text(def.title),
    initial_data_source: { properties: def.properties },
  });
  if (!isFullDatabase(db) || !db.data_sources.length) {
    throw new Error(`Created "${def.title}" but the response did not include its data source ID.`);
  }
  log(`    database ${db.id}, data source ${db.data_sources[0].id}`);
  return { databaseId: db.id, dataSourceId: db.data_sources[0].id, created: true };
}

async function retrieveDataSource(notion, dataSourceId) {
  const ds = await notion.dataSources.retrieve({ data_source_id: dataSourceId });
  if (!isFullDataSource(ds)) throw new Error(`Could not read data source ${dataSourceId}.`);
  return ds;
}

// Adds any missing non-relation properties to a reused database.
async function ensureProperties(notion, def, dataSourceId) {
  const ds = await retrieveDataSource(notion, dataSourceId);
  const existing = ds.properties;
  const missing = {};

  for (const [name, config] of Object.entries(def.properties)) {
    const wantedType = Object.keys(config)[0];
    const prop = existing[name];
    if (!prop) {
      if (wantedType === "title") {
        const titleProp = Object.values(existing).find((p) => p.type === "title");
        warn(`"${def.title}": title property is "${titleProp && titleProp.name}", expected "Name". Leaving as is.`);
      } else {
        missing[name] = config;
      }
    } else if (prop.type !== wantedType) {
      warn(`"${def.title}": property "${name}" is ${prop.type}, expected ${wantedType}. Leaving as is.`);
    }
  }

  const names = Object.keys(missing);
  if (names.length) {
    log(`  + "${def.title}": adding missing properties: ${names.join(", ")}`);
    await notion.dataSources.update({ data_source_id: dataSourceId, properties: missing });
  } else {
    log(`  = "${def.title}": properties OK`);
  }
}

async function ensureRelation(notion, rel, ids) {
  const fromTitle = DATABASES[rel.from].title;
  const toTitle = DATABASES[rel.to].title;
  const fromDs = ids[rel.from].dataSourceId;
  const toDs = ids[rel.to].dataSourceId;
  const label = `${fromTitle}."${rel.prop}" -> ${toTitle}` + (rel.synced ? ` (reverse: "${rel.synced}")` : " (one-way)");

  let source = await retrieveDataSource(notion, fromDs);
  let prop = source.properties[rel.prop];

  if (prop) {
    if (prop.type !== "relation" || normId(prop.relation.data_source_id) !== normId(toDs)) {
      throw new Error(`${fromTitle} already has a "${rel.prop}" property that is not a relation to ${toTitle}.`);
    }
    log(`  = ${label}: already present`);
  } else {
    // A new dual relation also creates a property on the target, so make sure
    // the reverse name is not already taken by something else.
    if (rel.synced) {
      const target = await retrieveDataSource(notion, toDs);
      if (target.properties[rel.synced]) {
        throw new Error(
          `${toTitle} already has a "${rel.synced}" property, so the reverse side of ${label} cannot use that name.`
        );
      }
    }
    log(`  + ${label}`);
    const relation = rel.synced
      ? { data_source_id: toDs, type: "dual_property", dual_property: { synced_property_name: rel.synced } }
      : { data_source_id: toDs, type: "single_property", single_property: {} };
    await notion.dataSources.update({
      data_source_id: fromDs,
      properties: { [rel.prop]: { relation } },
    });
    source = await retrieveDataSource(notion, fromDs);
    prop = source.properties[rel.prop];
    if (!prop || prop.type !== "relation") throw new Error(`Relation ${label} was not created as expected.`);
  }

  if (!rel.synced) return;

  // Ensure the reverse property on the target has the URET name. Notion may
  // ignore synced_property_name on creation and use a default name instead.
  if (prop.relation.type !== "dual_property") {
    warn(`${label}: existing relation is one-way, expected two-way. Leaving as is.`);
    return;
  }
  const reverseId = prop.relation.dual_property.synced_property_id;
  const target = await retrieveDataSource(notion, toDs);
  const reverse = Object.values(target.properties).find((p) => p.id === reverseId);
  if (!reverse) {
    warn(`${label}: could not find the reverse property on ${toTitle}.`);
  } else if (reverse.name !== rel.synced) {
    if (target.properties[rel.synced]) {
      warn(`${label}: reverse property is "${reverse.name}" and "${rel.synced}" is taken; not renaming.`);
    } else {
      log(`    renaming reverse property "${reverse.name}" -> "${rel.synced}"`);
      await notion.dataSources.update({ data_source_id: toDs, properties: { [reverseId]: { name: rel.synced } } });
    }
  }
}

async function findPageByName(notion, dataSourceId, name) {
  const res = await notion.dataSources.query({
    data_source_id: dataSourceId,
    filter: { property: "Name", title: { equals: name } },
    page_size: 2,
  });
  const pages = res.results.filter(isFullPage);
  if (pages.length > 1) warn(`More than one record named "${name}" exists; using the first.`);
  return pages[0] || null;
}

function readUretId(page) {
  const prop = page.properties["URET ID"];
  return prop && prop.type === "rich_text" ? prop.rich_text.map((t) => t.plain_text).join("") : "";
}

// Creates a record unless one with the same Name already exists. Allocates a
// URET ID only when it actually creates the record.
async function ensureRecord(notion, key, ids, name, buildProperties) {
  const def = DATABASES[key];
  const dataSourceId = ids[key].dataSourceId;
  const existing = await findPageByName(notion, dataSourceId, name);
  if (existing) {
    log(`  = ${def.title}: "${name}" already exists (${readUretId(existing) || "no URET ID"}, page ${existing.id})`);
    return existing.id;
  }
  const uretId = nextUretId(def.idPrefix);
  const page = await notion.pages.create({
    parent: { type: "data_source_id", data_source_id: dataSourceId },
    properties: {
      Name: { title: text(name) },
      "URET ID": { rich_text: text(uretId) },
      ...buildProperties(),
    },
  });
  log(`  + ${def.title}: created ${uretId} "${name}" (page ${page.id})`);
  return page.id;
}

async function seedExampleChain(notion, ids) {
  const today = new Date().toISOString().slice(0, 10);
  const rel = (id) => ({ relation: [{ id }] });
  const select = (name) => ({ select: { name } });
  const rt = (content) => ({ rich_text: text(content) });

  const oppId = await ensureRecord(notion, "opportunities", ids, "URET Control Plane Setup", () => ({
    Status: select("Active"),
    "Project / Asset": rt("URET control plane"),
    "Problem summary": rt("URET needs a structured place to track opportunities, specs, work, evidence and releases."),
    "Target users": rt("URET operator"),
    "Success metrics": rt("All five URET databases exist and are linked end to end."),
    "Next action": rt("Review the Notion foundation."),
  }));

  const specId = await ensureRecord(notion, "specs", ids, "URET Notion Foundation v0.1", () => ({
    Opportunity: rel(oppId),
    Version: rt("0.1"),
    Summary: rt("Five linked Notion databases forming the URET control plane."),
    "Scope in": rt("Opportunities, Specs, Work Packages, Evidence, Releases and their relations."),
    "Scope out": rt("Automation beyond initial setup."),
    Constraints: rt("Run from Termux with Node.js and @notionhq/client."),
    Status: select("Approved"),
    Repo: { url: "https://github.com/uniqueapps-dev/uret-control-plane" },
    Branch: rt("main"),
  }));

  const wpId = await ensureRecord(notion, "workPackages", ids, "Create Notion Foundation", () => ({
    Spec: rel(specId),
    Type: select("Prototype"),
    Worker: select("Claude Code"),
    Status: select("Done"),
    Summary: rt("Create the five URET databases and wire their relations."),
    Instructions: rt("Run create-uret-databases.js from Termux."),
    Outputs: rt("Five linked Notion databases and an example record chain."),
    "Start date": { date: { start: today } },
    "End date": { date: { start: today } },
  }));

  const evdId = await ensureRecord(notion, "evidence", ids, "Notion Foundation Creation Test", () => ({
    "Work package": rel(wpId),
    Type: select("Test results"),
    Summary: rt("Setup script created the databases, relations and this example chain."),
    Verdict: select("Pass"),
    Date: { date: { start: today } },
  }));

  await ensureRecord(notion, "releases", ids, "URET Notion Foundation v0.1", () => ({
    Opportunity: rel(oppId),
    Spec: rel(specId),
    Evidence: rel(evdId),
    Version: rt("0.1"),
    Date: { date: { start: today } },
    Summary: rt("Initial URET Notion foundation."),
    Status: select("Released"),
  }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const seed = !args.includes("--no-seed");

  if (!TOKEN) {
    console.error("NOTION_TOKEN is not set. Run: NOTION_TOKEN=secret_... node create-uret-databases.js");
    process.exit(1);
  }

  acquireLock();
  const cleanup = () => {
    releaseLock();
    process.exit(130);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  try {
    // Validate the counter file before touching Notion.
    const counters = readCounters();
    log(`URET ID counters: ${ID_PREFIXES.map((p) => `${p}=${counters[p]}`).join(", ")}`);

    const notion = new Client({ auth: TOKEN, notionVersion: NOTION_VERSION });

    log(`\n[1/4] Checking parent page ${PARENT_PAGE_ID} for existing URET databases`);
    const children = await listChildDatabases(notion, PARENT_PAGE_ID);
    log(`  found ${children.length} child database(s)`);

    log("\n[2/4] Creating / reusing databases");
    const ids = {};
    for (const [key, def] of Object.entries(DATABASES)) {
      ids[key] = await ensureDatabase(notion, key, def, children);
    }
    for (const [key, def] of Object.entries(DATABASES)) {
      if (!ids[key].created) await ensureProperties(notion, def, ids[key].dataSourceId);
    }

    log("\n[3/4] Wiring relations");
    for (const rel of RELATIONS) {
      await ensureRelation(notion, rel, ids);
    }

    if (seed) {
      log("\n[4/4] Ensuring example record chain");
      await seedExampleChain(notion, ids);
    } else {
      log("\n[4/4] Skipping example records (--no-seed)");
    }

    log("\nDone. Database and data source IDs:");
    for (const [key, def] of Object.entries(DATABASES)) {
      log(`  ${def.title}: database ${ids[key].databaseId}, data source ${ids[key].dataSourceId}`);
    }
    const after = readCounters();
    log(`URET ID counters: ${ID_PREFIXES.map((p) => `${p}=${after[p]}`).join(", ")}`);
  } finally {
    releaseLock();
  }
}

if (require.main === module) {
  main().catch((err) => {
    const code = err && err.code ? ` [${err.code}]` : "";
    console.error(redact(`\nERROR${code}: ${err && err.message ? err.message : err}`));
    process.exitCode = 1;
  });
}

module.exports = { main, DATABASES, RELATIONS, PARENT_PAGE_ID, formatUretId, nextUretId, readCounters };
