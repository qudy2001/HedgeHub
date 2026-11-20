import { parentPort, workerData } from "node:worker_threads";
import { backtest } from "../../shared/builderEngine.js";
try {
  parentPort.postMessage({
    result: backtest(workerData.bars, workerData.strategy, workerData.settings),
  });
} catch (e) {
  parentPort.postMessage({ error: e.message });
}
