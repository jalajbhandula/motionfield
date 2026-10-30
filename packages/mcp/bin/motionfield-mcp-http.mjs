#!/usr/bin/env node
// Node ≥22.18 runs the .mts sources directly (type stripping) - no build step.
import("../src/http/main.mts");
