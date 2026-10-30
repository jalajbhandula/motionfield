/* The tool registry - one file per tool under tools/<toolset>/. */

import type { ToolDef } from "../registry.mts";

import models_list from "./core/models_list.mts";
import model_schema from "./core/model_schema.mts";
import presets from "./core/presets.mts";
import skills from "./core/skills.mts";
import estimate from "./core/estimate.mts";
import upload from "./core/upload.mts";
import generate from "./core/generate.mts";
import generate_batch from "./core/generate_batch.mts";
import job_status from "./core/job_status.mts";
import job_wait from "./core/job_wait.mts";
import job_cancel from "./core/job_cancel.mts";
import job_download from "./core/job_download.mts";
import jobs_list from "./core/jobs_list.mts";
import assets_list from "./core/assets_list.mts";
import system_status from "./core/system_status.mts";
import run_create from "./core/run_create.mts";
import run_get from "./core/run_get.mts";
import run_approve from "./core/run_approve.mts";
import run_edit_step from "./core/run_edit_step.mts";
import run_control from "./core/run_control.mts";

/* the 3d toolset - stage lists when the server reports the 'stage'
 *  capability; anim_clips stays pending until WS5b S1 ships clip search */
import stage from "./3d/stage.mts";
import anim_clips from "./3d/anim_clips.mts";

/* the 17 studio tools - refs, the four endpoint-backed surfaces and audio
 *  list when their gate opens; the 11 pending wrappers never list (calls
 *  still answer a clean not_available until the real wrapper lands with its
 *  capability) */
import refs from "./studio/refs.mts";
import characters from "./studio/characters.mts";
import person_swap from "./studio/person_swap.mts";
import director_shot from "./studio/director_shot.mts";
import reshoot from "./studio/reshoot.mts";
import vfx_lab from "./studio/vfx_lab.mts";
import re_edit from "./studio/re_edit.mts";
import audio from "./studio/audio.mts";
import voices from "./studio/voices.mts";
import dub from "./studio/dub.mts";
import motion_graphics from "./studio/motion_graphics.mts";
import ad_lab from "./studio/ad_lab.mts";
import video_analyze from "./studio/video_analyze.mts";
import clipper from "./studio/clipper.mts";
import shorts from "./studio/shorts.mts";
import podcast_edit from "./studio/podcast_edit.mts";
import virality_score from "./studio/virality_score.mts";

export const TOOLS: ToolDef[] = [
  models_list, model_schema,
  presets, skills,
  estimate, upload,
  generate, generate_batch,
  job_status, job_wait, job_cancel, job_download, jobs_list,
  assets_list,
  system_status,
  run_create, run_get, run_approve, run_edit_step, run_control,
  refs, characters, person_swap, director_shot, reshoot, vfx_lab, re_edit,
  audio, voices, dub, motion_graphics, ad_lab, video_analyze, clipper,
  shorts, podcast_edit, virality_score,
  stage, anim_clips,
];
