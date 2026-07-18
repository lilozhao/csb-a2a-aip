#!/bin/sh
# A2A Server v4 launcher for port 3100
cd /home/node/.openclaw/workspace/shared-a2a-skill
export A2A_PORT=3100
exec node server_v4.js
