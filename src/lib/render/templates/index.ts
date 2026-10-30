import { parseSceneSpec, type SceneSpec } from "../spec";
import illustrationAnimation from "./illustration-animation.json";
import paperCollage from "./paper-collage.json";
import localizationBoard from "./localization-board.json";
import saasUi from "./saas-ui.json";
import presentation from "./presentation.json";
import whiteboard from "./whiteboard.json";
import stickFigureExplainer from "./stick-figure-explainer.json";

/**
 * Motion-graphics templates - hand-authored SceneSpec v1 documents, each
 * deterministic and each carrying ≥2 customizable params. The /motion-graphics page
 * chips select these; the LLM spec-writer gets the chosen one as an example.
 */
export interface MotionTemplate {
  id: string;
  label: string;
  description: string;
  /** raw JSON - run through parseSceneSpec before use */
  spec: unknown;
}

export const MOTION_TEMPLATES: MotionTemplate[] = [
  {
    id: "illustration-animation",
    label: "Illustration",
    description: "A flat illustrated scene that assembles itself - sun, hills, drifting stars, and a wipe-on title.",
    spec: illustrationAnimation,
  },
  {
    id: "paper-collage",
    label: "Paper collage",
    description: "Cut-paper scraps drop and settle at angles under a strip of tape and a handwritten caption.",
    spec: paperCollage,
  },
  {
    id: "localization-board",
    label: "Localization board",
    description: "A dark card where language rows cascade in one after another under a colored header bar.",
    spec: localizationBoard,
  },
  {
    id: "saas-ui",
    label: "SaaS UI",
    description: "A dashboard mock that draws its own chart line while stat cards settle into place.",
    spec: saasUi,
  },
  {
    id: "presentation",
    label: "Presentation",
    description: "An extruded 3D headline over a drawn rule, with bullet points wiping on in sequence.",
    spec: presentation,
  },
  {
    id: "whiteboard",
    label: "Whiteboard",
    description: "Marker strokes draw a circle, an arrow, and an underline on a blank board.",
    spec: whiteboard,
  },
  {
    id: "stick-figure-explainer",
    label: "Stick figure",
    description: "A line-drawn figure waves beside 3D step lettering that lands glyph by glyph.",
    spec: stickFigureExplainer,
  },
];

export const motionTemplateById = (id: string | null | undefined) =>
  MOTION_TEMPLATES.find((t) => t.id === id) ?? null;

/** Validate + return a template's spec. All bundled templates are checked by unit tests. */
export function motionTemplateSpec(id: string): SceneSpec | null {
  const t = motionTemplateById(id);
  return t ? parseSceneSpec(t.spec) : null;
}
