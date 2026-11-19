#!/bin/bash
# Double-click this file on a Mac to update and start Halftone, then open it in the browser.
cd "$(dirname "$0")" || exit 1
git pull --ff-only
npm install
# The SEC requires a contact email from anyone reading its company data. It is asked for
# once and kept in a file on this computer only (never uploaded with the code).
if [ -z "$SEC_USER_AGENT" ]; then
  if [ ! -s .sec-contact ]; then
    printf "\nCompany reports come from the SEC, which asks for a contact email.\nType your email and press Return (or just press Return to skip): "
    read -r contact
    [ -n "$contact" ] && printf "%s" "$contact" > .sec-contact
  fi
  [ -s .sec-contact ] && export SEC_USER_AGENT="Halftone $(cat .sec-contact)"
fi
(sleep 4 && open http://localhost:3000) &
npm start
