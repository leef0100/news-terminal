#!/bin/bash
# Double-click this file on a Mac to update and start Halftone, then open it in the browser.
cd "$(dirname "$0")" || exit 1
git pull --ff-only
npm install
(sleep 4 && open http://localhost:3000) &
npm start
