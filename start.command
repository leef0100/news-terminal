#!/bin/bash
# Double-click this file on a Mac to update and start Halftone, then open it in the browser.
cd "$(dirname "$0")" || exit 1
# Update first, then start again from the updated copy of this file, so that changes to the
# launcher itself take effect on this run and not the next one.
if [ "$1" != "--updated" ]; then
  git pull --ff-only
  exec /bin/bash "$0" --updated
fi
# Only one copy can run at a time. Stop an earlier one that is still holding the port.
old=$(lsof -ti tcp:3000 -sTCP:LISTEN 2>/dev/null)
if [ -n "$old" ]; then echo "Stopping the copy of Halftone that was already running."; kill $old 2>/dev/null; sleep 1; fi
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
