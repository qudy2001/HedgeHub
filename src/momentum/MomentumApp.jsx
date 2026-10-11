import BuilderApp from "../builder/BuilderApp.jsx";
import MomentumWorkspace from "./MomentumWorkspace.jsx";
import "@momentum-design/fonts/dist/css/fonts.css";
import "@momentum-design/tokens/dist/css/typography/complete.css";
import "@momentum-design/tokens/dist/css/theme/webex/light-stable.css";
import "@momentum-design/tokens/dist/css/theme/webex/dark-stable.css";
import "./momentum.css";

const presentation = {
  basePath: "/momentum",
  storageKey: "hedgehub-momentum-demo",
  renderWorkspace: (workspace) => <MomentumWorkspace {...workspace} />,
};
export default function MomentumApp() {
  return <BuilderApp presentation={presentation} />;
}
