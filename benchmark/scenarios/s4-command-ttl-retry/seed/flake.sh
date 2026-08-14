#!/bin/sh
if [ -f flag.txt ]; then
  echo FLAKE-OK
  exit 0
else
  echo FLAKE-FAIL
  exit 1
fi
