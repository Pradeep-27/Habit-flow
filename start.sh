#!/bin/bash
cd "$(dirname "$0")"
pkill -f "node server" 2>/dev/null
sleep 1
PORT=3001 nohup node server.js > /home/nature/Desktop/Freebuff/.freebuff/preview-thms244066drq6.log 2>&1 &
PID=$!
echo "Server PID=$PID"
echo $PID > /tmp/habitflow.pid
sleep 2
curl -s -o /dev/null -w "HTTP=%{http_code}\n" http://localhost:3001/
