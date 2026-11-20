function parseBooleanEnv(name) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) {
    return null;
  }

  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") {
    return true;
  }

  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") {
    return false;
  }

  return null;
}

export function envFlagEnabled(name, defaultValue = false) {
  const parsed = parseBooleanEnv(name);
  return parsed == null ? defaultValue : parsed;
}

function normalizeRole(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "scanner" ? "scanner" : "web";
}

const role = normalizeRole(process.env.HEDGEHUB_ROLE);
const roleDefaults =
  role === "scanner"
    ? {
        enableHttp: false,
        enableBackgroundJobs: true
      }
    : {
        enableHttp: true,
        enableBackgroundJobs: false
      };

export const runtimeConfig = {
  role,
  enableHttp: parseBooleanEnv("HEDGEHUB_ENABLE_HTTP") ?? roleDefaults.enableHttp,
  enableBackgroundJobs:
    parseBooleanEnv("HEDGEHUB_ENABLE_BACKGROUND_JOBS") ?? roleDefaults.enableBackgroundJobs
};
