#!/bin/sh
# Double-clickable on macOS — same as start.sh.
cd "$(dirname "$0")" && exec sh start.sh "$@"
