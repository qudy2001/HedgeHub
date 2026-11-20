import { logError, logInfo } from "./logger.js";
import { maintainMarketTopics } from "./db.js";
import {
  advanceAnalysisTaskDefinitionNextRun,
  createAnalysisTask,
  listDueAnalysisTaskDefinitions,
  updateAnalysisTaskDefinition
} from "./db.js";

const CADENCE_MS = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000
};

export const ANALYSIS_TASK_SCHEDULER_TICK_MS = 60 * 1000;

function nextRunAfter(cadence, fromDate) {
  const stepMs = CADENCE_MS[cadence];
  if (!stepMs) {
    return null;
  }
  return new Date(fromDate.getTime() + stepMs).toISOString();
}

export function runAnalysisTaskSchedulerTick() {
  const due = listDueAnalysisTaskDefinitions();
  for (const definition of due) {
    createAnalysisTask({
      definitionId: definition.id,
      topicId: definition.topicId,
      prompt: definition.prompt
    });

    if (definition.cadence) {
      const nextRunAt = nextRunAfter(definition.cadence, new Date());
      if (nextRunAt) {
        advanceAnalysisTaskDefinitionNextRun(definition.id, nextRunAt);
      }
    } else {
      // One-off definition: deactivate after creating its single task instance,
      // otherwise it would re-fire on every scheduler tick forever.
      updateAnalysisTaskDefinition(definition.id, { active: false });
    }
  }

  if (due.length) {
    logInfo("Analysis task scheduler created pending tasks", {
      subsystem: "analysis-task-scheduler",
      count: due.length
    });
  }
}

let lastTopicMaintenance = 0;
function maybeMaintainTopics() {
  if (Date.now() - lastTopicMaintenance < 60 * 60 * 1000) return;
  lastTopicMaintenance = Date.now();
  const result = maintainMarketTopics();
  if (result.archived || result.removed) logInfo("Market topic lifecycle", { subsystem: "market-topics", ...result });
}

export function startAnalysisTaskScheduler() {
  setInterval(() => {
    try {
      maybeMaintainTopics();
      runAnalysisTaskSchedulerTick();
    } catch (error) {
      logError("Analysis task scheduler tick failed", {
        subsystem: "analysis-task-scheduler",
        error
      });
    }
  }, ANALYSIS_TASK_SCHEDULER_TICK_MS);
}
