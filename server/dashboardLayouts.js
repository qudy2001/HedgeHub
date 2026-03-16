import fs from "node:fs";
import path from "node:path";

const DASHBOARDS_DIR = path.join(process.cwd(), "dashboards");
const DEFAULT_DASHBOARDS_DIR = path.join(process.cwd(), "defaults", "dashboards");

function ensureDashboardsDirectory() {
  fs.mkdirSync(DASHBOARDS_DIR, { recursive: true });

  if (!fs.existsSync(DEFAULT_DASHBOARDS_DIR)) {
    return;
  }

  for (const fileName of fs.readdirSync(DEFAULT_DASHBOARDS_DIR)) {
    if (!fileName.endsWith(".json")) {
      continue;
    }

    const sourcePath = path.join(DEFAULT_DASHBOARDS_DIR, fileName);
    const targetPath = path.join(DASHBOARDS_DIR, fileName);

    if (!fs.existsSync(targetPath)) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function slugifyDashboardName(name) {
  const slug = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return slug || "dashboard";
}

function getDashboardPath(id) {
  return path.join(DASHBOARDS_DIR, `${id}.json`);
}

function readDashboardFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function listDashboardLayouts() {
  ensureDashboardsDirectory();

  return fs
    .readdirSync(DASHBOARDS_DIR)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => readDashboardFile(path.join(DASHBOARDS_DIR, fileName)))
    .map((dashboard) => ({
      id: dashboard.id,
      name: dashboard.name,
      createdAt: dashboard.createdAt,
      updatedAt: dashboard.updatedAt
    }))
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

export function readDashboardLayout(id) {
  ensureDashboardsDirectory();
  const normalizedId = slugifyDashboardName(id);
  const dashboardPath = getDashboardPath(normalizedId);

  if (!fs.existsSync(dashboardPath)) {
    return null;
  }

  return readDashboardFile(dashboardPath);
}

export function saveDashboardLayout(name, layout) {
  ensureDashboardsDirectory();

  const trimmedName = String(name ?? "").trim();

  if (!trimmedName) {
    throw new Error("Dashboard name is required");
  }

  const id = slugifyDashboardName(trimmedName);
  const dashboardPath = getDashboardPath(id);
  const existing = fs.existsSync(dashboardPath) ? readDashboardFile(dashboardPath) : null;
  const now = new Date().toISOString();
  const payload = {
    id,
    name: trimmedName,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    layout
  };

  fs.writeFileSync(dashboardPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

export function initializeDashboardLayoutsDirectory() {
  ensureDashboardsDirectory();
}
