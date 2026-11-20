import { demoStockProfile } from "../../shared/stockVolumeProfile.js";
self.onmessage = ({ data }) => {
  try {
    self.postMessage({ result: demoStockProfile(data.bars, data.settings) });
  } catch (e) {
    self.postMessage({ error: e.message });
  }
};
