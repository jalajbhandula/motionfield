/* MCP prompts - reusable instruction templates. Each prompt declares the
 * capabilities it needs (`requires`) and the tools its text uses (`tools`);
 * it's listed only when every named tool is advertised AND every required
 * capability is reported, so an agent never sees a recipe it can't run. */

import { z } from "zod";

export interface PromptDef {
  name: string;
  title: string;
  description: string;
  /** capability strings - all must be present for the prompt to be listed. */
  requires: string[];
  /** tool names the instructions call - all must be listed. */
  tools: string[];
  argsSchema?: Record<string, z.ZodTypeAny>;
  text: (args: Record<string, string | undefined>) => string;
}

const optional = (desc: string) => z.string().optional().describe(desc);

export const PROMPTS: PromptDef[] = [
  {
    name: "re-edit-edit",
    title: "Re-edit a clip",
    description: "Give existing footage a new cut - transfer its motion onto new direction or reframe it.",
    requires: ["uploads", "models", "jobs", "jobs.list"],
    tools: ["upload", "models_list", "model_schema", "generate", "job_wait", "job_download"],
    argsSchema: {
      clip: optional("local path or URL of the source footage"),
      direction: optional("what the new cut should look like"),
    },
    text: (a) =>
      `Re-edit a clip${a.direction ? ` - new direction: ${a.direction}` : ""}.\n` +
      `1. upload the source footage${a.clip ? ` from ${a.clip}` : " the user provides"}; keep the returned url.\n` +
      "2. models_list kind v2v - pick a motion-transfer or reframe endpoint (model_schema shows its exact params).\n" +
      "3. generate with the uploaded url in the endpoint's video param plus the new direction as the prompt; wait_s 50.\n" +
      "4. job_download index 0 and report the saved path.",
  },
  {
    name: "swap-performer",
    title: "Swap the performer",
    description: "Put a different performer or character into an existing clip.",
    requires: ["uploads", "models", "jobs", "jobs.list"],
    tools: ["upload", "models_list", "generate", "job_wait", "job_download"],
    argsSchema: {
      clip: optional("local path or URL of the performance footage"),
      character: optional("local path or URL of the replacement character image"),
    },
    text: (a) =>
      "Swap the performer in a clip.\n" +
      `1. upload the footage${a.clip ? ` from ${a.clip}` : ""} and the replacement character image${a.character ? ` from ${a.character}` : ""} - two upload calls, keep both urls.\n` +
      "2. models_list kind v2v - pick the character-swap endpoint.\n" +
      "3. generate with the clip url and the character image url in the params the endpoint declares; wait_s 50.\n" +
      "4. job_download index 0.",
  },
  {
    name: "direct-shot",
    title: "Direct a shot",
    description: "Write and generate one camera shot - framing and motion described in the prompt.",
    requires: ["models", "estimate", "jobs", "jobs.list"],
    tools: ["models_list", "estimate", "generate", "job_wait", "job_download"],
    argsSchema: {
      shot: optional("the shot to generate - subject, framing, camera move"),
      seconds: optional("target duration in seconds"),
    },
    text: (a) =>
      `Direct a shot${a.shot ? `: ${a.shot}` : ""}${a.seconds ? `, about ${a.seconds}s` : ""}.\n` +
      "1. models_list kind video - pick a text-to-video endpoint.\n" +
      "2. estimate it with the shot prompt; mention the credit cost before submitting.\n" +
      "3. generate with the prompt describing subject, framing and camera move; wait_s 50 - if it is still live, call job_wait again rather than resubmitting.\n" +
      "4. job_download index 0.",
  },
  {
    name: "reshoot-angle",
    title: "Reshoot from a new angle",
    description: "Take a still or a finished job's output and produce the same subject from a different angle.",
    requires: ["jobs", "jobs.list", "uploads", "models"],
    tools: ["jobs_list", "upload", "models_list", "generate", "job_wait", "job_download"],
    argsSchema: {
      source: optional("job id or local path of the shot to reshoot"),
      angle: optional("the new angle - e.g. over-the-shoulder, top-down"),
    },
    text: (a) =>
      `Reshoot a subject from a new angle${a.angle ? ` (${a.angle})` : ""}.\n` +
      `1. Get the source image: jobs_list to find the finished job and reuse its output url, or upload ${a.source ? `the file at ${a.source}` : "the still the user provides"}.\n` +
      "2. models_list - pick an image-to-image or edit endpoint.\n" +
      "3. generate with image=<source url> and the new angle in the prompt; wait_s 50.\n" +
      "4. job_download index 0.",
  },
  {
    name: "vfx-plate",
    title: "Prep a VFX plate",
    description: "Clean a plate for effects work - remove unwanted elements, then optionally upscale.",
    requires: ["uploads", "models", "jobs", "jobs.list"],
    tools: ["upload", "models_list", "generate", "job_wait", "job_download"],
    argsSchema: {
      plate: optional("local path or URL of the plate image"),
      remove: optional("what to take out"),
    },
    text: (a) =>
      `Prep a VFX plate${a.remove ? ` - remove: ${a.remove}` : ""}.\n` +
      `1. upload the plate${a.plate ? ` from ${a.plate}` : ""}.\n` +
      "2. models_list kind edit - pick the instruction-edit endpoint.\n" +
      "3. generate with image=<url> and a removal prompt naming what to take out and to fill the gap cleanly; wait_s 50.\n" +
      "4. Optional: generate again on an upscale endpoint with the first result's url for a cleaner plate.\n" +
      "5. job_download index 0 of the final job.",
  },
  {
    name: "stage-scene",
    title: "Stage a scene",
    description: "Dress a scene - place subject elements into an environment still and animate it.",
    requires: ["uploads", "presets", "models", "jobs", "jobs.list"],
    tools: ["upload", "presets", "models_list", "generate", "job_wait", "job_download"],
    argsSchema: {
      elements: optional("local paths or URLs of the subject elements"),
      environment: optional("local path or URL of the environment still"),
    },
    text: (a) =>
      "Stage a scene from element and environment stills.\n" +
      `1. upload the environment still${a.environment ? ` from ${a.environment}` : ""} and each element image${a.elements ? ` (${a.elements})` : ""}.\n` +
      "2. presets{action:list, kind:motion} - pick a scene/motion preset if one fits the mood.\n" +
      "3. models_list kind video - pick an image-to-video endpoint.\n" +
      "4. generate with the environment image plus a prompt describing where the elements sit and how the scene moves (add the preset id param if you picked one); wait_s 50.\n" +
      "5. job_download index 0.",
  },
  {
    name: "make-3d-character",
    title: "Make a 3D character",
    description: "Turn a character concept into a rendered 3D asset.",
    requires: ["models", "jobs", "jobs.list", "threed"],
    tools: ["models_list", "model_schema", "generate", "job_wait", "job_download"],
    argsSchema: {
      character: optional("who or what the character is"),
      style: optional("art direction - e.g. stylized, realistic"),
    },
    text: (a) =>
      `Create a 3D character${a.character ? `: ${a.character}` : ""}${a.style ? `, ${a.style} style` : ""}.\n` +
      "1. models_list kind threed - pick the character/3d endpoint; model_schema it for the params it takes.\n" +
      "2. generate with a prompt describing the character, the style and the pose; wait_s 50.\n" +
      "3. job_download index 0 - the output may be a model file, so report the saved path and its type.",
  },
  {
    name: "explainer",
    title: "Make an explainer video",
    description: "A topic becomes a short narrated explainer - scenes illustrated and voiced.",
    requires: ["skills.read", "models", "jobs", "jobs.list"],
    tools: ["skills", "models_list", "generate", "job_wait", "job_download"],
    argsSchema: {
      topic: optional("what the video explains"),
      scenes: optional("how many scenes"),
    },
    text: (a) =>
      `Make a narrated explainer${a.topic ? ` about "${a.topic}"` : ""}.\n` +
      "1. skills{action:list} - find the explainer skill; skills{action:get} its slug for the pipeline steps and intake questions.\n" +
      "2. Ask the intake questions the skill lists (scenes, voice, style, aspect) - then generate on the endpoint its steps name, with the answers in params" +
      `${a.scenes ? ` (scenes: ${a.scenes})` : ""}.\n` +
      "3. job_wait until completed - these jobs chain scenes and narration, so they can take the full wait budget.\n" +
      "4. job_download index 0.",
  },
  {
    name: "ugc-ad",
    title: "Make a UGC ad",
    description: "Casual creator-style ad - product and person photos in, a short ad clip out.",
    requires: ["skills.read", "uploads", "models", "jobs", "jobs.list"],
    tools: ["skills", "upload", "models_list", "generate", "job_wait", "job_download"],
    argsSchema: {
      product: optional("local paths or URLs of product photos"),
      hook: optional("the ad's angle - e.g. unboxing, problem/solution"),
    },
    text: (a) =>
      `Make a creator-style UGC ad${a.hook ? ` (${a.hook} angle)` : ""}.\n` +
      `1. upload the product photos${a.product ? ` from ${a.product}` : ""} (and a creator photo if the user has one).\n` +
      "2. skills{action:get, slug:the UGC ad skill} - read which endpoints its steps call and what it asks.\n" +
      "3. generate the product shot first (text-to-image with the uploaded refs in params), then the creator clip on an image-to-video endpoint; wait_s 50 each.\n" +
      "4. job_download index 0 on both jobs and list the saved files.",
  },
  {
    name: "ad-pack",
    title: "Make an ad pack",
    description: "One brief or source ad becomes a pack of campaign variations.",
    requires: ["uploads", "presets", "jobs", "jobs.list"],
    tools: ["upload", "presets", "generate_batch", "job_wait", "job_download"],
    argsSchema: {
      brief: optional("product/campaign the ads are for"),
      source: optional("existing ad image to vary"),
      count: optional("how many variations (default 3)"),
    },
    text: (a) =>
      `Produce an ad pack${a.brief ? ` for ${a.brief}` : ""}${a.count ? ` - ${a.count} variations` : " - 3 variations"}.\n` +
      `${a.source ? `1. upload the source ad from ${a.source}.\n2. ` : "1. "}presets{action:list, kind:style} - pick a consistent look per variant.\n` +
      `${a.source ? "3" : "2"}. generate_batch with one request per variation - same brief, varied setting/styling (and the source url or a preset marker in params). Per-item errors are reported in place.\n` +
      `${a.source ? "4" : "3"}. job_wait on the returned ids; job_download index 0 of each completed job.`,
  },
  {
    name: "launch-motion",
    title: "Launch in motion",
    description: "Animate a brand or product still into a launch clip.",
    requires: ["models", "uploads", "jobs", "jobs.list"],
    tools: ["models_list", "upload", "generate", "job_wait", "job_download"],
    argsSchema: {
      asset: optional("local path or URL of the logo/product still - absent → generate the still first"),
      mood: optional("the clip's energy - e.g. bold, minimal, glossy"),
    },
    text: (a) =>
      `Launch a brand or product in motion${a.mood ? ` - ${a.mood} energy` : ""}.\n` +
      (a.asset
        ? `1. upload the still from ${a.asset}.\n`
        : "1. No still? generate one first on a text-to-image endpoint (models_list kind image) - logo/hero frame for the launch.\n") +
      "2. models_list kind video - pick an image-to-video endpoint.\n" +
      "3. generate with the still url and a motion brief (reveal, camera push, light sweep); wait_s 50.\n" +
      "4. job_download index 0.",
  },
  {
    name: "podcast-cut",
    title: "Cut a podcast clip",
    description: "Turn a voice track into a shareable video - a speaker visual plus cover art.",
    requires: ["uploads", "models", "jobs", "jobs.list"],
    tools: ["upload", "models_list", "generate", "job_wait", "job_download"],
    argsSchema: {
      audio: optional("local path or URL of the audio track"),
      face: optional("local path or URL of a speaker image for lip-sync"),
    },
    text: (a) =>
      "Cut a podcast episode into a shareable clip.\n" +
      `1. upload the audio track${a.audio ? ` from ${a.audio}` : ""}.${a.face ? ` Also upload the speaker image from ${a.face}.` : ""}\n` +
      (a.face
        ? "2. models_list - pick the lip-sync video endpoint; generate with the face video/image and the audio urls; wait_s 50.\n"
        : "2. models_list kind image - generate a cover still for the episode first, then a talking-portrait endpoint job with the audio url if the user wants a speaking host; wait_s 50.\n") +
      "3. job_download index 0 on each finished job and report the saved files.",
  },
  {
    name: "make-game",
    title: "Make game art",
    description: "A concept becomes usable game art - sprites, textures or a character turnaround.",
    requires: ["skills.read", "models", "jobs", "jobs.list"],
    tools: ["skills", "models_list", "generate_batch", "job_wait", "job_download"],
    argsSchema: {
      concept: optional("the game's look - world, palette, mood"),
      assets: optional("what to make - spritesheet, tileable texture, character turnaround"),
    },
    text: (a) =>
      `Produce game art${a.concept ? ` for "${a.concept}"` : ""}${a.assets ? ` - ${a.assets}` : ""}.\n` +
      "1. skills{action:get, slug:the game art skill} - read its steps and intake questions (asset type, style).\n" +
      "2. models_list kind image - pick the text-to-image endpoint.\n" +
      "3. generate_batch with one request per asset (consistent style across the batch - same style words in each prompt). Watch for per-item errors in place.\n" +
      "4. job_wait the ids; job_download index 0 of each completed job.",
  },
  {
    name: "skill-run",
    title: "Run a skill as a durable run",
    description: "Pick a catalog skill, turn a brief into its multi-step run, then approve and watch it execute.",
    requires: ["skills.read", "runs"],
    tools: ["skills", "run_create", "run_get", "run_approve", "run_control"],
    argsSchema: {
      brief: optional("the topic or brief the run produces"),
      skill: optional("skill slug - defaults to asking the catalog"),
    },
    text: (a) =>
      `Run a skill pipeline as a durable run${a.brief ? ` - brief: ${a.brief}` : ""}.\n` +
      `1. skills{action:list} - pick the skill that fits${a.skill ? ` (${a.skill})` : ""}; skills{action:get} reads its intake questions.\n` +
      "2. run_create with the skill slug + brief (intake answers in params); ask_first:true parks it for review - show the plan's steps, estimate and planner.via.\n" +
      "3. When the user approves the plan, run_approve; run_control can pause, resume or cancel along the way.\n" +
      "4. run_get until the run is done - per-step status, rev and error; report which step produced what.",
  },
];
